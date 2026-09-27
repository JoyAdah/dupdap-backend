import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RuntimeConfig } from './runtime-config.entity';
import { CacheService } from '../cache/cache.service';

@Injectable()
export class RuntimeConfigService {
  private readonly logger = new Logger(RuntimeConfigService.name);
  private readonly CACHE_PREFIX = 'runtime-config:';
  private readonly CACHE_TTL_SECONDS = 300;

  constructor(
    @InjectRepository(RuntimeConfig)
    private readonly configRepo: Repository<RuntimeConfig>,
    @Optional() private readonly cacheService?: CacheService,
  ) {}

  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    const cacheKey = `${this.CACHE_PREFIX}${key}`;

    // 1. Try Redis
    if (this.cacheService) {
      const cached = await this.cacheService.get<T>(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    // 2. Try DB
    const config = await this.configRepo.findOne({ where: { key } });
    if (!config) {
      return defaultValue;
    }

    const value = this.parseValue<T>(config.value, config.type);

    // 3. Populate cache for subsequent reads
    if (this.cacheService) {
      await this.cacheService.set(cacheKey, value, { ttlSeconds: this.CACHE_TTL_SECONDS });
    }

    return value;
  }

  async set<T>(key: string, value: T, type?: string): Promise<RuntimeConfig> {
    const serialized = this.serializeValue(value);
    let config = await this.configRepo.findOne({ where: { key } });

    if (config) {
      config.value = serialized;
      if (type) config.type = type;
    } else {
      config = this.configRepo.create({ key, value: serialized, type: type ?? 'string' });
    }

    const saved = await this.configRepo.save(config);
    await this.invalidate(key);
    return saved;
  }

  async invalidate(key: string): Promise<void> {
    if (this.cacheService) {
      await this.cacheService.del(`${this.CACHE_PREFIX}${key}`);
    }
  }

  async getAll(): Promise<RuntimeConfig[]> {
    return this.configRepo.find();
  }

  private parseValue<T>(raw: string, type: string): T {
    switch (type) {
      case 'number':
        return Number(raw) as unknown as T;
      case 'boolean':
        return (raw === 'true') as unknown as T;
      case 'json':
        try {
          return JSON.parse(raw) as T;
        } catch {
          this.logger.warn(`Failed to parse JSON runtime config value: ${raw}`);
          return undefined as unknown as T;
        }
      default:
        return raw as unknown as T;
    }
  }

  private serializeValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return String(value);
  }
}
