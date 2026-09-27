import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { EmailLog, EmailStatus } from './entities/email-log.entity';
import { RetryConfigService } from '../retry/retry-config.service';

export const EMAIL_QUEUE = 'email-jobs';

export interface EmailJobPayload {
  logId: string;
  to: string;
  templateAlias: string;
  mergeData: Record<string, unknown>;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @InjectRepository(EmailLog)
    private readonly logRepo: Repository<EmailLog>,
    @InjectQueue(EMAIL_QUEUE)
    private readonly emailQueue: Queue<EmailJobPayload>,
    private readonly retryConfig: RetryConfigService,
  ) {}

  async queue(
    to: string,
    templateAlias: string,
    mergeData: Record<string, unknown>,
    userId?: string,
  ): Promise<EmailLog> {
    const log = await this.logRepo.save(
      this.logRepo.create({
        to,
        templateAlias,
        subject: (mergeData['subject'] as string | undefined) ?? templateAlias,
        status: EmailStatus.QUEUED,
        userId: userId ?? null,
      }),
    );

    const emailRetry = this.retryConfig.email;

    await this.emailQueue.add(
      { logId: log.id, to, templateAlias, mergeData },
      {
        attempts: emailRetry.maxAttempts + 1,
        backoff: { type: 'fixed', delay: emailRetry.delaysMs[0] ?? 30_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(`Queued email logId=${log.id} to=${to} template=${templateAlias}`);
    return log;
  }
}
