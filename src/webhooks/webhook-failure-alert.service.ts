import { Injectable, Logger } from "@nestjs/common";
import { Webhook } from "./entities/webhook.entity";

const ALERT_THRESHOLDS = [
  { count: 3, urgency: "warning" },
  { count: 7, urgency: "high" },
  { count: 10, urgency: "critical" },
] as const;

@Injectable()
export class WebhookFailureAlertService {
  private readonly logger = new Logger(WebhookFailureAlertService.name);

  async notifyIfNeeded(
    webhook: Webhook,
    merchantEmail: string,
    lastError: string,
    settingsUrl: string,
  ): Promise<void> {
    const threshold = ALERT_THRESHOLDS.find(
      (t) =>
        webhook.failureCount >= t.count && webhook.failureCount - 1 < t.count,
    );
    if (!threshold) return;

    this.logger.warn(
      `Webhook ${webhook.id} reached ${webhook.failureCount} consecutive failures (${threshold.urgency}).`,
    );

    await this.sendAlert(
      merchantEmail,
      threshold.urgency,
      webhook,
      lastError,
      settingsUrl,
    );
  }

  private async sendAlert(
    merchantEmail: string,
    urgency: string,
    webhook: Webhook,
    lastError: string,
    settingsUrl: string,
  ): Promise<void> {
    // Existing alert delivery implementation.
    this.logger.log(
      `Sending ${urgency} webhook failure alert to ${merchantEmail} for ${webhook.url}: ${lastError} (${settingsUrl})`,
    );
  }
}
