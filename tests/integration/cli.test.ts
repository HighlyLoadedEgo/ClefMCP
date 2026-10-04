import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath, makeFakeInstall, type FakeInstall } from '../helpers.js';

const execFileP = promisify(execFile);

function run(args: string[], env: Record<string, string>) {
  return execFileP(process.execPath, [cliPath(), ...args], {
    env,
    timeout: 60_000,
    encoding: 'utf8',
  });
}

let empty: FakeInstall;
let installed: FakeInstall;

beforeAll(async () => {
  empty = await makeFakeInstall({ withModel: false });
  installed = await makeFakeInstall();
});

afterAll(async () => {
  await fsp.rm(empty.clefHome, { recursive: true, force: true });
  await fsp.rm(installed.clefHome, { recursive: true, force: true });
});

describe('CLI', () => {
  it('--help lists all documented commands', async () => {
    const { stdout } = await run(['--help'], empty.env);
    for (const cmd of ['decide', 'install', 'models', 'status', 'doctor', 'uninstall']) {
      expect(stdout).toContain(cmd);
    }
  });

  it('models lists clef-flash with quantizations', async () => {
    const { stdout } = await run(['models'], empty.env);
    expect(stdout).toContain('clef-flash');
    expect(stdout).toContain('Q4_K_M');
    expect(stdout).toContain('Q8_0');
    expect(stdout).toContain('BF16');
  });

  it('status reports a missing model clearly and exits 0', async () => {
    const { stdout } = await run(['status'], empty.env);
    expect(stdout).toContain('Model status: not installed');
    expect(stdout).toContain('clef-mcp install');
  });

  it('status reports the installed quantization', async () => {
    const { stdout } = await run(['status'], installed.env);
    expect(stdout).toContain('Model status: installed');
    expect(stdout).toContain('Q4_K_M');
  });

  it('doctor fails cleanly on an empty install (no model, no runtime)', async () => {
    await expect(run(['doctor'], empty.env)).rejects.toMatchObject({ code: 1 });
    try {
      await run(['doctor'], empty.env);
    } catch (err) {
      const output = String((err as { stdout?: string }).stdout ?? err);
      expect(output).toContain('clef-mcp doctor');
      expect(output).toContain('Model');
      expect(output).toContain('Runtime binary');
    }
  });

  it('doctor passes critical checks on a complete fake install (probe via fake server)', async () => {
    // Inference probe runs the fake llama-server end-to-end.
    const { stdout } = await run(['doctor'], installed.env);
    expect(stdout).toContain('Inference');
    expect(stdout).toMatch(/Inference\s+✔|✔\s+Inference|probe decision/);
    expect(stdout).toContain('All critical checks passed');
  }, 60_000);
});
