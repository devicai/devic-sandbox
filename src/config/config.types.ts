export interface ModuleConfig {
  server: ServerConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  defaults: SandboxDefaultsConfig;
  runtime: RuntimeConfig;
  mcp: McpConfig;
  extensions: ExtensionsConfig;
  auth: AuthConfig;
  webhooks?: WebhooksConfig;
  logging: LoggingConfig;
  resourceLimits?: ResourceLimitsConfig;
  hotPool?: HotPoolConfig;
  ingress?: IngressConfig;
  snapshots?: SnapshotsConfig;
}

export interface ServerConfig {
  port: number;
  basePath: string;
  cors?: {
    enabled: boolean;
    origins: string[];
  };
}

export interface DatabaseConfig {
  provider: 'mongodb';
  uri?: string;
}

export interface RedisConfig {
  url: string;
}

/**
 * Default values applied when a CreateSandboxDto / restore omits them.
 * Shared by all runtime backends.
 */
export interface SandboxDefaultsConfig {
  defaultImage: string;
  defaultCpus: number;
  defaultMemoryMib: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  ttlCheckIntervalMs: number;
}

export type RuntimeType = 'microsandbox' | 'docker';

export interface RuntimeConfig {
  type: RuntimeType;
  docker?: DockerRuntimeConfig;
}

export interface DockerRuntimeConfig {
  /** Path to the Docker daemon socket. Defaults to /var/run/docker.sock. */
  socketPath?: string;
  /** OCI runtime to launch each sandbox container with. */
  runtime?: 'sysbox-runc' | 'runc';
  /** Docker network to attach sandboxes to when networkPolicy=allow-all. */
  network?: string;
  hardening?: DockerHardeningConfig;
}

export interface DockerHardeningConfig {
  /** Drop ALL Linux capabilities at container start. Default: true. */
  dropAllCaps?: boolean;
  /** Set --security-opt=no-new-privileges. Default: true. */
  noNewPrivileges?: boolean;
  /** Mount rootfs read-only. Many workloads (apt, npm install) break with this. Default: false. */
  readOnlyRootfs?: boolean;
  /** Seccomp profile path or 'default' for Docker's default profile. Default: 'default'. */
  seccompProfile?: string;
  /** Maximum number of processes inside the container. Default: 512. */
  pidsLimit?: number;
}

export interface McpConfig {
  enabled: boolean;
  path?: string;
}

export interface ExtensionsConfig {
  properties: ExtensionProperty[];
}

export interface ExtensionProperty {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  required: boolean;
  index: boolean;
  entities: string[] | '*';
  source: 'header';
  headerName: string;
}

export interface AuthConfig {
  enabled: boolean;
  strategy: 'api-key' | 'jwt' | 'none';
  apiKeys?: Array<{
    name: string;
    key: string;
  }>;
}

export interface WebhooksConfig {
  events: Record<string, string>;
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'pretty';
}

/**
 * Snapshot behaviour. A snapshot can capture the whole filesystem diff vs the
 * base image (`full` — installed packages, /usr/local/bin, /etc all survive a
 * restore) or just the working directory (`workdir` — lighter, legacy). Full
 * snapshots stay small by storing only the *diff* (compressed) and skipping
 * regenerable caches.
 */
export interface SnapshotsConfig {
  /** Scope used when a create request omits it. Default: 'full'. */
  defaultScope?: 'full' | 'workdir';
  /**
   * Compression for full snapshots. The value also decides WHERE it runs:
   *   - 'gzip' (and 'auto'): streamed inside the sandbox (`tar | gzip`) — CPU is
   *     charged to the tenant's quota, no uncompressed staging, restore needs
   *     only the universal gzip. Recommended default for a shared host.
   *   - 'zstd': sandbox emits a plain tar and the HOST compresses with Node's
   *     zlib (smaller artifacts, but unmetered host CPU + transient staging;
   *     restore also decompresses host-side so the base image needn't have
   *     zstd). Falls back to gzip if this Node build lacks zstd support.
   * Default: 'auto'.
   */
  compression?: 'auto' | 'zstd' | 'gzip';
  /**
   * How aggressively to drop regenerable content from a full snapshot to save
   * disk. 'conservative' (default) excludes package-manager caches; 'none'
   * captures the diff verbatim; 'aggressive' additionally drops logs, residual
   * tmp and man/doc.
   */
  cleanup?: 'conservative' | 'none' | 'aggressive';
  /**
   * Extra absolute path prefixes (or glob-ish suffixes like `**​/__pycache__`)
   * to exclude from full snapshots, merged on top of the `cleanup` preset.
   */
  excludePaths?: string[];
}

