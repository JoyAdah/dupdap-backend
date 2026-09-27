import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SettlementsService } from './settlements.service';
import { Settlement, SettlementStatus } from './entities/settlement.entity';
import { Payment, PaymentStatus } from '../payments/entities/payment.entity';
import { AdminAlertService } from '../alerts/admin-alert.service';
import { AdminAlertType } from '../alerts/admin-alert.entity';
import { WebhooksService } from '../webhooks/webhooks.service';
import { EmailService } from '../email/email.service';
import { MerchantsService } from '../merchants/merchants.service';
import { NotificationPrefsService } from '../notifications/notification-prefs.service';
import { StellarService } from '../stellar/stellar.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CronJobService } from '../cron/cron-job.service';
import { RetryConfigService } from '../retry/retry-config.service';

describe('SettlementsService batching', () => {
  let service: SettlementsService;
  let settlementsRepo: any;
  let paymentsRepo: any;
  let settlementQueue: any;

  const mockRetryConfig = {
    settlement: {
      maxAttempts: 3,
      delaysMs: [60_000, 300_000, 1_800_000],
    },
  };

  const deps = () => ({
    config: { get: jest.fn() } as unknown as ConfigService,
    webhooks: { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhooksService,
    adminAlerts: {
      raise: jest.fn().mockResolvedValue(null),
    } as unknown as AdminAlertService,
    analytics: { clearCacheForMerchant: jest.fn() } as unknown as AnalyticsService,
    emailService: { queue: jest.fn().mockResolvedValue(undefined) } as unknown as EmailService,
    merchantsService: { findOne: jest.fn().mockResolvedValue({ email: 'merchant@example.com' }) } as unknown as MerchantsService,
    notificationPrefs: { isEnabled: jest.fn().mockResolvedValue(false) } as unknown as NotificationPrefsService,
    stellar: {
      invokeContract: jest.fn().mockResolvedValue('mock-contract-hash'),
    } as unknown as StellarService,
  });

  beforeEach(() => {
    settlementsRepo = {
      create: jest.fn((input) => ({ id: 'settlement-1', ...input } as Settlement)),
      save: jest.fn(async (settlement: Settlement) => settlement),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
    };

    paymentsRepo = {
      save: jest.fn(async (payment: Payment) => payment),
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    settlementQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    service = new SettlementsService(
      settlementsRepo as any,
      paymentsRepo as any,
      deps().config,
      deps().webhooks,
      deps().adminAlerts,
      deps().analytics,
      deps().emailService,
      deps().merchantsService,
      deps().notificationPrefs,
      deps().stellar,
      settlementQueue as any,
      { run: jest.fn() } as unknown as CronJobService,
      mockRetryConfig as unknown as RetryConfigService,
    );

    jest.restoreAllMocks();
  });

  it('keeps sub-$10 confirmed payments out of immediate settlement', async () => {
    const payment = {
      id: 'payment-small',
      merchantId: 'merchant-1',
      amountUsd: 5,
      status: PaymentStatus.CONFIRMED,
    } as Payment;

    await service.initiateSettlement(payment);

    expect(settlementsRepo.create).not.toHaveBeenCalled();
    expect(settlementQueue.add).not.toHaveBeenCalled();
    expect(payment.status).toBe(PaymentStatus.CONFIRMED);
  });

  it('batches confirmed small payments per merchant once the threshold is reached', async () => {
    const now = new Date('2026-04-27T10:00:00Z');
    jest.spyOn(global.Date, 'now').mockReturnValue(now.getTime());

    const payments = [
      {
        id: 'p1',
        merchantId: 'merchant-1',
        amountUsd: 4,
        status: PaymentStatus.CONFIRMED,
        confirmedAt: new Date('2026-04-27T09:56:00Z'),
        createdAt: new Date('2026-04-27T09:56:00Z'),
      },
      {
        id: 'p2',
        merchantId: 'merchant-1',
        amountUsd: 3,
        status: PaymentStatus.CONFIRMED,
        confirmedAt: new Date('2026-04-27T09:57:00Z'),
        createdAt: new Date('2026-04-27T09:57:00Z'),
      },
      {
        id: 'p3',
        merchantId: 'merchant-1',
        amountUsd: 3.5,
        status: PaymentStatus.CONFIRMED,
        confirmedAt: new Date('2026-04-27T09:58:00Z'),
        createdAt: new Date('2026-04-27T09:58:00Z'),
      },
      {
        id: 'p4',
        merchantId: 'merchant-2',
        amountUsd: 2,
        status: PaymentStatus.CONFIRMED,
        confirmedAt: new Date('2026-04-27T09:59:00Z'),
        createdAt: new Date('2026-04-27T09:59:00Z'),
      },
    ] as Payment[];

    paymentsRepo.find = jest.fn().mockResolvedValue(payments);

    await service.batchSmallConfirmedPayments();

    expect(settlementsRepo.create).toHaveBeenCalledTimes(1);
    expect(settlementsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'merchant-1',
        totalAmountUsd: 10.5,
        feeAmountUsd: 10.5 * 0.015,
        netAmountUsd: 10.5 - 10.5 * 0.015,
        fiatCurrency: 'NGN',
        status: SettlementStatus.PROCESSING,
        requiresApproval: false,
      }),
    );
    expect(paymentsRepo.save).toHaveBeenCalledTimes(3);
    expect(settlementQueue.add).toHaveBeenCalledTimes(1);
    expect(settlementQueue.add).toHaveBeenCalledWith(
      'dispatch',
      { settlementId: 'settlement-1' },
      expect.objectContaining({ attempts: 4 }), // maxAttempts(3) + 1
    );
    expect((payments[0] as Payment).status).toBe(PaymentStatus.SETTLING);
    expect((payments[1] as Payment).status).toBe(PaymentStatus.SETTLING);
    expect((payments[2] as Payment).status).toBe(PaymentStatus.SETTLING);
    expect((payments[3] as Payment).status).toBe(PaymentStatus.CONFIRMED);
  });

  it('does not flush a merchant batch that is still below the $10 threshold', async () => {
    const payments = [
      {
        id: 'p1',
        merchantId: 'merchant-1',
        amountUsd: 4,
        status: PaymentStatus.CONFIRMED,
        confirmedAt: new Date('2026-04-27T09:55:00Z'),
        createdAt: new Date('2026-04-27T09:55:00Z'),
      },
      {
        id: 'p2',
        merchantId: 'merchant-1',
        amountUsd: 5,
        status: PaymentStatus.CONFIRMED,
        confirmedAt: new Date('2026-04-27T09:56:00Z'),
        createdAt: new Date('2026-04-27T09:56:00Z'),
      },
    ] as Payment[];

    paymentsRepo.find = jest.fn().mockResolvedValue(payments);

    await service.batchSmallConfirmedPayments();

    expect(settlementsRepo.create).not.toHaveBeenCalled();
    expect(settlementQueue.add).not.toHaveBeenCalled();
    expect(paymentsRepo.save).not.toHaveBeenCalled();
  });
});

