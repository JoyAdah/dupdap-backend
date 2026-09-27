import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Centralised queue/retry configuration.
 *
 * Env var names intentionally match the README's "Queues & retries" section
 * and `.env.example` so operators tuning retry behaviour get the effect they
 * expect. Hardcoded defaults are used when a var is unset.
 */
@Injectable()
export class QueueConfigService {
  constructor(private readonly configService: ConfigService) {}

  private parseCsvToMillis(value: string): number[] {
    return value
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);
  }

  get webhookRetrySchedule(): number[] {
    return this.parseCsvToMillis(
      this.configService.get<string>(
        "WEBHOOK_RETRY_DELAYS_MS",
        "60000,300000,1800000,7200000,43200000",
      ),
    );
  }

  get webhookMaxRetries(): number {
    return Number(this.configService.get<number>("WEBHOOK_RETRY_COUNT", 5));
  }

  get emailRetryDelay(): number {
    return Number(this.configService.get<number>("EMAIL_RETRY_DELAYS_MS", 300000));
  }

  get emailMaxRetries(): number {
    return Number(this.configService.get<number>("EMAIL_RETRY_COUNT", 1));
  }

  get settlementRetryDelays(): number[] {
    return this.parseCsvToMillis(
      this.configService.get<string>(
        "SETTLEMENT_RETRY_DELAYS_MS",
        "60000,300000,1800000",
      ),
    );
  }

  get settlementMaxRetries(): number {
    return Number(this.configService.get<number>("SETTLEMENT_RETRY_COUNT", 3));
  }

  get stellarMonitorRetryDelay(): number {
    return Number(this.configService.get<number>("STELLAR_MONITOR_RETRY_DELAYS_MS", 0));
  }

  get stellarMonitorMaxRetries(): number {
    return Number(this.configService.get<number>("STELLAR_MONITOR_RETRY_COUNT", 0));
  }
}
