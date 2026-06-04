/**
 * Pure helpers for full-filesystem snapshots.
 *
 * A "full" snapshot captures the container's filesystem *diff* against its base
 * image (everything `docker diff` reports — installed packages, /usr/local/bin
 * binaries, /etc configs — not just the workdir). To keep the artifact small we
 * archive only the changed paths and skip regenerable caches.
 *
 * This module is intentionally side-effect free (no Docker, no fs): it only
 * decides which paths to keep and builds the shell snippets the service runs
 * inside the sandbox. That keeps it unit-testable.
 */

export type CleanupPreset = 'conservative' | 'none' | 'aggressive';

/** Pseudo / runtime filesystems and our own temp files — never snapshot these. */
const ALWAYS_EXCLUDE_PREFIXES = [
  '/proc',
  '/sys',
  '/dev',
  '/tmp',
  '/run',
  '/var/run',
  '/var/lock',
];

/**
 * Package-manager and tooling caches that any build can recreate. Note `/home`
 * is deliberately NOT here (users may keep real files there); only concrete
 * cache directories are listed.
 */
const CONSERVATIVE_EXCLUDE_PREFIXES = [
  '/var/lib/apt/lists',
  '/var/cache/apt',
  '/var/cache/debconf',
  '/root/.npm',
  '/root/.cache',
  '/usr/local/share/.cache',
];

/** Logs / docs / locale — safe to drop when squeezing disk hardest. */
const AGGRESSIVE_EXTRA_PREFIXES = [
  '/var/log',
  '/usr/share/man',
  '/usr/share/doc',
  '/usr/share/locale',
];

/** Path *segments* (any component equal to this) that are pure cache. */
const SEGMENT_EXCLUDES = ['__pycache__'];

/** Multi-segment cache directories matched anywhere in the path. */
const SUBPATH_EXCLUDES = ['node_modules/.cache'];

export interface ExcludeConfig {
  cleanup: CleanupPreset;
  /** Extra absolute prefixes or segment/subpath patterns from config. */
  extra?: string[];
}

/**
 * Build the predicate that decides whether a path is excluded from a full
 * snapshot. Used both to filter the `docker diff` list and the delete manifest.
 */
export function buildExcludeMatcher(cfg: ExcludeConfig): (path: string) => boolean {
  const prefixes = [...ALWAYS_EXCLUDE_PREFIXES];
  if (cfg.cleanup !== 'none') prefixes.push(...CONSERVATIVE_EXCLUDE_PREFIXES);
  if (cfg.cleanup === 'aggressive') prefixes.push(...AGGRESSIVE_EXTRA_PREFIXES);

  const segments = [...SEGMENT_EXCLUDES];
  const subpaths = [...SUBPATH_EXCLUDES];
  for (const e of cfg.extra ?? []) {
    if (e.startsWith('/')) prefixes.push(e.replace(/\/+$/, ''));
    else if (e.includes('/')) subpaths.push(e);
    else segments.push(e);
  }

  return (raw: string): boolean => {
    const p = raw.startsWith('/') ? raw : `/${raw}`;
    for (const pre of prefixes) {
      if (p === pre || p.startsWith(`${pre}/`)) return true;
    }
    const comps = p.split('/');
    if (comps.some((c) => c.startsWith('.devic-runtime-'))) return true;
    for (const seg of segments) {
      if (comps.includes(seg)) return true;
    }
    for (const sub of subpaths) {
      if (p.includes(`/${sub}/`) || p.endsWith(`/${sub}`)) return true;
    }
    return false;
  };
}

export interface FullCapturePartition {
  /** Changed/added paths to archive, made relative to `/` (no leading slash). */
  present: string[];
  /** Deleted paths (absolute) to `rm -rf` on restore. */
  deletes: string[];
  excludedCount: number;
}

/**
 * Split a `docker diff` result into the paths to archive vs the paths that were
 * deleted vs the ones we drop, applying the exclude matcher to both kept and
 * deleted sets (no point recording a delete under an excluded cache).
 */
export function partitionChanges(
  changes: Array<{ path: string; kind: 'A' | 'C' | 'D' }>,
  isExcluded: (p: string) => boolean,
): FullCapturePartition {
  const present: string[] = [];
  const deletes: string[] = [];
  let excludedCount = 0;
  for (const c of changes) {
    if (isExcluded(c.path)) {
      excludedCount++;
      continue;
    }
    if (c.kind === 'D') deletes.push(c.path);
    else present.push(c.path.replace(/^\/+/, '')); // relative to /
  }
  return { present, deletes, excludedCount };
}

/** Shell-quote a single argument for POSIX sh. */
export function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether a delete path is safe to `rm -rf` on restore. Rejects anything that
 * is not a concrete absolute path (no root, no relative, no traversal).
 */
export function isSafeDeletePath(p: string): boolean {
  return (
    typeof p === 'string' &&
    p.startsWith('/') &&
    p !== '/' &&
    !p.split('/').includes('..')
  );
}