describe('SettlementsService cache invalidation', () => {
  let service: SettlementsService;
  let settlementsRepo: any;
  let paymentsRepo: any;
  let analytics: AnalyticsService;

  const deps = () => ({
    config: { get: jest.fn() } as unknown as ConfigService,
    webhooks: { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhooksService,
    adminAlerts: {
      raise: jest.fn().mockResolvedValue(null),
    } as unknown as AdminAlertService,
    analytics: { clearCacheForMerchant: jest.fn() } as unknown as AnalyticsService,
    emailService: { queue: jest.fn().mockResolvedValue(undefined) } as unknown as EmailService,
    merchantsService: { findOne: jest.fn().mockResolvedValue({ email: 'merchant@example.com' }) } as unknown as MerchantsService,
    notificationPrefs: { isEnabled: jest.fn().mockResolvedValue(false) } as unknown as NotificationPrefsService,
    stellar: {
      invokeContract: jest.fn().mockResolvedValue('mock-contract-hash'),
    } as unknown as StellarService,
  });

  beforeEach(() => {
    settlementsRepo = {
      create: jest.fn((input) => ({ id: 'settlement-1', ...input } as Settlement)),
      save: jest.fn(async (settlement: Settlement) => settlement),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
    };

    paymentsRepo = {
      save: jest.fn(async (payment: Payment) => payment),
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const settlementQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    service = new SettlementsService(
      settlementsRepo as any,
      paymentsRepo as any,
      deps().config,
      deps().webhooks,
      deps().adminAlerts,
      deps().analytics,
      deps().emailService,
      deps().merchantsService,
      deps().notificationPrefs,
      deps().stellar,
      settlementQueue as any,
      { run: jest.fn() } as unknown as CronJobService,
      mockRetryConfig as unknown as RetryConfigService,
    );

    analytics = deps().analytics;
    jest.restoreAllMocks();
  });

  it('should invalidate merchant analytics cache when settlement completes successfully', async () => {
    const payment = { id: 'p1', status: PaymentStatus.SETTLING } as Payment;
    const settlement = {
      id: 'settlement-1',
      merchantId: 'merchant-abc',
      payments: [payment],
      status: SettlementStatus.PROCESSING,
    } as Settlement;

    settlementsRepo.findOne.mockResolvedValue(settlement);
    (deps().config.get as jest.Mock).mockReturnValue('http://partner-api');

    const axios = require('axios');
    jest.mock('axios', () => ({
      post: jest.fn().mockResolvedValue({ data: { reference: 'ref-123' } }),
    }));

    await service.executeFiatTransfer(settlement);

    expect(analytics.clearCacheForMerchant).toHaveBeenCalledWith('merchant-abc');
  });

  it('should invalidate merchant analytics cache when partner callback succeeds', async () => {
    const payment = { id: 'p1', status: PaymentStatus.SETTLING } as Payment;
    const settlement = {
      id: 'settlement-1',
      merchantId: 'merchant-xyz',
      payments: [payment],
    } as Settlement;

    settlementsRepo.findOne.mockResolvedValue(settlement);

    await service.handlePartnerCallback({ reference: 'settlement-1', status: 'success' });

    expect(analytics.clearCacheForMerchant).toHaveBeenCalledWith('merchant-xyz');
  });

  it('should call clearCacheForMerchant with correct merchant ID only', async () => {
    const payment = { id: 'p1', status: PaymentStatus.SETTLING } as Payment;
    const settlement = {
      id: 'settlement-1',
      merchantId: 'merchant-123',
      payments: [payment],
    } as Settlement;

    settlementsRepo.findOne.mockResolvedValue(settlement);

    await service.handlePartnerCallback({ reference: 'settlement-1', status: 'success' });

    expect(analytics.clearCacheForMerchant).toHaveBeenCalledTimes(1);
    expect(analytics.clearCacheForMerchant).toHaveBeenCalledWith('merchant-123');
    // Verify it doesn't invalidate other merchants
    expect(analytics.clearCacheForMerchant).not.toHaveBeenCalledWith('merchant-456');
  });
});

jest.mock('axios', () => ({
  post: jest.fn(),
}));

describe('SettlementsService executeFiatTransfer', () => {
  let service: SettlementsService;
  let settlementsRepo: any;
  let paymentsRepo: any;
  let settlementQueue: any;
  let webhooks: WebhooksService;
  let adminAlerts: AdminAlertService;
  let emailService: EmailService;
  let merchantsService: MerchantsService;
  let notificationPrefs: NotificationPrefsService;
  let stellar: StellarService;
  let analytics: AnalyticsService;

  const deps = () => ({
    config: { get: jest.fn() } as unknown as ConfigService,
    webhooks: { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhooksService,
    adminAlerts: {
      raise: jest.fn().mockResolvedValue(null),
    } as unknown as AdminAlertService,
    analytics: { clearCacheForMerchant: jest.fn() } as unknown as AnalyticsService,
    emailService: { queue: jest.fn().mockResolvedValue(undefined) } as unknown as EmailService,
    merchantsService: { findOne: jest.fn().mockResolvedValue({ email: 'merchant@example.com' }) } as unknown as MerchantsService,
    notificationPrefs: { isEnabled: jest.fn().mockResolvedValue(false) } as unknown as NotificationPrefsService,
    stellar: {
      invokeContract: jest.fn().mockResolvedValue('mock-contract-hash'),
    } as unknown as StellarService,
  });

  beforeEach(() => {
    settlementsRepo = {
      create: jest.fn((input) => ({ id: 'settlement-1', ...input } as Settlement)),
      save: jest.fn(async (settlement: Settlement) => settlement),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
    };

    paymentsRepo = {
      save: jest.fn(async (payment: Payment) => payment),
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    settlementQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const d = deps();
    webhooks = d.webhooks;
    adminAlerts = d.adminAlerts;
    emailService = d.emailService;
    merchantsService = d.merchantsService;
    notificationPrefs = d.notificationPrefs;
    stellar = d.stellar;
    analytics = d.analytics;

    service = new SettlementsService(
      settlementsRepo as any,
      paymentsRepo as any,
      d.config,
      webhooks,
      adminAlerts,
      analytics,
      emailService,
      merchantsService,
      notificationPrefs,
      stellar,
      settlementQueue as any,
      { run: jest.fn() } as unknown as CronJobService,
      mockRetryConfig as unknown as RetryConfigService,
    );

    jest.restoreAllMocks();
  });

  it('marks settlement completed and updates all payments on successful transfer', async () => {
    const payment = { id: 'p1', amountUsd: 100, status: PaymentStatus.SETTLING } as Payment;
    const settlement = {
      id: 'settlement-1',
      merchantId: 'merchant-abc',
      payments: [payment],
      status: SettlementStatus.PROCESSING,
      netAmountUsd: 100,
    } as Settlement;

    settlementsRepo.findOne.mockResolvedValue(settlement);
    (deps().config.get as jest.Mock).mockReturnValue('http://partner-api');
    (axios.post as jest.Mock).mockResolvedValue({ data: { reference: 'partner-ref-123' } });

    await service.executeFiatTransfer(settlement);

    expect(settlement.status).toBe(SettlementStatus.COMPLETED);
    expect(settlement.partnerReference).toBe('partner-ref-123');
    expect(payment.status).toBe(PaymentStatus.SETTLED);
    expect(stellar.invokeContract).toHaveBeenCalledWith('settle', ['p1', 'settlement-1']);
    expect(analytics.clearCacheForMerchant).toHaveBeenCalledWith('merchant-abc');
    expect(webhooks.dispatch).toHaveBeenCalledWith('merchant-abc', 'payment.settled', {
      paymentId: 'p1',
      settlementId: 'settlement-1',
      amount: 100,
    });
  });

  it('marks settlement and payments failed on transfer error', async () => {
    const payment = { id: 'p1', amountUsd: 100, status: PaymentStatus.SETTLING } as Payment;
    const settlement = {
      id: 'settlement-1',
      merchantId: 'merchant-abc',
      payments: [payment],
      status: SettlementStatus.PROCESSING,
      netAmountUsd: 100,
    } as Settlement;

    settlementsRepo.findOne.mockResolvedValue(settlement);
    (deps().config.get as jest.Mock).mockReturnValue('http://partner-api');
    (axios.post as jest.Mock).mockRejectedValue(new Error('Partner timeout'));

    await service.executeFiatTransfer(settlement);

    expect(settlement.status).toBe(SettlementStatus.FAILED);
    expect(settlement.failureReason).toBe('Partner timeout');
    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(adminAlerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AdminAlertType.SETTLEMENT_FAILURE,
        dedupeKey: 'settlement:settlement-1',
      }),
    );
  });
});

describe('SettlementsService handlePartnerCallback', () => {
  let service: SettlementsService;
  let settlementsRepo: any;
  let paymentsRepo: any;
  let settlementQueue: any;
  let webhooks: WebhooksService;
  let stellar: StellarService;
  let analytics: AnalyticsService;

  const deps = () => ({
    config: { get: jest.fn() } as unknown as ConfigService,
    webhooks: { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhooksService,
    adminAlerts: {
      raise: jest.fn().mockResolvedValue(null),
    } as unknown as AdminAlertService,
    analytics: { clearCacheForMerchant: jest.fn() } as unknown as AnalyticsService,
    emailService: { queue: jest.fn().mockResolvedValue(undefined) } as unknown as EmailService,
    merchantsService: { findOne: jest.fn().mockResolvedValue({ email: 'merchant@example.com' }) } as unknown as MerchantsService,
    notificationPrefs: { isEnabled: jest.fn().mockResolvedValue(false) } as unknown as NotificationPrefsService,
    stellar: {
      invokeContract: jest.fn().mockResolvedValue('mock-contract-hash'),
    } as unknown as StellarService,
  });

  beforeEach(() => {
    settlementsRepo = {
      create: jest.fn((input) => ({ id: 'settlement-1', ...input } as Settlement)),
      save: jest.fn(async (settlement: Settlement) => settlement),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
    };

    paymentsRepo = {
      save: jest.fn(async (payment: Payment) => payment),
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    settlementQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const d = deps();
    webhooks = d.webhooks;
    stellar = d.stellar;
    analytics = d.analytics;

    service = new SettlementsService(
      settlementsRepo as any,
      paymentsRepo as any,
      d.config,
      webhooks,
      d.adminAlerts,
      analytics,
      d.emailService,
      d.merchantsService,
      d.notificationPrefs,
      stellar,
      settlementQueue as any,
      { run: jest.fn() } as unknown as CronJobService,
      mockRetryConfig as unknown as RetryConfigService,
    );

    jest.restoreAllMocks();
  });

  it('settles payments and invalidates analytics on successful callback', async () => {
    const payment = { id: 'p1', amountUsd: 100, status: PaymentStatus.SETTLING } as Payment;
    const settlement = {
      id: 'settlement-1',
      merchantId: 'merchant-xyz',
      payments: [payment],
      status: SettlementStatus.PROCESSING,
    } as Settlement;

    settlementsRepo.findOne.mockResolvedValue(settlement);

    await service.handlePartnerCallback({ reference: 'settlement-1', status: 'success' });

    expect(settlement.status).toBe(SettlementStatus.COMPLETED);
    expect(payment.status).toBe(PaymentStatus.SETTLED);
    expect(stellar.invokeContract).toHaveBeenCalledWith('settle', ['p1', 'settlement-1']);
    expect(analytics.clearCacheForMerchant).toHaveBeenCalledWith('merchant-xyz');
    expect(webhooks.dispatch).toHaveBeenCalledWith('merchant-xyz', 'payment.settled', {
      paymentId: 'p1',
      settlementId: 'settlement-1',
      amount: 100,
    });
  });

  it('ignores duplicate callback for already-completed settlement', async () => {
    const payment = { id: 'p1', amountUsd: 100, status: PaymentStatus.SETTLED } as Payment;
    const settlement = {
      id: 'settlement-1',
      merchantId: 'merchant-xyz',
      payments: [payment],
      status: SettlementStatus.COMPLETED,
    } as Settlement;

    settlementsRepo.findOne.mockResolvedValue(settlement);

    await service.handlePartnerCallback({ reference: 'settlement-1', status: 'success' });

    expect(stellar.invokeContract).not.toHaveBeenCalled();
    expect(webhooks.dispatch).not.toHaveBeenCalled();
    expect(analytics.clearCacheForMerchant).not.toHaveBeenCalled();
  });

  it('returns early for unknown settlement reference', async () => {
    settlementsRepo.findOne.mockResolvedValue(null);

    await service.handlePartnerCallback({ reference: 'unknown-settlement', status: 'success' });

    expect(settlementsRepo.save).not.toHaveBeenCalled();
  });

  it('marks settlement and payments failed on partner-reported failure', async () => {
    const payment = { id: 'p1', amountUsd: 100, status: PaymentStatus.SETTLING } as Payment;
    const settlement = {
      id: 'settlement-1',
      merchantId: 'merchant-xyz',
      payments: [payment],
      status: SettlementStatus.PROCESSING,
    } as Settlement;

    settlementsRepo.findOne.mockResolvedValue(settlement);

    await service.handlePartnerCallback({ reference: 'settlement-1', status: 'failed', failureReason: 'Bank declined' });

    expect(settlement.status).toBe(SettlementStatus.FAILED);
    expect(settlement.failureReason).toBe('Bank declined');
    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(webhooks.dispatch).toHaveBeenCalledWith('merchant-xyz', 'payment.failed', {
      paymentId: 'p1',
      reason: 'Bank declined',
    });
  });
});

describe('SettlementsService admin methods', () => {
  let service: SettlementsService;
  let settlementsRepo: any;
  let paymentsRepo: any;
  let settlementQueue: any;
  let webhooks: WebhooksService;
  let adminAlerts: AdminAlertService;
  let analytics: AnalyticsService;

  const deps = () => ({
    config: { get: jest.fn() } as unknown as ConfigService,
    webhooks: { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhooksService,
    adminAlerts: {
      raise: jest.fn().mockResolvedValue(null),
    } as unknown as AdminAlertService,
    analytics: { clearCacheForMerchant: jest.fn() } as unknown as AnalyticsService,
    emailService: { queue: jest.fn().mockResolvedValue(undefined) } as unknown as EmailService,
    merchantsService: { findOne: jest.fn().mockResolvedValue({ email: 'merchant@example.com' }) } as unknown as MerchantsService,
    notificationPrefs: { isEnabled: jest.fn().mockResolvedValue(false) } as unknown as NotificationPrefsService,
    stellar: {
      invokeContract: jest.fn().mockResolvedValue('mock-contract-hash'),
    } as unknown as StellarService,
  });

  beforeEach(() => {
    settlementsRepo = {
      create: jest.fn((input) => ({ id: 'settlement-1', ...input } as Settlement)),
      save: jest.fn(async (settlement: Settlement) => settlement),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
    };

    paymentsRepo = {
      save: jest.fn(async (payment: Payment) => payment),
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    settlementQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const d = deps();
    webhooks = d.webhooks;
    adminAlerts = d.adminAlerts;
    analytics = d.analytics;

    service = new SettlementsService(
      settlementsRepo as any,
      paymentsRepo as any,
      d.config,
      webhooks,
      adminAlerts,
      analytics,
      d.emailService,
      d.merchantsService,
      d.notificationPrefs,
      d.stellar,
      settlementQueue as any,
      { run: jest.fn() } as unknown as CronJobService,
      mockRetryConfig as unknown as RetryConfigService,
    );

    jest.restoreAllMocks();
  });

  describe('findAllAdmin', () => {
    it('returns paginated settlements with optional filters', async () => {
      const settlements = [
        { id: 's1', merchantId: 'm1', status: SettlementStatus.PROCESSING },
      ] as Settlement[];
      settlementsRepo.findAndCount.mockResolvedValue([settlements, 1]);

      const result = await service.findAllAdmin({ page: 1, limit: 20, status: SettlementStatus.PROCESSING });

      expect(result.data).toEqual(settlements);
      expect(result.total).toBe(1);
      expect(settlementsRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: SettlementStatus.PROCESSING }),
          relations: ['merchant', 'payments'],
          order: { createdAt: 'DESC' },
          skip: 0,
          take: 20,
        }),
      );
    });
  });

  describe('retrySettlement', () => {
    it('resets a failed settlement and enqueues for retry', async () => {
      const payment = { id: 'p1', status: PaymentStatus.FAILED } as Payment;
      const settlement = {
        id: 's1',
        status: SettlementStatus.FAILED,
        payments: [payment],
      } as Settlement;

      settlementsRepo.findOne.mockResolvedValue(settlement);

      const result = await service.retrySettlement('s1');

      expect(result.success).toBe(true);
      expect(settlement.status).toBe(SettlementStatus.PROCESSING);
      expect(settlement.failureReason).toBeNull();
      expect(payment.status).toBe(PaymentStatus.SETTLING);
      expect(settlementQueue.add).toHaveBeenCalledWith(
        'dispatch',
        { settlementId: 's1' },
        expect.objectContaining({ attempts: 4 }),
      );
    });

    it('rejects retry for non-failed settlement', async () => {
      const settlement = {
        id: 's1',
        status: SettlementStatus.PROCESSING,
        payments: [],
      } as Settlement;

      settlementsRepo.findOne.mockResolvedValue(settlement);

      const result = await service.retrySettlement('s1');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Only failed settlements can be retried');
    });

    it('returns failure for non-existent settlement', async () => {
      settlementsRepo.findOne.mockResolvedValue(null);

      const result = await service.retrySettlement('missing');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Settlement not found');
    });
  });

  describe('approveSettlement', () => {
    it('approves a pending-approval settlement with the provided admin identity', async () => {
      const payment = { id: 'p1', status: PaymentStatus.SETTLING } as Payment;
      const settlement = {
        id: 's1',
        status: SettlementStatus.PENDING_APPROVAL,
        requiresApproval: true,
        payments: [payment],
      } as Settlement;

      settlementsRepo.findOne.mockResolvedValue(settlement);

      const result = await service.approveSettlement('s1', 'admin-user-42');

      expect(result.success).toBe(true);
      expect(settlement.status).toBe(SettlementStatus.PROCESSING);
      expect(settlement.approvedBy).toBe('admin-user-42');
      expect(settlement.approvedAt).toBeInstanceOf(Date);
      expect(payment.status).toBe(PaymentStatus.SETTLING);
      expect(settlementQueue.add).toHaveBeenCalledWith(
        'dispatch',
        { settlementId: 's1' },
        expect.objectContaining({ attempts: 4 }),
      );
    });

    it('rejects approval for non-pending-approval settlement', async () => {
      const settlement = {
        id: 's1',
        status: SettlementStatus.PROCESSING,
        requiresApproval: true,
        payments: [],
      } as Settlement;

      settlementsRepo.findOne.mockResolvedValue(settlement);

      const result = await service.approveSettlement('s1', 'admin-user-42');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Only settlements pending approval can be approved');
    });

    it('rejects approval for settlement that does not require approval', async () => {
      const settlement = {
        id: 's1',
        status: SettlementStatus.PENDING_APPROVAL,
        requiresApproval: false,
        payments: [],
      } as Settlement;

      settlementsRepo.findOne.mockResolvedValue(settlement);

      const result = await service.approveSettlement('s1', 'admin-user-42');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Settlement does not require manual approval');
    });

    it('returns failure for non-existent settlement', async () => {
      settlementsRepo.findOne.mockResolvedValue(null);

      const result = await service.approveSettlement('missing', 'admin-user-42');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Settlement not found');
    });
  });
});
