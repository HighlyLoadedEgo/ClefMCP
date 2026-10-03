import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath } from '../helpers.js';

const execFileP = promisify(execFile);

function home() {
  return path.join(os.tmpdir(), `clef-setup-${runId}`);
}

let runId: string;

beforeAll(() => {
  runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterAll(async () => {
  await fsp.rm(home(), { recursive: true, force: true });
});

function run(args: string[]) {
  return execFileP(process.execPath, [cliPath(), ...args], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home(),
      CLEF_LOG_LEVEL: 'error',
    },
    timeout: 60_000,
    encoding: 'utf8',
  });
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
}

describe('clef-mcp setup', () => {
  it(
    'registers the server in zcode + cursor and installs the skill',
    async () => {
      const { stdout } = await run(['setup', '--clients', 'zcode,cursor', '--yes']);
      expect(stdout).toContain('Done');

      const zcode = await readJson(path.join(home(), '.zcode', 'cli', 'config.json'));
      const zServers = ((zcode.mcp as Record<string, unknown>).servers as Record<string, Record<string, unknown>>)['clef-mcp'];
      expect(zServers).toMatchObject({ command: 'clef-mcp', type: 'stdio' });

      const cursor = await readJson(path.join(home(), '.cursor', 'mcp.json'));
      expect((cursor.mcpServers as Record<string, Record<string, unknown>>)['clef-mcp']).toMatchObject({ command: 'clef-mcp' });

      const skill = await fsp.readFile(path.join(home(), '.agents', 'skills', 'clef-decisions', 'SKILL.md'), 'utf8');
      expect(skill).toContain('clef_decide');
    },
  );

  it(
    'is idempotent (second run reports already-configured)',
    async () => {
      const { stdout } = await run(['setup', '--clients', 'zcode,cursor', '--yes']);
      expect(stdout.match(/=/g)?.length).toBeGreaterThanOrEqual(3);
      // And the zcode config still parses with exactly one clef-mcp entry.
      const zcode = await readJson(path.join(home(), '.zcode', 'cli', 'config.json'));
      const servers = (zcode.mcp as Record<string, unknown>).servers as Record<string, unknown>;
      expect(Object.keys(servers).filter((k) => k === 'clef-mcp')).toHaveLength(1);
    },
  );

  it(
    'appends the codex toml section idempotently',
    async () => {
      await run(['setup', '--clients', 'codex', '--yes']);
      await run(['setup', '--clients', 'codex', '--yes']);
      const toml = await fsp.readFile(path.join(home(), '.codex', 'config.toml'), 'utf8');
      expect(toml.match(/\[mcp_servers\.clef-mcp\]/g)).toHaveLength(1);
      expect(toml).toContain('command = "clef-mcp"');
    },
  );

  it(
    'rejects unknown client names with INVALID_INPUT',
    async () => {
      await expect(run(['setup', '--clients', 'wechat', '--yes'])).rejects.toThrow(/Unknown client/);
    },
  );
});
