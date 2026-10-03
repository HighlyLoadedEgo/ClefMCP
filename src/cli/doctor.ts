import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ClefError } from '../clef/errors.js';
import { loadConfig } from '../config/env.js';
import { pathsFor } from '../config/paths.js';
import { deepVerifyChecksum, findInstalledManifest, verifyModelFiles } from '../models/manifest.js';
import { assertSupportedPlatform, detectPlatform, formatBytes } from '../models/platform.js';
import { getModelSpec } from '../models/registry.js';
import { resolveLlamaServerBinary } from '../runtime/binary.js';
import { probeInference } from '../runtime/probe.js';

const execFileP = promisify(execFile);

export interface DoctorOptions {
  deep?: boolean;
  json?: boolean;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  /** Informational checks do not affect the exit code. */
  informational?: boolean;
}

function mark(ok: boolean): string {
  return ok ? '✔' : '✘';
}

function printCheck(check: DoctorCheck): void {
  const skip = check.informational && !check.ok ? 'ℹ' : mark(check.ok);
  console.log(`${skip}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  if (check.hint) console.log(`      hint: ${check.hint}`);
}

async function checkBinaryVersion(binaryPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP(binaryPath, ['--version'], { timeout: 20_000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

interface McpConfigHint {
  client: string;
  path: string;
  configured: boolean;
}

async function detectMcpConfigs(): Promise<McpConfigHint[]> {
  const home = os.homedir();
  const hints: McpConfigHint[] = [
    { client: 'Codex', path: path.join(home, '.codex', 'config.toml'), configured: false },
    { client: 'Claude Code (user)', path: path.join(home, '.claude.json'), configured: false },
    { client: 'Claude Code (project)', path: path.resolve('.mcp.json'), configured: false },
    { client: 'Cursor', path: path.join(process.cwd(), '.cursor', 'mcp.json'), configured: false },
  ];
  for (const hint of hints) {
    try {
      const content = await fsp.readFile(hint.path, 'utf8');
      hint.configured = content.includes('clef-mcp');
    } catch {
      hint.configured = false;
    }
  }
  return hints;
}

export async function runDoctor(opts: DoctorOptions): Promise<boolean> {
  const config = loadConfig();
  const checks: DoctorCheck[] = [];
  const { modelsDir } = pathsFor(config.clefHome);

  // 1. Platform
  const info = await detectPlatform();
  try {
    assertSupportedPlatform(info);
    checks.push({ name: 'OS / architecture', ok: true, detail: `${info.platform}/${info.arch}` });
  } catch (err) {
    checks.push({
      name: 'OS / architecture',
      ok: false,
      detail: `${info.platform}/${info.arch}`,
      hint: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Memory — advisory: the install flow enforces the real requirement
  // (pickQuant throws below 16 GB); here it is a warning, not a failure.
  const memGb = info.totalMemBytes / 1024 ** 3;
  checks.push({
    name: 'Memory',
    ok: memGb >= 16,
    informational: true,
    detail: formatBytes(info.totalMemBytes),
    hint: memGb < 16 ? 'Clef-Flash Q4_K_M needs ~16 GB of memory to run comfortably.' : undefined,
  });

  // 3. GPU (informational — llama.cpp uses Metal on macOS by default)
  checks.push({
    name: 'GPU',
    ok: true,
    informational: true,
    detail: info.gpu?.name
      ? `${info.gpu.name}${info.gpu.vramBytes ? ` (${formatBytes(info.gpu.vramBytes)})` : ''}`
      : 'not detected (llama.cpp falls back to CPU; on Apple Silicon Metal is built in)',
  });

  // 4. Runtime binary
  let binaryPath: string | undefined;
  try {
    const binary = resolveLlamaServerBinary(config);
    binaryPath = binary.path;
    const version = await checkBinaryVersion(binary.path);
    checks.push({
      name: 'Runtime binary',
      ok: version !== undefined,
      detail: `${binary.source}: ${binary.path}${version ? ` (${version})` : ''}`,
      hint: version === undefined ? 'The binary exists but did not answer --version; it may be broken or incompatible.' : undefined,
    });
  } catch (err) {
    checks.push({
      name: 'Runtime binary',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      hint: err instanceof ClefError ? err.hint : undefined,
    });
  }

  // 5. Model
  let spec;
  let manifest;
  try {
    spec = getModelSpec(config.model);
    manifest = await findInstalledManifest(config.clefHome, spec);
  } catch {
    checks.push({ name: 'Model', ok: false, detail: `unknown model id "${config.model}"` });
  }
  if (spec) {
    if (!manifest) {
      checks.push({
        name: 'Model',
        ok: false,
        detail: `${spec.id} is not installed`,
        hint: 'Run `clef-mcp install`.',
      });
    } else {
      const verify = await verifyModelFiles(manifest);
      let detail = `${manifest.quant} at ${manifest.modelPath} (${formatBytes(manifest.bytes)})`;
      let ok = verify.ok;
      if (ok && opts.deep) {
        const deep = await deepVerifyChecksum(manifest);
        ok = deep.ok;
        detail += deep.ok ? ' — checksum OK' : ` — ${deep.problems.join('; ')}`;
      } else if (ok) {
        detail += ' — size OK (use --deep to verify checksum)';
      }
      checks.push({
        name: 'Model',
        ok,
        detail,
        hint: ok ? undefined : 'Re-run `clef-mcp install` to re-download the model.',
      });
      checks.push({
        name: 'Model license',
        ok: true,
        informational: true,
        detail: `${spec.licenseId} — ${spec.licenseUrl}`,
      });
    }
  }

  // 6. Inference probe (end-to-end)
  if (binaryPath && manifest && (await verifyModelFiles(manifest)).ok) {
    try {
      const probe = await probeInference(config, manifest, undefined, 180_000);
      checks.push({
        name: 'Inference',
        ok: true,
        detail: `probe decision returned in ${(probe.latencyMs / 1000).toFixed(1)}s (incl. model load)`,
      });
    } catch (err) {
      const clefErr = err instanceof ClefError ? err : undefined;
      checks.push({
        name: 'Inference',
        ok: false,
        detail: clefErr?.message ?? (err instanceof Error ? err.message : String(err)),
        hint: clefErr?.hint ?? 'The installed llama.cpp build may lack clef support; update llama.cpp or run `clef-mcp install`.',
      });
    }
  } else {
    checks.push({
      name: 'Inference',
      ok: false,
      informational: true,
      detail: 'skipped (model or runtime missing)',
    });
  }

  // 7. MCP client configuration (informational)
  const mcpHints = await detectMcpConfigs();
  const configured = mcpHints.filter((h) => h.configured);
  checks.push({
    name: 'MCP client configuration',
    ok: true,
    informational: true,
    detail: configured.length
      ? configured.map((h) => `${h.client}: ${h.path}`).join('; ')
      : 'no clef-mcp registration found (add it to your client; see README)',
  });

  if (opts.json) {
    console.log(JSON.stringify({ clefHome: pathsFor(config.clefHome).root, modelCache: modelsDir, checks }, null, 2));
  } else {
    console.log(`clef-mcp doctor (cache: ${pathsFor(config.clefHome).root})\n`);
    for (const check of checks) printCheck(check);
  }

  const failed = checks.filter((c) => !c.ok && !c.informational);
  if (!opts.json) {
    console.log(
      failed.length === 0
        ? '\nAll critical checks passed.'
        : `\n${failed.length} critical check(s) failed.`,
    );
  }
  return failed.length > 0;
}
