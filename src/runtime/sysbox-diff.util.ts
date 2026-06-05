/**
 * Filesystem-diff helpers for the `sysbox-runc` runtime.
 *
 * `docker diff` (container.changes()) does NOT report changes under the
 * directories sysbox mounts internally (/usr, /etc, /lib, /var, ...), so a
 * full-filesystem snapshot built from it would silently miss installed packages
 * and system configs (see DockerSandbox.diff()). Verified A/B on one daemon:
 * runc reports every change, sysbox-runc reports only /root, /home and the
 * workdir.
 *
 * The workaround is to compute the diff from INSIDE the container (where the
 * filesystem is fully merged and visible) with `find`, comparing against a
 * baseline `find` of a fresh sysbox container of the same image:
 *
 *   - sysbox injects ~thousands of files (inner Docker/containerd/systemd) into
 *     every container, but DETERMINISTICALLY: two fresh sysbox containers of the
 *     same image are byte-identical in (path, size). So baselining against a
 *     fresh sysbox container of the image cancels every injected file and leaves
 *     exactly the user's changes. (Baselining against a `runc` container would
 *     NOT cancel them — it must be a sysbox baseline.)
 *
 * This module is pure (no Docker, no fs): it builds the `find` command and
 * computes the change set from two manifests, so it is unit-testable.
 */

import { FsChange } from './runtime-provider.interface';

/**
 * Paths pruned from the manifest walk: pseudo-filesystems, volatile runtime
 * state, and the inner-runtime trees sysbox manages (which are not user state).
 * Both the baseline and the live walk MUST use the same prune set to be
 * comparable.
 */
export const MANIFEST_PRUNE_PATHS = [
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/tmp',
  '/var/run',
  '/var/lock',
  '/var/lib/docker',
  '/var/lib/containerd',
  '/var/lib/kubelet',
];

/**
 * `find` command that emits one `<path>\t<size>` line per regular file and
 * symlink, pruning the volatile/pseudo trees. stderr is dropped so unreadable
 * paths don't pollute the manifest.
 */
export function buildManifestFindCommand(): string {
  const prune = MANIFEST_PRUNE_PATHS.map((p) => `-path ${p}`).join(' -o ');
  return (
    `find / \\( ${prune} \\) -prune -o ` +
    `\\( -type f -o -type l \\) -printf "%p\\t%s\\n" 2>/dev/null`
  );
}

/**
 * Parse `find -printf "%p\t%s\n"` output into a path→size map. The size column
 * is split on the LAST tab so paths containing tabs (rare) keep their value.
 */
export function parseManifest(text: string): Map<string, number> {
  const manifest = new Map<string, number>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const tab = line.lastIndexOf('\t');
    if (tab <= 0) continue;
    const path = line.slice(0, tab);
    const size = Number(line.slice(tab + 1));
    manifest.set(path, Number.isFinite(size) ? size : -1);
  }
  return manifest;
}

/**
 * Compute the change set of `current` relative to `base`:
 *   - added (path only in current)        → 'A'
 *   - size-changed (path in both, ≠ size) → 'C'
 *   - deleted (path only in base)         → 'D'
 *
 * Size is used as the change signal (not mtime): for fresh sysbox containers the
 * (path, size) manifest is identical, so this yields zero noise; mtime would
 * diverge on sysbox-injected files. The trade-off is that a same-size content
 * edit is not detected as changed — uncommon and acceptable for the "persist
 * installed packages / configs" use case (installs surface as added paths).
 */
export function diffManifests(
  base: Map<string, number>,
  current: Map<string, number>,
): FsChange[] {
  const changes: FsChange[] = [];
  for (const [path, size] of current) {
    if (!base.has(path)) changes.push({ path, kind: 'A' });
    else if (base.get(path) !== size) changes.push({ path, kind: 'C' });
  }
  for (const path of base.keys()) {
    if (!current.has(path)) changes.push({ path, kind: 'D' });
  }
  return changes;
}
