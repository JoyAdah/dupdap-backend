import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { PoolMonitorService } from './pool-monitor.service';
import { AdminAlertService } from '../alerts/admin-alert.service';
import { AdminAlertType } from '../alerts/admin-alert.entity';
import { DataSource } from 'typeorm';

describe('PoolMonitorService', () => {
  let alertService: { raise: jest.Mock };

  const makePool = (total: number, idle: number, waiting: number) => ({
    totalCount: total,
    idleCount: idle,
    waitingCount: waiting,
  });

  const makeDataSource = (pool: ReturnType<typeof makePool>) => ({
    driver: { master: pool },
  }) as unknown as DataSource;

  beforeEach(() => {
    alertService = { raise: jest.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  async function compileModule(pool: ReturnType<typeof makePool>) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PoolMonitorService,
        { provide: getDataSourceToken(), useValue: makeDataSource(pool) },
        { provide: AdminAlertService, useValue: alertService },
      ],
    }).compile();

    return module.get<PoolMonitorService>(PoolMonitorService);
  }

  describe('checkPool', () => {
    it('does not raise an alert when no connections are waiting', async () => {
      const svc = await compileModule(makePool(10, 5, 0));
      const checkPool = (svc as any).checkPool.bind(svc);
      await checkPool();

      expect(alertService.raise).not.toHaveBeenCalled();
    });

    it('raises a DB_POOL_EXHAUSTED alert when connections are waiting', async () => {
      const svc = await compileModule(makePool(10, 3, 4));
      const checkPool = (svc as any).checkPool.bind(svc);
      await checkPool();

      expect(alertService.raise).toHaveBeenCalledTimes(1);
      expect(alertService.raise).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AdminAlertType.DB_POOL_EXHAUSTED,
          dedupeKey: 'db-pool-exhausted',
          thresholdValue: 1,
          metadata: { total: 10, active: 7, idle: 3, waiting: 4 },
        }),
      );
    });

    it('logs a warning when the pool is exhausted', async () => {
      const svc = await compileModule(makePool(10, 3, 4));
      const checkPool = (svc as any).checkPool.bind(svc);

      const loggerWarn = jest.spyOn(
        (svc as any).logger,
        'warn',
      );
      await checkPool();

      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('[DB Pool] Pool exhausted'),
      );
    });

    it('does not raise an alert when the pool driver is unavailable', async () => {
      const ds = { driver: null } as unknown as DataSource;
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PoolMonitorService,
          { provide: getDataSourceToken(), useValue: ds },
          { provide: AdminAlertService, useValue: alertService },
        ],
      }).compile();

      const svc = module.get<PoolMonitorService>(PoolMonitorService);
      const checkPool = (svc as any).checkPool.bind(svc);
      await checkPool();

      expect(alertService.raise).not.toHaveBeenCalled();
    });
  });
});
