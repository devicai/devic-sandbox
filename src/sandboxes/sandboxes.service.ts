import { Injectable, Inject, Logger, NotFoundException, BadRequestException, forwardRef, Optional } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { SandboxRegistry } from './sandbox-registry';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SandboxProfileRepository } from '../repositories/sandbox-profile.repository';
import { SandboxDocument, SandboxStatus } from '../schemas/sandbox.schema';
import { ExtensionScope, PaginatedResponse } from '../interfaces';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';
import { CreateSandboxDto } from './dto/create-sandbox.dto';
import { RunCommandDto } from './dto/run-command.dto';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { ResourceUsageService } from '../providers/resource-usage.service';
import { HotPoolService } from '../hot-pool/hot-pool.service';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
  RuntimeSandbox,
} from '../runtime/runtime-provider.interface';

const CWD_MARKER = '__SANDBOX_CWD__';

@Injectable()
export class SandboxesService {
  private readonly logger = new Logger(SandboxesService.name);

  constructor(
    private readonly registry: SandboxRegistry,
    private readonly sandboxRepo: SandboxRepository,
    private readonly profileRepo: SandboxProfileRepository,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    @Inject(forwardRef(() => SnapshotsService))
    private readonly snapshotsService: SnapshotsService,
    private readonly resourceUsage: ResourceUsageService,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
    @Optional()
    @Inject(forwardRef(() => HotPoolService))
    private readonly hotPool?: HotPoolService,
  ) {}

