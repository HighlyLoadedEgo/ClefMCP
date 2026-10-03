import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath, makeFakeInstall, sampleDecideArgs, type FakeInstall } from '../helpers.js';

const execFileP = promisify(execFile);

interface ClientHandle {
  client: Client;
  stop(): Promise<void>;
}

async function startServer(env: Record<string, string>): Promise<ClientHandle> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath()],
    env: { ...env, CLEF_LOG_LEVEL: env.CLEF_LOG_LEVEL ?? 'error' },
  });
  const client = new Client({ name: 'clef-mcp-test', version: '0.0.1' });
  await client.connect(transport);
  return {
    client,
    stop: async () => {
      await client.close();
    },
  };
}

let install: FakeInstall;
let emptyHome: FakeInstall;
const handles: ClientHandle[] = [];

beforeAll(async () => {
  install = await makeFakeInstall();
  emptyHome = await makeFakeInstall({ withModel: false });
});

afterAll(async () => {
  for (const h of handles.splice(0)) await h.stop();
  await fsp.rm(install.clefHome, { recursive: true, force: true });
  await fsp.rm(emptyHome.clefHome, { recursive: true, force: true });
});

async function withServer(env: Record<string, string>, fn: (h: ClientHandle) => Promise<void>): Promise<void> {
  const handle = await startServer(env);
  handles.push(handle);
  await fn(handle);
  await handle.stop();
}

describe('clef-mcp MCP server (stdio)', () => {
  it(
    'initializes and exposes exactly the clef_decide tool',
    async () => {
      await withServer(install.env, async ({ client }) => {
        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(1);
        const tool = tools.tools[0]!;
        expect(tool.name).toBe('clef_decide');
        expect(tool.inputSchema).toBeTruthy();
        const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
        expect(Object.keys(props)).toEqual(expect.arrayContaining(['state', 'questions']));
      });
    },
  );

  it(
    'returns structured probability distributions for all question types',
    async () => {
      await withServer(install.env, async ({ client }) => {
        const result = await client.callTool({ name: 'clef_decide', arguments: sampleDecideArgs() });
        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as {
          model: string;
          decisions: Record<string, { answer: Record<string, number> }>;
        };
        expect(structured.model).toBe('clef-flash');

        const choice = structured.decisions.next_action?.answer;
        expect(Object.keys(choice ?? {})).toHaveLength(4);
        expect(Object.values(choice ?? {}).reduce((s, p) => s + p, 0)).toBeCloseTo(1, 5);

        const score = structured.decisions.confidence?.answer;
        expect(Object.keys(score ?? {})).toEqual(['very_low', 'low', 'medium', 'high', 'very_high']);

        const noul = structured.decisions.outage?.answer;
        expect(noul?.true).toBeCloseTo(0.87, 5);
        expect(noul?.false).toBeCloseTo(0.13, 5);

        // The text content mirrors the structured JSON.
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
        expect(JSON.parse(text!)).toEqual(structured);
      });
    },
  );

  it(
    'accepts options.temperature as a documented no-op',
    async () => {
      await withServer(install.env, async ({ client }) => {
        const args = { ...sampleDecideArgs(), options: { temperature: 0.7 } };
        const result = await client.callTool({ name: 'clef_decide', arguments: args });
        expect(result.isError).toBeFalsy();
        expect((result.structuredContent as { model: string }).model).toBe('clef-flash');
      });
    },
  );

  it(
    'returns INVALID_INPUT for malformed arguments',
    async () => {
      await withServer(install.env, async ({ client }) => {
        const result = await client.callTool({
          name: 'clef_decide',
          arguments: { state: 'x', questions: { bad: { type: 'essay', instructions: 'i' } } },
        });
        expect(result.isError).toBe(true);
        // Schema-invalid input is rejected by the MCP SDK's protocol-level
        // validation before the tool handler runs, so the text is the SDK's
        // validation error rather than our structured JSON.
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
        expect(text).toMatch(/Input validation error/i);
      });
    },
  );

  it(
    'returns MODEL_NOT_INSTALLED when no model is present',
    async () => {
      await withServer(emptyHome.env, async ({ client }) => {
        const result = await client.callTool({ name: 'clef_decide', arguments: sampleDecideArgs() });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
        const parsed = JSON.parse(text!) as { error: { code: string; hint: string } };
        expect(parsed.error.code).toBe('MODEL_NOT_INSTALLED');
        expect(parsed.error.hint).toMatch(/clef-mcp install/);
      });
    },
  );

  it(
    'honors CLEF_MAX_STATE_BYTES and reports the limit in the error',
    async () => {
      const env = { ...install.env, CLEF_MAX_STATE_BYTES: '100' };
      await withServer(env, async ({ client }) => {
        const result = await client.callTool({
          name: 'clef_decide',
          arguments: { state: 'x'.repeat(150), questions: { n: { type: 'noul', instructions: 'i' } } },
        });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
        const parsed = JSON.parse(text!) as { error: { code: string; message: string; hint?: string } };
        expect(parsed.error.code).toBe('INVALID_INPUT');
        expect(parsed.error.message).toContain('100');
        expect(parsed.error.hint).toContain('CLEF_MAX_STATE_BYTES');
      });
    },
  );

  it(
    'rejects unknown model ids with INVALID_INPUT',
    async () => {
      await withServer(install.env, async ({ client }) => {
        const args = { ...sampleDecideArgs(), model: 'gpt-5' };
        const result = await client.callTool({ name: 'clef_decide', arguments: args });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
        expect((JSON.parse(text!) as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
      });
    },
  );

  it(
    'shuts down the fake llama-server on client disconnect',
    async () => {
      const handle = await startServer(install.env);
      handles.push(handle);
      await handle.client.callTool({ name: 'clef_decide', arguments: sampleDecideArgs() });
      const listPids = async () =>
        (await execFileP('pgrep', ['-f', 'fake-llama-server.mjs']).catch(() => ({ stdout: '' }))).stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      const pidsBefore = await listPids();
      expect(pidsBefore.length).toBeGreaterThan(0);
      await handle.stop();
      await new Promise((r) => setTimeout(r, 500));
      const pidsAfter = new Set(await listPids());
      // Scoped to the pids this test observed: other test files may run their
      // own fake servers concurrently, so only our own leaks count as failure.
      const leaked = pidsBefore.filter((p) => pidsAfter.has(p));
      expect(leaked).toEqual([]);
    },
  );
});

