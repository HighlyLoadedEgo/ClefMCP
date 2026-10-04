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
    'lists and returns bundled prompts',
    async () => {
      await withServer(install.env, async ({ client }) => {
        const prompts = await client.listPrompts();
        const names = prompts.prompts.map((p) => p.name).sort();
        expect(names).toEqual(['incident-triage', 'next-action', 'security-review', 'ticket-routing']);

        const got = await client.getPrompt({
          name: 'incident-triage',
          arguments: { incident_description: 'checkout 500s after deploy' },
        });
        const text = (got.messages[0]!.content as { type: string; text: string }).text;
        expect(text).toContain('clef_decide');
        expect(text).toContain('checkout 500s after deploy');
      });
    },
  );

  it(
    'lists and reads bundled resources',
    async () => {
      await withServer(install.env, async ({ client }) => {
        const resources = await client.listResources();
        const uris = resources.resources.map((r) => r.uri).sort();
        expect(uris).toEqual(['clef-mcp://capabilities', 'clef-mcp://evals/dataset', 'clef-mcp://evals/schema']);

        const caps = await client.readResource({ uri: 'clef-mcp://capabilities' });
        const capsText = (caps.contents[0] as { text: string }).text;
        expect(JSON.parse(capsText)).toMatchObject({ name: 'clef-mcp', model: 'clef-flash', runtime: 'llama-cpp' });

        const dataset = await client.readResource({ uri: 'clef-mcp://evals/dataset' });
        expect((dataset.contents[0] as { text: string }).text).toContain('coding-inspect-first');
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
          decisions: Record<string, { answer: Record<string, number>; confidence?: number }>;
          usage?: { input_tokens?: number; output_tokens?: number; latency_ms?: number };
        };
        expect(structured.model).toBe('clef-flash');

        const choice = structured.decisions.next_action?.answer;
        expect(Object.keys(choice ?? {})).toHaveLength(4);
        expect(Object.values(choice ?? {}).reduce((s, p) => s + p, 0)).toBeCloseTo(1, 5);
        // The fake llama-server reports confidence for choice/score answers.
        expect(structured.decisions.next_action?.confidence).toBeCloseTo(0.6, 5);

        const score = structured.decisions.confidence?.answer;
        expect(Object.keys(score ?? {})).toEqual(['very_low', 'low', 'medium', 'high', 'very_high']);
        expect(structured.decisions.confidence?.confidence).toBeCloseTo(0.5, 5);

        // The fake mirrors the live llama.cpp shape, which omits confidence for noul.
        const noul = structured.decisions.outage?.answer;
        expect(noul?.true).toBeCloseTo(0.87, 5);
        expect(noul?.false).toBeCloseTo(0.13, 5);
        expect(structured.decisions.outage?.confidence).toBeUndefined();

        // Token usage / latency pass through when the runtime reports them.
        expect(structured.usage).toEqual({ input_tokens: 42, output_tokens: 0, latency_ms: 3 });

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
      const listPids = async () => {
        const { stdout } = await execFileP('pgrep', ['-f', 'fake-llama-server.mjs']).catch(() => ({ stdout: '' }));
        const pids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        // Scope to this install: other test files (e.g. the daemon tests) keep
        // their own long-lived fake servers, which are not leaks of ours.
        const scoped: string[] = [];
        for (const pid of pids) {
          const { stdout: cmd } = await execFileP('ps', ['-p', pid, '-o', 'command=']).catch(() => ({ stdout: '' }));
          if (cmd.includes(install.clefHome)) scoped.push(pid);
        }
        return scoped;
      };
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

