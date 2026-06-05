import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { nanoid } from 'nanoid';
import { join } from 'path';
import {
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  createReadStream,
  createWriteStream,
} from 'fs';
import { homedir } from 'os';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SandboxRegistry } from '../sandboxes/sandbox-registry';
import { SnapshotDocument, SnapshotStatus } from '../schemas/snapshot.schema';
import { SandboxDocument, SandboxStatus } from '../schemas/sandbox.schema';
import { ExtensionScope, PaginatedResponse } from '../interfaces';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';
import { CreateSnapshotDto, SnapshotScope } from './dto/create-snapshot.dto';
import { RestoreSnapshotDto } from './dto/restore-snapshot.dto';
import { ResourceUsageService } from '../providers/resource-usage.service';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
  RuntimeSandbox,
} from '../runtime/runtime-provider.interface';
import {
  buildExcludeMatcher,
  partitionChanges,
  isSafeDeletePath,
  sh,
} from './snapshot-fs.util';

const SNAPSHOTS_DIR = join(homedir(), '.devic-sandbox', 'snapshots');

/** zstd compression level for full-snapshot artifacts (disk-priority). */
const ZSTD_LEVEL = 19;
/** gzip level used when zstd is unavailable. */
const GZIP_LEVEL = 9;
/**
 * Upper bound on how many delete paths we persist in the snapshot doc. Deletes
 * of base-image files are rare; this guards the 16 MB Mongo doc limit. When
 * exceeded we keep the first N and log — restore replays what it has.
 */
const MAX_PERSISTED_DELETES = 20000;

