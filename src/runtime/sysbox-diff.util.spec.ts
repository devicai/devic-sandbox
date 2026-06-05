import {
  buildManifestFindCommand,
  diffManifests,
  parseManifest,
} from './sysbox-diff.util';

describe('buildManifestFindCommand', () => {
  const cmd = buildManifestFindCommand();
  it('prunes pseudo and sysbox-volatile trees', () => {
    expect(cmd).toContain('-path /proc');
    expect(cmd).toContain('-path /var/lib/docker');
    expect(cmd).toContain('-prune');
  });
  it('emits path<TAB>size for files and symlinks', () => {
    expect(cmd).toContain('-type f -o -type l');
    expect(cmd).toContain('-printf "%p\\t%s\\n"');
  });
  it('drops stderr', () => {
    expect(cmd).toContain('2>/dev/null');
  });
});

describe('parseManifest', () => {
  it('parses path/size lines, tolerating CRLF and blanks', () => {
    const m = parseManifest('/a\t10\r\n/b/c\t0\n\n/d\t999\n');
    expect(m.get('/a')).toBe(10);
    expect(m.get('/b/c')).toBe(0);
    expect(m.get('/d')).toBe(999);
    expect(m.size).toBe(3);
  });
  it('splits on the last tab so paths with tabs keep their size', () => {
    const m = parseManifest('/weird\tname\t42\n');
    expect(m.get('/weird\tname')).toBe(42);
  });
  it('skips malformed lines', () => {
    const m = parseManifest('no-tab-here\n/ok\t5\n');
    expect(m.has('no-tab-here')).toBe(false);
    expect(m.get('/ok')).toBe(5);
  });
});

describe('diffManifests', () => {
  it('detects added, deleted and size-changed paths', () => {
    const base = new Map<string, number>([
      ['/usr/bin/node', 1000],
      ['/etc/hosts', 50],
      ['/etc/debian_version', 5],
    ]);
    const current = new Map<string, number>([
      ['/usr/bin/node', 1000], // unchanged
      ['/etc/hosts', 80], // size changed
      ['/usr/local/bin/snaptool', 30], // added
      // /etc/debian_version removed
    ]);
    const changes = diffManifests(base, current);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.kind]));
    expect(byPath['/usr/local/bin/snaptool']).toBe('A');
    expect(byPath['/etc/hosts']).toBe('C');
    expect(byPath['/etc/debian_version']).toBe('D');
    expect(byPath['/usr/bin/node']).toBeUndefined(); // unchanged → omitted
    expect(changes).toHaveLength(3);
  });

  it('returns nothing for identical manifests (zero sysbox-injection noise)', () => {
    const m = new Map<string, number>([
      ['/usr/lib/a', 1],
      ['/usr/lib/b', 2],
    ]);
    expect(diffManifests(new Map(m), new Map(m))).toEqual([]);
  });
});
