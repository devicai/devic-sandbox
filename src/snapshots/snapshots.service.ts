import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { nanoid } from 'nanoid';
import { join } from 'path';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SandboxRegistry } from '../sandboxes/sandbox-registry';
import { SnapshotDocument, SnapshotStatus } from '../schemas/snapshot.schema';
import { SandboxDocument, SandboxStatus } from '../schemas/sandbox.schema';
import { ExtensionScope, PaginatedResponse } from '../interfaces';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';
import { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { RestoreSnapshotDto } from './dto/restore-snapshot.dto';
import { ResourceUsageService } from '../providers/resource-usage.service';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
  RuntimeSandbox,
} from '../runtime/runtime-provider.interface';

const SNAPSHOTS_DIR = join(homedir(), '.devic-sandbox', 'snapshots');

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    private readonly snapshotRepo: SnapshotRepository,
    private readonly sandboxRepo: SandboxRepository,
    private readonly registry: SandboxRegistry,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    private readonly resourceUsage: ResourceUsageService,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
  ) {
    if (!existsSync(SNAPSHOTS_DIR)) {
      mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
  }

  /**
   * Resolve a stored snapshotPath to its current location.
   *
   * Snapshots used to live in ~/.microsandbox/snapshots/. Once the runtime
   * abstraction landed they moved to ~/.devic-sandbox/snapshots/. To keep
   * existing instances functional we transparently fall back to the legacy
   * path when the new one is missing.
   */
  private resolveSnapshotPath(stored: string): string {
    if (existsSync(stored)) return stored;
    if (stored.includes('/.microsandbox/snapshots/')) {
      const migrated = stored.replace(
        '/.microsandbox/snapshots/',
        '/.devic-sandbox/snapshots/',
      );
      if (existsSync(migrated)) return migrated;
    }
    if (stored.includes('/.devic-sandbox/snapshots/')) {
      const legacy = stored.replace(
        '/.devic-sandbox/snapshots/',
        '/.microsandbox/snapshots/',
      );
      if (existsSync(legacy)) return legacy;
    }
    return stored;
  }

  async create(
    dto: CreateSnapshotDto,
    scope: ExtensionScope,
  ): Promise<SnapshotDocument> {
    const sandboxDoc = await this.findSandbox(dto.sandboxId, scope);
    if (sandboxDoc.status !== SandboxStatus.RUNNING) {
      throw new BadRequestException(
        `Sandbox is not running (status: ${sandboxDoc.status})`,
      );
    }

    await this.resourceUsage.assertDiskAvailable();

    const sandbox = await this.getSandboxInstance(sandboxDoc);
    const snapshotId = nanoid(12);
    const snapshotFileName = `${snapshotId}.tar.gz`;
    const snapshotPath = join(SNAPSHOTS_DIR, snapshotFileName);
    // Stage the tarball inside workdir: sysbox-runc presents /tmp as a
    // virtual mount that Docker's archive driver cannot read or write,
    // so getArchive/putArchive against /tmp/* fails with "no such file".
    // Workdir is created by Docker (WorkingDir) and is reachable.
    const guestTarPath = `${sandboxDoc.workdir}/.devic-runtime-snapshot-${snapshotId}.tar.gz`;

    const doc = await this.snapshotRepo.create(
      {
        snapshotId,
        sandboxId: sandboxDoc.sandboxId,
        name: dto.name || `snapshot-${snapshotId}`,
        description: dto.description || '',
        status: SnapshotStatus.CREATING,
        image: sandboxDoc.image,
        workdir: sandboxDoc.workdir,
        cpus: sandboxDoc.cpus,
        memoryMib: sandboxDoc.memoryMib,
        envVars: sandboxDoc.envVars ?? {},
        ports: sandboxDoc.ports ?? {},
        snapshotPath,
        sizeBytes: 0,
        metadata: {
          sourceSandboxName: sandboxDoc.name,
          currentCwd: sandboxDoc.currentCwd,
        },
      } as any,
      scope,
    );

    try {
      this.logger.log(
        `Creating snapshot ${snapshotId} from sandbox ${sandboxDoc.sandboxId}...`,
      );

      const tarResult = await sandbox.exec(
        `tar czf ${guestTarPath} --warning=no-file-changed --exclude='./.devic-runtime-*' -C ${sandboxDoc.workdir} .`,
      );

      // tar exits 1 when it emits warnings (e.g. directory mtime bumped while
      // we wrote the staged tarball into it). The archive itself is still
      // valid; only fatal errors (code >= 2) should abort the snapshot.
      if (tarResult.code >= 2) {
        throw new Error(`tar failed: ${tarResult.stderr}`);
      }

      await sandbox.copyToHost(guestTarPath, snapshotPath);
      await sandbox.exec(`rm -f ${guestTarPath}`);

      let sizeBytes = 0;
      try {
        sizeBytes = statSync(snapshotPath).size;
      } catch {}

      const updated = await this.snapshotRepo.updateById(
        (doc as any)._id.toString(),
        {
          $set: {
            status: SnapshotStatus.READY,
            sizeBytes,
          },
        },
        scope,
      );

      this.logger.log(
        `Snapshot ${snapshotId} created (${(sizeBytes / 1024).toFixed(1)} KB)`,
      );

      return updated!;
    } catch (err) {
      await this.snapshotRepo.updateById(
        (doc as any)._id.toString(),
        { $set: { status: SnapshotStatus.FAILED } },
        scope,
      );
      this.logger.error(
        `Snapshot ${snapshotId} failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async restore(
    snapshotId: string,
    dto: RestoreSnapshotDto,
    scope: ExtensionScope,
  ): Promise<SandboxDocument> {
    const snapshot = await this.findById(snapshotId, scope);
    if (snapshot.status !== SnapshotStatus.READY) {
      throw new BadRequestException(
        `Snapshot is not ready (status: ${snapshot.status})`,
      );
    }

    const onDiskPath = this.resolveSnapshotPath(snapshot.snapshotPath);
    if (!existsSync(onDiskPath)) {
      throw new BadRequestException('Snapshot file not found on disk');
    }

    const defaults = this.config.defaults;
    const sandboxId = nanoid(12);
    const containerName = `sandbox-${sandboxId}`;
    const ttlSeconds = dto.ttlSeconds ?? defaults.defaultTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const restoreMemoryMib = dto.memoryMib ?? snapshot.memoryMib;

    await this.resourceUsage.assertMemoryAvailable(restoreMemoryMib);

    const isLinked = dto.linked !== false; // default true

    const sandboxDoc = await this.sandboxRepo.create(
      {
        sandboxId,
        name: containerName,
        status: SandboxStatus.CREATING,
        image: snapshot.image,
        workdir: snapshot.workdir,
        currentCwd: snapshot.metadata?.currentCwd ?? snapshot.workdir,
        cpus: dto.cpus ?? snapshot.cpus,
        memoryMib: dto.memoryMib ?? snapshot.memoryMib,
        envVars: snapshot.envVars ?? {},
        ports: snapshot.ports ?? {},
        ttlSeconds,
        expiresAt,
        ...(isLinked ? { snapshotId: snapshot.snapshotId } : {}),
        commandCount: 0,
        recentCommands: [],
        metadata: {
          restoredFrom: snapshot.snapshotId,
          restoredAt: new Date().toISOString(),
          linked: isLinked,
        },
      } as any,
      scope,
    );

    try {
      const sandbox = await this.runtime.create({
        name: containerName,
        image: snapshot.image,
        workdir: snapshot.workdir,
        cpus: dto.cpus ?? snapshot.cpus,
        memoryMib: dto.memoryMib ?? snapshot.memoryMib,
        env: snapshot.envVars ?? {},
        ports: snapshot.ports ?? {},
        networkPolicy: 'allow-all',
      });
      await this.registry.register(sandboxId, containerName, ttlSeconds);

      // Stage inside workdir; /tmp is unreachable via Docker archive APIs
      // when sysbox-runc is the runtime (see snapshot create for context).
      const guestTarPath = `${snapshot.workdir}/.devic-runtime-restore-${sandboxId}.tar.gz`;
      await sandbox.copyFromHost(onDiskPath, guestTarPath);

      const extractResult = await sandbox.exec(
        `tar xzf ${guestTarPath} -C ${snapshot.workdir} && rm -f ${guestTarPath}`,
      );

      if (extractResult.code !== 0) {
        this.logger.warn(
          `Snapshot restore extraction warning: ${extractResult.stderr}`,
        );
      }

      await this.sandboxRepo.updateById(
        (sandboxDoc as any)._id.toString(),
        { $set: { status: SandboxStatus.RUNNING } },
        scope,
      );

      this.logger.log(
        `Sandbox ${sandboxId} restored from snapshot ${snapshotId}`,
      );

      const updated = await this.sandboxRepo.findById(
        (sandboxDoc as any)._id.toString(),
        scope,
      );
      return updated!;
    } catch (err) {
      await this.sandboxRepo.updateById(
        (sandboxDoc as any)._id.toString(),
        { $set: { status: SandboxStatus.FAILED } },
        scope,
      );
      throw err;
    }
  }

  async findAll(
    scope: ExtensionScope,
    options?: { limit?: number; offset?: number; sandboxId?: string },
  ): Promise<PaginatedResponse<SnapshotDocument>> {
    const filter: Record<string, any> = {};
    if (options?.sandboxId) filter.sandboxId = options.sandboxId;
    return this.snapshotRepo.find(filter, scope, options);
  }

  async findById(
    id: string,
    scope: ExtensionScope,
  ): Promise<SnapshotDocument> {
    const doc =
      (await this.snapshotRepo.findOne({ snapshotId: id } as any, scope)) ??
      (await this.snapshotRepo.findById(id, scope));
    if (!doc) throw new NotFoundException(`Snapshot ${id} not found`);
    return doc;
  }

  async destroy(id: string, scope: ExtensionScope): Promise<void> {
    const doc = await this.findById(id, scope);

    const onDiskPath = this.resolveSnapshotPath(doc.snapshotPath);
    try {
      if (existsSync(onDiskPath)) {
        unlinkSync(onDiskPath);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to delete snapshot file ${onDiskPath}: ${(err as Error).message}`,
      );
    }

    await this.snapshotRepo.deleteById((doc as any)._id.toString(), scope);
    this.logger.log(`Snapshot ${doc.snapshotId} destroyed`);
  }

  /**
   * Persist the current sandbox filesystem state back to its linked snapshot.
   * Called automatically when a snapshot-linked sandbox is stopped or expires.
   */
  async persistToSnapshot(sandboxDoc: SandboxDocument): Promise<void> {
    if (!sandboxDoc.snapshotId) return;

    let snapshotDoc: SnapshotDocument | null;
    try {
      snapshotDoc = await this.snapshotRepo.findOne(
        { snapshotId: sandboxDoc.snapshotId } as any,
        {},
      );
    } catch {
      snapshotDoc = null;
    }

    if (!snapshotDoc || snapshotDoc.status !== SnapshotStatus.READY) {
      this.logger.warn(
        `Snapshot ${sandboxDoc.snapshotId} not found or not ready, skipping persist`,
      );
      return;
    }

    const guestTarPath = `${sandboxDoc.workdir}/.devic-runtime-persist-${sandboxDoc.sandboxId}.tar.gz`;

    try {
      this.logger.log(
        `Persisting sandbox ${sandboxDoc.sandboxId} to snapshot ${snapshotDoc.snapshotId}...`,
      );

      const containerName =
        (await this.registry.get(sandboxDoc.sandboxId)) ?? sandboxDoc.name;
      const handle = await this.runtime.get(containerName);
      if (!handle || handle.status !== 'running') {
        this.logger.warn(
          `Sandbox ${sandboxDoc.sandboxId} not running (status: ${handle?.status ?? 'missing'}), skipping persist`,
        );
        return;
      }
      const sandbox = await handle.connect();

      const tarResult = await sandbox.exec(
        `tar czf ${guestTarPath} --warning=no-file-changed --exclude='./.devic-runtime-*' -C ${sandboxDoc.workdir} .`,
      );

      if (tarResult.code >= 2) {
        this.logger.error(`Persist tar failed: ${tarResult.stderr}`);
        return;
      }

      // Always write to the canonical (current) location even if the snapshot
      // was originally created under the legacy path.
      const targetPath = snapshotDoc.snapshotPath.includes('/.microsandbox/snapshots/')
        ? snapshotDoc.snapshotPath.replace(
            '/.microsandbox/snapshots/',
            '/.devic-sandbox/snapshots/',
          )
        : snapshotDoc.snapshotPath;

      if (targetPath !== snapshotDoc.snapshotPath && !existsSync(SNAPSHOTS_DIR)) {
        mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      }

      await sandbox.copyToHost(guestTarPath, targetPath);
      await sandbox.exec(`rm -f ${guestTarPath}`);

      // If we migrated the path, drop the legacy file to avoid drift.
      if (
        targetPath !== snapshotDoc.snapshotPath &&
        existsSync(snapshotDoc.snapshotPath)
      ) {
        try {
          unlinkSync(snapshotDoc.snapshotPath);
        } catch {}
      }

      let sizeBytes = 0;
      try {
        sizeBytes = statSync(targetPath).size;
      } catch {}

      await this.snapshotRepo.updateById(
        (snapshotDoc as any)._id.toString(),
        {
          $set: {
            sizeBytes,
            snapshotPath: targetPath,
            'metadata.lastPersistedFrom': sandboxDoc.sandboxId,
            'metadata.lastPersistedAt': new Date().toISOString(),
            'metadata.currentCwd': sandboxDoc.currentCwd,
          },
        },
        {},
      );

      this.logger.log(
        `Snapshot ${snapshotDoc.snapshotId} updated from sandbox ${sandboxDoc.sandboxId} (${(sizeBytes / 1024).toFixed(1)} KB)`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist snapshot ${snapshotDoc.snapshotId}: ${(err as Error).message}`,
      );
    }
  }

  private async findSandbox(
    id: string,
    scope: ExtensionScope,
  ): Promise<SandboxDocument> {
    const doc =
      (await this.sandboxRepo.findOne({ sandboxId: id } as any, scope)) ??
      (await this.sandboxRepo.findById(id, scope));
    if (!doc) throw new NotFoundException(`Sandbox ${id} not found`);
    return doc;
  }

  private async getSandboxInstance(doc: SandboxDocument): Promise<RuntimeSandbox> {
    const containerName = await this.registry.get(doc.sandboxId);
    const name = containerName ?? doc.name;

    const handle = await this.runtime.get(name);
    if (!handle) {
      throw new BadRequestException(
        `Sandbox ${doc.sandboxId} is not reachable: not found`,
      );
    }

    try {
      if (handle.status === 'running') return handle.connect();
      return handle.start();
    } catch (err) {
      throw new BadRequestException(
        `Sandbox ${doc.sandboxId} is not reachable: ${(err as Error).message}`,
      );
    }
  }
}

