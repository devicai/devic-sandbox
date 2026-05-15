/**
 * Live integration test for the persistent shell session feature.
 *
 * Spins up a real Docker container (no sysbox required — uses default runc),
 * opens a DockerShellSession through the real DockerRuntimeProvider, and
 * verifies that export, cd, shell functions and aliases all persist across
 * separate run() calls — which is the whole point of this PR.
 *
 * Run with:
 *   nvm use 24
 *   npx ts-node -P tsconfig.build.json test/integration/persistent-shell.live.ts
 */

import 'reflect-metadata';
import Docker from 'dockerode';
import { DockerRuntimeProvider } from '../../src/runtime/docker.runtime-provider';
import type { ModuleConfig } from '../../src/config/config.types';

const IMAGE = process.env.LIVE_TEST_IMAGE ?? 'alpine:3.20';
const CONTAINER_NAME = `devic-shell-live-${Date.now()}`;

const config: ModuleConfig = {
  server: { port: 0, basePath: '/api/v1' },
  database: { provider: 'mongodb', uri: 'mongodb://localhost/unused' },
  redis: { url: 'redis://localhost/unused' },
  defaults: {
    defaultImage: IMAGE,
    defaultCpus: 1,
    defaultMemoryMib: 256,
    defaultTtlSeconds: 600,
    maxTtlSeconds: 7200,
    ttlCheckIntervalMs: 30_000,
  },
  runtime: {
    type: 'docker',
    docker: {
      socketPath: '/var/run/docker.sock',
      runtime: 'runc',
      network: 'bridge',
      hardening: {
        dropAllCaps: false,
        noNewPrivileges: false,
        readOnlyRootfs: false,
        seccompProfile: 'default',
        pidsLimit: 512,
      },
    },
  },
  mcp: { enabled: false },
  extensions: { properties: [] },
  auth: { enabled: false, strategy: 'none' },
  logging: { level: 'info', format: 'json' },
};

interface Check {
  name: string;
  expectedStdout?: string;
  expectedCode?: number;
  expectedCwd?: string;
}

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
    failures.push(label);
  }
}

