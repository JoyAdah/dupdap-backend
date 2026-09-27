import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { QUEUE_NAMES } from '../queues/queue.constants';
import { DataSource, Repository } from 'typeorm';
import { AdminAlertService } from '../alerts/admin-alert.service';
import { AdminAlertType } from '../alerts/admin-alert.entity';
import { Payment, PaymentStatus } from '../payments/entities/payment.entity';
import { StellarService } from './stellar.service';
import { SorobanMonitorService } from './soroban-monitor.service';
import { SettlementsService } from '../settlements/settlements.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { EmailService } from '../email/email.service';
import { ConfigService } from '@nestjs/config';
import { Merchant } from '../merchants/entities/merchant.entity';
import { NotificationPrefsService } from '../notifications/notification-prefs.service';
import { NotificationChannel, NotificationEventType } from '../notifications/entities/notification-preference.entity';
import { RetryConfigService } from '../retry/retry-config.service';

@Injectable()
export class StellarMonitorService implements OnModuleInit {
  private readonly logger = new Logger(StellarMonitorService.name);
  private cursors: Map<string, string> = new Map();
  private lastRunAt: Date | null = null;
  private lastRunStatus: 'idle' | 'ok' | 'error' = 'idle';
  private lastRunError: string | null = null;

  constructor(
    @InjectRepository(Payment)
    private paymentsRepo: Repository<Payment>,
    @InjectDataSource()
    private dataSource: DataSource,
    private adminAlerts: AdminAlertService,
    private stellar: StellarService,
    private settlements: SettlementsService,
    private webhooks: WebhooksService,
    private emailService: EmailService,
    private config: ConfigService,
    private notificationPrefs: NotificationPrefsService,
    private sorobanMonitor: SorobanMonitorService,
    @InjectQueue(QUEUE_NAMES.stellarMonitor) private monitorQueue: Queue,
    private retryConfig: RetryConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const monitorRetry = this.retryConfig.stellarMonitor;
    await this.monitorQueue.add(
      'scan',
      {},
      {
        repeat: { every: 30_000 },
        jobId: 'stellar-monitor-repeat',
        removeOnComplete: true,
        attempts: monitorRetry.maxAttempts + 1,
        backoff: { type: 'fixed', delay: monitorRetry.delaysMs[0] ?? 0 },
      },
    );
    this.logger.log('Stellar monitor Bull job scheduled every 30 seconds');
  }

  async scanPendingPayments() {
    try {
      const depositAddress = this.stellar.getDepositAddress();
      if (!depositAddress) {
        this.markRunSuccess();
        return;
      }

      const cursor = this.cursors.get(depositAddress);
      let transactions: any[];

      try {
        transactions = await this.stellar.getAccountTransactions(depositAddress, cursor);
      } catch (err) {
        this.logger.error('Failed to fetch Stellar transactions', err.message);
        await this.adminAlerts.raise({
          type: AdminAlertType.STELLAR_MONITOR,
          dedupeKey: 'stellar-monitor.fetch',
          message: `Failed to fetch Stellar transactions: ${err.message}`,
          metadata: { depositAddress },
          thresholdValue: 1,
        });
        this.markRunFailure(err);
        return;
      }

      for (const tx of transactions) {
        this.cursors.set(depositAddress, tx.paging_token);

        const paymentMemo = tx.memo;
        if (!paymentMemo) continue;

        // Query directly by memo+status so monitoring can use the memo index.
        const matched = await this.paymentsRepo.findOne({
          where: {
            status: PaymentStatus.PENDING,
            stellarMemo: paymentMemo,
          },
          relations: ['merchant'],
        });
        if (!matched) continue;

        const result = await this.stellar.verifyPayment(tx.hash, paymentMemo);
        if (!result.verified) continue;

        try {
          await this.confirmPayment(matched, tx.hash, result.amount, result.asset, result.from);
        } catch (err) {
          await this.adminAlerts.raise({
            type: AdminAlertType.STELLAR_MONITOR,
            dedupeKey: `stellar-monitor.confirm:${matched.id}`,
            message: `Failed to confirm payment ${matched.reference}: ${err.message}`,
            metadata: { txHash: tx.hash, paymentId: matched.id },
            thresholdValue: 1,
          });
        }
      }

      await this.expireOldPayments();

      // Soroban escrow monitor: poll contract state-transition events
      await this.sorobanMonitor.pollEscrowEvents();
      this.markRunSuccess();
    } catch (error) {
      this.markRunFailure(error);
      throw error;
    }
  }

  getLastRunStatus(): {
    lastRunAt: string | null;
    status: 'idle' | 'ok' | 'error';
    lastError: string | null;
  } {
    return {
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      status: this.lastRunStatus,
      lastError: this.lastRunError,
    };
  }

