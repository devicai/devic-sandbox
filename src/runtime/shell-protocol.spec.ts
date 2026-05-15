import {
  buildWrappedCommand,
  MarkerProcessor,
  parseStdoutMeta,
  shellEscape,
} from './shell-protocol';

describe('shellEscape', () => {
  it('wraps simple strings in single quotes', () => {
    expect(shellEscape('hello')).toBe(`'hello'`);
  });

  it('escapes embedded single quotes', () => {
    expect(shellEscape(`it's`)).toBe(`'it'\\''s'`);
  });
});

describe('parseStdoutMeta', () => {
  it('parses :CODE:CWD', () => {
    expect(parseStdoutMeta(':0:/workspace')).toEqual({
      code: 0,
      cwd: '/workspace',
    });
  });

  it('parses non-zero exit codes', () => {
    expect(parseStdoutMeta(':127:/tmp')).toEqual({
      code: 127,
      cwd: '/tmp',
    });
  });

  it('tolerates colons in the cwd', () => {
    // Unlikely on POSIX paths but the parser only consumes the first colon
    // after the code.
    expect(parseStdoutMeta(':0:/weird:path')).toEqual({
      code: 0,
      cwd: '/weird:path',
    });
  });

  it('returns null for malformed input', () => {
    expect(parseStdoutMeta('garbage')).toBeNull();
    expect(parseStdoutMeta(':abc:/x')).toBeNull();
    expect(parseStdoutMeta(':0')).toBeNull();
  });
});

describe('buildWrappedCommand', () => {
  const MARKER = '__DEVIC_END_TESTUUID__';

  it('base64-encodes the user command so it cannot break the wrapper', () => {
    const wrapped = buildWrappedCommand('echo "hi"; rm -rf nothing', MARKER);
    const b64 = Buffer.from('echo "hi"; rm -rf nothing', 'utf-8').toString(
      'base64',
    );
    expect(wrapped).toContain(`'${b64}'`);
    // The literal user command must NOT appear unencoded.
    expect(wrapped).not.toContain('rm -rf nothing');
  });

  it('emits markers on both stdout and stderr', () => {
    const wrapped = buildWrappedCommand('true', MARKER);
    // stdout marker carries metadata.
    expect(wrapped).toContain(`'${MARKER}:%d:%s\\n'`);
    // stderr marker is a bare sync barrier.
    expect(wrapped).toContain(`'${MARKER}\\n' >&2`);
  });

  it('emits exports for per-call env overrides', () => {
    const wrapped = buildWrappedCommand('true', MARKER, {
      env: { FOO: 'bar', QUOTED: "it's" },
    });
    expect(wrapped).toContain(`export FOO='bar'`);
    expect(wrapped).toContain(`export QUOTED='it'\\''s'`);
  });

  it('cd-prefixes the command when cwd is provided', () => {
    const wrapped = buildWrappedCommand('pwd', MARKER, { cwd: '/srv/x' });
    expect(wrapped).toContain(`cd '/srv/x' && eval "$__DEVIC_CMD"`);
  });

  it('omits cd when cwd is absent', () => {
    const wrapped = buildWrappedCommand('pwd', MARKER);
    expect(wrapped).not.toContain('cd ');
    expect(wrapped).toContain('eval "$__DEVIC_CMD"');
  });
});

describe('MarkerProcessor', () => {
  const MARKER = '__DEVIC_END_TESTUUID__';

  function makeProc() {
    const data: Buffer[] = [];
    const completes: string[] = [];
    const errors: Error[] = [];
    const proc = new MarkerProcessor(
      MARKER,
      (c) => data.push(c),
      (m) => completes.push(m),
      (e) => errors.push(e),
    );
    return { proc, data, completes, errors };
  }

  it('forwards user output before the marker verbatim', () => {
    const { proc, data, completes } = makeProc();
    proc.feed(Buffer.from('hello world\n'));
    // Marker not arrived yet — the hold-back buffer keeps the last
    // (markerLen - 1) bytes pending.
    const total = Buffer.concat(data).toString('utf-8');
    expect('hello world\n'.startsWith(total)).toBe(true);
    expect(completes).toEqual([]);
  });

  it('flushes pending bytes once the marker arrives', () => {
    const { proc, data, completes } = makeProc();
    proc.feed(Buffer.from('hello world\n'));
    proc.feed(Buffer.from(`${MARKER}:0:/workspace\n`));
    expect(Buffer.concat(data).toString('utf-8')).toBe('hello world\n');
    expect(completes).toEqual([':0:/workspace']);
  });

  it('detects markers that span chunk boundaries', () => {
    const { proc, data, completes } = makeProc();
    const cut = 6; // arbitrary split inside the marker bytes
    const fullLine = `output\n${MARKER}:0:/x\n`;
    proc.feed(Buffer.from(fullLine.slice(0, fullLine.indexOf(MARKER) + cut)));
    proc.feed(Buffer.from(fullLine.slice(fullLine.indexOf(MARKER) + cut)));
    expect(Buffer.concat(data).toString('utf-8')).toBe('output\n');
    expect(completes).toEqual([':0:/x']);
  });

  it('waits for the trailing newline before completing', () => {
    const { proc, completes } = makeProc();
    proc.feed(Buffer.from(`${MARKER}:0:/work`));
    expect(completes).toEqual([]);
    proc.feed(Buffer.from(`space\n`));
    expect(completes).toEqual([':0:/workspace']);
  });

  it('reports abort with custom error', () => {
    const { proc, errors } = makeProc();
    proc.abort(new Error('boom'));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('boom');
  });

  it('reports abort with default error when no error supplied', () => {
    const { proc, errors } = makeProc();
    proc.abort();
    expect(errors[0].message).toMatch(/closed/);
  });

  it('does not emit after completion', () => {
    const { proc, data, completes } = makeProc();
    proc.feed(Buffer.from(`done\n${MARKER}:0:/x\nstraggler bytes`));
    expect(Buffer.concat(data).toString('utf-8')).toBe('done\n');
    expect(completes).toEqual([':0:/x']);
    // Subsequent feeds are no-ops after `done` flag.
    proc.feed(Buffer.from('more'));
    expect(Buffer.concat(data).toString('utf-8')).toBe('done\n');
  });
});
