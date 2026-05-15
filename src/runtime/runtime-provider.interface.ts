/**
 * Abstraction over the underlying sandbox runtime.
 *
 * Two implementations exist:
 *   - MicrosandboxRuntimeProvider — wraps the microsandbox SDK (libkrun microVMs, requires KVM).
 *   - DockerRuntimeProvider       — wraps the Docker daemon (uses sysbox-runc / runc, no KVM).
 *
 * Higher-level services (sandboxes, snapshots, ttl, terminal) depend ONLY on this interface.
 */

export interface RuntimeSandboxConfig {
  name: string;
  image: string;
  workdir: string;
  cpus: number;
  memoryMib: number;
  env: Record<string, string>;
  /** hostPort -> guestPort */
  ports?: Record<string, number>;
  networkPolicy?: 'allow-all' | 'deny-all';
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecStreamEvent {
  type: 'stdout' | 'stderr';
  data: Buffer;
}

export interface ExecStream {
  events: AsyncIterable<ExecStreamEvent>;
  /** Stop the stream and release resources. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Persistent shell session bound to a single sandbox. Commands sent through
 * the same session share environment, working directory, shell options, and
 * any other in-shell state (functions, aliases) — so `export FOO=bar` in one
 * call is visible to the next, and `cd subdir` actually moves the cwd.
 *
 * Implementations serialize concurrent calls per session; callers may queue
 * commands freely without external locking.
 */
export interface ShellSession {
  /** Run a command to completion and return aggregated stdout/stderr. */
  run(command: string, opts?: ShellRunOptions): Promise<ShellRunResult>;
  /**
   * Run a command, streaming stdout/stderr as it arrives. `done` resolves with
   * the final exit code and resulting cwd once the command finishes; the
   * `events` iterable terminates at the same point.
   */
  runStream(command: string, opts?: ShellRunOptions): Promise<ShellRunStream>;
  /** Tear the session down. Idempotent. */
  close(): Promise<void>;
  /** True once the underlying shell process has exited (e.g. user `exit`). */
  readonly closed: boolean;
}

export interface ShellRunOptions {
  /**
   * Change directory before running the command. The shell `cd` is real and
   * persists for subsequent calls in this session. Defaults to the session's
   * current cwd.
   */
  cwd?: string;
  /**
   * Environment overrides scoped to this single command (exported inline
   * before running). Use plain `export X=Y` inside a command if you want the
   * value to persist across calls.
   */
  env?: Record<string, string>;
}

export interface ShellRunResult {
  code: number;
  /** cwd of the session after the command (reflects internal `cd`s). */
  cwd: string;
  stdout: string;
  stderr: string;
}

export interface ShellRunStream {
  events: AsyncIterable<ExecStreamEvent>;
  done: Promise<{ code: number; cwd: string }>;
}

export type RuntimeStatus = 'running' | 'stopped' | 'unknown';

/**
 * Active connection to a sandbox. Exec / fs operations go through this object.
 */
export interface RuntimeSandbox {
  readonly name: string;

  /** One-shot command. Resolves with full stdout/stderr/exitCode. */
  exec(command: string): Promise<ExecResult>;

  /** Streaming command for interactive use (terminal gateway). */
  execStream(command: string): Promise<ExecStream>;

  /**
   * Open a persistent shell session whose env vars, cwd, shell functions and
   * other shell state survive across calls. Same session may back both the
   * agent-facing exec API and the interactive terminal, so they observe a
   * consistent view of the sandbox.
   */
  openShell(initialCwd?: string): Promise<ShellSession>;

  /** Read a file from the sandbox filesystem. */
  readFile(path: string): Promise<Buffer>;

  /** Write a file to the sandbox filesystem (creates parents if needed). */
  writeFile(path: string, content: Buffer): Promise<void>;

  /** Copy a single file out of the sandbox to the host filesystem. */
  copyToHost(guestPath: string, hostPath: string): Promise<void>;

  /** Copy a single file from the host filesystem into the sandbox. */
  copyFromHost(hostPath: string, guestPath: string): Promise<void>;

  /** Stop the sandbox without removing its filesystem state. */
  detach(): Promise<void>;
}

export interface RuntimeHandle {
  status: RuntimeStatus;
  /** Reattach to a running sandbox. */
  connect(): Promise<RuntimeSandbox>;
  /** Start a stopped sandbox. */
  start(): Promise<RuntimeSandbox>;
}

/**
 * Network endpoint at which the calling process can reach a sandbox over TCP.
 * Returned by `RuntimeProvider.getAddress` and used by the public ingress proxy.
 */
export interface SandboxAddress {
  /** Host or IP reachable from the devic-sandbox process. */
  host: string;
  /** TCP port reachable at `host`. */
  port: number;
}

export interface RuntimeProvider {
  /** Create + start a new sandbox. The returned object is already running. */
  create(config: RuntimeSandboxConfig): Promise<RuntimeSandbox>;

  /** Look up an existing sandbox by name. Returns null if it does not exist. */
  get(name: string): Promise<RuntimeHandle | null>;

  /** Permanently delete a sandbox and reclaim its resources. Idempotent. */
  remove(name: string): Promise<void>;

  /**
   * Resolve a TCP endpoint reachable from this process for the given sandbox
   * and an internal port (the port a service inside the sandbox listens on).
   * Returns null if the sandbox does not exist or the port is not reachable.
   */
  getAddress(
    name: string,
    internalPort: number,
  ): Promise<SandboxAddress | null>;

  /**
   * Optional: ensure the calling process can reach this sandbox over the
   * network. For Docker with per-sandbox networks, this connects the local
   * (self) container to the sandbox's dedicated bridge so the proxy can
   * route to the bridge IP. No-op for runtimes where reachability is given
   * (e.g. microsandbox host-port forwarding) or when the calling process
   * lives on the host directly.
   */
  attachLocal?(name: string): Promise<void>;

  /**
   * Optional: tear down whatever `attachLocal` set up. Idempotent.
   */
  detachLocal?(name: string): Promise<void>;
}

export const RUNTIME_PROVIDER = Symbol('RUNTIME_PROVIDER');