  private async confirmPayment(
    payment: Payment,
    txHash: string,
    amount: number,
    asset: string,
    from?: string,
  ) {
    await this.dataSource.transaction(async (manager) => {
      // Re-fetch with a row-level lock to prevent concurrent double-settlement.
      // If another worker already confirmed this payment, its status will no
      // longer be PENDING and we bail out safely.
      const locked = await manager.findOne(Payment, {
        where: { id: payment.id, status: PaymentStatus.PENDING },
        lock: { mode: 'pessimistic_write' },
      });

      if (!locked) {
        this.logger.warn(
          `confirmPayment: payment ${payment.reference} is no longer PENDING — skipping (possible concurrent confirm)`,
        );
        return;
      }

      await this.stellar.invokeContract('confirm', [
        locked.id,
        txHash,
        amount,
        asset,
        from ?? null,
      ]);

      this.logger.log(`Payment confirmed: ${locked.reference} | tx: ${txHash}`);

      locked.status = PaymentStatus.CONFIRMED;
      locked.txHash = txHash;
      locked.confirmedAt = new Date();
      locked.customerWalletAddress = from;

      if (asset === 'USDC') locked.amountUsdc = amount;
      else locked.amountXlm = amount;

      await manager.save(locked);

      // Run side-effects outside the lock to keep the critical section tight.
      // We capture `locked` in closure — payment is already persisted above.
      await this.queuePaymentConfirmedEmail(locked, asset);

      await this.webhooks.dispatch(locked.merchantId, 'payment.confirmed', {
        paymentId: locked.id,
        reference: locked.reference,
        txHash,
        amount,
        asset,
      });

      await this.settlements.initiateSettlement(locked);
    });
  }

  private async queuePaymentConfirmedEmail(
    payment: Payment & { merchant?: Merchant },
    asset: string,
  ): Promise<void> {
    const merchant = payment.merchant;
    if (!merchant?.email) return;

    const emailEnabled = await this.notificationPrefs.isEnabled(
      merchant.id,
      NotificationChannel.EMAIL,
      NotificationEventType.PAYMENT_CONFIRMED,
    );
    if (!emailEnabled) return;

    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    const paymentDetailUrl = `${frontendUrl.replace(/\/$/, '')}/pay/${payment.reference}`;
    const txUrl = this.buildExplorerUrl(payment.txHash);
    const assetAmount =
      asset === 'USDC'
        ? Number(payment.amountUsdc ?? 0).toFixed(6)
        : Number(payment.amountXlm ?? 0).toFixed(7);

    await this.emailService.queue(
      merchant.email,
      'payment-confirmed',
      {
        merchantName: merchant.businessName,
        reference: payment.reference,
        amountUsd: Number(payment.amountUsd).toFixed(2),
        assetAmount,
        asset,
        txHash: payment.txHash,
        txUrl,
        confirmedAt: payment.confirmedAt?.toISOString() ?? new Date().toISOString(),
        paymentDetailUrl,
      },
      merchant.id,
    );
  }

  private buildExplorerUrl(txHash?: string): string {
    const network = this.config.get<string>('STELLAR_NETWORK', 'TESTNET');
    const networkPath = network === 'PUBLIC' ? 'public' : 'testnet';
    return txHash
      ? `https://stellar.expert/explorer/${networkPath}/tx/${txHash}`
      : '';
  }

  private async expireOldPayments() {
    const now = new Date();
    const expired = await this.paymentsRepo
      .createQueryBuilder('payment')
      .where('payment.status = :status', { status: PaymentStatus.PENDING })
      .andWhere('payment.expiresAt < :now', { now })
      .getMany();

    for (const payment of expired) {
      try {
        await this.stellar.invokeContract('expire', [payment.id]);
        payment.status = PaymentStatus.EXPIRED;
        await this.paymentsRepo.save(payment);

        await this.webhooks.dispatch(payment.merchantId, 'payment.expired', {
          paymentId: payment.id,
          reference: payment.reference,
        });
      } catch (err) {
        this.logger.error(`Failed to expire payment ${payment.id}: ${err.message}`);
        await this.adminAlerts.raise({
          type: AdminAlertType.STELLAR_MONITOR,
          dedupeKey: `stellar-monitor.expire:${payment.id}`,
          message: `Failed to expire payment ${payment.reference}: ${err.message}`,
          metadata: { paymentId: payment.id },
          thresholdValue: 1,
        });
      }
    }
  }

  private markRunSuccess(): void {
    this.lastRunAt = new Date();
    this.lastRunStatus = 'ok';
    this.lastRunError = null;
  }

  private markRunFailure(error: unknown): void {
    this.lastRunAt = new Date();
    this.lastRunStatus = 'error';
    this.lastRunError = error instanceof Error ? error.message : String(error);
  }
}