type Codec = 'zstd' | 'gzip';

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

  /**
   * Pick the compression codec for full snapshots. The codec also decides WHERE
   * compression runs:
   *   - 'gzip' (default): streamed INSIDE the sandbox (`tar | gzip`), so the CPU
   *     is charged to the tenant's cpu quota, nothing is staged uncompressed,
   *     and restore only needs the universally-present gzip. Scales well on a
   *     shared host.
   *   - 'zstd' (opt-in): the sandbox emits a plain tar and the HOST compresses
   *     it with Node's zlib. Smaller artifacts, but the CPU runs unmetered on
   *     the shared host with a transient uncompressed staging file. Restore
   *     decompresses host-side too, so the base image never needs zstd.
   * 'auto' resolves to gzip (the safe default for a multitenant host).
   */
  private resolveCodec(): Codec {
    const want = this.config.snapshots?.compression ?? 'auto';
    if (want !== 'zstd') return 'gzip';
    const hasZstd = typeof (zlib as any).createZstdCompress === 'function';
    if (!hasZstd) {
      this.logger.warn(
        'snapshots.compression=zstd but this Node build has no zstd support; falling back to gzip',
      );
      return 'gzip';
    }
    return 'zstd';
  }

  private extFor(scope: SnapshotScope, codec: Codec): string {
    if (scope === 'workdir') return 'tar.gz';
    return codec === 'zstd' ? 'tar.zst' : 'tar.gz';
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

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
    const captureScope: SnapshotScope =
      dto.scope ?? this.config.snapshots?.defaultScope ?? 'full';
    const codec: Codec = captureScope === 'full' ? this.resolveCodec() : 'gzip';

    const snapshotId = nanoid(12);
    const snapshotFileName = `${snapshotId}.${this.extFor(captureScope, codec)}`;
    const snapshotPath = join(SNAPSHOTS_DIR, snapshotFileName);

    const doc = await this.snapshotRepo.create(
      {
        snapshotId,
        sandboxId: sandboxDoc.sandboxId,
        name: dto.name || `snapshot-${snapshotId}`,
        description: dto.description || '',
        status: SnapshotStatus.CREATING,
        image: sandboxDoc.image,
        workdir: sandboxDoc.workdir,
        scope: captureScope,
        compression: codec,
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
        `Creating ${captureScope} snapshot ${snapshotId} from sandbox ${sandboxDoc.sandboxId}...`,
      );

      let deletes: string[] = [];
      let captureMeta: Record<string, any> = {};

      if (captureScope === 'full') {
        const result = await this.captureFullToHost(
          sandbox,
          sandboxDoc.workdir,
          snapshotId,
          codec,
          snapshotPath,
        );
        deletes = result.deletes;
        captureMeta = result.stats;
      } else {
        await this.captureWorkdirToHost(
          sandbox,
          sandboxDoc.workdir,
          snapshotId,
          snapshotPath,
        );
      }

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
            ...(captureScope === 'full'
              ? {
                  'metadata.deletes': this.capDeletes(deletes),
                  'metadata.fullCapture': captureMeta,
                }
              : {}),
          },
        },
        scope,
      );

      this.logger.log(
        `Snapshot ${snapshotId} (${captureScope}/${codec}) created (${(sizeBytes / 1024).toFixed(1)} KB)`,
      );

      return updated!;
    } catch (err) {
      await this.snapshotRepo.updateById(
        (doc as any)._id.toString(),
        { $set: { status: SnapshotStatus.FAILED } },
        scope,
      );
      // Best-effort cleanup of a partially written artifact.
      try {
        if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
      } catch {}
      this.logger.error(
        `Snapshot ${snapshotId} failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Restore
  // ---------------------------------------------------------------------------

  async restore(
    snapshotId: string,
    dto: RestoreSnapshotDto,
    scope: ExtensionScope,
  ): Promise<SandboxDocument> {
    return this.restoreInternal(snapshotId, dto, scope, {
      skipMemoryCheck: false,
      hotReserved: false,
    });
  }

  /**
   * Provision a hot-reserve sandbox from a snapshot, bypassing the standard
   * memory check (the hot pool service already accounts for the slice it owns).
   * The sandbox is marked `hotReserved=true` and gets a far-future expiresAt
   * so the TTL service ignores it. Snapshot link is intentionally dropped —
   * a hot sandbox that is later claimed must not auto-persist back to the
   * pool's source snapshot.
   */
  async provisionHotReserve(
    snapshotId: string,
    overrides: { cpus?: number; memoryMib?: number },
  ): Promise<SandboxDocument> {
    return this.restoreInternal(
      snapshotId,
      {
        cpus: overrides.cpus,
        memoryMib: overrides.memoryMib,
        ttlSeconds: 60 * 60 * 24 * 365, // 1 year — effectively "no TTL"
        linked: false,
      },
      {},
      {
        skipMemoryCheck: true,
        hotReserved: true,
      },
    );
  }

  private async restoreInternal(
    snapshotId: string,
    dto: RestoreSnapshotDto,
    scope: ExtensionScope,
    options: { skipMemoryCheck: boolean; hotReserved: boolean },
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

    // Documents created before scoped snapshots existed have no `scope` field;
    // they are workdir-only tarballs, so default reads to 'workdir'.
    const restoreScope: SnapshotScope =
      (snapshot.scope as SnapshotScope) ?? 'workdir';
    const codec: Codec = (snapshot.compression as Codec) ?? 'gzip';

    const defaults = this.config.defaults;
    const sandboxId = nanoid(12);
    const containerName = `sandbox-${sandboxId}`;
    const ttlSeconds = dto.ttlSeconds ?? defaults.defaultTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const restoreMemoryMib = dto.memoryMib ?? snapshot.memoryMib;

    if (!options.skipMemoryCheck) {
      await this.resourceUsage.assertMemoryAvailable(restoreMemoryMib);
    }

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
        hotReserved: options.hotReserved,
        commandCount: 0,
        recentCommands: [],
        metadata: {
          restoredFrom: snapshot.snapshotId,
          restoredAt: new Date().toISOString(),
          linked: isLinked,
          ...(options.hotReserved
            ? { hotPool: true, hotPoolSnapshotId: snapshot.snapshotId }
            : {}),
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

      if (restoreScope === 'full') {
        await this.restoreFull(
          sandbox,
          snapshot.workdir,
          sandboxId,
          onDiskPath,
          codec,
          (snapshot.metadata?.deletes as string[]) ?? [],
        );
      } else {
        await this.restoreWorkdir(
          sandbox,
          snapshot.workdir,
          sandboxId,
          onDiskPath,
        );
      }

      await this.sandboxRepo.updateById(
        (sandboxDoc as any)._id.toString(),
        { $set: { status: SandboxStatus.RUNNING } },
        scope,
      );

      this.logger.log(
        `Sandbox ${sandboxId} restored from ${restoreScope} snapshot ${snapshotId}`,
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
   * Re-captures with the same scope/codec the snapshot was created with.
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

    const persistScope: SnapshotScope =
      (snapshotDoc.scope as SnapshotScope) ?? 'workdir';
    const codec: Codec = (snapshotDoc.compression as Codec) ?? 'gzip';

    try {
      this.logger.log(
        `Persisting sandbox ${sandboxDoc.sandboxId} to ${persistScope} snapshot ${snapshotDoc.snapshotId}...`,
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

      // Always write to the canonical (current) location even if the snapshot
      // was originally created under the legacy path.
      const targetPath = snapshotDoc.snapshotPath.includes(
        '/.microsandbox/snapshots/',
      )
        ? snapshotDoc.snapshotPath.replace(
            '/.microsandbox/snapshots/',
            '/.devic-sandbox/snapshots/',
          )
        : snapshotDoc.snapshotPath;

      if (targetPath !== snapshotDoc.snapshotPath && !existsSync(SNAPSHOTS_DIR)) {
        mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      }

      let deletes: string[] = [];
      let captureMeta: Record<string, any> = {};

      if (persistScope === 'full') {
        const result = await this.captureFullToHost(
          sandbox,
          sandboxDoc.workdir,
          sandboxDoc.sandboxId,
          codec,
          targetPath,
        );
        deletes = result.deletes;
        captureMeta = result.stats;
      } else {
        await this.captureWorkdirToHost(
          sandbox,
          sandboxDoc.workdir,
          sandboxDoc.sandboxId,
          targetPath,
        );
      }

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
            ...(persistScope === 'full'
              ? {
                  'metadata.deletes': this.capDeletes(deletes),
                  'metadata.fullCapture': captureMeta,
                }
              : {}),
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

  // ---------------------------------------------------------------------------
  // Capture / restore implementations
  // ---------------------------------------------------------------------------

  /**
   * Workdir-only capture (legacy behaviour). Lightweight tar.gz of the working
   * directory, produced inside the sandbox. Kept byte-for-byte compatible with
   * pre-existing snapshots.
   */
  private async captureWorkdirToHost(
    sandbox: RuntimeSandbox,
    workdir: string,
    id: string,
    hostPath: string,
  ): Promise<void> {
    const guestTarPath = `${workdir}/.devic-runtime-snapshot-${id}.tar.gz`;

    // No `--warning=no-file-changed`: that flag is GNU-only and busybox tar
    // (alpine et al.) treats it as an unrecognized option, prints usage to
    // stderr and silently produces no archive. GNU tar emits the mtime-changed
    // warning to stderr instead, which is harmless; the code-1 exit it triggers
    // is tolerated below.
    const tarResult = await sandbox.exec(
      `tar czf ${guestTarPath} --exclude='./.devic-runtime-*' -C ${workdir} . && [ -s ${guestTarPath} ]`,
    );

    if (tarResult.code >= 2) {
      throw new Error(
        `Snapshot archive not produced (tar code=${tarResult.code}): ${tarResult.stderr || tarResult.stdout}`,
      );
    }

    await sandbox.copyToHost(guestTarPath, hostPath);
    await sandbox.exec(`rm -f ${guestTarPath}`);
  }

  /**
   * Build the shell that tars the listed paths to `outputArgs` (e.g. `-cf -` to
   * stream, or `-cf "$RAW"` to a file), capturing tar's real exit code into
   * `rcPath` even when it runs inside a pipe. GNU tar uses `--no-recursion` so
   * directory members keep their metadata without pulling unchanged children;
   * busybox/alpine tar (no `--no-recursion`) gets a pre-filtered list with real
   * directories dropped (parents are recreated on extract).
   */
  private tarEmitBlock(
    listPath: string,
    filesPath: string,
    rcPath: string,
    outputArgs: string,
  ): string {
    return [
      `if tar --version 2>/dev/null | grep -qi 'GNU tar'; then`,
      `  ( tar --no-recursion -T ${sh(listPath)} ${outputArgs} ; echo $? > ${sh(rcPath)} )`,
      `else`,
      `  while IFS= read -r p; do if [ -d "/$p" ] && [ ! -L "/$p" ]; then :; else printf '%s\\n' "$p"; fi; done < ${sh(listPath)} > ${sh(filesPath)}`,
      `  ( tar -T ${sh(filesPath)} ${outputArgs} ; echo $? > ${sh(rcPath)} )`,
      `fi`,
    ].join('\n');
  }

  /**
   * Full-filesystem capture. Archives only the changed/added paths from
   * `sandbox.diff()` (minus excluded caches). For gzip (default) it compresses
   * in a single streamed pass INSIDE the sandbox (`tar | gzip`) and copies the
   * compressed artifact out — metered, no uncompressed staging. For zstd it
   * emits a plain tar, copies it out and compresses host-side. Returns deleted
   * paths (to replay on restore) plus capture stats.
   *
   * Runtime-agnostic: the tar runs via `docker exec` inside the container, which
   * sees the fully merged filesystem under both `runc` and `sysbox-runc`. The
   * runtime difference is confined to how `sandbox.diff()` enumerates the
   * changed set (docker diff vs in-container manifest); see DockerSandbox.diff().
   */
  private async captureFullToHost(
    sandbox: RuntimeSandbox,
    workdir: string,
    id: string,
    codec: Codec,
    hostPath: string,
  ): Promise<{ deletes: string[]; stats: Record<string, any> }> {
    const cleanup = this.config.snapshots?.cleanup ?? 'conservative';
    const isExcluded = buildExcludeMatcher({
      cleanup,
      extra: this.config.snapshots?.excludePaths,
    });

    const changes = await sandbox.diff();
    const { present, deletes, excludedCount } = partitionChanges(
      changes,
      isExcluded,
    );

    const listPath = `${workdir}/.devic-runtime-snaplist-${id}`;
    const filesPath = `${workdir}/.devic-runtime-snapfiles-${id}`;
    const rcPath = `${workdir}/.devic-runtime-snaprc-${id}`;
    const safeDeletes = deletes.filter(isSafeDeletePath);

    // Degenerate case: nothing changed vs the base image. tar refuses to build
    // an empty archive, so write a sentinel file, include it, and mark it for
    // deletion on restore so it leaves no trace.
    if (present.length === 0) {
      const sentinelRel = `.devic-runtime-snapsentinel-${id}`;
      await sandbox.exec(`: > ${sh(`${workdir}/${sentinelRel}`)}`);
      present.push(`${workdir.replace(/^\/+/, '')}/${sentinelRel}`);
      safeDeletes.push(`${workdir}/${sentinelRel}`);
    }

    await sandbox.writeFile(
      listPath,
      Buffer.from(present.join('\n') + '\n', 'utf-8'),
    );

    const cleanupCmd = `rm -f ${sh(listPath)} ${sh(filesPath)} ${sh(rcPath)}`;

    if (codec === 'gzip') {
      // Stream tar -> gzip in one pass; no uncompressed staging. The compound
      // is grouped so the whole thing pipes into gzip; tar's rc is recovered
      // from rcPath (rc=1 is a benign "file changed while reading" warning).
      const guestGz = `${workdir}/.devic-runtime-snapshot-${id}.tar.gz`;
      const script = [
        'set -u',
        'cd / || exit 90',
        `{ ${this.tarEmitBlock(listPath, filesPath, rcPath, '-cf -')} ; } | gzip -c > ${sh(guestGz)}`,
        `rc=$(cat ${sh(rcPath)} 2>/dev/null || echo 99)`,
        cleanupCmd,
        `if [ "$rc" -ge 2 ]; then echo "tar rc=$rc" >&2; rm -f ${sh(guestGz)}; exit "$rc"; fi`,
        `[ -s ${sh(guestGz)} ] || { echo "empty archive" >&2; exit 5; }`,
        'echo OK',
      ].join('\n');

      const res = await sandbox.exec(script);
      if (res.code >= 2) {
        throw new Error(
          `Full snapshot tar failed (code=${res.code}): ${res.stderr || res.stdout}`,
        );
      }
      await sandbox.copyToHost(guestGz, hostPath);
      await sandbox.exec(`rm -f ${sh(guestGz)}`);

      return {
        deletes: safeDeletes,
        stats: {
          changed: present.length,
          deleted: safeDeletes.length,
          excluded: excludedCount,
          codec,
          where: 'sandbox',
        },
      };
    }

    // zstd: emit a plain tar in the sandbox, compress host-side.
    const rawTar = `${workdir}/.devic-runtime-snapraw-${id}.tar`;
    const script = [
      'set -u',
      'cd / || exit 90',
      this.tarEmitBlock(listPath, filesPath, rcPath, `-cf ${sh(rawTar)}`),
      `rc=$(cat ${sh(rcPath)} 2>/dev/null || echo 99)`,
      cleanupCmd,
      `if [ "$rc" -ge 2 ]; then echo "tar rc=$rc" >&2; rm -f ${sh(rawTar)}; exit "$rc"; fi`,
      `[ -s ${sh(rawTar)} ] || { echo "empty raw tar" >&2; exit 5; }`,
      'echo OK',
    ].join('\n');

    const res = await sandbox.exec(script);
    if (res.code >= 2) {
      throw new Error(
        `Full snapshot tar failed (code=${res.code}): ${res.stderr || res.stdout}`,
      );
    }

    const rawHost = `${hostPath}.rawtar`;
    await sandbox.copyToHost(rawTar, rawHost);
    await sandbox.exec(`rm -f ${sh(rawTar)}`);

    let rawBytes = 0;
    try {
      rawBytes = statSync(rawHost).size;
    } catch {}

    try {
      await this.compressFile(rawHost, hostPath, codec);
    } finally {
      try {
        unlinkSync(rawHost);
      } catch {}
    }

    return {
      deletes: safeDeletes,
      stats: {
        changed: present.length,
        deleted: safeDeletes.length,
        excluded: excludedCount,
        rawBytes,
        codec,
        where: 'host',
      },
    };
  }

  /** Restore a workdir-only snapshot (legacy path): extract tar.gz into workdir. */
  private async restoreWorkdir(
    sandbox: RuntimeSandbox,
    workdir: string,
    sandboxId: string,
    onDiskPath: string,
  ): Promise<void> {
    const guestTarPath = `${workdir}/.devic-runtime-restore-${sandboxId}.tar.gz`;
    await sandbox.copyFromHost(onDiskPath, guestTarPath);

    const extractResult = await sandbox.exec(
      `tar xzf ${guestTarPath} -C ${workdir} && rm -f ${guestTarPath}`,
    );
    if (extractResult.code !== 0) {
      this.logger.warn(
        `Snapshot restore extraction warning: ${extractResult.stderr}`,
      );
    }
  }

  /**
   * Restore a full snapshot into the fresh (base-image) sandbox: extract the
   * diff at `/` preserving perms, then replay deletes. For gzip the compressed
   * artifact is pushed straight in and extracted with `tar -xzpf` (gzip is
   * universal). For zstd the host decompresses to a plain tar first, so the
   * base image never needs a zstd binary. `rm -rf` of deletes is guarded to
   * concrete absolute paths.
   */
  private async restoreFull(
    sandbox: RuntimeSandbox,
    workdir: string,
    sandboxId: string,
    onDiskPath: string,
    codec: Codec,
    deletes: string[],
  ): Promise<void> {
    const safe = (deletes ?? []).filter(isSafeDeletePath);
    const delListPath = `${workdir}/.devic-runtime-deletes-${sandboxId}`;
    const deletesCmd = safe.length
      ? `if [ -f ${sh(delListPath)} ]; then while IFS= read -r p; do case "$p" in /|"") ;; *) rm -rf "$p";; esac; done < ${sh(delListPath)}; rm -f ${sh(delListPath)}; fi`
      : ':';

    const runExtract = async (guestTarPath: string, tarFlags: string) => {
      if (safe.length) {
        await sandbox.writeFile(
          delListPath,
          Buffer.from(safe.join('\n') + '\n', 'utf-8'),
        );
      }
      const script = [
        'set -u',
        'cd / || exit 90',
        `T=${sh(guestTarPath)}`,
        `tar ${tarFlags} "$T"; rc=$?`,
        `rm -f "$T"`,
        `if [ "$rc" -ge 2 ]; then echo "extract rc=$rc" >&2; fi`,
        deletesCmd,
        'echo OK',
      ].join('\n');
      const res = await sandbox.exec(script);
      if (res.code >= 2) {
        this.logger.warn(
          `Full snapshot restore extraction warning: ${res.stderr}`,
        );
      }
    };

    if (codec === 'gzip') {
      // Push the compressed artifact straight in; gzip extract is universal.
      const guestGz = `${workdir}/.devic-runtime-restore-${sandboxId}.tar.gz`;
      await sandbox.copyFromHost(onDiskPath, guestGz);
      await runExtract(guestGz, '-xzpf');
      return;
    }

    // zstd: decompress host-side to a plain tar, then push + extract plain.
    const rawHost = `${onDiskPath}.restoretar`;
    try {
      await this.decompressFile(onDiskPath, rawHost, codec);
      const guestTarPath = `${workdir}/.devic-runtime-restore-${sandboxId}.tar`;
      await sandbox.copyFromHost(rawHost, guestTarPath);
      await runExtract(guestTarPath, '-xpf');
    } finally {
      try {
        unlinkSync(rawHost);
      } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // Host-side (de)compression — streamed so large diffs don't block or buffer.
  // ---------------------------------------------------------------------------

  private async compressFile(
    srcTar: string,
    destPath: string,
    codec: Codec,
  ): Promise<void> {
    const transform =
      codec === 'zstd'
        ? (zlib as any).createZstdCompress({
            params: {
              [(zlib as any).constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL,
            },
          })
        : zlib.createGzip({ level: GZIP_LEVEL });
    await pipeline(
      createReadStream(srcTar),
      transform,
      createWriteStream(destPath),
    );
  }

  private async decompressFile(
    srcPath: string,
    destTar: string,
    codec: Codec,
  ): Promise<void> {
    const transform =
      codec === 'zstd'
        ? (zlib as any).createZstdDecompress()
        : zlib.createGunzip();
    await pipeline(
      createReadStream(srcPath),
      transform,
      createWriteStream(destTar),
    );
  }

  /** Trim a delete list to the persisted cap, warning when truncated. */
  private capDeletes(deletes: string[]): string[] {
    if (deletes.length <= MAX_PERSISTED_DELETES) return deletes;
    this.logger.warn(
      `Snapshot has ${deletes.length} deletes; persisting only the first ${MAX_PERSISTED_DELETES}`,
    );
    return deletes.slice(0, MAX_PERSISTED_DELETES);
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
