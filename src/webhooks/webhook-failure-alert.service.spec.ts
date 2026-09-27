import { Test, TestingModule } from '@nestjs/testing';
import { WebhookFailureAlertService } from './webhook-failure-alert.service';
import { Webhook, WebhookStatus } from './entities/webhook.entity';
import { NotificationsService } from '../notifications/notifications.service';

describe('WebhookFailureAlertService', () => {
  let service: WebhookFailureAlertService;
  let notificationsService: { sendAlert: jest.Mock };

  const buildWebhook = (failureCount: number): Webhook =>
    ({
      id: 'webhook-1',
      merchantId: 'merchant-1',
      url: 'https://example.com/webhook',
      status: WebhookStatus.ACTIVE,
      failureCount,
    } as unknown as Webhook);

  beforeEach(async () => {
    notificationsService = { sendAlert: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookFailureAlertService,
        { provide: NotificationsService, useValue: notificationsService },
      ],
    }).compile();

    service = module.get<WebhookFailureAlertService>(WebhookFailureAlertService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does not alert below the first threshold', async () => {
    await service.notifyIfNeeded(buildWebhook(2));

    expect(notificationsService.sendAlert).not.toHaveBeenCalled();
  });

  it('sends a warning alert when the count reaches 3', async () => {
    await service.notifyIfNeeded(buildWebhook(3));

    expect(notificationsService.sendAlert).toHaveBeenCalledTimes(1);
    expect(notificationsService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ urgency: 'warning' }),
    );
  });

  it('sends a high urgency alert when the count reaches 7', async () => {
    await service.notifyIfNeeded(buildWebhook(7));

    expect(notificationsService.sendAlert).toHaveBeenCalledTimes(1);
    expect(notificationsService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ urgency: 'high' }),
    );
  });

  it('sends a critical alert when the count reaches 10', async () => {
    await service.notifyIfNeeded(buildWebhook(10));

    expect(notificationsService.sendAlert).toHaveBeenCalledTimes(1);
    expect(notificationsService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ urgency: 'critical' }),
    );
  });

  it('still alerts when concurrent increments skip past a threshold (2 -> 3 -> 4)', async () => {
    await service.notifyIfNeeded(buildWebhook(4));

    expect(notificationsService.sendAlert).toHaveBeenCalledTimes(1);
    expect(notificationsService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ urgency: 'warning' }),
    );
  });

  it('still alerts when concurrent increments skip past the high threshold (6 -> 7 -> 8)', async () => {
    await service.notifyIfNeeded(buildWebhook(8));

    expect(notificationsService.sendAlert).toHaveBeenCalledTimes(1);
    expect(notificationsService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ urgency: 'high' }),
    );
  });

  it('still alerts when concurrent increments skip past the critical threshold (9 -> 10 -> 11)', async () => {
    await service.notifyIfNeeded(buildWebhook(11));

    expect(notificationsService.sendAlert).toHaveBeenCalledTimes(1);
    expect(notificationsService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ urgency: 'critical' }),
    );
  });
});
