import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the built CLI entry (tests build first via `npm test`). */
export function cliPath(): string {
  // This file lives in <repo>/tests/, so the built CLI is at ../dist/cli.js.
  return fileURLToPath(new URL('../dist/cli.js', import.meta.url));
}

export function fakeServerScript(): string {
  // This file lives in <repo>/tests/, fixtures are a sibling directory.
  return fileURLToPath(new URL('fixtures/fake-llama-server.mjs', import.meta.url));
}

export interface FakeInstall {
  clefHome: string;
  wrapperPath: string;
  modelPath: string;
  env: Record<string, string>;
}

/**
 * Materialize a fake install: a dummy model file + manifest + a `llama-server`
 * shell wrapper that execs the node fake. Point CLEF_LLAMA_BIN at the wrapper
 * so clef-mcp exercises the full spawn → health → decide → SIGTERM path.
 */
export async function makeFakeInstall(options?: {
  quant?: string;
  dirLabel?: string;
  healthDelayMs?: number;
  withModel?: boolean;
}): Promise<FakeInstall> {
  const clefHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'clef-it-'));
  const quant = options?.quant ?? 'Q4_K_M';
  const dirLabel = options?.dirLabel ?? '4bit';
  const modelDir = path.join(clefHome, 'models', 'clef-flash', dirLabel);
  await fsp.mkdir(modelDir, { recursive: true });

  const modelPath = path.join(modelDir, 'Clef-Flash-Q4_K_M.gguf');
  const withModel = options?.withModel ?? true;
  if (withModel) {
    const bytes = Buffer.alloc(4096, 7);
    await fsp.writeFile(modelPath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest = {
      schemaVersion: 1,
      model: 'clef-flash',
      quant,
      file: 'Clef-Flash-Q4_K_M.gguf',
      modelPath,
      bytes: bytes.length,
      sha256,
      repo: 'ggml-org/Clef-Flash-GGUF',
      revision: '4a7a08c09bc63baf043b62b5ba89dd67a0357d95',
      licenseId: 'Apache-2.0',
      licenseUrl: 'https://huggingface.co/Cloudflare/clef-flash',
      installedAt: new Date().toISOString(),
      clefMcpVersion: '0.1.0',
    };
    await fsp.writeFile(path.join(modelDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  const binDir = path.join(clefHome, 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  const wrapperPath = path.join(binDir, 'llama-server');
  const script = [
    '#!/bin/sh',
    `exec node "${fakeServerScript()}" --health-delay-ms ${options?.healthDelayMs ?? 0} "$@"`,
    '',
  ].join('\n');
  await fsp.writeFile(wrapperPath, script);
  await fsp.chmod(wrapperPath, 0o755);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? clefHome,
    CLEF_HOME: clefHome,
    CLEF_LLAMA_BIN: wrapperPath,
    CLEF_LOG_LEVEL: 'debug',
  };
  return { clefHome, wrapperPath, modelPath, env };
}

export function sampleDecideArgs(): Record<string, unknown> {
  return {
    state: {
      task: 'Fix failing tests',
      error: 'TypeError: Cannot read properties of undefined',
    },
    questions: {
      next_action: {
        type: 'choice',
        instructions: 'What should the coding agent do next?',
        criteria: {
          inspect: 'Inspect the code and gather more information',
          modify: 'Modify the code',
          test: 'Run additional tests',
          ask_user: 'Ask the user for clarification',
        },
      },
      confidence: {
        type: 'score',
        instructions: 'How confident are you in this decision?',
        criteria: ['very_low', 'low', 'medium', 'high', 'very_high'],
      },
      outage: {
        type: 'noul',
        instructions: 'Is a service down?',
      },
    },
  };
}
