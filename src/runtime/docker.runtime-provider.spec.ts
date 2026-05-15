import { PassThrough } from 'stream';
import { Test, TestingModule } from '@nestjs/testing';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { DockerRuntimeProvider } from './docker.runtime-provider';

const createContainer = jest.fn();
const getContainer = jest.fn();
const getImage = jest.fn();
const pull = jest.fn();
const followProgress = jest.fn();

jest.mock('dockerode', () => {
  return jest.fn().mockImplementation(() => ({
    createContainer,
    getContainer,
    getImage,
    pull,
    modem: { followProgress },
  }));
});

function buildConfig(overrides?: Partial<ModuleConfig['runtime']>): ModuleConfig {
  return {
    server: { port: 3200, basePath: '/api/v1' },
    database: { provider: 'mongodb', uri: 'mongodb://localhost/test' },
    redis: { url: 'redis://localhost' },
    defaults: {
      defaultImage: 'node:24',
      defaultCpus: 1,
      defaultMemoryMib: 256,
      defaultTtlSeconds: 1800,
      maxTtlSeconds: 7200,
      ttlCheckIntervalMs: 30000,
    },
    runtime: {
      type: 'docker',
      docker: {
        socketPath: '/var/run/docker.sock',
        runtime: 'sysbox-runc',
        network: 'bridge',
        hardening: {
          dropAllCaps: true,
          noNewPrivileges: true,
          readOnlyRootfs: false,
          seccompProfile: 'default',
          pidsLimit: 512,
        },
      },
      ...overrides,
    } as ModuleConfig['runtime'],
    mcp: { enabled: true },
    extensions: { properties: [] },
    auth: { enabled: false, strategy: 'none' },
    logging: { level: 'info', format: 'json' },
  };
}

async function buildProvider(config: ModuleConfig = buildConfig()) {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      DockerRuntimeProvider,
      { provide: CONFIG, useValue: config },
    ],
  }).compile();
  return moduleRef.get(DockerRuntimeProvider);
}

function fakeContainer(overrides?: Partial<{
  inspectResult: any;
  inspectError: any;
  startError: any;
}>) {
  const start = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn().mockResolvedValue(undefined);
  const inspect = overrides?.inspectError
    ? jest.fn().mockRejectedValue(overrides.inspectError)
    : jest.fn().mockResolvedValue(
        overrides?.inspectResult ?? {
          State: { Status: 'running' },
        },
      );
  return { start, remove, inspect };
}