async function main(): Promise<void> {
  const provider = new DockerRuntimeProvider(config);

  console.log(`▶ Creating sandbox container '${CONTAINER_NAME}' on image '${IMAGE}'`);
  const sandbox = await provider.create({
    name: CONTAINER_NAME,
    image: IMAGE,
    workdir: '/workspace',
    cpus: 1,
    memoryMib: 256,
    env: { FOO_BOOT: 'boot-value' },
    networkPolicy: 'allow-all',
  });
  console.log(`  container up`);

  try {
    console.log(`▶ Opening persistent shell`);
    const shell = await sandbox.openShell('/workspace');

    // ---- export persistence ----
    console.log(`\n▶ Test 1: export persists across commands`);
    let r = await shell.run(`export MYVAR=hello-world`);
    check(`export returns code 0`, r.code === 0, `got code=${r.code}, stderr=${r.stderr}`);
    r = await shell.run(`echo "$MYVAR"`);
    check(
      `echo $MYVAR sees previously exported value`,
      r.stdout.trim() === 'hello-world',
      `got stdout='${r.stdout.trim()}'`,
    );

    // ---- cd persistence ----
    console.log(`\n▶ Test 2: cd persists across commands`);
    r = await shell.run(`cd /tmp`);
    check(`cd returns code 0`, r.code === 0);
    check(
      `cwd reported by marker is /tmp`,
      r.cwd === '/tmp',
      `got cwd='${r.cwd}'`,
    );
    r = await shell.run(`pwd`);
    check(
      `pwd reflects persistent cwd /tmp`,
      r.stdout.trim() === '/tmp',
      `got stdout='${r.stdout.trim()}'`,
    );

    // ---- explicit cwd override ----
    console.log(`\n▶ Test 3: ShellRunOptions.cwd overrides for that call only`);
    r = await shell.run(`pwd`, { cwd: '/workspace' });
    check(
      `pwd with cwd:/workspace overrides session cwd`,
      r.stdout.trim() === '/workspace',
      `got stdout='${r.stdout.trim()}'`,
    );
    check(
      `marker cwd reflects /workspace`,
      r.cwd === '/workspace',
      `got cwd='${r.cwd}'`,
    );

    // ---- shell functions persist ----
    console.log(`\n▶ Test 4: shell functions persist`);
    r = await shell.run(`greet() { echo "hi $1"; }`);
    check(`function definition returns 0`, r.code === 0);
    r = await shell.run(`greet pablo`);
    check(
      `function call sees previously-defined function`,
      r.stdout.trim() === 'hi pablo',
      `got stdout='${r.stdout.trim()}'`,
    );

    // ---- exit code passes through ----
    console.log(`\n▶ Test 5: non-zero exit code is captured`);
    r = await shell.run(`false`);
    check(`false returns code 1`, r.code === 1, `got code=${r.code}`);
    r = await shell.run(`sh -c 'exit 42'`);
    check(`exit 42 returns code 42`, r.code === 42, `got code=${r.code}`);

    // ---- stderr separation ----
    console.log(`\n▶ Test 6: stderr is captured separately from stdout`);
    r = await shell.run(`echo to-stdout; echo to-stderr >&2`);
    check(
      `stdout has only stdout content`,
      r.stdout.trim() === 'to-stdout',
      `got stdout='${r.stdout.trim()}'`,
    );
    check(
      `stderr has only stderr content`,
      r.stderr.trim() === 'to-stderr',
      `got stderr='${r.stderr.trim()}'`,
    );

    // ---- per-call env passes through ----
    console.log(`\n▶ Test 7: per-call env option is applied`);
    r = await shell.run(`echo "$PERCALL"`, { env: { PERCALL: 'percall-value' } });
    check(
      `echo $PERCALL sees per-call env`,
      r.stdout.trim() === 'percall-value',
      `got stdout='${r.stdout.trim()}'`,
    );

    // ---- boot env vars from create() ----
    console.log(`\n▶ Test 8: env vars set at sandbox create() are visible`);
    r = await shell.run(`echo "$FOO_BOOT"`);
    check(
      `echo $FOO_BOOT sees container env`,
      r.stdout.trim() === 'boot-value',
      `got stdout='${r.stdout.trim()}'`,
    );

    // ---- arbitrary content (quotes, newlines, marker-looking strings) ----
    console.log(`\n▶ Test 9: marker-looking strings in user output don't trip up the parser`);
    const tricky = `it's "weird" and __DEVIC_END_fake__ multi\nline`;
    r = await shell.run(`printf '%s' '${tricky.replace(/'/g, `'\\''`)}'`);
    check(
      `tricky output preserved verbatim`,
      r.stdout === tricky,
      `got stdout='${r.stdout}' (expected '${tricky}')`,
    );

    // ---- streaming ----
    console.log(`\n▶ Test 10: runStream emits stdout chunks live`);
    const stream = await shell.runStream(`for i in 1 2 3; do echo "line-$i"; done`);
    const chunks: string[] = [];
    for await (const evt of stream.events) {
      if (evt.type === 'stdout') chunks.push(evt.data.toString('utf-8'));
    }
    const { code, cwd } = await stream.done;
    const combined = chunks.join('');
    check(
      `runStream collected stdout`,
      combined.includes('line-1') && combined.includes('line-2') && combined.includes('line-3'),
      `got='${combined}'`,
    );
    check(`runStream done.code is 0`, code === 0, `got code=${code}`);
    check(`runStream done.cwd looks plausible`, cwd === '/workspace', `got cwd='${cwd}'`);

    // ---- concurrent calls are serialized correctly ----
    console.log(`\n▶ Test 11: concurrent run() calls are serialized`);
    const [a, b, c] = await Promise.all([
      shell.run(`export STEP=1; echo s1`),
      shell.run(`echo "after=$STEP"`),
      shell.run(`export STEP=2; echo "now=$STEP"`),
    ]);
    check(
      `first call sees s1`,
      a.stdout.trim() === 's1',
      `got='${a.stdout.trim()}'`,
    );
    check(
      `second call sees STEP=1 (queued after first)`,
      b.stdout.trim() === 'after=1',
      `got='${b.stdout.trim()}'`,
    );
    check(
      `third call updates STEP to 2`,
      c.stdout.trim() === 'now=2',
      `got='${c.stdout.trim()}'`,
    );

    // ---- shell session is reused across openShell() ----
    console.log(`\n▶ Test 12: openShell returns the same session`);
    const shell2 = await sandbox.openShell();
    check(`openShell idempotent`, shell2 === shell);

    // Verify state is shared:
    r = await shell2.run(`echo "$MYVAR"`);
    check(
      `state shared with previously-obtained handle`,
      r.stdout.trim() === 'hello-world',
      `got='${r.stdout.trim()}'`,
    );

    console.log(`\n▶ Closing shell`);
    await shell.close();
  } finally {
    console.log(`\n▶ Cleaning up container`);
    try {
      await provider.remove(CONTAINER_NAME);
    } catch (err) {
      console.warn(`  cleanup error: ${(err as Error).message}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  } else {
    console.log(`\n✓ All checks passed`);
  }
}

main().catch((err) => {
  console.error('fatal error:', err);
  // Best-effort cleanup of the container even on fatal error.
  const docker = new Docker({ socketPath: '/var/run/docker.sock' });
  docker
    .getContainer(CONTAINER_NAME)
    .remove({ force: true, v: true })
    .catch(() => undefined)
    .finally(() => process.exit(1));
});
