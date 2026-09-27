import { Injectable, Logger, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { QUEUE_NAMES, DEFAULT_QUEUE_JOB } from '../queues/queue.constants';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindManyOptions, Between, IsNull, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import Big from 'big.js';
import { AdminAlertService } from '../alerts/admin-alert.service';
import { AdminAlertType } from '../alerts/admin-alert.entity';
import { Settlement, SettlementStatus } from './entities/settlement.entity';
import { Payment, PaymentStatus } from '../payments/entities/payment.entity';
import { WebhooksService } from '../webhooks/webhooks.service';
import { PaginatedResponseDto } from '../common/dto/pagination.dto';
import { AdminSettlementsQueryDto } from './dto/admin-settlements-query.dto';
import { EmailService } from '../email/email.service';
import { MerchantsService } from '../merchants/merchants.service';
import { NotificationPrefsService } from '../notifications/notification-prefs.service';
import { NotificationChannel, NotificationEventType } from '../notifications/entities/notification-preference.entity';
import { StellarService } from '../stellar/stellar.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CronJobService } from '../cron/cron-job.service';
import { RetryConfigService } from '../retry/retry-config.service';

export interface PartnerCallbackPayload {
  reference: string;
  status: 'success' | 'failed';
  failureReason?: string;
}

const SMALL_BATCH_THRESHOLD_USD = 10;
const MAX_BATCH_PAYMENT_COUNT = 50;
const BATCH_WINDOW_MINUTES = 15;
const BATCH_FEE_RATE = 0.015;

/**
 * Maps a merchant's country to the fiat currency their settlements are
 * denominated in. Falls back to USD for unknown countries so we never
 * silently record a settlement in the wrong currency.
 */
const COUNTRY_TO_SETTLEMENT_CURRENCY: Record<string, string> = {
  NG: 'NGN',
  US: 'USD',
  GB: 'GBP',
  AU: 'AUD',
};

const DEFAULT_SETTLEMENT_CURRENCY = 'USD';

@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(
    @InjectRepository(Settlement)
    private settlementsRepo: Repository<Settlement>,
    @InjectRepository(Payment)
    private paymentsRepo: Repository<Payment>,
    private config: ConfigService,
    private webhooks: WebhooksService,
    private adminAlerts: AdminAlertService,
    private analytics: AnalyticsService,
    private emailService: EmailService,
    private merchantsService: MerchantsService,
    private notificationPrefs: NotificationPrefsService,
    @Inject(forwardRef(() => StellarService))
    private stellar: StellarService,
    @InjectQueue(QUEUE_NAMES.settlement)
    private settlementQueue: Queue,
    private cronJobService: CronJobService,
    private retryConfig: RetryConfigService,
  ) {}

  private invalidateAnalyticsForMerchant(merchantId: string): void {
    this.analytics.clearCacheForMerchant(merchantId);
  }

  private toBig(value: number | string): Big {
    return new Big(value);
  }

  /**
   * Resolves the fiat currency a merchant's settlements should be denominated
   * in, based on the merchant's country. Never hardcodes a single currency.
   */
  private async resolveSettlementCurrency(merchantId: string): Promise<string> {
    try {
      const merchant = await this.merchantsService.findOne(merchantId);
      const country = merchant?.country?.toUpperCase();
      if (country && COUNTRY_TO_SETTLEMENT_CURRENCY[country]) {
        return COUNTRY_TO_SETTLEMENT_CURRENCY[country];
      }
      this.logger.warn(
        `No settlement currency mapping for merchant ${merchantId} (country: ${merchant?.country ?? 'unknown'}); defaulting to ${DEFAULT_SETTLEMENT_CURRENCY}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to resolve settlement currency for merchant ${merchantId}; defaulting to ${DEFAULT_SETTLEMENT_CURRENCY}`,
      );
    }
    return DEFAULT_SETTLEMENT_CURRENCY;
  }

  async initiateSettlement(payment: Payment): Promise<void> {
    const amountUsd = this.toBig(payment.amountUsd);
    if (amountUsd.lt(SMALL_BATCH_THRESHOLD_USD)) {
      this.logger.debug(
        `Payment ${payment.id} below ${SMALL_BATCH_THRESHOLD_USD} USD batch threshold; waiting for batch window.`,
      );
      return;
    }

    const feeUsd = amountUsd.times(BATCH_FEE_RATE);
    const netUsd = amountUsd.minus(feeUsd);
    const LARGE_SETTLEMENT_THRESHOLD = 10000;

    const fiatCurrency = await this.resolveSettlementCurrency(payment.merchantId);

    const settlement = this.settlementsRepo.create({
      merchantId: payment.merchantId,
      totalAmountUsd: amountUsd.toNumber(),
      feeAmountUsd: feeUsd.toNumber(),
      netAmountUsd: netUsd.toNumber(),
      fiatCurrency,
      status: netUsd.gte(LARGE_SETTLEMENT_THRESHOLD) ? SettlementStatus.PENDING_APPROVAL : SettlementStatus.PROCESSING,
      requiresApproval: netUsd.gte(LARGE_SETTLEMENT_THRESHOLD),
    });

    const saved = await this.settlementsRepo.save(settlement);

    payment.status = PaymentStatus.SETTLING;
    payment.feeUsd = feeUsd.toNumber();
    payment.settlementId = saved.id;
    await this.paymentsRepo.save(payment);

    await this.webhooks.dispatch(payment.merchantId, 'payment.settling', {
      paymentId: payment.id,
      settlementId: saved.id,
    });

    // Only execute transfer if no approval required
    if (!settlement.requiresApproval) {
      this.logger.debug(`Enqueuing settlement job for ${saved.id}`);
      await this.enqueueSettlement(saved.id);
    } else {
      // Alert admin about large settlement requiring approval
      await this.adminAlerts.raise({
        type: AdminAlertType.SETTLEMENT_FAILURE, // Reusing existing type for now
        dedupeKey: `large-settlement:${saved.id}`,
        message: `Large settlement ${saved.id} requires manual approval: $${netUsd.toFixed(2)}`,
        metadata: {
          merchantId: saved.merchantId,
          paymentId: payment.id,
          amount: netUsd.toNumber(),
        },
        thresholdValue: 1,
      });
    }
  }

  private async enqueueSettlement(settlementId: string): Promise<void> {
    const settlementRetry = this.retryConfig.settlement;
    await this.settlementQueue.add(DEFAULT_QUEUE_JOB, { settlementId }, {
      attempts: settlementRetry.maxAttempts + 1,
      backoff: { type: 'fixed', delay: settlementRetry.delaysMs[0] ?? 60_000 },
      removeOnFail: false,
    });
  }

  @Cron('0 */15 * * * *')
  async batchSmallConfirmedPayments(): Promise<void> {
    await this.cronJobService.run('batch-small-confirmed-payments', async () => {
      const confirmedPayments = await this.paymentsRepo.find({
        where: {
          status: PaymentStatus.CONFIRMED,
          settlementId: IsNull(),
          amountUsd: LessThan(SMALL_BATCH_THRESHOLD_USD),
        },
        order: {
          merchantId: 'ASC',
          confirmedAt: 'ASC',
          createdAt: 'ASC',
        },
      });

      if (confirmedPayments.length === 0) {
        return 0;
      }

      const groups = new Map<string, Payment[]>();
      for (const payment of confirmedPayments) {
        const list = groups.get(payment.merchantId) ?? [];
        list.push(payment);
        groups.set(payment.merchantId, list);
      }

      for (const payments of groups.values()) {
        await this.flushMerchantBatch(payments);
      }

      return confirmedPayments.length;
    });
  }

  private async flushMerchantBatch(payments: Payment[]): Promise<void> {
    const ordered = [...payments].sort(
      (a, b) =>
        new Date(a.confirmedAt ?? a.createdAt).getTime() -
        new Date(b.confirmedAt ?? b.createdAt).getTime(),
    );

    let batch: Payment[] = [];
    let runningTotal = new Big(0);

    for (const payment of ordered) {
      batch.push(payment);
      runningTotal = runningTotal.plus(this.toBig(payment.amountUsd));

      const oldest = batch[0];
      const oldestAt = new Date(oldest.confirmedAt ?? oldest.createdAt).getTime();
      const isOldEnough = Date.now() - oldestAt >= BATCH_WINDOW_MINUTES * 60 * 1000;
      const shouldFlush =
        runningTotal.gte(SMALL_BATCH_THRESHOLD_USD) ||
        batch.length >= MAX_BATCH_PAYMENT_COUNT ||
        isOldEnough;

      if (shouldFlush) {
        await this.createBatchSettlement(batch);
        batch = [];
        runningTotal = new Big(0);
      }
    }
  }

  private async createBatchSettlement(payments: Payment[]): Promise<void> {
    if (payments.length === 0) {
      return;
    }

    const totalAmountUsd = payments.reduce((sum, payment) => sum.plus(this.toBig(payment.amountUsd)), new Big(0));
    const feeAmountUsd = totalAmountUsd.times(BATCH_FEE_RATE);
    const netAmountUsd = totalAmountUsd.minus(feeAmountUsd);

    const fiatCurrency = await this.resolveSettlementCurrency(payments[0].merchantId);

    const settlement = this.settlementsRepo.create({
      merchantId: payments[0].merchantId,
      totalAmountUsd: totalAmountUsd.toNumber(),
      feeAmountUsd: feeAmountUsd.toNumber(),
      netAmountUsd: netAmountUsd.toNumber(),
      fiatCurrency,
      status: netAmountUsd.gte(10000) ? SettlementStatus.PENDING_APPROVAL : SettlementStatus.PROCESSING,
      requiresApproval: netAmountUsd.gte(10000),
    });

    const saved = await this.settlementsRepo.save(settlement);

    for (const payment of payments) {
      payment.status = PaymentStatus.SETTLING;
      payment.feeUsd = this.toBig(payment.amountUsd).times(BATCH_FEE_RATE).toNumber();
      payment.settlementId = saved.id;
    }

    await this.paymentsRepo.save(payments);

    await this.webhooks.dispatch(payments[0].merchantId, 'settlement.created', {
      settlementId: saved.id,
      paymentIds: payments.map((p) => p.id),
      fiatCurrency: saved.fiatCurrency,
    });

    if (!saved.requiresApproval) {
      await this.enqueueSettlement(saved.id);
    } else {
      await this.adminAlerts.raise({
        type: AdminAlertType.SETTLEMENT_FAILURE,
        dedupeKey: `large-settlement:${saved.id}`,
        message: `Large batch settlement ${saved.id} requires manual approval: $${netAmountUsd.toFixed(2)}`,
        metadata: {
          merchantId: saved.merchantId,
          paymentIds: payments.map((p) => p.id),
          amount: netAmountUsd.toNumber(),
        },
        thresholdValue: 1,
      });
    }
  }

  private async executeFiatTransfer(settlement: Settlement): Promise<void> {
    const partnerUrl = this.config.get<string>('SETTLEMENT_PARTNER_URL');
    const partnerApiKey = this.config.get<string>('SETTLEMENT_PARTNER_API_KEY');

    if (!partnerUrl || !partnerApiKey) {
      throw new Error('Settlement partner is not configured');
    }

    await axios.post(
      `${partnerUrl}/transfers`,
      {
        reference: settlement.id,
        amount: settlement.netAmountUsd,
        currency: settlement.fiatCurrency,
        merchantId: settlement.merchantId,
      },
      {
        headers: {
          Authorization: `Bearer ${partnerApiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
  }

  async processSettlement(settlementId: string): Promise<void> {
    const settlement = await this.settlementsRepo.findOne({ where: { id: settlementId } });
    if (!settlement) {
      throw new NotFoundException(`Settlement ${settlementId} not found`);
    }

    if (settlement.status !== SettlementStatus.PROCESSING) {
      this.logger.warn(`Settlement ${settlementId} is not in PROCESSING state; skipping`);
      return;
    }

    try {
      await this.executeFiatTransfer(settlement);
      settlement.status = SettlementStatus.COMPLETED;
      settlement.completedAt = new Date();
      await this.settlementsRepo.save(settlement);
      this.invalidateAnalyticsForMerchant(settlement.merchantId);
      await this.webhooks.dispatch(settlement.merchantId, 'settlement.completed', {
        settlementId: settlement.id,
      });
    } catch (error) {
      this.logger.error(`Settlement ${settlementId} failed: ${(error as Error).message}`);
      settlement.status = SettlementStatus.FAILED;
      settlement.failureReason = (error as Error).message;
      await this.settlementsRepo.save(settlement);
      this.invalidateAnalyticsForMerchant(settlement.merchantId);
      await this.adminAlerts.raise({
        type: AdminAlertType.SETTLEMENT_FAILURE,
        dedupeKey: `settlement-failed:${settlement.id}`,
        message: `Settlement ${settlement.id} failed: ${(error as Error).message}`,
        metadata: { merchantId: settlement.merchantId },
        thresholdValue: 1,
      });
      throw error;
    }
  }

  async approveSettlement(settlementId: string, adminId: string): Promise<Settlement> {
    const settlement = await this.settlementsRepo.findOne({ where: { id: settlementId } });
    if (!settlement) {
      throw new NotFoundException(`Settlement ${settlementId} not found`);
    }

    if (settlement.status !== SettlementStatus.PENDING_APPROVAL) {
      throw new Error(`Settlement ${settlementId} is not awaiting approval`);
    }

    settlement.status = SettlementStatus.PROCESSING;
    settlement.approvedBy = adminId;
    settlement.approvedAt = new Date();
    const saved = await this.settlementsRepo.save(settlement);

    await this.enqueueSettlement(saved.id);
    return saved;
  }

  async rejectSettlement(settlementId: string, adminId: string, reason: string): Promise<Settlement> {
    const settlement = await this.settlementsRepo.findOne({ where: { id: settlementId } });
    if (!settlement) {
      throw new NotFoundException(`Settlement ${settlementId} not found`);
    }

    settlement.status = SettlementStatus.REJECTED;
    settlement.rejectedBy = adminId;
    settlement.rejectedAt = new Date();
    settlement.rejectionReason = reason;
    return this.settlementsRepo.save(settlement);
  }

  async findForMerchant(
    merchantId: string,
    options: FindManyOptions<Settlement> = {},
  ): Promise<Settlement[]> {
    return this.settlementsRepo.find({
      ...options,
      where: { ...(options.where as object), merchantId },
      order: options.order ?? { createdAt: 'DESC' },
    });
  }

  async findOneForMerchant(merchantId: string, settlementId: string): Promise<Settlement> {
    const settlement = await this.settlementsRepo.findOne({
      where: { id: settlementId, merchantId },
    });
    if (!settlement) {
      throw new NotFoundException(`Settlement ${settlementId} not found`);
    }
    return settlement;
  }

  async findForAdmin(query: AdminSettlementsQueryDto): Promise<PaginatedResponseDto<Settlement>> {
    const { page = 1, limit = 20, status, merchantId, from, to } = query;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (merchantId) where.merchantId = merchantId;
    if (from && to) where.createdAt = Between(new Date(from), new Date(to));

    const [items, total] = await this.settlementsRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async handlePartnerCallback(payload: PartnerCallbackPayload): Promise<void> {
    const settlement = await this.settlementsRepo.findOne({ where: { id: payload.reference } });
    if (!settlement) {
      this.logger.warn(`Received partner callback for unknown settlement ${payload.reference}`);
      return;
    }

    if (payload.status === 'success') {
      settlement.status = SettlementStatus.COMPLETED;
      settlement.completedAt = new Date();
    } else {
      settlement.status = SettlementStatus.FAILED;
      settlement.failureReason = payload.failureReason ?? 'Partner reported failure';
    }

    await this.settlementsRepo.save(settlement);
    this.invalidateAnalyticsForMerchant(settlement.merchantId);

    await this.webhooks.dispatch(settlement.merchantId, `settlement.${payload.status}`, {
      settlementId: settlement.id,
    });

    await this.emailService.sendSettlementStatusEmail(settlement.merchantId, settlement);

    await this.notificationPrefs.notify(
      settlement.merchantId,
      NotificationEventType.SETTLEMENT_STATUS,
      NotificationChannel.EMAIL,
      { settlementId: settlement.id, status: settlement.status },
    );
  }
}
