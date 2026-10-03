import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath, fakeServerScript, sampleDecideArgs } from '../helpers.js';

/**
 * End-to-end for the MLX runtime path without a real model: a fake `uv`
 * executable that execs the fake llama-server (same /health + /v1/systemone
 * contract as clef_mlx.py serve), plus a fake MLX manifest in CLEF_HOME.
 */

let home: string;

beforeAll(async () => {
  home = path.join(os.tmpdir(), `clef-mlx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const clefHome = path.join(home, 'clef-home');
  const snapshot = path.join(clefHome, 'snapshots', 'clef-flash-mlx');
  await fsp.mkdir(snapshot, { recursive: true });
  await fsp.writeFile(path.join(snapshot, 'clef_mlx.py'), '# fake loader for tests\n');
  await fsp.mkdir(path.join(clefHome, 'models', 'clef-flash', 'mlx'), { recursive: true });

  const manifest = {
    schemaVersion: 1,
    kind: 'mlx',
    model: 'clef-flash',
    repo: 'mlx-community/clef-flash-4bit',
    revision: '140bf7e037f5fa95a96535feca112f46c15927cf',
    snapshotPath: snapshot,
    licenseId: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Cloudflare/clef-flash',
    installedAt: new Date().toISOString(),
    clefMcpVersion: 'test',
  };
  await fsp.writeFile(path.join(clefHome, 'models', 'clef-flash', 'mlx', 'manifest.json'), JSON.stringify(manifest, null, 2));

  const binDir = path.join(home, 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  const fakeUv = path.join(binDir, 'uv');
  await fsp.writeFile(fakeUv, `#!/bin/sh\nexec node "${fakeServerScript()}" "$@"\n`);
  await fsp.chmod(fakeUv, 0o755);
});

afterAll(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

function startClient(clefHome: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath()],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      CLEF_HOME: clefHome,
      CLEF_RUNTIME: 'mlx',
      CLEF_MLX_UV: path.join(home, 'bin', 'uv'),
      CLEF_LOG_LEVEL: 'error',
    },
  });
  const client = new Client({ name: 'mlx-test', version: '0' });
  return { client, transport };
}

describe('MLX runtime (fake uv, stdio)', () => {
  it(
    'loads via the mlx branch and answers clef_decide',
    async () => {
      const { client, transport } = startClient(path.join(home, 'clef-home'));
      await client.connect(transport);
      try {
        const result = await client.callTool({
          name: 'clef_decide',
          arguments: {
            state: 'deploy increased error rate',
            questions: {
              act: { type: 'choice', instructions: 'Next?', criteria: { rollback: 'Roll back', wait: 'Wait' } },
            },
          },
        });
        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as { model: string; decisions: Record<string, { answer: Record<string, number> }> };
        expect(structured.model).toBe('clef-flash');
        expect(Object.keys(structured.decisions.act?.answer ?? {}).sort()).toEqual(['rollback', 'wait']);
      } finally {
        await client.close();
      }
    },
  );

  it(
    'returns MODEL_NOT_INSTALLED when the mlx snapshot is missing',
    async () => {
      const { client, transport } = startClient(path.join(home, 'empty-clef-home'));
      await client.connect(transport);
      try {
        const result = await client.callTool({ name: 'clef_decide', arguments: sampleDecideArgs() });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
        expect(text).toContain('MODEL_NOT_INSTALLED');
        expect(text).toContain('--runtime mlx');
      } finally {
        await client.close();
      }
    },
  );
});
