import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';

export interface IngressEntry {
  /** Sandbox ID this subdomain belongs to. */
  sandboxId: string;
  /** TCP host the proxy must connect to. */
  upstreamHost: string;
  /** TCP port the proxy must connect to. */
  upstreamPort: number;
}

const REGISTRY_PREFIX = 'sandbox:ingress:';

/**
 * Persists subdomain → upstream mappings in Redis so any Operator
 * instance behind a load balancer can route requests for any sandbox.
 *
 * Keys are scoped by subdomain (the wildcard label) — for a request to
 * `<sub>.<wildcardDomain>`, the proxy reads `sandbox:ingress:<sub>`.
 */
@Injectable()
export class IngressRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(IngressRegistry.name);
  private readonly redis: Redis;

  constructor(@Inject(CONFIG) private readonly config: ModuleConfig) {
    this.redis = new Redis(config.redis.url);
    this.redis.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  private key(subdomain: string): string {
    return `${REGISTRY_PREFIX}${subdomain.toLowerCase()}`;
  }

  async publish(
    subdomain: string,
    entry: IngressEntry,
    ttlSeconds: number,
  ): Promise<void> {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    await this.redis.set(this.key(subdomain), JSON.stringify(entry), 'EX', ttl);
  }

  async lookup(subdomain: string): Promise<IngressEntry | null> {
    const raw = await this.redis.get(this.key(subdomain));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IngressEntry;
    } catch (err) {
      this.logger.warn(
        `Corrupt ingress entry for ${subdomain}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async unpublish(subdomain: string): Promise<void> {
    await this.redis.del(this.key(subdomain));
  }

  async extendTtl(subdomain: string, ttlSeconds: number): Promise<void> {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    await this.redis.expire(this.key(subdomain), ttl);
  }
}
