import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CONFIG } from '../config/config.loader';
import { HotPoolConfig, ModuleConfig } from '../config/config.types';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { SandboxesService } from '../sandboxes/sandboxes.service';
import { ResourceUsageService } from '../providers/resource-usage.service';
import { SandboxDocument, SandboxStatus } from '../schemas/sandbox.schema';
import { SnapshotStatus } from '../schemas/snapshot.schema';
import {
  HOT_POOL_SETTINGS_KEY,
  ModuleSettings,
  ModuleSettingsDocument,
} from '../schemas/module-settings.schema';
import { UpdateHotPoolDto } from './dto/update-hot-pool.dto';
import { ClaimHotDto } from './dto/claim-hot.dto';
import {
  HotPoolMetrics,
  HotPoolSandboxView,
  HotPoolStatus,
} from './hot-pool.types';

/**
 * Maintains a fleet of pre-restored sandboxes, ready to be claimed instantly.
 *
 * Lifecycle:
 *  1. On boot, merges YAML config with the persisted overrides (Mongo).
 *  2. A reconciliation loop computes the desired pool size from the configured
 *     memory reserve and provisions / removes hot sandboxes accordingly.
 *  3. `claim()` pops the oldest hot sandbox atomically, transfers ownership
 *     and triggers an immediate reconcile to refill the slot.
 */
@Injectable()
export class HotPoolService implements OnModuleInit {
  private readonly logger = new Logger(HotPoolService.name);

