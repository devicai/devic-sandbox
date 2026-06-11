import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Docker from 'dockerode';
import * as tar from 'tar-stream';
import { PassThrough, Readable } from 'stream';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { basename, dirname, isAbsolute, resolve } from 'path';
import { CONFIG } from '../config/config.loader';
import { DockerHardeningConfig, ModuleConfig } from '../config/config.types';
import { isImageAllowed } from './admission.util';
import {
  buildManifestFindCommand,
  diffManifests,
  parseManifest,
} from './sysbox-diff.util';
import {
  ExecResult,
  ExecStream,
  ExecStreamEvent,
  FsChange,
  RuntimeHandle,
  RuntimeProvider,
  RuntimeSandbox,
  RuntimeSandboxConfig,
  RuntimeStatus,
  SandboxAddress,
  ShellRunOptions,
  ShellRunResult,
  ShellRunStream,
  ShellSession,
} from './runtime-provider.interface';
import {
  buildWrappedCommand,
  MarkerProcessor,
  parseStdoutMeta,
} from './shell-protocol';

/**
 * Bridge network name for a per-sandbox isolated network. Used only when the
 * public ingress feature is enabled, so each sandbox has its own L2 segment
 * and cannot reach `app`, `mongo`, `redis`, the frontend or other sandboxes.
 */
const isolatedNetworkName = (sandboxName: string): string =>
  `devic-${sandboxName}`;

@Injectable()
export class DockerRuntimeProvider implements RuntimeProvider {
  private readonly logger = new Logger(DockerRuntimeProvider.name);
  private readonly docker: Docker;
  private readonly runtime: string;
  private readonly defaultNetwork: string;
  private readonly hardening: Required<DockerHardeningConfig>;
  private readonly imagesPolicy: { allowlist: string[]; maxSizeBytes: number };
  private readonly allowHostPortPublishing: boolean;
  /** Resolved `seccomp=<value>` SecurityOpt, or null to use the daemon default. */
  private readonly seccompOpt: string | null;
  /** Whether the daemon supports AppArmor (lazily probed on first create). */
  private apparmorSupported: boolean | null = null;
  private readonly ingressEnabled: boolean;
  private readonly selfContainerId: string | null;
  /**
   * Container-name -> DockerSandbox instance cache. We reuse the same instance
   * across `connect()` / `start()` calls so the persistent shell session it
   * may hold is not torn down between callers (terminal gateway and the
   * agent-facing exec API share one shell per sandbox).
   */
  private readonly sandboxCache = new Map<string, DockerSandbox>();
  /**
   * Per-image baseline filesystem manifest (path→size), used only under
   * sysbox-runc to diff a sandbox against a fresh container of its base image.
   * Built lazily on first full snapshot of an image and reused thereafter.
   */
  private readonly baseManifestCache = new Map<string, Map<string, number>>();
  private readonly baseManifestInFlight = new Map<
    string,
    Promise<Map<string, number>>
  >();

  constructor(@Inject(CONFIG) private readonly config: ModuleConfig) {
    const docker = config.runtime.docker;
    this.docker = new Docker({
      socketPath: docker?.socketPath ?? '/var/run/docker.sock',
    });
    this.runtime = docker?.runtime ?? 'sysbox-runc';
    this.defaultNetwork = docker?.network ?? 'bridge';
    this.hardening = {
      dropAllCaps: docker?.hardening?.dropAllCaps ?? true,
      noNewPrivileges: docker?.hardening?.noNewPrivileges ?? true,
      readOnlyRootfs: docker?.hardening?.readOnlyRootfs ?? false,
      seccompProfile: docker?.hardening?.seccompProfile ?? 'default',
      apparmorProfile: docker?.hardening?.apparmorProfile ?? 'docker-default',
      runAsUser: docker?.hardening?.runAsUser ?? '',
      pidsLimit: docker?.hardening?.pidsLimit ?? 512,
    };
    this.imagesPolicy = {
      allowlist: docker?.images?.allowlist ?? [],
      maxSizeBytes: docker?.images?.maxSizeBytes ?? 0,
    };
    this.allowHostPortPublishing = docker?.allowHostPortPublishing ?? false;
    this.seccompOpt = this.resolveSeccompOpt(this.hardening.seccompProfile);
    this.ingressEnabled = Boolean(config.ingress?.enabled);
    this.selfContainerId = detectSelfContainerId(this.logger);
  }

