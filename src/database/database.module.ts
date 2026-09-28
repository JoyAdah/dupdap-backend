import { Module } from '@nestjs/common';
import { AdminAlertModule } from '../alerts/admin-alert.module';
import { PoolMonitorService } from './pool-monitor.service';

@Module({
  imports: [AdminAlertModule],
  providers: [PoolMonitorService],
})
export class DatabaseModule {}
