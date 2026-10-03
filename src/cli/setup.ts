import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import { confirm } from './prompt.js';

export const SERVER_ENTRY = { command: 'clef-mcp', args: [], type: 'stdio' } as const;

export type SetupClient = 'zcode' | 'claude-code' | 'codex' | 'cursor';

export interface SetupOptions {
  clients?: string;
  skill?: boolean;
  noSkill?: boolean;
  yes?: boolean;
}

export interface SetupReport {
  client: SetupClient | 'skill';
  status: 'configured' | 'already-configured' | 'skipped' | 'manual-hint';
  detail: string;
}

const HOME = () => os.homedir();

function bundledSkillPath(): string {
  // dist/cli.js → ../skills/clef-decisions/SKILL.md (shipped via npm "files").
  return fileURLToPath(new URL('../skills/clef-decisions/SKILL.md', import.meta.url));
}

async function mergeJsonServerEntry(file: string, serverKey: string, container: 'mcp.servers' | 'mcpServers'): Promise<'configured' | 'already-configured'> {
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    doc = {};
  }
  if (container === 'mcp.servers') {
    const mcp = (doc.mcp as Record<string, unknown> | undefined) ?? {};
    const servers = (mcp.servers as Record<string, unknown> | undefined) ?? {};
    if (servers[serverKey]) return 'already-configured';
    servers[serverKey] = { ...SERVER_ENTRY };
    mcp.servers = servers;
    doc.mcp = mcp;
  } else {
    const servers = (doc.mcpServers as Record<string, unknown> | undefined) ?? {};
    if (servers[serverKey]) return 'already-configured';
    servers[serverKey] = { command: SERVER_ENTRY.command, args: [...SERVER_ENTRY.args] };
    doc.mcpServers = servers;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return 'configured';
}

const CODEX_SECTION = [
  '[mcp_servers.clef-mcp]',
  'command = "clef-mcp"',
  'args = []',
  '',
].join('\n');

async function setupCodex(): Promise<SetupReport> {
  const file = path.join(HOME(), '.codex', 'config.toml');
  let content = '';
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch {
    content = '';
  }
  if (content.includes('[mcp_servers.clef-mcp]')) {
    return { client: 'codex', status: 'already-configured', detail: file };
  }
  const next = (content && !content.endsWith('\n') ? content + '\n' : content) + '\n' + CODEX_SECTION;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, next, 'utf8');
  return { client: 'codex', status: 'configured', detail: file };
}

async function setupZcode(): Promise<SetupReport> {
  const file = path.join(HOME(), '.zcode', 'cli', 'config.json');
  const status = await mergeJsonServerEntry(file, 'clef-mcp', 'mcp.servers');
  return { client: 'zcode', status, detail: file };
}

async function setupCursor(): Promise<SetupReport> {
  const file = path.join(HOME(), '.cursor', 'mcp.json');
  const status = await mergeJsonServerEntry(file, 'clef-mcp', 'mcpServers');
  return { client: 'cursor', status, detail: file };
}

function whichCli(bin: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

async function setupClaudeCode(): Promise<SetupReport> {
  const claude = whichCli('claude');
  if (!claude) {
    return {
      client: 'claude-code',
      status: 'manual-hint',
      detail: 'claude CLI not found — run manually: claude mcp add clef-mcp -- clef-mcp',
    };
  }
  const existing = await new Promise<string>((resolve) => {
    execFile(claude, ['mcp', 'list'], { timeout: 30_000, encoding: 'utf8' }, (_err, stdout) => resolve(String(stdout)));
  });
  if (existing.includes('clef-mcp')) {
    return { client: 'claude-code', status: 'already-configured', detail: 'claude mcp list' };
  }
  await new Promise<void>((resolve, reject) => {
    execFile(claude, ['mcp', 'add', '--scope', 'user', 'clef-mcp', '--', 'clef-mcp'], { timeout: 60_000, encoding: 'utf8' }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
  return { client: 'claude-code', status: 'configured', detail: 'claude mcp add --scope user' };
}

export async function installSkill(): Promise<SetupReport> {
  const src = bundledSkillPath();
  const destDir = path.join(HOME(), '.agents', 'skills', 'clef-decisions');
  const dest = path.join(destDir, 'SKILL.md');
  let content = '';
  try {
    content = await fsp.readFile(dest, 'utf8');
  } catch {
    // not installed yet
  }
  const incoming = await fsp.readFile(src, 'utf8');
  if (content === incoming) {
    return { client: 'skill', status: 'already-configured', detail: dest };
  }
  await fsp.mkdir(destDir, { recursive: true });
  await fsp.writeFile(dest, incoming, 'utf8');
  return { client: 'skill', status: 'configured', detail: dest };
}

function parseClients(raw: string | undefined): SetupClient[] {
  const all: SetupClient[] = ['zcode', 'claude-code', 'codex', 'cursor'];
  if (!raw || raw === 'all') return all;
  const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const w of wanted) {
    if (!all.includes(w as SetupClient)) {
      throw new ClefError(
        ClefErrorCode.INVALID_INPUT,
        `Unknown client "${w}".`,
        `Available: ${all.join(', ')} (or "all")`,
      );
    }
  }
  return wanted as SetupClient[];
}

/** Register the MCP server + agent skill in the user's clients. */
export async function runSetup(opts: SetupOptions): Promise<void> {
  const wantSkill = opts.skill === true || opts.noSkill !== true;
  const clients = parseClients(opts.clients);

  const plan: string[] = [...clients, ...(wantSkill ? ['skill' as const] : [])];
  console.log(`Setup will register clef-mcp with: ${plan.join(', ')}\n`);
  const ok = await confirm('Continue?', opts.yes === true);
  if (!ok) {
    console.log('Aborted. Nothing was changed.');
    return;
  }

  const reports: SetupReport[] = [];
  for (const client of clients) {
    try {
      if (client === 'zcode') reports.push(await setupZcode());
      else if (client === 'cursor') reports.push(await setupCursor());
      else if (client === 'codex') reports.push(await setupCodex());
      else if (client === 'claude-code') reports.push(await setupClaudeCode());
    } catch (err) {
      reports.push({
        client,
        status: 'manual-hint',
        detail: `failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (wantSkill) {
    try {
      reports.push(await installSkill());
    } catch (err) {
      reports.push({
        client: 'skill',
        status: 'manual-hint',
        detail: `failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  console.log('');
  for (const r of reports) {
    const mark = r.status === 'configured' ? '+' : r.status === 'already-configured' ? '=' : '!';
    console.log(`${mark}  ${r.client.padEnd(12)} ${r.status.padEnd(20)} ${r.detail}`);
  }
  console.log('\nDone. Restart your MCP clients (new agent sessions) to pick up the server.');
}
