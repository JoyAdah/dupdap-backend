import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminAlertService } from '../alerts/admin-alert.service';
import { AdminAlertType } from '../alerts/admin-alert.entity';

/**
 * Monitors the TypeORM connection pool and logs a warning when the pool
 * is exhausted (all connections in use). Runs a periodic check every 30s.
 * Also raises an admin alert so the operations team is paged.
 */
@Injectable()
export class PoolMonitorService implements OnModuleInit {
  private readonly logger = new Logger(PoolMonitorService.name);
  private intervalRef: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly alertService: AdminAlertService,
  ) {}

  onModuleInit() {
    this.intervalRef = setInterval(() => this.checkPool(), 30_000);
  }

  onModuleDestroy() {
    if (this.intervalRef) clearInterval(this.intervalRef);
  }

  private async checkPool() {
    // TypeORM uses `pg` driver; the underlying pool is accessible via driver
    const pool = (this.dataSource.driver as any)?.master;
    if (!pool) return;

    const total: number = pool.totalCount ?? 0;
    const idle: number = pool.idleCount ?? 0;
    const waiting: number = pool.waitingCount ?? 0;
    const active = total - idle;

    if (waiting > 0) {
      this.logger.warn(
        `[DB Pool] Pool exhausted — total=${total} active=${active} idle=${idle} waiting=${waiting}`,
      );
      await this.alertService.raise({
        type: AdminAlertType.DB_POOL_EXHAUSTED,
        dedupeKey: 'db-pool-exhausted',
        message: `[DB Pool] Pool exhausted — total=${total} active=${active} idle=${idle} waiting=${waiting}`,
        metadata: { total, active, idle, waiting },
        thresholdValue: 1,
      });
    }
  }
}