describe('DockerRuntimeProvider', () => {
  beforeEach(() => {
    createContainer.mockReset();
    getContainer.mockReset();
    getImage.mockReset();
    pull.mockReset();
    followProgress.mockReset();
  });

  describe('create', () => {
    it('applies hardening defaults to the HostConfig', async () => {
      getImage.mockReturnValue({ inspect: jest.fn().mockResolvedValue({}) });
      const fake = fakeContainer();
      // We capture the create call and short-circuit start + workdir-mkdir exec.
      fake.start.mockResolvedValue(undefined);
      const execStart = jest.fn().mockResolvedValue({
        on: (event: string, cb: any) => {
          if (event === 'end') setImmediate(cb);
          if (event === 'close') setImmediate(cb);
        },
        once: (event: string, cb: any) => {
          if (event === 'end') setImmediate(cb);
          if (event === 'close') setImmediate(cb);
        },
      });
      const containerWithExec: any = {
        ...fake,
        exec: jest.fn().mockResolvedValue({
          start: execStart,
          inspect: jest.fn().mockResolvedValue({ ExitCode: 0 }),
        }),
        modem: { demuxStream: jest.fn() },
      };
      createContainer.mockResolvedValue(containerWithExec);
      getContainer.mockReturnValue({ inspect: jest.fn().mockRejectedValue({ statusCode: 404 }) });

      const provider = await buildProvider();
      await provider.create({
        name: 'sandbox-abc',
        image: 'node:24',
        workdir: '/workspace',
        cpus: 2,
        memoryMib: 1024,
        env: { FOO: 'bar' },
        ports: { '8080': 3000 },
      });

      const opts = createContainer.mock.calls[0][0];
      expect(opts.name).toBe('sandbox-abc');
      expect(opts.HostConfig.Runtime).toBe('sysbox-runc');
      expect(opts.HostConfig.Memory).toBe(1024 * 1024 * 1024);
      expect(opts.HostConfig.NanoCpus).toBe(2_000_000_000);
      expect(opts.HostConfig.NetworkMode).toBe('bridge');
      expect(opts.HostConfig.PortBindings).toEqual({
        '3000/tcp': [{ HostPort: '8080' }],
      });
      expect(opts.HostConfig.CapDrop).toEqual(['ALL']);
      expect(opts.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
      expect(opts.HostConfig.PidsLimit).toBe(512);
      expect(opts.HostConfig.ReadonlyRootfs).toBe(false);
      expect(opts.Env).toEqual(['FOO=bar']);
    });

    it('translates networkPolicy=deny-all to NetworkMode=none', async () => {
      getImage.mockReturnValue({ inspect: jest.fn().mockResolvedValue({}) });
      const fake = fakeContainer();
      const containerWithExec: any = {
        ...fake,
        exec: jest.fn().mockResolvedValue({
          start: jest.fn().mockResolvedValue({
            on: (e: string, cb: any) => {
              if (e === 'end' || e === 'close') setImmediate(cb);
            },
            once: (e: string, cb: any) => {
              if (e === 'end' || e === 'close') setImmediate(cb);
            },
          }),
          inspect: jest.fn().mockResolvedValue({ ExitCode: 0 }),
        }),
        modem: { demuxStream: jest.fn() },
      };
      createContainer.mockResolvedValue(containerWithExec);
      getContainer.mockReturnValue({ inspect: jest.fn().mockRejectedValue({ statusCode: 404 }) });

      const provider = await buildProvider();
      await provider.create({
        name: 'sandbox-net',
        image: 'node:24',
        workdir: '/workspace',
        cpus: 1,
        memoryMib: 256,
        env: {},
        networkPolicy: 'deny-all',
      });

      expect(createContainer.mock.calls[0][0].HostConfig.NetworkMode).toBe('none');
    });

    it('respects hardening.readOnlyRootfs and hardening.seccompProfile', async () => {
      getImage.mockReturnValue({ inspect: jest.fn().mockResolvedValue({}) });
      const fake = fakeContainer();
      const containerWithExec: any = {
        ...fake,
        exec: jest.fn().mockResolvedValue({
          start: jest.fn().mockResolvedValue({
            on: (e: string, cb: any) => {
              if (e === 'end' || e === 'close') setImmediate(cb);
            },
            once: (e: string, cb: any) => {
              if (e === 'end' || e === 'close') setImmediate(cb);
            },
          }),
          inspect: jest.fn().mockResolvedValue({ ExitCode: 0 }),
        }),
        modem: { demuxStream: jest.fn() },
      };
      createContainer.mockResolvedValue(containerWithExec);
      getContainer.mockReturnValue({ inspect: jest.fn().mockRejectedValue({ statusCode: 404 }) });

      const provider = await buildProvider(
        buildConfig({
          type: 'docker',
          docker: {
            runtime: 'runc',
            network: 'bridge',
            hardening: {
              dropAllCaps: false,
              noNewPrivileges: true,
              readOnlyRootfs: true,
              seccompProfile: '/etc/docker/sec.json',
              pidsLimit: 1024,
            },
          },
        }),
      );

      await provider.create({
        name: 'sandbox-h',
        image: 'node:24',
        workdir: '/workspace',
        cpus: 1,
        memoryMib: 256,
        env: {},
      });

      const opts = createContainer.mock.calls[0][0];
      expect(opts.HostConfig.Runtime).toBe('runc');
      expect(opts.HostConfig.CapDrop).toBeUndefined();
      expect(opts.HostConfig.ReadonlyRootfs).toBe(true);
      expect(opts.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
      expect(opts.HostConfig.SecurityOpt).toContain('seccomp=/etc/docker/sec.json');
      expect(opts.HostConfig.PidsLimit).toBe(1024);
    });

    it('pulls the image when it is missing locally', async () => {
      getImage.mockReturnValue({
        inspect: jest.fn().mockRejectedValue({ statusCode: 404 }),
      });
      pull.mockResolvedValue('progress-stream');
      followProgress.mockImplementation((_stream: any, cb: any) => cb(null));

      const fake = fakeContainer();
      const containerWithExec: any = {
        ...fake,
        exec: jest.fn().mockResolvedValue({
          start: jest.fn().mockResolvedValue({
            on: (e: string, cb: any) => {
              if (e === 'end' || e === 'close') setImmediate(cb);
            },
            once: (e: string, cb: any) => {
              if (e === 'end' || e === 'close') setImmediate(cb);
            },
          }),
          inspect: jest.fn().mockResolvedValue({ ExitCode: 0 }),
        }),
        modem: { demuxStream: jest.fn() },
      };
      createContainer.mockResolvedValue(containerWithExec);
      getContainer.mockReturnValue({ inspect: jest.fn().mockRejectedValue({ statusCode: 404 }) });

      const provider = await buildProvider();
      await provider.create({
        name: 'sandbox-pull',
        image: 'python:3.12',
        workdir: '/workspace',
        cpus: 1,
        memoryMib: 256,
        env: {},
      });

      expect(pull).toHaveBeenCalledWith('python:3.12');
      expect(followProgress).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns null when the container does not exist (404)', async () => {
      const inspectErr: any = new Error('not found');
      inspectErr.statusCode = 404;
      getContainer.mockReturnValue({
        inspect: jest.fn().mockRejectedValue(inspectErr),
      });

      const provider = await buildProvider();
      expect(await provider.get('missing')).toBeNull();
    });

    it('returns a handle with status running for a running container', async () => {
      getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({ State: { Status: 'running' } }),
      });

      const provider = await buildProvider();
      const handle = await provider.get('alive');
      expect(handle?.status).toBe('running');
    });

    it('maps exited/created/paused/dead to stopped', async () => {
      const states = ['exited', 'created', 'paused', 'dead'];
      for (const state of states) {
        getContainer.mockReturnValueOnce({
          inspect: jest.fn().mockResolvedValue({ State: { Status: state } }),
        });
        const provider = await buildProvider();
        const handle = await provider.get(`box-${state}`);
        expect(handle?.status).toBe('stopped');
      }
    });
  });

  describe('openShell', () => {
    /**
     * Stand up a provider whose `container.exec` produces a fake bidirectional
     * stream we can drive from the test. The first exec call (the workdir
     * mkdir performed during `create`) gets a fast-completing one-shot; the
     * second one (the persistent shell) wires up to the harness streams.
     */
    async function buildShellHarness() {
      getImage.mockReturnValue({ inspect: jest.fn().mockResolvedValue({}) });

      // First exec: workdir mkdir. Completes instantly.
      const mkdirExec = {
        start: jest.fn().mockResolvedValue({
          on: (e: string, cb: any) => {
            if (e === 'end' || e === 'close') setImmediate(cb);
          },
          once: (e: string, cb: any) => {
            if (e === 'end' || e === 'close') setImmediate(cb);
          },
        }),
        inspect: jest.fn().mockResolvedValue({ ExitCode: 0 }),
      };

      // Second exec: persistent shell. The duplex stream captures stdin
      // writes from the harness's POV, and the demuxStream mock wires our
      // sinks to it so the test can synthesize stdout/stderr.
      const shellStdin: Buffer[] = [];
      const shellStream: any = {
        write: jest.fn((chunk: any) => {
          shellStdin.push(Buffer.from(chunk));
          return true;
        }),
        end: jest.fn(),
        destroy: jest.fn(),
        once: jest.fn(),
        on: jest.fn(),
      };
      let stdoutSink: PassThrough | undefined;
      let stderrSink: PassThrough | undefined;
      const modem = {
        demuxStream: jest.fn((_s: any, out: PassThrough, err: PassThrough) => {
          stdoutSink = out;
          stderrSink = err;
        }),
      };
      const shellExec = {
        start: jest.fn().mockResolvedValue(shellStream),
        inspect: jest.fn().mockResolvedValue({ ExitCode: 0 }),
      };

      const exec = jest
        .fn()
        .mockResolvedValueOnce(mkdirExec)
        .mockResolvedValue(shellExec);
      const fake = fakeContainer();
      const containerWithExec: any = { ...fake, exec, modem };
      createContainer.mockResolvedValue(containerWithExec);
      getContainer.mockReturnValue({
        inspect: jest.fn().mockRejectedValue({ statusCode: 404 }),
      });

      const provider = await buildProvider();
      const sandbox = await provider.create({
        name: 'sandbox-shell',
        image: 'node:24',
        workdir: '/workspace',
        cpus: 1,
        memoryMib: 256,
        env: {},
      });

      return {
        provider,
        sandbox,
        // Lazy accessors — sinks only exist after openShell() runs.
        getSinks: () => {
          if (!stdoutSink || !stderrSink) {
            throw new Error('shell sinks not yet wired (openShell not called?)');
          }
          return { stdoutSink, stderrSink };
        },
        shellStdin,
      };
    }

    function markerFromStdin(stdin: Buffer[]): string {
      const joined = Buffer.concat(stdin).toString('utf-8');
      const m = joined.match(/__DEVIC_END_[0-9a-f]+__/);
      if (!m) throw new Error(`no marker in stdin: ${joined}`);
      return m[0];
    }

    it('resolves run() with the exit code and cwd carried by the markers', async () => {
      const h = await buildShellHarness();
      const shell = await h.sandbox.openShell();
      const runPromise = shell.run('echo hello');

      // Wait one tick so the wrapped command lands in stdin.
      await new Promise((r) => setImmediate(r));
      const marker = markerFromStdin(h.shellStdin);

      // Drive the streams as the shell would.
      const { stdoutSink, stderrSink } = h.getSinks();
      stdoutSink.write(Buffer.from('hello\n'));
      stdoutSink.write(Buffer.from(`${marker}:0:/workspace\n`));
      stderrSink.write(Buffer.from(`${marker}\n`));

      const result = await runPromise;
      expect(result.code).toBe(0);
      expect(result.cwd).toBe('/workspace');
      expect(result.stdout).toBe('hello\n');
      expect(result.stderr).toBe('');
    });

    it('propagates non-zero exit codes and updated cwd from the wrapper', async () => {
      const h = await buildShellHarness();
      const shell = await h.sandbox.openShell();
      const runPromise = shell.run('cd /tmp && false');

      await new Promise((r) => setImmediate(r));
      const marker = markerFromStdin(h.shellStdin);

      const { stdoutSink, stderrSink } = h.getSinks();
      stdoutSink.write(Buffer.from(`${marker}:1:/tmp\n`));
      stderrSink.write(Buffer.from(`${marker}\n`));

      const result = await runPromise;
      expect(result.code).toBe(1);
      expect(result.cwd).toBe('/tmp');
    });

    it('serializes concurrent run() calls', async () => {
      const h = await buildShellHarness();
      const shell = await h.sandbox.openShell();
      const p1 = shell.run('first');
      const p2 = shell.run('second');

      // Only the first command should have been written so far.
      await new Promise((r) => setImmediate(r));
      const joined1 = Buffer.concat(h.shellStdin).toString('utf-8');
      const firstMarkers = joined1.match(/__DEVIC_END_[0-9a-f]+__/g) ?? [];
      // First wrapper emits two marker occurrences (stdout + stderr printfs).
      expect(firstMarkers.length).toBe(2);

      // Complete the first command.
      const marker1 = firstMarkers[0];
      const { stdoutSink, stderrSink } = h.getSinks();
      stdoutSink.write(Buffer.from(`${marker1}:0:/workspace\n`));
      stderrSink.write(Buffer.from(`${marker1}\n`));
      await p1;

      // Now the second one should be written and waiting.
      await new Promise((r) => setImmediate(r));
      const joined2 = Buffer.concat(h.shellStdin).toString('utf-8');
      const allMarkers = joined2.match(/__DEVIC_END_[0-9a-f]+__/g) ?? [];
      expect(allMarkers.length).toBe(4);
      const marker2 = allMarkers[2];
      expect(marker2).not.toBe(marker1);

      stdoutSink.write(Buffer.from(`${marker2}:0:/workspace\n`));
      stderrSink.write(Buffer.from(`${marker2}\n`));
      await p2;
    });

    it('returns the same shell session on repeated openShell calls', async () => {
      const h = await buildShellHarness();
      const s1 = await h.sandbox.openShell();
      const s2 = await h.sandbox.openShell();
      expect(s1).toBe(s2);
    });
  });

  describe('remove', () => {
    it('is idempotent on missing containers (404)', async () => {
      const err: any = new Error('not found');
      err.statusCode = 404;
      getContainer.mockReturnValue({
        remove: jest.fn().mockRejectedValue(err),
      });

      const provider = await buildProvider();
      await expect(provider.remove('gone')).resolves.toBeUndefined();
    });

    it('forces removal with volumes', async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      getContainer.mockReturnValue({ remove });

      const provider = await buildProvider();
      await provider.remove('alive');

      expect(remove).toHaveBeenCalledWith({ force: true, v: true });
    });
  });
});
