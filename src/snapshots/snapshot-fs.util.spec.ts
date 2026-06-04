import {
  buildExcludeMatcher,
  partitionChanges,
  isSafeDeletePath,
  sh,
} from './snapshot-fs.util';

describe('buildExcludeMatcher', () => {
  it('always excludes pseudo / runtime filesystems and our temp files', () => {
    const ex = buildExcludeMatcher({ cleanup: 'none' });
    expect(ex('/proc/1/status')).toBe(true);
    expect(ex('/sys/kernel')).toBe(true);
    expect(ex('/dev/null')).toBe(true);
    expect(ex('/tmp/foo')).toBe(true);
    expect(ex('/run/lock')).toBe(true);
    expect(ex('/workspace/.devic-runtime-snapraw-abc.tar')).toBe(true);
  });

  it('keeps real installed content under cleanup=none', () => {
    const ex = buildExcludeMatcher({ cleanup: 'none' });
    expect(ex('/usr/local/bin/cowsay')).toBe(false);
    expect(ex('/etc/profile')).toBe(false);
    expect(ex('/var/cache/apt/archives/x.deb')).toBe(false); // not excluded when none
    expect(ex('/workspace/app.js')).toBe(false);
  });

  it('conservative drops regenerable caches but keeps installed binaries', () => {
    const ex = buildExcludeMatcher({ cleanup: 'conservative' });
    expect(ex('/var/lib/apt/lists/deb.list')).toBe(true);
    expect(ex('/var/cache/apt/archives/x.deb')).toBe(true);
    expect(ex('/root/.npm/_cacache/index')).toBe(true);
    expect(ex('/root/.cache/pip/wheels/x')).toBe(true);
    expect(ex('/srv/app/__pycache__/m.pyc')).toBe(true);
    expect(ex('/workspace/node_modules/.cache/babel/x')).toBe(true);
    // still keeps the actually-installed software:
    expect(ex('/usr/local/bin/cowsay')).toBe(false);
    expect(ex('/usr/local/lib/node_modules/typescript/bin/tsc')).toBe(false);
    expect(ex('/home/user/project/file.txt')).toBe(false);
  });

  it('aggressive additionally drops logs/man/doc/locale', () => {
    const con = buildExcludeMatcher({ cleanup: 'conservative' });
    const agg = buildExcludeMatcher({ cleanup: 'aggressive' });
    expect(con('/var/log/apt/history.log')).toBe(false);
    expect(agg('/var/log/apt/history.log')).toBe(true);
    expect(agg('/usr/share/man/man1/ls.1')).toBe(true);
    expect(agg('/usr/share/doc/pkg/README')).toBe(true);
  });

  it('merges extra config patterns (abs prefix, segment, subpath)', () => {
    const ex = buildExcludeMatcher({
      cleanup: 'none',
      extra: ['/opt/scratch', '.cache', 'foo/bar'],
    });
    expect(ex('/opt/scratch/x')).toBe(true);
    expect(ex('/srv/.cache/y')).toBe(true); // segment
    expect(ex('/a/foo/bar/z')).toBe(true); // subpath
    expect(ex('/opt/keep/x')).toBe(false);
  });
});

describe('partitionChanges', () => {
  const keepAll = () => false;

  it('splits into present (A/C, relative) and deletes (D, absolute)', () => {
    const { present, deletes, excludedCount } = partitionChanges(
      [
        { path: '/usr/local/bin/cowsay', kind: 'A' },
        { path: '/etc/profile', kind: 'C' },
        { path: '/workspace/old.txt', kind: 'D' },
      ],
      keepAll,
    );
    expect(present).toEqual(['usr/local/bin/cowsay', 'etc/profile']);
    expect(deletes).toEqual(['/workspace/old.txt']);
    expect(excludedCount).toBe(0);
  });

  it('drops excluded paths from both present and deletes and counts them', () => {
    const isExcluded = buildExcludeMatcher({ cleanup: 'conservative' });
    const { present, deletes, excludedCount } = partitionChanges(
      [
        { path: '/usr/local/bin/cowsay', kind: 'A' },
        { path: '/var/cache/apt/x.deb', kind: 'A' },
        { path: '/var/lib/apt/lists/y', kind: 'D' },
      ],
      isExcluded,
    );
    expect(present).toEqual(['usr/local/bin/cowsay']);
    expect(deletes).toEqual([]);
    expect(excludedCount).toBe(2);
  });
});

describe('isSafeDeletePath', () => {
  it('accepts concrete absolute paths', () => {
    expect(isSafeDeletePath('/workspace/old.txt')).toBe(true);
    expect(isSafeDeletePath('/usr/local/bin/x')).toBe(true);
  });
  it('rejects root, relative and traversal paths', () => {
    expect(isSafeDeletePath('/')).toBe(false);
    expect(isSafeDeletePath('relative/x')).toBe(false);
    expect(isSafeDeletePath('/a/../../etc')).toBe(false);
    expect(isSafeDeletePath('')).toBe(false);
  });
});

describe('sh', () => {
  it('single-quotes and escapes embedded single quotes', () => {
    expect(sh('/a/b')).toBe(`'/a/b'`);
    expect(sh("a'b")).toBe(`'a'\\''b'`);
  });
});