  async create(dto: CreateSandboxDto, scope: ExtensionScope): Promise<SandboxDocument> {
    if (dto.useHotPool && this.hotPool) {
      try {
        const claimed = await this.hotPool.claim({
          bindingId: dto.bindingId,
          ttlSeconds: dto.ttlSeconds,
        });
        this.logger.log(
          `Sandbox ${claimed.sandboxId} served from hot pool (binding=${dto.bindingId ?? '-'})`,
        );
        return claimed;
      } catch (err) {
        this.logger.warn(
          `Hot pool claim failed, falling back to fresh create: ${(err as Error).message}`,
        );
      }
    }

    const defaults = this.config.defaults;

    let image = dto.image ?? defaults.defaultImage;
    let workdir = dto.workdir ?? '/workspace';
    let cpus = dto.cpus ?? defaults.defaultCpus;
    let memoryMib = dto.memoryMib ?? defaults.defaultMemoryMib;
    let envVars = dto.envVars ?? {};
    let initScript = dto.initScript ?? '';
    let ports = dto.ports ?? {};
    let ttlSeconds = dto.ttlSeconds ?? defaults.defaultTtlSeconds;
    let networkPolicy = dto.networkPolicy ?? 'allow-all';

    if (dto.profileId) {
      const profile = await this.profileRepo.findById(dto.profileId, scope);
      if (!profile) throw new NotFoundException(`Profile ${dto.profileId} not found`);

      image = dto.image ?? profile.image ?? image;
      workdir = dto.workdir ?? profile.workdir ?? workdir;
      cpus = dto.cpus ?? profile.cpus ?? cpus;
      memoryMib = dto.memoryMib ?? profile.memoryMib ?? memoryMib;
      envVars = { ...(profile.envVars ?? {}), ...(dto.envVars ?? {}) };
      initScript = dto.initScript ?? profile.initScript ?? initScript;
      ports = { ...(profile.ports ?? {}), ...(dto.ports ?? {}) };
      ttlSeconds = dto.ttlSeconds ?? profile.ttlSeconds ?? ttlSeconds;
      networkPolicy = dto.networkPolicy ?? profile.networkPolicy ?? networkPolicy;
    }

    if (ttlSeconds > defaults.maxTtlSeconds) {
      ttlSeconds = defaults.maxTtlSeconds;
    }

    await this.resourceUsage.assertMemoryAvailable(memoryMib);

    const sandboxId = nanoid(12);
    const containerName = `sandbox-${sandboxId}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const doc = await this.sandboxRepo.create(
      {
        sandboxId,
        name: containerName,
        profileId: dto.profileId,
        status: SandboxStatus.CREATING,
        image,
        workdir,
        currentCwd: workdir,
        cpus,
        memoryMib,
        envVars,
        ports,
        ttlSeconds,
        expiresAt,
        bindingId: dto.bindingId,
        commandCount: 0,
        recentCommands: [],
        metadata: {},
      } as any,
      scope,
    );

    try {
      const sandbox = await this.runtime.create({
        name: containerName,
        image,
        workdir,
        cpus,
        memoryMib,
        env: envVars,
        ports,
        networkPolicy: networkPolicy as 'allow-all' | 'deny-all',
      });
      await this.registry.register(sandboxId, containerName, ttlSeconds);

      if (initScript) {
        try {
          const result = await sandbox.exec(initScript);
          if (result.code !== 0) {
            this.logger.warn(
              `Init script exited with code ${result.code} for ${sandboxId}: ${result.stderr}`,
            );
          } else {
            this.logger.log(`Init script completed for ${sandboxId}`);
          }
        } catch (err) {
          this.logger.warn(
            `Init script failed for ${sandboxId}: ${(err as Error).message}`,
          );
        }
      }

      await this.sandboxRepo.updateById(
        (doc as any)._id.toString(),
        { $set: { status: SandboxStatus.RUNNING } },
        scope,
      );

      const updated = await this.sandboxRepo.findById((doc as any)._id.toString(), scope);
      return updated!;
    } catch (err) {
      await this.sandboxRepo.updateById(
        (doc as any)._id.toString(),
        { $set: { status: SandboxStatus.FAILED } },
        scope,
      );
      throw err;
    }
  }

  async findAll(
    scope: ExtensionScope,
    options?: { limit?: number; offset?: number; status?: string },
  ): Promise<PaginatedResponse<SandboxDocument>> {
    const filter: Record<string, any> = {};
    if (options?.status) filter.status = options.status;
    return this.sandboxRepo.find(filter, scope, options);
  }

  async findById(id: string, scope: ExtensionScope): Promise<SandboxDocument> {
    const doc =
      (await this.sandboxRepo.findOne({ sandboxId: id } as any, scope)) ??
      (await this.sandboxRepo.findById(id, scope));
    if (!doc) throw new NotFoundException(`Sandbox ${id} not found`);
    return doc;
  }

  async findByBinding(bindingId: string, scope: ExtensionScope): Promise<SandboxDocument | null> {
    return this.sandboxRepo.findByBinding(bindingId, scope);
  }

  async getOrCreateByBinding(
    bindingId: string,
    profileId: string | undefined,
    scope: ExtensionScope,
  ): Promise<SandboxDocument> {
    const existing = await this.sandboxRepo.findByBinding(bindingId, scope);
    if (existing && existing.status === SandboxStatus.RUNNING) return existing;

    return this.create({ bindingId, profileId }, scope);
  }

  private async getSandboxInstance(doc: SandboxDocument): Promise<RuntimeSandbox> {
    const containerName = await this.registry.get(doc.sandboxId);
    const name = containerName ?? doc.name;

    const handle = await this.runtime.get(name);
    if (!handle) {
      throw new BadRequestException(`Sandbox ${doc.sandboxId} is not reachable: not found`);
    }

    try {
      if (handle.status === 'running') {
        return await handle.connect();
      }
      return await handle.start();
    } catch (err) {
      this.logger.error(
        `Failed to reach sandbox ${doc.sandboxId} (name=${name}): ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new BadRequestException(
        `Sandbox ${doc.sandboxId} is not reachable: ${(err as Error).message}`,
      );
    }
  }

  async runCommand(
    id: string,
    dto: RunCommandDto,
    scope: ExtensionScope,
  ): Promise<{ code: number; stdout: string; stderr: string; cwd: string }> {
    const doc = await this.findById(id, scope);
    if (doc.status !== SandboxStatus.RUNNING) {
      throw new BadRequestException(`Sandbox is not running (status: ${doc.status})`);
    }

    const sandbox = await this.getSandboxInstance(doc);

    let command = dto.command.replace(/\bsudo\s+/g, '');
    const cwd = dto.cwd ?? doc.currentCwd ?? doc.workdir;

    if (dto.env && Object.keys(dto.env).length > 0) {
      const envPrefix = Object.entries(dto.env)
        .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
        .join('; ');
      command = `${envPrefix}; ${command}`;
    }

    // Wrap the user command so we can:
    //   (a) cd into the requested cwd before running it,
    //   (b) print a marker line afterwards so we can detect if the command
    //       itself changed cwd (e.g. `cd subdir`),
    //   (c) preserve the user command's real exit code as the sh -c exit
    //       code — `; echo …` would always make echo the last command and
    //       mask non-zero exits like `false` (1) or missing binaries (127).
    const fullCommand =
      `cd '${cwd}' && { ${command}; __devic_ec=$?; ` +
      `echo "${CWD_MARKER}$(pwd)"; exit $__devic_ec; }`;
    const result = await sandbox.exec(fullCommand);
    const stdout = result.stdout;
    const stderr = result.stderr;

    let newCwd = cwd;
    const markerIdx = stdout.lastIndexOf(CWD_MARKER);
    if (markerIdx !== -1) {
      newCwd = stdout.substring(markerIdx + CWD_MARKER.length).trim();
    }

    const cleanStdout = markerIdx !== -1 ? stdout.substring(0, markerIdx) : stdout;

    const recentCommands = [...(doc.recentCommands ?? []), dto.command].slice(-10);
    await this.sandboxRepo.updateById(
      (doc as any)._id.toString(),
      {
        $set: { currentCwd: newCwd, recentCommands },
        $inc: { commandCount: 1 },
      },
      scope,
    );

    return {
      code: result.code,
      stdout: cleanStdout,
      stderr,
      cwd: newCwd,
    };
  }

  async writeFile(
    id: string,
    filePath: string,
    content: string,
    scope: ExtensionScope,
  ): Promise<void> {
    const doc = await this.findById(id, scope);
    const sandbox = await this.getSandboxInstance(doc);
    await sandbox.writeFile(filePath, Buffer.from(content));
  }

  async readFile(
    id: string,
    filePath: string,
    scope: ExtensionScope,
  ): Promise<string> {
    const doc = await this.findById(id, scope);
    const sandbox = await this.getSandboxInstance(doc);
    const data = await sandbox.readFile(filePath);
    return data.toString('utf-8');
  }

  async stop(id: string, scope: ExtensionScope): Promise<SandboxDocument> {
    const doc = await this.findById(id, scope);
    if (doc.status !== SandboxStatus.RUNNING) {
      throw new BadRequestException(`Sandbox is not running (status: ${doc.status})`);
    }

    if (doc.snapshotId) {
      await this.snapshotsService.persistToSnapshot(doc);
    }

    try {
      const containerName = await this.registry.get(doc.sandboxId);
      if (containerName) {
        const handle = await this.runtime.get(containerName);
        if (handle?.status === 'running') {
          const sandbox = await handle.connect();
          await sandbox.detach();
        }
      }
    } catch (err) {
      this.logger.warn(`Error stopping sandbox ${doc.sandboxId}: ${(err as Error).message}`);
    }

    await this.registry.remove(doc.sandboxId);
    const updated = await this.sandboxRepo.updateById(
      (doc as any)._id.toString(),
      { $set: { status: SandboxStatus.STOPPED } },
      scope,
    );
    return updated!;
  }

  async destroy(id: string, scope: ExtensionScope): Promise<void> {
    const doc = await this.findById(id, scope);

    try {
      await this.runtime.remove(doc.name);
    } catch (err) {
      this.logger.warn(`Error removing sandbox ${doc.sandboxId}: ${(err as Error).message}`);
    }

    await this.registry.remove(doc.sandboxId);
    await this.sandboxRepo.deleteById((doc as any)._id.toString(), scope);
  }

  async extendTtl(
    id: string,
    additionalSeconds: number,
    scope: ExtensionScope,
  ): Promise<SandboxDocument> {
    const doc = await this.findById(id, scope);
    if (doc.status !== SandboxStatus.RUNNING) {
      throw new BadRequestException(`Sandbox is not running (status: ${doc.status})`);
    }

    const maxTtl = this.config.defaults.maxTtlSeconds;
    const elapsed = (Date.now() - new Date((doc as any).createdAt).getTime()) / 1000;
    const totalTtl = elapsed + additionalSeconds;

    if (totalTtl > maxTtl) {
      throw new BadRequestException(
        `Total TTL would exceed maximum of ${maxTtl}s`,
      );
    }

    const newExpiresAt = new Date(Date.now() + additionalSeconds * 1000);
    await this.registry.extendTtl(doc.sandboxId, additionalSeconds);

    const updated = await this.sandboxRepo.updateById(
      (doc as any)._id.toString(),
      { $set: { expiresAt: newExpiresAt } },
      scope,
    );
    return updated!;
  }

  async getStatus(id: string, scope: ExtensionScope) {
    const doc = await this.findById(id, scope);
    const remainingMs = Math.max(0, new Date(doc.expiresAt).getTime() - Date.now());

    return {
      sandboxId: doc.sandboxId,
      status: doc.status,
      image: doc.image,
      cpus: doc.cpus,
      memoryMib: doc.memoryMib,
      currentCwd: doc.currentCwd,
      commandCount: doc.commandCount,
      remainingSeconds: Math.floor(remainingMs / 1000),
      expiresAt: doc.expiresAt,
      createdAt: (doc as any).createdAt,
    };
  }
}
