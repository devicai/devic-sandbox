/**
 * Wire protocol shared by every runtime that exposes a persistent shell
 * session. Two pieces:
 *
 *   1. `buildWrappedCommand` — wraps the user command so we can detect when
 *      it has finished and recover its exit code + the resulting cwd, without
 *      having to escape the user input (it travels as base64).
 *
 *   2. `MarkerProcessor` — stateful per-stream scanner that forwards user
 *      output verbatim, holds back potential marker prefixes across chunk
 *      boundaries, and reports completion once the marker line has been
 *      consumed in full.
 *
 * The same protocol is used by the Docker runtime (one long-lived `/bin/sh`
 * process talking over stdin) and the Microsandbox runtime (one-shot SDK
 * shells wrapped to emulate persistence of cwd).
 */

import { ShellRunOptions } from './runtime-provider.interface';

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseStdoutMeta(
  meta: string,
): { code: number; cwd: string } | null {
  if (!meta.startsWith(':')) return null;
  const rest = meta.slice(1);
  const colon = rest.indexOf(':');
  if (colon === -1) return null;
  const code = Number(rest.slice(0, colon));
  if (!Number.isFinite(code)) return null;
  const cwd = rest.slice(colon + 1);
  return { code, cwd };
}

/**
 * Build the wrapper that runs `userCommand` inside a shell and emits the
 * end-of-command markers on stdout (with `:CODE:CWD\n` metadata) and stderr
 * (bare `\n`). The user command is base64-encoded and decoded inline by the
 * shell, so its content cannot affect the wrapper structure regardless of
 * quoting, newlines, or coincidental marker-looking strings.
 */
export function buildWrappedCommand(
  userCommand: string,
  marker: string,
  opts?: ShellRunOptions,
): string {
  const b64 = Buffer.from(userCommand, 'utf-8').toString('base64');
  const parts: string[] = [];
  if (opts?.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      // Per-call env exports persist past this call by design — matches the
      // legacy behaviour of the agent exec API. Callers that want scoped
      // overrides can wrap their command in `( ... )` themselves.
      parts.push(`export ${k}=${shellEscape(v)}`);
    }
  }
  parts.push(`__DEVIC_CMD=$(printf '%s' '${b64}' | base64 -d)`);
  if (opts?.cwd) {
    parts.push(
      `{ cd ${shellEscape(opts.cwd)} && eval "$__DEVIC_CMD"; }`,
    );
  } else {
    parts.push(`eval "$__DEVIC_CMD"`);
  }
  parts.push(`__DEVIC_EC=$?`);
  parts.push(`printf '${marker}:%d:%s\\n' "$__DEVIC_EC" "$(pwd)"`);
  parts.push(`printf '${marker}\\n' >&2`);
  return parts.join('; ');
}

/**
 * Stateful scanner for one of stdout/stderr that:
 *   - forwards user output chunks to `onData` as they arrive,
 *   - holds back the trailing bytes that could be the start of `marker`
 *     so we never emit a partial marker to the caller,
 *   - on detecting the marker, captures the rest of the line (terminated by
 *     `\n`) as `meta` and invokes `onComplete(meta)` exactly once.
 *
 * Bytes after the trailing newline are ignored (no other writer is expected
 * to be active on this stream while we're waiting for completion).
 */
export class MarkerProcessor {
  private buffer = Buffer.alloc(0);
  private foundMarker = false;
  private metaBuffer = Buffer.alloc(0);
  private done = false;
  private readonly markerBytes: Buffer;

  constructor(
    marker: string,
    private readonly onData: (chunk: Buffer) => void,
    private readonly onComplete: (meta: string) => void,
    private readonly onError: (err: Error) => void,
  ) {
    this.markerBytes = Buffer.from(marker, 'utf-8');
  }

  feed(chunk: Buffer): void {
    if (this.done) return;
    if (this.foundMarker) {
      this.consumeMetaChunk(chunk);
      return;
    }
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, chunk]);
    const idx = this.buffer.indexOf(this.markerBytes);
    if (idx === -1) {
      const holdBack = this.markerBytes.length - 1;
      if (this.buffer.length <= holdBack) return;
      const cutoff = this.buffer.length - holdBack;
      const safe = this.buffer.subarray(0, cutoff);
      const remainder = Buffer.from(this.buffer.subarray(cutoff));
      this.buffer = remainder;
      if (safe.length > 0) this.onData(Buffer.from(safe));
      return;
    }
    this.foundMarker = true;
    const before = this.buffer.subarray(0, idx);
    const after = this.buffer.subarray(idx + this.markerBytes.length);
    this.buffer = Buffer.alloc(0);
    if (before.length > 0) this.onData(Buffer.from(before));
    this.consumeMetaChunk(Buffer.from(after));
  }

  abort(err?: Error): void {
    if (this.done) return;
    this.done = true;
    this.onError(
      err ?? new Error('shell stream closed before command completed'),
    );
  }

  private consumeMetaChunk(chunk: Buffer): void {
    this.metaBuffer =
      this.metaBuffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.metaBuffer, chunk]);
    const nl = this.metaBuffer.indexOf(0x0a);
    if (nl === -1) return;
    const metaLine = this.metaBuffer.subarray(0, nl).toString('utf-8');
    this.done = true;
    this.onComplete(metaLine);
  }
}