  /**
   * Resolve the configured seccomp profile into a SecurityOpt value. The Docker
   * Engine API expects the profile's JSON *content* (not a path) in
   * `seccomp=<...>`, so a path is read and inlined here. Returns null for the
   * daemon default (no SecurityOpt added).
   */
  private resolveSeccompOpt(profile: string): string | null {
    const p = (profile ?? 'default').trim();
    if (!p || p === 'default') return null;
    if (p === 'unconfined') return 'seccomp=unconfined';
    try {
      const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
      const json = readFileSync(abs, 'utf-8');
      JSON.parse(json); // fail fast on a malformed profile
      return `seccomp=${json}`;
    } catch (err) {
      this.logger.warn(
        `seccompProfile '${p}' could not be loaded (${(err as Error).message}); ` +
          'falling back to the daemon default profile',
      );
      return null;
    }
  }

  /**
   * Probe the daemon once for AppArmor support. Applying an AppArmor profile on
   * a host without AppArmor fails the container create, so we detect support up
   * front and skip the profile (with a warning) where it is unavailable.
   */
  private async ensureDaemonInfo(): Promise<void> {
    if (this.apparmorSupported !== null) return;
    try {
      const info = (await this.docker.info()) as { SecurityOptions?: string[] };
      this.apparmorSupported = (info.SecurityOptions ?? []).some((o) =>
        o.includes('name=apparmor'),
      );
    } catch (err) {
      this.logger.warn(
        `Could not query daemon security options: ${(err as Error).message}`,
      );
      this.apparmorSupported = false;
    }
    const aa = this.hardening.apparmorProfile?.trim();
    if (aa && aa !== 'unconfined' && !this.apparmorSupported) {
      this.logger.warn(
        `AppArmor profile '${aa}' requested but the daemon does not support ` +
          'AppArmor; sandboxes will run without an explicit AppArmor profile',
      );
    }
  }

  /**
   * Network the sandbox container will be attached to at create time. With
   * ingress enabled, every allow-all sandbox gets its own bridge network so
   * sandboxes are isolated from each other and from the rest of the stack.
   * Without ingress, behaviour matches the previous default (shared bridge).
   */
  private networkFor(cfg: RuntimeSandboxConfig): string {
    if (cfg.networkPolicy === 'deny-all') return 'none';
    if (this.ingressEnabled) return isolatedNetworkName(cfg.name);
    return this.defaultNetwork;
  }

