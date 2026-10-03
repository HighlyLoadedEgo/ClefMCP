import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import { pathsFor } from '../config/paths.js';
import type { Logger } from '../config/logger.js';

/**
 * MLX runtime model install: snapshot of mlx-community/clef-flash-4bit (which
 * bundles the self-contained `clef_mlx.py` loader/served) fetched into
 * CLEF_HOME via a uv-managed huggingface_hub, no global Python state.
 */

export const MLX_MODEL_REPO = 'mlx-community/clef-flash-4bit';
export const MLX_MODEL_REVISION = '140bf7e037f5fa95a96535feca112f46c15927cf';

export interface MlxManifest {
  schemaVersion: 1;
  kind: 'mlx';
  model: string;
  repo: string;
  revision: string;
  /** Absolute path of the downloaded snapshot directory. */
  snapshotPath: string;
  licenseId: string;
  licenseUrl: string;
  installedAt: string;
  clefMcpVersion: string;
}

function manifestPath(clefHome: string): string {
  return path.join(pathsFor(clefHome).modelsDir, 'clef-flash', 'mlx', 'manifest.json');
}

export async function readMlxManifest(clefHome: string): Promise<MlxManifest | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath(clefHome), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as MlxManifest;
    if (parsed.kind === 'mlx' && typeof parsed.snapshotPath === 'string') return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

export async function writeMlxManifest(clefHome: string, manifest: MlxManifest): Promise<void> {
  const file = manifestPath(clefHome);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/** Installed = manifest present and the snapshot still contains the loader. */
export async function mlxIsInstalled(clefHome: string): Promise<MlxManifest | undefined> {
  const manifest = await readMlxManifest(clefHome);
  if (!manifest) return undefined;
  try {
    await fsp.access(path.join(manifest.snapshotPath, 'clef_mlx.py'));
    return manifest;
  } catch {
    return undefined;
  }
}

export function resolveUv(envUv: string | undefined): string {
  if (envUv?.trim()) return envUv.trim();
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'uv');
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  throw new ClefError(
    ClefErrorCode.RUNTIME_NOT_FOUND,
    'uv is required for the MLX runtime but was not found on PATH.',
    'Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh',
  );
}

interface RunOptions {
  timeoutMs?: number;
  onStdoutLine?(line: string): void;
}

/** Run a short uv command, returning the trimmed stdout. */
export async function runUv(uvBin: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      uvBin,
      args,
      { timeout: opts.timeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new ClefError(
              ClefErrorCode.DOWNLOAD_FAILED,
              `uv command failed: ${err.message.split('\n')[0]}${stderr ? `\n${stderr.trim().slice(0, 1000)}` : ''}`,
              'Make sure uv is up to date: uv self update',
            ),
          );
        } else {
          resolve(stdout.trim());
        }
      },
    );
    if (opts.onStdoutLine) {
      let buf = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) opts.onStdoutLine!(line);
      });
    }
  });
}

/**
 * Download the pinned MLX snapshot (or return the existing one). Safe to
 * re-run. Returns the manifest describing the snapshot.
 */
export async function installModelMlx(opts: {
  clefHome: string;
  uvBin?: string;
  clefMcpVersion: string;
  log?: Logger;
}): Promise<MlxManifest> {
  const existing = await mlxIsInstalled(opts.clefHome);
  if (existing) return existing;

  const uvBin = resolveUv(opts.uvBin ?? process.env.CLEF_MLX_UV);
  const hfCache = path.join(pathsFor(opts.clefHome).root, 'hf-cache');
  await fsp.mkdir(hfCache, { recursive: true });

  opts.log?.info('downloading MLX model snapshot', { repo: MLX_MODEL_REPO, revision: MLX_MODEL_REVISION });
  const py = [
    'from huggingface_hub import snapshot_download',
    `p = snapshot_download("${MLX_MODEL_REPO}", revision="${MLX_MODEL_REVISION}", cache_dir=r"${hfCache}")`,
    'print(p)',
  ].join('\n');
  const stdout = await runUv(
    uvBin,
    ['run', '--with', 'huggingface_hub', 'python', '-c', py],
    {
      timeoutMs: 1_800_000,
      onStdoutLine: (line) => {
        if (line.trim()) opts.log?.debug(line.trimEnd());
      },
    },
  );
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('/'));
  const snapshotPath = lines.at(-1)?.trim();
  if (!snapshotPath) {
    throw new ClefError(ClefErrorCode.DOWNLOAD_FAILED, 'snapshot_download did not report a snapshot path');
  }
  await fsp.access(path.join(snapshotPath, 'clef_mlx.py'));

  const manifest: MlxManifest = {
    schemaVersion: 1,
    kind: 'mlx',
    model: 'clef-flash',
    repo: MLX_MODEL_REPO,
    revision: MLX_MODEL_REVISION,
    snapshotPath,
    licenseId: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Cloudflare/clef-flash',
    installedAt: new Date().toISOString(),
    clefMcpVersion: opts.clefMcpVersion,
  };
  await writeMlxManifest(opts.clefHome, manifest);
  opts.log?.info('MLX model installed', { snapshotPath });
  return manifest;
}

/** Remove the MLX snapshot + manifest. */
export async function removeMlxModel(clefHome: string): Promise<boolean> {
  const manifest = await readMlxManifest(clefHome);
  if (!manifest) return false;
  await fsp.rm(manifest.snapshotPath, { recursive: true, force: true }).catch(() => undefined);
  await fsp.rm(path.dirname(manifestPath(clefHome)), { recursive: true, force: true });
  return true;
}