  /** Live, in-memory config (YAML defaults overridden by DB-persisted settings). */
  private liveConfig: HotPoolConfig;

  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconcileRunning = false;
  private lastReconcileAt: Date | null = null;
  private lastError: string | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: ModuleConfig,
    @InjectModel(ModuleSettings.name)
    private readonly settingsModel: Model<ModuleSettingsDocument>,
    private readonly sandboxRepo: SandboxRepository,
    private readonly snapshotRepo: SnapshotRepository,
    @Inject(forwardRef(() => SnapshotsService))
    private readonly snapshotsService: SnapshotsService,
    @Inject(forwardRef(() => SandboxesService))
    private readonly sandboxesService: SandboxesService,
    private readonly resourceUsage: ResourceUsageService,
  ) {
    this.liveConfig = this.cloneConfig(config.hotPool ?? { enabled: false });
  }

  async onModuleInit(): Promise<void> {
    await this.loadPersistedConfig();
    this.resourceUsage.registerHotAccountant({
      getReservedMemoryOverhead: () => this.getReservedMemoryOverhead(),
    });
    this.scheduleReconcile();
    this.logger.log(
      `Hot pool initialized — enabled=${this.liveConfig.enabled} ` +
        `snapshot=${this.liveConfig.snapshotId ?? 'none'}`,
    );
  }

  // ────────────────────────── public API ──────────────────────────

  getConfig(): HotPoolConfig {
    return this.cloneConfig(this.liveConfig);
  }

  /**
   * Replace the live config with the merged result of `current ⊕ patch` and
   * persist it. Triggers an immediate reconcile so the change is visible in
   * the metrics within milliseconds.
   */
  async updateConfig(patch: UpdateHotPoolDto): Promise<HotPoolConfig> {
    if (
      patch.minSize !== undefined &&
      patch.maxSize !== undefined &&
      patch.maxSize !== null &&
      patch.minSize > patch.maxSize
    ) {
      throw new BadRequestException('minSize cannot exceed maxSize');
    }

    // class-transformer materializes every optional field as `undefined` on
    // the DTO instance, which would clobber the live config on spread. Strip
    // explicit undefineds so the merge keeps existing values. An explicit
    // `null` means "clear this field" — fields that support it (e.g.
    // `maxSize`, `targetSize`) are removed from the merged config so their
    // fallback semantics kick back in.
    const sanitized: Partial<HotPoolConfig> = {};
    const cleared = new Set<string>();
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null) cleared.add(k);
      else (sanitized as any)[k] = v;
    }

    const merged: any = {
      ...this.liveConfig,
      ...sanitized,
    };
    for (const k of cleared) delete merged[k];
    const next: HotPoolConfig = merged;

    if (next.enabled && !next.snapshotId) {
      throw new BadRequestException(
        'Cannot enable hot pool without a snapshotId',
      );
    }
    if (next.snapshotId) {
      const snapshot = await this.snapshotRepo.findOne(
        { snapshotId: next.snapshotId } as any,
        {},
      );
      if (!snapshot) {
        throw new NotFoundException(
          `Snapshot ${next.snapshotId} not found`,
        );
      }
      if (snapshot.status !== SnapshotStatus.READY) {
        throw new BadRequestException(
          `Snapshot ${next.snapshotId} is not ready (status: ${snapshot.status})`,
        );
      }
    }

    this.liveConfig = next;
    await this.persistConfig();

    // If interval changed, reschedule.
    this.scheduleReconcile();
    // Run once now so the UI sees an immediate effect.
    void this.reconcile().catch((err) => {
      this.logger.warn(
        `Post-update reconcile failed: ${(err as Error).message}`,
      );
    });

    return this.cloneConfig(this.liveConfig);
  }

  async getStatus(): Promise<HotPoolStatus> {
    const metrics = await this.computeMetrics();
    const hotDocs = await this.sandboxRepo.findHotReserved(
      this.liveConfig.snapshotId,
    );
    const now = Date.now();
    const hotSandboxes: HotPoolSandboxView[] = hotDocs.map((d) => ({
      sandboxId: d.sandboxId,
      name: d.name,
      memoryMib: d.memoryMib,
      cpus: d.cpus,
      ageSeconds: Math.max(
        0,
        Math.floor((now - new Date((d as any).createdAt).getTime()) / 1000),
      ),
    }));

    let snapshotInfo: HotPoolStatus['snapshot'] = null;
    if (this.liveConfig.snapshotId) {
      const snap = await this.snapshotRepo.findOne(
        { snapshotId: this.liveConfig.snapshotId } as any,
        {},
      );
      if (snap) {
        snapshotInfo = { snapshotId: snap.snapshotId, name: snap.name };
      }
    }

    return {
      config: this.cloneConfig(this.liveConfig),
      effective: this.cloneConfig(this.liveConfig),
      metrics,
      snapshot: snapshotInfo,
      hotSandboxes,
      lastReconcileAt: this.lastReconcileAt
        ? this.lastReconcileAt.toISOString()
        : null,
      lastError: this.lastError,
    };
  }

  /**
   * Claim the oldest available hot sandbox for the configured snapshot,
   * transferring ownership. Triggers a refill in the background.
   * Throws BadRequest when no sandbox is available — caller is expected to
   * fall back to the regular create path.
   */
  async claim(dto: ClaimHotDto): Promise<SandboxDocument> {
    if (!this.liveConfig.enabled || !this.liveConfig.snapshotId) {
      throw new BadRequestException(
        'Hot pool is disabled or has no snapshot configured',
      );
    }
    const ttlSeconds =
      dto.ttlSeconds ?? this.config.defaults.defaultTtlSeconds;
    const claimed = await this.sandboxRepo.atomicClaimHot(
      this.liveConfig.snapshotId,
      {
        bindingId: dto.bindingId,
        ttlSeconds,
        maxTtlSeconds: this.config.defaults.maxTtlSeconds,
      },
    );

    if (!claimed) {
      throw new BadRequestException(
        'No hot sandbox available for the configured snapshot',
      );
    }

    this.logger.log(
      `Claimed hot sandbox ${claimed.sandboxId} (binding=${dto.bindingId ?? '-'})`,
    );

    // Fire-and-forget refill.
    void this.reconcile().catch((err) => {
      this.logger.warn(
        `Post-claim reconcile failed: ${(err as Error).message}`,
      );
    });

    return claimed;
  }

  /**
   * Compute the slice of memory currently set aside for the pool. Used by
   * ResourceUsageService to keep on-demand sandboxes from filling the
   * reserved capacity.
   */
  async getReservedMemoryOverhead(): Promise<number> {
    if (!this.liveConfig.enabled || !this.liveConfig.snapshotId) return 0;
    const target = this.computeTargetSize();
    const current = await this.sandboxRepo.countHotReserved(
      this.liveConfig.snapshotId,
    );
    const missingSlots = Math.max(0, target - current);
    const memPer = this.liveConfig.memoryMibPerSandbox ?? 0;
    return missingSlots * memPer;
  }

  /** Public hook so the controller can trigger a one-off reconcile. */
  async forceReconcile(): Promise<HotPoolStatus> {
    await this.reconcile();
    return this.getStatus();
  }

  // ────────────────────────── reconciliation ──────────────────────────

  private scheduleReconcile(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    const intervalMs = Math.max(
      2000,
      this.liveConfig.reconcileIntervalMs ?? 15000,
    );
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((err) => {
        this.logger.warn(
          `Scheduled reconcile failed: ${(err as Error).message}`,
        );
      });
    }, intervalMs);
  }

  private async reconcile(): Promise<void> {
    if (this.reconcileRunning) return;
    this.reconcileRunning = true;
    try {
      this.lastReconcileAt = new Date();
      this.lastError = null;

      // Always sweep failed/orphan hot pods first — these can leak from a
      // crashed provision or a snapshot change. They occupy DB rows (and,
      // for orphans, real memory) until they're reaped.
      await this.cleanupFailedHotSandboxes();
      if (this.liveConfig.enabled && this.liveConfig.snapshotId) {
        await this.cleanupOrphanHotSandboxes();
      }

      if (!this.liveConfig.enabled) {
        // Disabled → drain the pool down to zero.
        await this.drainPool('disabled');
        return;
      }

      if (!this.liveConfig.snapshotId) {
        this.logger.debug('Hot pool enabled but no snapshotId — skipping');
        return;
      }

      const target = this.computeTargetSize();
      const hotDocs = await this.sandboxRepo.findHotReserved(
        this.liveConfig.snapshotId,
      );
      const current = hotDocs.length;

      if (current > target) {
        const toRemove = current - target;
        this.logger.log(
          `Pool over-provisioned (current=${current}, target=${target}) — ` +
            `removing ${toRemove} hot sandbox(es)`,
        );
        // Remove the oldest first so claims always go to a freshly warmed pod.
        for (let i = 0; i < toRemove; i++) {
          const victim = hotDocs[i];
          await this.destroyHot(victim);
        }
        return;
      }

      if (current < target) {
        const toAdd = target - current;
        this.logger.log(
          `Pool under-provisioned (current=${current}, target=${target}) — ` +
            `provisioning ${toAdd} hot sandbox(es)`,
        );
        for (let i = 0; i < toAdd; i++) {
          await this.provisionOne();
        }
      }
    } catch (err) {
      this.lastError = (err as Error).message;
      this.logger.error(
        `Reconcile failed: ${this.lastError}`,
        (err as Error).stack,
      );
    } finally {
      this.reconcileRunning = false;
    }
  }

  /** When the pool is disabled, drain every hot pod regardless of snapshot. */
  private async drainPool(reason: string): Promise<void> {
    const all = await this.sandboxRepo.findHotReserved();
    for (const doc of all) {
      this.logger.log(`Draining hot sandbox ${doc.sandboxId} (${reason})`);
      await this.destroyHot(doc);
    }
  }

  /**
   * Reap hot pods whose `metadata.hotPoolSnapshotId` no longer matches the
   * configured snapshot — they would otherwise hold real memory invisibly
   * (the count() query filters by snapshot, so they aren't in `current`).
   */
  private async cleanupOrphanHotSandboxes(): Promise<void> {
    const all = await this.sandboxRepo.findHotReserved();
    const orphans = all.filter(
      (d) =>
        (d.metadata as any)?.hotPoolSnapshotId !==
        this.liveConfig.snapshotId,
    );
    for (const orphan of orphans) {
      this.logger.log(
        `Removing orphan hot sandbox ${orphan.sandboxId} ` +
          `(was=${(orphan.metadata as any)?.hotPoolSnapshotId ?? 'unknown'} ` +
          `now=${this.liveConfig.snapshotId})`,
      );
      await this.destroyHot(orphan);
    }
  }

  /**
   * Reap hot docs whose status drifted to `failed` (provisioning crashed
   * mid-flight). They don't count toward the live pool but pile up in the
   * DB if left untouched.
   */
  private async cleanupFailedHotSandboxes(): Promise<void> {
    const failed = await this.sandboxRepo.findFailedHotReserved();
    for (const doc of failed) {
      this.logger.warn(
        `Removing failed hot sandbox ${doc.sandboxId}`,
      );
      await this.destroyHot(doc);
    }
  }

  private computeTargetSize(): number {
    const cfg = this.liveConfig;
    const min = cfg.minSize ?? 0;
    // maxSize is an optional safety ceiling. When unset there is no upper
    // bound beyond what `memoryReservePercent` × `memoryMibPerSandbox` already
    // implies — that calculation is the real reserve cap.
    const cap = cfg.maxSize ?? Number.POSITIVE_INFINITY;

    // Explicit fixed size wins.
    if (cfg.targetSize !== undefined && cfg.targetSize !== null) {
      return Math.max(min, Math.min(cap, cfg.targetSize));
    }

    const limit = this.config.resourceLimits?.maxTotalMemoryMib;
    const memPer = cfg.memoryMibPerSandbox ?? 0;
    if (!limit || limit <= 0 || memPer <= 0) {
      // No total cap (or no per-sandbox sizing) → fall back to minSize.
      return Math.max(min, Math.min(cap, min));
    }

    const pct = cfg.memoryReservePercent ?? 0;
    const reserved = Math.floor((limit * pct) / 100);
    const slots = Math.floor(reserved / memPer);
    return Math.max(min, Math.min(cap, slots));
  }

  private async computeMetrics(): Promise<HotPoolMetrics> {
    const target = this.liveConfig.enabled ? this.computeTargetSize() : 0;
    const current = await this.sandboxRepo.countHotReserved(
      this.liveConfig.snapshotId,
    );
    const currentMemoryMib = await this.sandboxRepo.aggregateHotMemoryMib(
      this.liveConfig.snapshotId,
    );
    const memPer = this.liveConfig.memoryMibPerSandbox ?? 0;
    const targetMemoryMib = target * memPer;
    const totalLimit = this.config.resourceLimits?.maxTotalMemoryMib ?? null;
    const reservedPercent = this.liveConfig.memoryReservePercent ?? null;
    const reservedMib =
      totalLimit && reservedPercent !== null
        ? Math.floor((totalLimit * reservedPercent) / 100)
        : targetMemoryMib;

    return {
      current,
      currentMemoryMib,
      target,
      targetMemoryMib,
      reservedPercent,
      reservedMib,
      totalLimitMib: totalLimit,
    };
  }

  private async provisionOne(): Promise<void> {
    if (!this.liveConfig.snapshotId) return;
    try {
      const sandbox = await this.snapshotsService.provisionHotReserve(
        this.liveConfig.snapshotId,
        {
          cpus: this.liveConfig.cpus,
          memoryMib: this.liveConfig.memoryMibPerSandbox,
        },
      );
      this.logger.log(
        `Provisioned hot sandbox ${sandbox.sandboxId} ` +
          `(snapshot=${this.liveConfig.snapshotId}, mem=${sandbox.memoryMib}MiB)`,
      );
    } catch (err) {
      this.lastError = (err as Error).message;
      this.logger.error(
        `Failed to provision hot sandbox: ${this.lastError}`,
      );
    }
  }

  private async destroyHot(doc: SandboxDocument): Promise<void> {
    try {
      await this.sandboxesService.destroy(doc.sandboxId, {});
    } catch (err) {
      this.logger.warn(
        `Error destroying hot sandbox ${doc.sandboxId}: ${(err as Error).message}`,
      );
    }
  }

  // ────────────────────────── persistence ──────────────────────────

  private async loadPersistedConfig(): Promise<void> {
    try {
      const doc = await this.settingsModel
        .findOne({ key: HOT_POOL_SETTINGS_KEY })
        .lean()
        .exec();
      if (doc?.value) {
        // Drop null/undefined keys so YAML defaults survive when an older
        // persisted record has nulled-out fields.
        const sanitized: Partial<HotPoolConfig> = {};
        for (const [k, v] of Object.entries(doc.value)) {
          if (v !== null && v !== undefined) (sanitized as any)[k] = v;
        }
        this.liveConfig = {
          ...this.liveConfig,
          ...sanitized,
        };
        this.logger.log('Loaded persisted hot pool config');
      }
    } catch (err) {
      this.logger.warn(
        `Failed to load persisted hot pool config: ${(err as Error).message}`,
      );
    }
  }

  private async persistConfig(): Promise<void> {
    try {
      await this.settingsModel
        .findOneAndUpdate(
          { key: HOT_POOL_SETTINGS_KEY },
          { $set: { value: this.liveConfig } },
          { upsert: true, new: true },
        )
        .exec();
    } catch (err) {
      this.logger.error(
        `Failed to persist hot pool config: ${(err as Error).message}`,
      );
    }
  }

  private cloneConfig(c: HotPoolConfig): HotPoolConfig {
    return JSON.parse(JSON.stringify(c));
  }

  // For tests / shutdown.
  onApplicationShutdown(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }
}