  async create(cfg: RuntimeSandboxConfig): Promise<RuntimeSandbox> {
    await this.ensureDaemonInfo();
    await this.ensureImage(cfg.image);
    await this.removeIfExists(cfg.name);

    const env = Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`);
    const exposed: Record<string, {}> = {};
    const portBindings: Record<
      string,
      Array<{ HostPort: string; HostIp?: string }>
    > = {};
    if (cfg.ports) {
      for (const [hostPort, guestPort] of Object.entries(cfg.ports)) {
        const key = `${guestPort}/tcp`;
        exposed[key] = {};
        // Bind to loopback only: host publishing is an opt-in escape hatch and
        // must never expose a sandbox port on all interfaces.
        portBindings[key] = [{ HostPort: String(hostPort), HostIp: '127.0.0.1' }];
      }
    }

    const networkMode = this.networkFor(cfg);
    if (
      this.ingressEnabled &&
      cfg.networkPolicy !== 'deny-all'
    ) {
      await this.ensureIsolatedNetwork(networkMode);
    }

    const securityOpt: string[] = [];
    if (this.hardening.noNewPrivileges) {
      securityOpt.push('no-new-privileges:true');
    }
    if (this.seccompOpt) {
      securityOpt.push(this.seccompOpt);
    }
    const apparmor = this.hardening.apparmorProfile?.trim();
    if (apparmor && apparmor !== 'unconfined' && this.apparmorSupported) {
      securityOpt.push(`apparmor=${apparmor}`);
    }

    const runAsUser = this.hardening.runAsUser?.trim();

    const container = await this.docker.createContainer({
      name: cfg.name,
      Image: cfg.image,
      Env: env,
      WorkingDir: cfg.workdir,
      User: runAsUser || undefined,
      Cmd: ['/bin/sh', '-c', 'sleep infinity'],
      Tty: false,
      ExposedPorts: exposed,
      HostConfig: {
        Runtime: this.runtime,
        Memory: cfg.memoryMib * 1024 * 1024,
        NanoCpus: cfg.cpus * 1_000_000_000,
        NetworkMode: networkMode,
        PortBindings: portBindings,
        CapDrop: this.hardening.dropAllCaps ? ['ALL'] : undefined,
        ReadonlyRootfs: this.hardening.readOnlyRootfs,
        SecurityOpt: securityOpt.length ? securityOpt : undefined,
        PidsLimit: this.hardening.pidsLimit,
        AutoRemove: false,
      },
      Labels: {
        'devic-sandbox.managed': 'true',
        'devic-sandbox.name': cfg.name,
      },
    });

    await container.start();

    const sandbox = this.cacheSandbox(cfg.name, container);
    // Make sure the workdir exists. Some images ship without /workspace.
    await sandbox.exec(`mkdir -p ${shellEscape(cfg.workdir)}`);
    return sandbox;
  }

  /**
   * Return the cached DockerSandbox for `name`, creating one if absent. The
   * cache is keyed on the container name, so reattaching to an existing
   * sandbox after a process restart will produce a fresh instance with no
   * pre-existing shell — that is fine and intended.
   */
  private cacheSandbox(name: string, container: Docker.Container): DockerSandbox {
    const cached = this.sandboxCache.get(name);
    if (cached) return cached;
    const fresh = new DockerSandbox(name, container, {
      runtime: this.runtime,
      getBaseManifest: (image) => this.getBaseManifest(image),
    });
    this.sandboxCache.set(name, fresh);
    return fresh;
  }

  /**
   * Baseline (path→size) manifest of a fresh sysbox container of `image`,
   * cached per image. Used to cancel sysbox's deterministic file injection so a
   * sandbox's diff is exactly the user's changes. Concurrent callers coalesce.
   */
  private async getBaseManifest(image: string): Promise<Map<string, number>> {
    const cached = this.baseManifestCache.get(image);
    if (cached) return cached;
    const inFlight = this.baseManifestInFlight.get(image);
    if (inFlight) return inFlight;
    const build = this.buildBaseManifest(image)
      .then((m) => {
        this.baseManifestCache.set(image, m);
        return m;
      })
      .finally(() => this.baseManifestInFlight.delete(image));
    this.baseManifestInFlight.set(image, build);
    return build;
  }

  /**
   * Run a throwaway sysbox container of `image` and capture its filesystem
   * manifest. Must use the SAME runtime as the sandboxes (so the injected files
   * match) and the SAME find command. A short settle delay lets sysbox finish
   * its internal setup before the walk.
   */
  private async buildBaseManifest(image: string): Promise<Map<string, number>> {
    const cmd = `sleep 8; ${buildManifestFindCommand()}`;
    const container = await this.docker.createContainer({
      Image: image,
      Entrypoint: ['sh', '-c'],
      Cmd: [cmd],
      Tty: true, // raw stdout, no stream demuxing needed
      HostConfig: { Runtime: this.runtime, AutoRemove: false },
      Labels: {
        'devic-sandbox.managed': 'true',
        'devic-sandbox.baseline': 'true',
      },
    });
    try {
      await container.start();
      await container.wait();
      const buf = (await container.logs({
        stdout: true,
        stderr: false,
      })) as unknown as Buffer;
      return parseManifest(buf.toString('utf-8'));
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  /**
   * Drop the cached sandbox (and any open shell session it owns) for `name`.
   * Idempotent. Called whenever the container is removed or known to be gone.
   */
  private async evictSandbox(name: string): Promise<void> {
    const cached = this.sandboxCache.get(name);
    if (!cached) return;
    this.sandboxCache.delete(name);
    try {
      await cached.disposeShell();
    } catch (err) {
      this.logger.debug(
        `evictSandbox(${name}) shell dispose ignored: ${(err as Error).message}`,
      );
    }
  }

  async get(name: string): Promise<RuntimeHandle | null> {
    const container = this.docker.getContainer(name);
    let info: Docker.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (err: any) {
      if (err.statusCode === 404) return null;
      this.logger.error(`docker inspect ${name} failed: ${err.message}`);
      throw err;
    }

    const status = mapStatus(info.State.Status);
    return {
      status,
      connect: async () => this.cacheSandbox(name, container),
      start: async () => {
        if (info.State.Status !== 'running') {
          await container.start().catch((err: any) => {
            // Already started is fine.
            if (err.statusCode !== 304) throw err;
          });
        }
        return this.cacheSandbox(name, container);
      },
    };
  }

  async remove(name: string): Promise<void> {
    await this.evictSandbox(name);
    try {
      const container = this.docker.getContainer(name);
      await container.remove({ force: true, v: true });
    } catch (err: any) {
      if (err.statusCode !== 404) {
        this.logger.warn(`docker remove ${name} failed: ${err.message}`);
      }
    }
    if (this.ingressEnabled) {
      await this.removeIsolatedNetwork(isolatedNetworkName(name));
    }
  }

  async attachLocal(name: string): Promise<void> {
    if (!this.ingressEnabled || !this.selfContainerId) return;
    const networkName = isolatedNetworkName(name);
    try {
      const network = this.docker.getNetwork(networkName);
      await network.connect({ Container: this.selfContainerId });
      this.logger.debug(
        `Connected self container ${this.selfContainerId} to ${networkName}`,
      );
    } catch (err: any) {
      // Status 403 from Docker means already connected — treat as no-op.
      if (err.statusCode === 403) return;
      if (err.statusCode === 404) {
        this.logger.warn(
          `Cannot attach to ${networkName}: network does not exist`,
        );
        return;
      }
      this.logger.warn(
        `attachLocal(${name}) failed: ${(err as Error).message}`,
      );
    }
  }

  async detachLocal(name: string): Promise<void> {
    if (!this.ingressEnabled || !this.selfContainerId) return;
    const networkName = isolatedNetworkName(name);
    try {
      const network = this.docker.getNetwork(networkName);
      await network.disconnect({
        Container: this.selfContainerId,
        Force: true,
      });
    } catch (err: any) {
      if (err.statusCode === 404) return;
      // 403 = not connected; 500 with "is not connected" body — both benign.
      if (err.statusCode === 403) return;
      this.logger.debug(
        `detachLocal(${name}) ignored: ${(err as Error).message}`,
      );
    }
  }

  private async ensureIsolatedNetwork(networkName: string): Promise<void> {
    try {
      await this.docker.getNetwork(networkName).inspect();
      return;
    } catch (err: any) {
      if (err.statusCode !== 404) throw err;
    }
    try {
      await this.docker.createNetwork({
        Name: networkName,
        Driver: 'bridge',
        CheckDuplicate: true,
        Internal: false,
        Labels: {
          'devic-sandbox.managed': 'true',
        },
      });
    } catch (err: any) {
      // Race: another concurrent create() raced us. Tolerate.
      if (err.statusCode === 409) return;
      throw err;
    }
  }

  private async removeIsolatedNetwork(networkName: string): Promise<void> {
    try {
      const network = this.docker.getNetwork(networkName);
      // Make sure no peers (e.g. self container) are still attached, otherwise
      // the network will refuse to be removed.
      if (this.selfContainerId) {
        try {
          await network.disconnect({
            Container: this.selfContainerId,
            Force: true,
          });
        } catch {
          // Either already disconnected (403) or network gone (404). Ignored.
        }
      }
      await network.remove();
    } catch (err: any) {
      if (err.statusCode === 404) return;
      this.logger.debug(
        `removeIsolatedNetwork(${networkName}) ignored: ${(err as Error).message}`,
      );
    }
  }

  async getAddress(
    name: string,
    internalPort: number,
  ): Promise<SandboxAddress | null> {
    const container = this.docker.getContainer(name);
    let info: Docker.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (err: any) {
      if (err.statusCode === 404) return null;
      throw err;
    }
    if (info.State.Status !== 'running') return null;

    // Prefer the IP on the configured network, fall back to the first attached
    // network. The proxy reaches the container directly on its bridge IP, so
    // no host port-publishing is required for the ingress feature to work.
    const networks = info.NetworkSettings?.Networks ?? {};
    const preferredName = this.ingressEnabled
      ? isolatedNetworkName(name)
      : this.defaultNetwork;
    const preferred = networks[preferredName];
    const ip =
      preferred?.IPAddress ||
      Object.values(networks)
        .map((n) => n?.IPAddress)
        .find(Boolean);
    if (!ip) return null;
    return { host: ip, port: internalPort };
  }

  private async removeIfExists(name: string): Promise<void> {
    await this.evictSandbox(name);
    try {
      const c = this.docker.getContainer(name);
      await c.inspect();
      await c.remove({ force: true, v: true });
    } catch (err: any) {
      if (err.statusCode === 404) return;
      this.logger.warn(
        `failed to clean up pre-existing container ${name}: ${err.message}`,
      );
    }
  }

  private async ensureImage(image: string): Promise<void> {
    // Admission backstop: every create/restore/hot-pool path funnels through
    // here, so an unlisted image is rejected before it is ever pulled or run.
    if (!isImageAllowed(image, this.imagesPolicy.allowlist)) {
      throw new Error(
        `Image '${image}' is not permitted by runtime.docker.images.allowlist`,
      );
    }
    try {
      await this.docker.getImage(image).inspect();
      await this.assertImageSize(image);
      return;
    } catch (err: any) {
      if (err.statusCode !== 404) throw err;
    }
    this.logger.log(`Pulling image ${image}...`);
    const stream = (await this.docker.pull(image)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    await this.assertImageSize(image);
  }

  /**
   * Reject images larger than the configured cap. Non-destructive: the pulled
   * image is left in place (it may be shared by other sandboxes) and only the
   * create is refused. Disabled when maxSizeBytes is 0.
   */
  private async assertImageSize(image: string): Promise<void> {
    const cap = this.imagesPolicy.maxSizeBytes;
    if (!cap || cap <= 0) return;
    let size = 0;
    try {
      const info = await this.docker.getImage(image).inspect();
      size = info.Size ?? 0;
    } catch {
      return; // size unknown — don't block on an inspect hiccup
    }
    if (size > cap) {
      throw new Error(
        `Image '${image}' (${size} bytes) exceeds ` +
          `runtime.docker.images.maxSizeBytes (${cap})`,
      );
    }
  }
}

function mapStatus(s: string): RuntimeStatus {
  if (s === 'running') return 'running';
  if (s === 'created' || s === 'exited' || s === 'paused' || s === 'dead') {
    return 'stopped';
  }
  return 'unknown';
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Best-effort detection of the container the Operator process itself is
 * running in. Used to attach `app` to a sandbox's isolated bridge so the
 * embedded ingress proxy can route to it.
 *
 * Resolution order:
 *   1. `DEVIC_SANDBOX_SELF_CONTAINER` env var (operator override).
 *   2. `/etc/hostname` when its first 12 chars match a Docker short ID.
 *
 * Returns null when neither is available — the proxy then falls back to
 * relying on host-routable bridge IPs (works on bare-metal dev setups).
 */
function detectSelfContainerId(logger: Logger): string | null {
  const envId = process.env.DEVIC_SANDBOX_SELF_CONTAINER;
  if (envId && envId.trim()) return envId.trim();
  try {
    const hostname = readFileSync('/etc/hostname', 'utf-8').trim();
    if (/^[0-9a-f]{12,64}$/i.test(hostname)) return hostname;
  } catch {
    // /etc/hostname unreadable (unusual but harmless on dev hosts).
  }
  logger.debug(
    'Could not detect self container ID; per-sandbox network attach will be skipped',
  );
  return null;
}

/**
 * Provider-supplied context a DockerSandbox needs beyond its own container:
 * the active OCI runtime (so diff() can adapt) and a way to obtain the cached
 * base-image manifest for the sysbox diff path.
 */
interface DockerSandboxContext {
  runtime: string;
  getBaseManifest(image: string): Promise<Map<string, number>>;
}

class DockerSandbox implements RuntimeSandbox {
  /**
   * Lazily-opened persistent shell session. Created by openShell() on first
   * call and reused for subsequent ones. Cleared automatically when the shell
   * process exits.
   */
  private shell: DockerShellSession | null = null;
  private shellOpening: Promise<DockerShellSession> | null = null;

  constructor(
    readonly name: string,
    private readonly container: Docker.Container,
    private readonly ctx: DockerSandboxContext,
  ) {}

  async openShell(initialCwd?: string): Promise<ShellSession> {
    if (this.shell && !this.shell.closed) return this.shell;
    // Coalesce concurrent openers.
    if (this.shellOpening) return this.shellOpening;
    this.shellOpening = (async () => {
      const session = await DockerShellSession.open(this.container, initialCwd);
      session.onClose(() => {
        if (this.shell === session) this.shell = null;
      });
      this.shell = session;
      return session;
    })();
    try {
      return await this.shellOpening;
    } finally {
      this.shellOpening = null;
    }
  }

  /**
   * Tear down the open shell session, if any. Called by the runtime provider
   * when the sandbox is being evicted from cache or removed.
   */
  async disposeShell(): Promise<void> {
    const s = this.shell;
    this.shell = null;
    if (s) await s.close();
  }

  async exec(command: string): Promise<ExecResult> {
    const exec = await this.container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    stdoutStream.on('data', (c: Buffer) => stdoutChunks.push(c));
    stderrStream.on('data', (c: Buffer) => stderrChunks.push(c));

    this.container.modem.demuxStream(stream, stdoutStream, stderrStream);

    await new Promise<void>((resolve, reject) => {
      const done = () => resolve();
      stream.once('end', done);
      stream.once('close', done);
      stream.once('error', reject);
    });

    const inspect = await exec.inspect();
    return {
      code: inspect.ExitCode ?? 0,
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    };
  }

  async diff(): Promise<FsChange[]> {
    // Under sysbox-runc, `docker diff` is blind to changes in sysbox's
    // internally-mounted system dirs (/usr, /etc, /lib, /var) — it would report
    // only /root, /home and the workdir, silently dropping installed packages
    // and configs. Verified A/B on one daemon: runc reports every change,
    // sysbox reports ~2 of 9. So under sysbox we compute the diff from inside
    // the container (where the fs is fully merged) against a baseline of a fresh
    // sysbox container of the same image. See sysbox-diff.util for the details.
    if (this.ctx.runtime === 'sysbox-runc') {
      try {
        return await this.diffViaBaseManifest();
      } catch (err) {
        // Never fail a snapshot over the diff strategy: fall back to docker
        // diff (incomplete under sysbox, but better than throwing).
        new Logger(DockerSandbox.name).warn(
          `sysbox manifest diff failed for ${this.name}, falling back to ` +
            `docker diff: ${(err as Error).message}`,
        );
      }
    }

    // Docker returns the changed paths of the container's writable layer
    // relative to its base image. The body is `null` (not `[]`) when nothing
    // changed, so guard for it. Kind: 0=modified, 1=added, 2=deleted.
    const changes = (await this.container.changes()) as
      | Array<{ Path: string; Kind: number }>
      | null;
    if (!changes) return [];
    return changes.map((c) => ({
      path: c.Path,
      kind: c.Kind === 2 ? 'D' : c.Kind === 1 ? 'A' : 'C',
    }));
  }

  /**
   * sysbox-runc diff: walk the live container's filesystem from inside (exec
   * sees the merged view) and compare against the cached baseline manifest of a
   * fresh container of the same base image. The difference is exactly the user's
   * changes — sysbox's deterministic file injection cancels out.
   */
  private async diffViaBaseManifest(): Promise<FsChange[]> {
    const info = await this.container.inspect();
    const image = info.Config?.Image || info.Image;
    if (!image) throw new Error('could not resolve base image for diff');
    const base = await this.ctx.getBaseManifest(image);
    const out = await this.exec(buildManifestFindCommand());
    const current = parseManifest(out.stdout);
    if (current.size === 0) {
      throw new Error('live manifest walk returned no entries');
    }
    return diffManifests(base, current);
  }

  async execStream(command: string): Promise<ExecStream> {
    const exec = await this.container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const raw = await exec.start({ hijack: true, stdin: false });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    this.container.modem.demuxStream(raw, stdoutStream, stderrStream);

    let stopped = false;
    const queue: ExecStreamEvent[] = [];
    let resolveNext: ((v: IteratorResult<ExecStreamEvent>) => void) | null = null;
    let ended = false;

    const push = (evt: ExecStreamEvent) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: evt, done: false });
      } else {
        queue.push(evt);
      }
    };

    const finish = () => {
      ended = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as any, done: true });
      }
    };

    stdoutStream.on('data', (c: Buffer) =>
      push({ type: 'stdout', data: Buffer.from(c) }),
    );
    stderrStream.on('data', (c: Buffer) =>
      push({ type: 'stderr', data: Buffer.from(c) }),
    );
    raw.on('end', finish);
    raw.on('close', finish);
    raw.on('error', finish);

    const events: AsyncIterable<ExecStreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ExecStreamEvent>> {
            if (stopped) return Promise.resolve({ value: undefined as any, done: true });
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (ended) return Promise.resolve({ value: undefined as any, done: true });
            return new Promise((resolve) => {
              resolveNext = resolve;
            });
          },
        };
      },
    };

    return {
      events,
      stop: async () => {
        stopped = true;
        finish();
        try {
          (raw as any).destroy?.();
        } catch {}
      },
    };
  }

  async readFile(path: string): Promise<Buffer> {
    const stream = await this.container.getArchive({ path });
    return await extractFirstFile(stream as any as NodeJS.ReadableStream);
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const dir = dirname(filePath) || '/';
    const name = basename(filePath);
    await this.exec(`mkdir -p ${shellEscape(dir)}`);

    const pack = tar.pack();
    pack.entry({ name, size: content.length, mode: 0o644 }, content);
    pack.finalize();

    await this.container.putArchive(pack as any, { path: dir });
  }

  async copyToHost(guestPath: string, hostPath: string): Promise<void> {
    const stream = await this.container.getArchive({ path: guestPath });
    const dir = dirname(hostPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await extractFirstFileToDisk(stream as any as NodeJS.ReadableStream, hostPath);
  }

  async copyFromHost(hostPath: string, guestPath: string): Promise<void> {
    const dir = dirname(guestPath) || '/';
    const name = basename(guestPath);
    await this.exec(`mkdir -p ${shellEscape(dir)}`);

    const stat = statSync(hostPath);
    const pack = tar.pack();
    const entry = pack.entry({
      name,
      size: stat.size,
      mode: stat.mode & 0o777,
    });

    // Stream the file into the tar entry and finalize the pack once it's fully
    // written. CRITICAL: putArchive must consume `pack` *concurrently* with this
    // pipe — do NOT await the entry's 'finish' before handing the pack over.
    // `pack` is a readable stream with a ~16 KB internal buffer; with no consumer
    // yet, piping any file larger than that fills the buffer, backpressure pauses
    // the read, the entry never emits 'finish', and the copy deadlocks forever.
    // That deadlock is exactly what hung snapshot restores: restoreFull() pushes
    // the (multi-MB) snapshot tarball in via copyFromHost, so every real-sized
    // snapshot got stuck here (only sub-16 KB ones ever completed).
    const source = createReadStream(hostPath);
    source.on('error', (err) => entry.destroy(err));
    entry.on('finish', () => pack.finalize());
    source.pipe(entry);

    await this.container.putArchive(pack as any, { path: dir });
  }

  async detach(): Promise<void> {
    // Best-effort: tear the shell session down before stopping the container
    // so we surface a clean close error rather than a half-broken stream.
    await this.disposeShell().catch(() => undefined);
    try {
      await this.container.stop({ t: 10 });
    } catch (err: any) {
      if (err.statusCode === 304 || err.statusCode === 404) return;
      throw err;
    }
  }
}

async function extractFirstFile(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const extract = tar.extract();
  const chunks: Buffer[] = [];
  let resolveResult: (b: Buffer) => void;
  let rejectResult: (e: Error) => void;
  const done = new Promise<Buffer>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  extract.on('entry', (header, fileStream, next) => {
    if (header.type !== 'file') {
      fileStream.resume();
      fileStream.on('end', next);
      return;
    }
    fileStream.on('data', (c: Buffer) => chunks.push(c));
    fileStream.on('end', () => {
      resolveResult(Buffer.concat(chunks));
      next();
    });
  });
  extract.on('finish', () => {
    if (chunks.length === 0) resolveResult(Buffer.alloc(0));
  });
  extract.on('error', (e) => rejectResult(e));

  (stream as Readable).pipe(extract);
  return done;
}

async function extractFirstFileToDisk(
  stream: NodeJS.ReadableStream,
  destPath: string,
): Promise<void> {
  const extract = tar.extract();
  let writeFinished: Promise<void> | null = null;

  return new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, fileStream, next) => {
      if (header.type !== 'file') {
        fileStream.resume();
        fileStream.on('end', next);
        return;
      }
      const out = createWriteStream(destPath);
      writeFinished = new Promise((res, rej) => {
        out.on('finish', () => res());
        out.on('error', rej);
      });
      fileStream.pipe(out);
      fileStream.on('end', next);
    });
    extract.on('finish', async () => {
      if (writeFinished) await writeFinished;
      resolve();
    });
    extract.on('error', reject);
    (stream as Readable).pipe(extract);
  });
}

/**
 * Persistent shell session backed by a long-lived `docker exec /bin/sh` with
 * stdin/stdout/stderr attached (Tty=false). Each `run()` writes a wrapped
 * command into the same shell, so `export`, `cd`, shell functions, etc.
 * persist across calls — agents observe a stable environment between tool
 * invocations and human operators in the terminal see the same.
 *
 * End-of-command detection uses per-call UUID markers emitted on both stdout
 * (with `:CODE:CWD\n` metadata) and stderr (bare `\n`). Output bytes prior to
 * each marker are forwarded to the caller verbatim; the marker line itself is
 * stripped. We base64-encode the user command to feed it into the shell so
 * arbitrary content (quotes, newlines, the marker string, $-substitutions)
 * cannot break the wrapper.
 */
class DockerShellSession implements ShellSession {
  private readonly stdoutSink = new PassThrough();
  private readonly stderrSink = new PassThrough();
  private queue: Promise<unknown> = Promise.resolve();
  private _closed = false;
  private readonly closeListeners: Array<() => void> = [];
  /** Currently-active per-command processors (null when idle between calls). */
  private currentStdout: MarkerProcessor | null = null;
  private currentStderr: MarkerProcessor | null = null;

  private constructor(
    private readonly exec: Docker.Exec,
    private readonly stream: NodeJS.ReadWriteStream,
    container: Docker.Container,
  ) {
    container.modem.demuxStream(stream, this.stdoutSink, this.stderrSink);

    this.stdoutSink.on('data', (c: Buffer) => this.currentStdout?.feed(c));
    this.stderrSink.on('data', (c: Buffer) => this.currentStderr?.feed(c));

    const onEnd = (err?: Error) => this.markClosed(err);
    stream.once('end', () => onEnd());
    stream.once('close', () => onEnd());
    stream.once('error', (err: Error) => onEnd(err));
  }

  /**
   * Spawn a `/bin/sh` inside the container with stdin attached. The shell
   * stays running until `close()` is called or the user runs `exit`.
   */
  static async open(
    container: Docker.Container,
    initialCwd?: string,
  ): Promise<DockerShellSession> {
    const exec = await container.exec({
      Cmd: ['/bin/sh'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = (await exec.start({
      hijack: true,
      stdin: true,
    })) as unknown as NodeJS.ReadWriteStream;
    const session = new DockerShellSession(exec, stream, container);
    if (initialCwd && initialCwd.trim()) {
      // Best-effort: position the shell at the requested cwd before any
      // caller-issued command. Failures here surface on the first run().
      await session.run(`cd ${shellEscape(initialCwd)}`).catch(() => undefined);
    }
    return session;
  }

  get closed(): boolean {
    return this._closed;
  }

  onClose(listener: () => void): void {
    if (this._closed) {
      queueMicrotask(listener);
      return;
    }
    this.closeListeners.push(listener);
  }

  private markClosed(err?: Error): void {
    if (this._closed) return;
    this._closed = true;
    // Abort any in-flight processors.
    this.currentStdout?.abort(err);
    this.currentStderr?.abort(err);
    this.currentStdout = null;
    this.currentStderr = null;
    for (const l of this.closeListeners.splice(0)) {
      try {
        l();
      } catch {
        // Listener errors must not poison the close path.
      }
    }
  }

  async run(command: string, opts?: ShellRunOptions): Promise<ShellRunResult> {
    const s = await this.runStream(command, opts);
    let stdout = '';
    let stderr = '';
    for await (const evt of s.events) {
      if (evt.type === 'stdout') stdout += evt.data.toString('utf-8');
      else stderr += evt.data.toString('utf-8');
    }
    const { code, cwd } = await s.done;
    return { code, cwd, stdout, stderr };
  }

  async runStream(
    command: string,
    opts?: ShellRunOptions,
  ): Promise<ShellRunStream> {
    if (this._closed) {
      throw new Error('Shell session is closed');
    }

    // Serialize: each command waits for the previous one to fully complete.
    const previous = this.queue;
    let releaseLock!: () => void;
    const lock = new Promise<void>((res) => {
      releaseLock = res;
    });
    this.queue = lock;
    await previous.catch(() => undefined);

    if (this._closed) {
      releaseLock();
      throw new Error('Shell session is closed');
    }

    const uuid = randomUUID().replace(/-/g, '');
    const marker = `__DEVIC_END_${uuid}__`;
    const wrapped = buildWrappedCommand(command, marker, opts);

    const queue: ExecStreamEvent[] = [];
    let pendingResolve:
      | ((v: IteratorResult<ExecStreamEvent>) => void)
      | null = null;
    let streamDone = false;
    let streamError: Error | null = null;

    const pushEvent = (evt: ExecStreamEvent) => {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: evt, done: false });
      } else {
        queue.push(evt);
      }
    };

    const finishIterable = () => {
      if (streamDone) return;
      streamDone = true;
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: undefined as any, done: true });
      }
    };

    let stdoutMeta: string | null = null;
    let stderrMeta: string | null = null;
    let resolveDone!: (v: { code: number; cwd: string }) => void;
    let rejectDone!: (err: Error) => void;
    const donePromise = new Promise<{ code: number; cwd: string }>(
      (res, rej) => {
        resolveDone = res;
        rejectDone = rej;
      },
    );

    const tryComplete = () => {
      if (stdoutMeta === null || stderrMeta === null) return;
      // stdoutMeta has the form ":CODE:CWD"; stderrMeta is the bare line (empty).
      const parsed = parseStdoutMeta(stdoutMeta);
      finishIterable();
      this.currentStdout = null;
      this.currentStderr = null;
      releaseLock();
      if (!parsed) {
        rejectDone(
          new Error(`shell: malformed end-of-command marker: ${stdoutMeta}`),
        );
        return;
      }
      resolveDone(parsed);
    };

    const failWith = (err: Error) => {
      streamError = err;
      finishIterable();
      this.currentStdout = null;
      this.currentStderr = null;
      releaseLock();
      rejectDone(err);
    };

    this.currentStdout = new MarkerProcessor(
      marker,
      (chunk) =>
        pushEvent({ type: 'stdout', data: Buffer.from(chunk) }),
      (meta) => {
        stdoutMeta = meta;
        tryComplete();
      },
      failWith,
    );
    this.currentStderr = new MarkerProcessor(
      marker,
      (chunk) =>
        pushEvent({ type: 'stderr', data: Buffer.from(chunk) }),
      (meta) => {
        stderrMeta = meta;
        tryComplete();
      },
      failWith,
    );

    // Send the wrapped command into the shell. We append a newline so the
    // shell parses the last statement.
    try {
      const ok = (this.stream as any).write(wrapped + '\n');
      if (ok === false) {
        await new Promise<void>((res) =>
          (this.stream as any).once('drain', res),
        );
      }
    } catch (err) {
      failWith(err as Error);
      throw err;
    }

    const events: AsyncIterable<ExecStreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ExecStreamEvent>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (streamError) return Promise.reject(streamError);
            if (streamDone) {
              return Promise.resolve({ value: undefined as any, done: true });
            }
            return new Promise((resolve) => {
              pendingResolve = resolve;
            });
          },
        };
      },
    };

    return { events, done: donePromise };
  }

  async close(): Promise<void> {
    if (this._closed) return;
    try {
      (this.stream as any).end?.();
    } catch {
      // ignored — markClosed runs from the stream's `end` / `close` event.
    }
    try {
      (this.stream as any).destroy?.();
    } catch {
      // ignored
    }
    this.markClosed();
  }
}


