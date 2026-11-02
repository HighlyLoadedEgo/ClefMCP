import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath, makeFakeInstall, sampleDecideArgs, type FakeInstall } from '../helpers.js';
import { decideViaDaemon } from '../../src/daemon/client.js';
import { daemonSocketPath } from '../../src/daemon/daemon.js';

interface Child {
  proc: ReturnType<typeof spawn>;
  stop(): Promise<void>;
}

function startDaemonCli(env: Record<string, string>): Child {
  const proc = spawn(process.execPath, [cliPath(), 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (c) => (stderr += c));
  return {
    proc,
    stop: () =>
      new Promise((resolve) => {
        // Idempotent: the big test stops the daemon itself; a second stop must not wait forever.
        if (proc.exitCode !== null || proc.signalCode) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
      }),
  };
}

async function waitUntilReady(socketPath: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pong = (await decideViaDaemon(socketPath, { ping: true }, 2_000).catch(() => undefined)) as { pong?: boolean } | undefined;
    if (pong?.pong) return;
    if (Date.now() > deadline) throw new Error(`daemon not ready on ${socketPath}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function decideArgs(env: Record<string, string>, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

let install: FakeInstall;
let daemon: Child;

beforeAll(async () => {
  install = await makeFakeInstall();
  daemon = startDaemonCli(install.env);
});

afterAll(async () => {
  await daemon?.stop().catch(() => undefined);
  await fsp.rm(install.clefHome, { recursive: true, force: true });
});

describe('clef-mcp daemon', () => {
  it('restricts the socket to its owner even with a permissive umask', async () => {
    const scopedInstall = await makeFakeInstall();
    let scopedDaemon: Child | undefined;
    try {
      const previousUmask = process.umask(0);
      try {
        scopedDaemon = startDaemonCli(scopedInstall.env);
      } finally {
        process.umask(previousUmask);
      }
      const socketPath = daemonSocketPath(scopedInstall.clefHome);
      await waitUntilReady(socketPath);
      expect((await fsp.stat(socketPath)).mode & 0o777).toBe(0o600);
    } finally {
      await scopedDaemon?.stop();
      await fsp.rm(scopedInstall.clefHome, { recursive: true, force: true });
    }
  });

  it('keeps active and queued decisions loaded, then unloads after a full idle window', async () => {
    const busyInstall = await makeFakeInstall({ inferenceDelayMs: 1500 });
    const startLog = path.join(busyInstall.clefHome, 'runtime-starts');
    const busyDaemon = startDaemonCli({ ...busyInstall.env, CLEF_DAEMON_IDLE: '1', FAKE_LLAMA_START_LOG: startLog });
    try {
      const socketPath = daemonSocketPath(busyInstall.clefHome);
      await waitUntilReady(socketPath);
      const args = sampleDecideArgs();
      // Warm up once, then keep the runtime busy beyond the idle timeout.
      const warm = await decideViaDaemon(socketPath, args, 10_000);
      expect(warm?.decisions).toBeTruthy();
      const results = await Promise.all([
        decideViaDaemon(socketPath, args, 10_000),
        decideViaDaemon(socketPath, args, 10_000),
      ]);
      for (const result of results) expect(result?.decisions).toBeTruthy();

      // A request right after completion must reuse the warm runtime.
      expect((await decideViaDaemon(socketPath, args, 10_000))?.decisions).toBeTruthy();
      expect((await fsp.readFile(startLog, 'utf8')).trim().split('\n')).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 2500));
      expect((await decideViaDaemon(socketPath, args, 10_000))?.decisions).toBeTruthy();
      expect((await fsp.readFile(startLog, 'utf8')).trim().split('\n')).toHaveLength(2);
    } finally {
      await busyDaemon.stop();
      await fsp.rm(busyInstall.clefHome, { recursive: true, force: true });
    }
  });

  it(
    'serves decide requests on the CLEF_HOME socket and removes it on exit',
    async () => {
      const socketPath = daemonSocketPath(install.clefHome);
      await waitUntilReady(socketPath);
      expect((await fsp.stat(socketPath)).isSocket()).toBe(true);

      const args = sampleDecideArgs() as { state: unknown; questions: unknown };
      const answer = (await decideViaDaemon(socketPath, args, 60_000)) as {
        model: string;
        decisions: Record<string, { answer: Record<string, number> }>;
        usage?: { input_tokens?: number };
      };
      expect(answer.model).toBe('clef-flash');
      expect(answer.decisions.outage?.answer?.true).toBeCloseTo(0.87, 5);

      // `decide --daemon` rides the same socket.
      const run = await decideArgs(install.env, ['decide', '--daemon'], JSON.stringify(sampleDecideArgs()));
      expect(run.code).toBe(0);
      const out = JSON.parse(run.stdout) as { model: string };
      expect(out.model).toBe('clef-flash');

      const unknownModel = await decideArgs(install.env, ['decide', '--daemon', '--model', 'missing-model'], JSON.stringify(sampleDecideArgs()));
      expect(unknownModel.code).toBe(2);
      expect(unknownModel.stdout).toBe('');
      expect(unknownModel.stderr).toContain('Unknown model "missing-model"');

      const overriddenModel = await decideArgs(install.env, ['decide', '--daemon', '--model', 'clef-flash'], JSON.stringify({ ...sampleDecideArgs(), model: 'missing-model' }));
      expect(overriddenModel.code).toBe(0);
      expect(JSON.parse(overriddenModel.stdout).model).toBe('clef-flash');

      const envModel = await decideArgs({ ...install.env, CLEF_MODEL: 'missing-env-model' }, ['decide', '--daemon'], JSON.stringify(sampleDecideArgs()));
      expect(envModel.code).toBe(2);
      expect(envModel.stdout).toBe('');
      expect(envModel.stderr).toContain('Unknown model "missing-env-model"');

      // SIGTERM stops the daemon and cleans up the socket file.
      await daemon.stop();
      await expect(fsp.stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    90_000,
  );

  it(
    'unloads the model after the idle window and still answers afterwards',
    async () => {
      const idleInstall = await makeFakeInstall();
      const idleDaemon = spawn(process.execPath, [cliPath(), 'daemon'], {
        env: { ...idleInstall.env, CLEF_DAEMON_IDLE: '2' },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      try {
        const socketPath = daemonSocketPath(idleInstall.clefHome);
        const deadline = Date.now() + 30_000;
        for (;;) {
          const pong = (await decideViaDaemon(socketPath, { ping: true }, 2_000).catch(() => undefined)) as { pong?: boolean } | undefined;
          if (pong?.pong) break;
          if (Date.now() > deadline) throw new Error('idle daemon not ready');
          await new Promise((r) => setTimeout(r, 250));
        }

        const args = sampleDecideArgs() as { state: unknown; questions: unknown };
        const first = (await decideViaDaemon(socketPath, args, 60_000)) as { model: string };
        expect(first.model).toBe('clef-flash');

        // Past the idle window the daemon unloads; the next request must reload.
        await new Promise((r) => setTimeout(r, 3_000));
        const second = (await decideViaDaemon(socketPath, args, 60_000)) as { model: string };
        expect(second.model).toBe('clef-flash');
      } finally {
        idleDaemon.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        await fsp.rm(idleInstall.clefHome, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    'falls back to a cold run when no daemon is reachable',
    async () => {
      const { code, stdout, stderr } = await decideArgs(install.env, ['decide', '--daemon'], JSON.stringify(sampleDecideArgs()));
      expect(code).toBe(0);
      expect(stderr).toContain('no daemon reachable');
      const out = JSON.parse(stdout) as { model: string };
      expect(out.model).toBe('clef-flash');
    },
    60_000,
  );
});
