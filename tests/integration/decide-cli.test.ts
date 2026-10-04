import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath, makeFakeInstall, sampleDecideArgs, type FakeInstall } from '../helpers.js';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the CLI with optional stdin; capture streams and exit code. */
function run(args: string[], env: Record<string, string>, input?: string): Promise<RunResult> {
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
let empty: FakeInstall;

beforeAll(async () => {
  install = await makeFakeInstall();
  empty = await makeFakeInstall({ withModel: false });
});

afterAll(async () => {
  await fsp.rm(install.clefHome, { recursive: true, force: true });
  await fsp.rm(empty.clefHome, { recursive: true, force: true });
});

interface DecideOutput {
  model: string;
  decisions: Record<string, { answer: Record<string, number>; confidence?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number; latency_ms?: number };
}

describe('clef-mcp decide (one-shot CLI)', () => {
  it(
    'reads a full document from stdin and prints the strict JSON result',
    async () => {
      const { code, stdout } = await run(['decide'], install.env, JSON.stringify(sampleDecideArgs()));
      expect(code).toBe(0);
      const out = JSON.parse(stdout) as DecideOutput;
      expect(out.model).toBe('clef-flash');
      expect(out.decisions.outage?.answer?.true).toBeCloseTo(0.87, 5);
      // Confidence and usage surface here too (same adapter as the MCP tool).
      expect(out.decisions.next_action?.confidence).toBeCloseTo(0.6, 5);
      expect(out.usage?.input_tokens).toBe(42);
    },
    60_000,
  );

  it(
    'accepts --questions and --state files',
    async () => {
      const args = sampleDecideArgs() as { state: unknown; questions: unknown };
      const qFile = path.join(install.clefHome, 'questions.json');
      const sFile = path.join(install.clefHome, 'state.json');
      await fsp.writeFile(qFile, JSON.stringify(args.questions));
      await fsp.writeFile(sFile, JSON.stringify(args.state));
      const { code, stdout } = await run(['decide', '--questions', qFile, '--state', sFile], install.env);
      expect(code).toBe(0);
      const out = JSON.parse(stdout) as DecideOutput;
      expect(out.decisions.confidence?.answer).toBeTruthy();
    },
    60_000,
  );

  it(
    'accepts inline --questions JSON with a plain-text --state',
    async () => {
      const { code, stdout } = await run(
        ['decide', '--questions', '{"deploy": {"type": "noul", "instructions": "Is the deploy safe?"}}', '--state', 'checkout is 500ing after the last deploy'],
        install.env,
      );
      expect(code).toBe(0);
      const out = JSON.parse(stdout) as DecideOutput;
      expect(out.decisions.deploy?.answer?.true).toBeCloseTo(0.87, 5);
    },
    60_000,
  );

  it(
    'fails with MODEL_NOT_INSTALLED (exit 3) and keeps stdout clean',
    async () => {
      const { code, stdout, stderr } = await run(['decide'], empty.env, JSON.stringify(sampleDecideArgs()));
      expect(code).toBe(3);
      expect(stdout).toBe('');
      expect(stderr).toContain('MODEL_NOT_INSTALLED');
      expect(stderr).toMatch(/clef-mcp install/);
    },
    60_000,
  );

  it(
    'fails with INVALID_INPUT (exit 2) for malformed questions',
    async () => {
      const { code, stderr } = await run(
        ['decide'],
        install.env,
        JSON.stringify({ state: 's', questions: { bad: { type: 'essay', instructions: 'i' } } }),
      );
      expect(code).toBe(2);
      expect(stderr).toContain('INVALID_INPUT');
    },
    60_000,
  );

  it(
    'fails with INVALID_INPUT (exit 2) when stdin is empty and no --questions given',
    async () => {
      const { code, stderr } = await run(['decide'], install.env, '');
      expect(code).toBe(2);
      expect(stderr).toContain('no input on stdin');
    },
    60_000,
  );
});