export interface ResourceLimitsConfig {
  /** Maximum total RAM (MiB) allocated across all running sandboxes. 0/undefined disables the limit. */
  maxTotalMemoryMib?: number;
  /** Maximum total disk usage (bytes) for stored snapshots. 0/undefined disables the limit. */
  maxTotalDiskBytes?: number;
}

/**
 * Hot Pool keeps a fleet of pre-warmed sandboxes (restored from a configured
 * snapshot) ready to be claimed instantly, avoiding the cold-start penalty
 * of creating + restoring a sandbox on demand.
 *
 * The pool reserves a slice of the total memory budget (resourceLimits.maxTotalMemoryMib)
 * proportional to `memoryReservePercent`. As long as the pool isn't full,
 * new on-demand sandboxes can't grow into the reserved portion.
 */
export interface HotPoolConfig {
  /** Master switch. */
  enabled: boolean;
  /** Snapshot ID used as the source for every hot sandbox. */
  snapshotId?: string;
  /**
   * Percentage (0–100) of `resourceLimits.maxTotalMemoryMib` reserved for
   * the hot pool. Required when `maxTotalMemoryMib` is set; otherwise the
   * pool falls back to a fixed `targetSize`.
   */
  memoryReservePercent?: number;
  /** Memory (MiB) of each individual hot sandbox. */
  memoryMibPerSandbox?: number;
  /** CPUs of each hot sandbox. */
  cpus?: number;
  /** Lower bound for pool size (irrespective of memory budget). */
  minSize?: number;
  /** Hard cap on pool size. */
  maxSize?: number;
  /**
   * Optional fixed pool size. Overrides percentage-based sizing when set.
   * Useful when no `maxTotalMemoryMib` cap is configured.
   */
  targetSize?: number;
  /** Reconcile cadence in milliseconds. */
  reconcileIntervalMs?: number;
}

/**
 * Public ingress: expose each running sandbox at <sandboxId>.<wildcardDomain>.
 * The module runs an embedded HTTP reverse proxy that resolves the Host header
 * to a sandbox upstream and forwards the request. TLS is expected to be
 * terminated upstream (Cloudflare / CDN / external LB).
 */
export interface IngressConfig {
  /** Master switch. When false, sandboxes are never published. */
  enabled: boolean;
  /**
   * Domain under which sandboxes are exposed. Public URLs become
   * `<sandboxId>.<wildcardDomain>` (e.g. `abc123.sandbox.devic.ai`).
   * The operator is responsible for the wildcard DNS record + TLS at the edge.
   */
  wildcardDomain: string;
  /**
   * Public scheme used to render `publicUrl` for callers. Defaults to `https`
   * since TLS termination is expected upstream.
   */
  publicScheme?: 'http' | 'https';
  /** Port the embedded reverse proxy listens on. Default 8080. */
  proxyPort?: number;
  /** Bind address for the proxy listener. Default '0.0.0.0'. */
  proxyHost?: string;
  /**
   * Default port inside the sandbox to forward HTTP traffic to. Each sandbox
   * may override this via its own `exposedHttpPort`. Default 80.
   */
  defaultUpstreamPort?: number;
  /**
   * Per-request upstream timeout (ms). Default 30000.
   */
  upstreamTimeoutMs?: number;
  /**
   * Max upstream cache TTL (s) for the subdomain → endpoint mapping in Redis.
   * Refreshed each time a sandbox publishes. Default: derived from sandbox
   * `expiresAt`, capped at 24h.
   */
  registryMaxTtlSeconds?: number;
}
