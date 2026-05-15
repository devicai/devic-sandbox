import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  Sandbox as MsbSandbox,
  SandboxConfig,
  ExecHandle,
  ExecEvent,
} from 'microsandbox';
import {
  ExecResult,
  ExecStream,
  ExecStreamEvent,
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

// The microsandbox SDK is loaded lazily so this module can be imported on hosts
// where the native binding cannot dlopen (e.g. node:24-slim without libdbus).
// Without this, selecting `runtime.type=docker` still crashes at startup
// because RuntimeModule eagerly imports both providers.
type MicrosandboxSdk = typeof import('microsandbox');
let _sdk: MicrosandboxSdk | null = null;
function sdk(): MicrosandboxSdk {
  return (_sdk ??= require('microsandbox'));
}

@Injectable()
export class MicrosandboxRuntimeProvider implements RuntimeProvider {
  private readonly logger = new Logger(MicrosandboxRuntimeProvider.name);

  /**
   * In-memory record of the host-port → guest-port forwarding declared at
   * `create()` time, keyed by sandbox name. The microsandbox SDK does not
   * expose a way to query this after the fact, so we keep it ourselves to
   * implement `getAddress`. Cleared on `remove`.
   */
  private readonly portMappings = new Map<string, Record<string, number>>();

  async create(cfg: RuntimeSandboxConfig): Promise<RuntimeSandbox> {
    const msbConfig: SandboxConfig = {
      name: cfg.name,
      image: cfg.image,
      workdir: cfg.workdir,
      cpus: cfg.cpus,
      memoryMib: cfg.memoryMib,
      env: cfg.env,
      patches: [sdk().Patch.mkdir(cfg.workdir)],
      network: {
        policy: (cfg.networkPolicy ?? 'allow-all') as any,
        tls: { interceptedPorts: [] },
      },
      quietLogs: true,
      replace: true,
    };

    if (cfg.ports && Object.keys(cfg.ports).length > 0) {
      msbConfig.ports = {};
      for (const [k, v] of Object.entries(cfg.ports)) {
        msbConfig.ports[k] = v;
      }
      this.portMappings.set(cfg.name, { ...cfg.ports });
    }

    const instance = await sdk().Sandbox.create(msbConfig);
    return new MicrosandboxSandbox(cfg.name, instance);
  }

  async get(name: string): Promise<RuntimeHandle | null> {
    try {
      const handle: any = await sdk().Sandbox.get(name);
      const status = mapStatus(handle.status);
      return {
        status,
        connect: async () => {
          const inst = await handle.connect();
          return new MicrosandboxSandbox(name, inst);
        },
        start: async () => {
          const inst = await handle.start();
          return new MicrosandboxSandbox(name, inst);
        },
      };
    } catch (err) {
      // microsandbox SDK throws when the sandbox does not exist; treat as null.
      this.logger.debug(
        `microsandbox.get(${name}) returned no handle: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await sdk().Sandbox.remove(name);
    } catch (err) {
      this.logger.warn(
        `microsandbox.remove(${name}) failed: ${(err as Error).message}`,
      );
    } finally {
      this.portMappings.delete(name);
    }
  }

  async getAddress(
    name: string,
    internalPort: number,
  ): Promise<SandboxAddress | null> {
    const mapping = this.portMappings.get(name);
    if (!mapping) return null;
    // microsandbox forwards `hostPort` on the host to `guestPort` inside the
    // microVM, so we look up which host port (key) maps to the requested
    // internal/guest port (value).
    const hostPortStr = Object.entries(mapping).find(
      ([, guest]) => Number(guest) === internalPort,
    )?.[0];
    if (!hostPortStr) return null;
    const port = Number(hostPortStr);
    if (!Number.isFinite(port)) return null;
    return { host: '127.0.0.1', port };
  }

  /**
   * Re-register a known host-port → guest-port mapping for an existing
   * microsandbox instance. Used when `getAddress` is called after the runtime
   * provider has been restarted (the in-memory mapping is gone) but the
   * caller still has the original port mapping persisted alongside the
   * sandbox doc.
   */
  rememberPortMapping(name: string, ports: Record<string, number>): void {
    this.portMappings.set(name, { ...ports });
  }
}

function mapStatus(raw: unknown): RuntimeStatus {
  if (raw === 'running') return 'running';
  if (raw === 'stopped' || raw === 'detached') return 'stopped';
  return 'unknown';
}

class MicrosandboxSandbox implements RuntimeSandbox {
  constructor(
    readonly name: string,
    private readonly inst: MsbSandbox,
  ) {}

  async exec(command: string): Promise<ExecResult> {
    const result = await this.inst.shell(command);
    return {
      code: result.code,
      stdout: result.stdout(),
      stderr: result.stderr(),
    };
  }

  async execStream(command: string): Promise<ExecStream> {
    const handle: ExecHandle = await this.inst.shellStream(command);
    let stopped = false;

    async function* iterate(): AsyncGenerator<ExecStreamEvent> {
      while (!stopped) {
        const event: ExecEvent | null = await handle.recv();
        if (event === null) return;
        if (event.eventType === 'stdout' && event.data) {
          yield { type: 'stdout', data: Buffer.from(event.data) };
        } else if (event.eventType === 'stderr' && event.data) {
          yield { type: 'stderr', data: Buffer.from(event.data) };
        }
      }
    }

    return {
      events: iterate(),
      stop: async () => {
        stopped = true;
      },
    };
  }

  async readFile(path: string): Promise<Buffer> {
    const data = await this.inst.fs().read(path);
    return Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    await this.inst.fs().write(path, content);
  }

  async copyToHost(guestPath: string, hostPath: string): Promise<void> {
    await this.inst.fs().copyToHost(guestPath, hostPath);
  }

  async copyFromHost(hostPath: string, guestPath: string): Promise<void> {
    await this.inst.fs().copyFromHost(hostPath, guestPath);
  }

  async openShell(initialCwd?: string): Promise<ShellSession> {
    return new MicrosandboxShellSession(this.inst, initialCwd);
  }

  async detach(): Promise<void> {
    await this.inst.detach();
  }
}

/**
 * Microsandbox emulation of a persistent shell session.
 *
 * The microsandbox SDK only exposes one-shot `shell()` / `shellStream()`
 * calls, so there is no actual long-lived shell process to talk to. We fake
 * persistence by remembering the cwd in memory and re-`cd`-ing into it on
 * every call (using the same `buildWrappedCommand` wrapper as Docker so the
 * end-of-command marker tells us where the user's command left the cwd).
 *
 * Limitations vs. the Docker shell session:
 *   - `export VAR=...` inside a user command does NOT persist across calls.
 *     Callers that need persistent env vars must pass them via `ShellRunOptions.env`
 *     on every call (the same as the legacy agent exec API).
 *   - Shell functions, aliases, and any other in-shell state are lost between
 *     calls for the same reason.
 *
 * `cd` persistence works as expected, which is the most common need.
 */
class MicrosandboxShellSession implements ShellSession {
  private cwd: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private _closed = false;

  constructor(
    private readonly inst: MsbSandbox,
    initialCwd?: string,
  ) {
    this.cwd = initialCwd && initialCwd.trim() ? initialCwd : undefined;
  }

  get closed(): boolean {
    return this._closed;
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  async run(command: string, opts?: ShellRunOptions): Promise<ShellRunResult> {
    if (this._closed) throw new Error('Shell session is closed');
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((res) => {
      release = res;
    });
    await previous.catch(() => undefined);
    try {
      const marker = `__DEVIC_END_${randomUUID().replace(/-/g, '')}__`;
      const effectiveCwd = opts?.cwd ?? this.cwd;
      const wrapped = buildWrappedCommand(command, marker, {
        ...opts,
        cwd: effectiveCwd,
      });
      const result = await this.inst.shell(wrapped);
      const rawStdout = result.stdout();
      const rawStderr = result.stderr();
      const stdout = stripMarker(rawStdout, marker);
      const stderr = stripMarker(rawStderr, marker);
      const meta = stdout.meta ? parseStdoutMeta(stdout.meta) : null;
      const code = meta?.code ?? result.code ?? 0;
      const cwd = meta?.cwd ?? effectiveCwd ?? '';
      if (cwd) this.cwd = cwd;
      return {
        code,
        cwd,
        stdout: stdout.text,
        stderr: stderr.text,
      };
    } finally {
      release();
    }
  }

  async runStream(
    command: string,
    opts?: ShellRunOptions,
  ): Promise<ShellRunStream> {
    if (this._closed) throw new Error('Shell session is closed');
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((res) => {
      release = res;
    });
    await previous.catch(() => undefined);

    const marker = `__DEVIC_END_${randomUUID().replace(/-/g, '')}__`;
    const effectiveCwd = opts?.cwd ?? this.cwd;
    const wrapped = buildWrappedCommand(command, marker, {
      ...opts,
      cwd: effectiveCwd,
    });

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
    let stderrSeen = false;
    let resolveDone!: (v: { code: number; cwd: string }) => void;
    let rejectDone!: (err: Error) => void;
    const donePromise = new Promise<{ code: number; cwd: string }>(
      (res, rej) => {
        resolveDone = res;
        rejectDone = rej;
      },
    );

    const failWith = (err: Error) => {
      streamError = err;
      finishIterable();
      release();
      rejectDone(err);
    };

    const tryComplete = () => {
      if (stdoutMeta === null || !stderrSeen) return;
      const parsed = parseStdoutMeta(stdoutMeta);
      finishIterable();
      release();
      if (!parsed) {
        rejectDone(
          new Error(`shell: malformed end-of-command marker: ${stdoutMeta}`),
        );
        return;
      }
      if (parsed.cwd) this.cwd = parsed.cwd;
      resolveDone(parsed);
    };

    const stdoutProc = new MarkerProcessor(
      marker,
      (chunk) => pushEvent({ type: 'stdout', data: Buffer.from(chunk) }),
      (meta) => {
        stdoutMeta = meta;
        tryComplete();
      },
      failWith,
    );
    const stderrProc = new MarkerProcessor(
      marker,
      (chunk) => pushEvent({ type: 'stderr', data: Buffer.from(chunk) }),
      () => {
        stderrSeen = true;
        tryComplete();
      },
      failWith,
    );

    // Drive the underlying microsandbox stream in the background.
    (async () => {
      try {
        const handle: ExecHandle = await this.inst.shellStream(wrapped);
        while (true) {
          const event: ExecEvent | null = await handle.recv();
          if (event === null) break;
          if (event.eventType === 'stdout' && event.data) {
            stdoutProc.feed(Buffer.from(event.data));
          } else if (event.eventType === 'stderr' && event.data) {
            stderrProc.feed(Buffer.from(event.data));
          }
        }
        // Stream closed before we saw both markers — surface as error.
        if (!streamDone) {
          stdoutProc.abort();
          stderrProc.abort();
        }
      } catch (err) {
        failWith(err as Error);
      }
    })();

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
}

/**
 * One-shot marker extraction for the non-streaming `run()` path. Returns the
 * portion of `raw` before the marker as `text`, plus the metadata that
 * follows on the same line as `meta` (or null if the marker is absent).
 */
function stripMarker(
  raw: string,
  marker: string,
): { text: string; meta?: string } {
  const idx = raw.indexOf(marker);
  if (idx === -1) return { text: raw };
  const before = raw.slice(0, idx);
  const after = raw.slice(idx + marker.length);
  const nl = after.indexOf('\n');
  const meta = nl === -1 ? after : after.slice(0, nl);
  return { text: before, meta };
}
