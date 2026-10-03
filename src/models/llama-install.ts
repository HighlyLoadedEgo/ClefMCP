import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import type { ClefConfig } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import { llamaRuntimeDir, llamaServerName, pathsFor } from '../config/paths.js';
import { downloadFile } from './hf.js';
import { writeRuntimeManifest, readRuntimeManifest } from './manifest.js';
import { resolveLlamaServerBinary, type ResolvedBinary } from '../runtime/binary.js';

const GITHUB_API = 'https://api.github.com/repos/ggml-org/llama.cpp';

interface GhRelease {
  tag_name: string;
  published_at?: string;
  assets: Array<{ name: string; size: number; browser_download_url: string }>;
}

async function ghJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'clef-mcp' },
    });
  } catch (err) {
    throw new ClefError(
      ClefErrorCode.DOWNLOAD_FAILED,
      `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new ClefError(
      ClefErrorCode.DOWNLOAD_FAILED,
      `GitHub API returned HTTP ${res.status} for ${url}`,
      res.status === 403 ? 'GitHub API rate limit may be hit; install llama.cpp manually and retry.' : undefined,
    );
  }
  return (await res.json()) as T;
}

interface AssetPattern {
  match: RegExp;
  /** Prefer the first pattern that matches, in order. */
  alternates?: RegExp[];
}

/** Official nightly asset naming: `llama-bNNNNN-bin-macos-arm64.tar.gz`, `llama-bin-win-cuda-...-x64.zip`, etc. */
function assetPatterns(platform: string, arch: string): AssetPattern {
  switch (platform) {
    case 'darwin':
      return arch === 'arm64'
        ? { match: /^llama-.*-bin-macos-arm64\.tar\.gz$/ }
        : { match: /^llama-.*-bin-macos-x64\.tar\.gz$/ };
    case 'linux':
      return arch === 'arm64'
        ? { match: /^llama-.*-bin-ubuntu-arm64\.tar\.gz$/ }
        : { match: /^llama-.*-bin-ubuntu-x64\.tar\.gz$/ };
    case 'win32':
      // CPU builds only; CUDA/Vulkan need extra runtime deps. Prefer avx2.
      return {
        match: /^llama-.*-bin-win-avx2-x64\.zip$/,
        alternates: [/^llama-.*-bin-win-noavx-x64\.zip$/, /^llama-.*-bin-win-x64\.zip$/],
      };
    default:
      throw new ClefError(ClefErrorCode.UNSUPPORTED_PLATFORM, `Unsupported platform ${platform}/${arch}`);
  }
}

function pickAsset(release: GhRelease, platform: string, arch: string): GhRelease['assets'][number] {
  const { match, alternates } = assetPatterns(platform, arch);
  const names = release.assets.map((a) => a.name.toLowerCase());
  const find = (re: RegExp) => release.assets[names.findIndex((n) => re.test(n))];
  const asset = find(match) ?? alternates?.map(find).find(Boolean);
  if (!asset) {
    throw new ClefError(
      ClefErrorCode.DOWNLOAD_FAILED,
      `No llama.cpp release asset for ${platform}/${arch} in ${release.tag_name}`,
      'Install llama.cpp manually (`brew install llama.cpp` or https://llama.app) and re-run install.',
    );
  }
  return asset;
}

function execTar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { cwd, timeout: 300_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`tar ${args.join(' ')} failed: ${stderr || err.message}`));
      else resolve();
    });
  });
}

async function findServerBinary(dir: string, platform: string): Promise<string> {
  const target = llamaServerName(platform);
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name === target) return full;
    }
  }
  throw new ClefError(
    ClefErrorCode.DOWNLOAD_FAILED,
    `Extracted llama.cpp release did not contain ${target}`,
  );
}

async function extractRelease(archivePath: string, destDir: string, platform: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const args = archivePath.endsWith('.zip')
    ? ['-xf', archivePath]
    : ['-xzf', archivePath];
  try {
    await execTar(args, destDir);
  } catch (err) {
    // GNU tar (common on Linux) cannot read zip; surface a clear hint.
    throw new ClefError(
      ClefErrorCode.DOWNLOAD_FAILED,
      `Could not extract ${path.basename(archivePath)}: ${err instanceof Error ? err.message : String(err)}`,
      'Extract the archive manually and point CLEF_LLAMA_BIN at llama-server.',
    );
  }
}

export interface ManagedRuntimeResult extends ResolvedBinary {
  releaseTag: string;
  freshInstall: boolean;
}

/**
 * Ensure a llama-server binary exists: resolve env/managed/PATH first, else
 * download the official ggml-org nightly build into CLEF_HOME/runtime.
 */
export async function ensureLlamaRuntime(cfg: ClefConfig, log?: Logger): Promise<ManagedRuntimeResult> {
  try {
    const resolved = resolveLlamaServerBinary(cfg);
    if (resolved.source === 'managed') {
      const platformDir = llamaRuntimeDir(pathsFor(cfg.clefHome).runtimeDir, process.platform, process.arch);
      const manifest = readRuntimeManifest(path.join(platformDir, 'runtime-manifest.json'));
      return { ...resolved, releaseTag: manifest?.releaseTag ?? 'unknown', freshInstall: false };
    }
    return { ...resolved, releaseTag: resolved.source, freshInstall: false };
  } catch (err) {
    if (!(err instanceof ClefError) || err.code !== ClefErrorCode.RUNTIME_NOT_FOUND) throw err;
  }
  const fresh = await downloadManagedLlama(cfg, log);
  return { ...fresh, freshInstall: true };
}

export async function downloadManagedLlama(cfg: ClefConfig, log?: Logger): Promise<ResolvedBinary & { releaseTag: string }> {
  const platform = process.platform;
  const arch = process.arch;
  const { runtimeDir } = pathsFor(cfg.clefHome);
  const platformDir = llamaRuntimeDir(runtimeDir, platform, arch);

  let release: GhRelease;
  if (cfg.llamaReleaseTag) {
    release = await ghJson<GhRelease>(`${GITHUB_API}/releases/tags/${cfg.llamaReleaseTag}`);
  } else {
    const releases = await ghJson<GhRelease[]>(`${GITHUB_API}/releases?per_page=15`);
    const nightly = releases.find((r) => /^b\d+$/.test(r.tag_name));
    if (!nightly) {
      throw new ClefError(
        ClefErrorCode.DOWNLOAD_FAILED,
        'No llama.cpp nightly release found on GitHub.',
        'Install llama.cpp manually (`brew install llama.cpp` or https://llama.app) and re-run install.',
      );
    }
    release = nightly;
  }

  const asset = pickAsset(release, platform, arch);
  log?.info('downloading llama.cpp runtime', { tag: release.tag_name, asset: asset.name });
  // The macOS builds link ggml/llama dylibs via @rpath, so the binary must
  // stay inside its release layout: extract into <platformDir>/<tag>/ and
  // record the real path in the manifest instead of moving it out.
  const tagDir = path.join(platformDir, release.tag_name);
  await fsp.mkdir(tagDir, { recursive: true });
  const tmpArchive = path.join(platformDir, `.download-${asset.name}`);
  await fsp.rm(tmpArchive, { force: true });
  const result = await downloadFile(asset.browser_download_url, tmpArchive, { expectedSize: asset.size, attempts: 3 });
  await extractRelease(tmpArchive, tagDir, platform);
  await fsp.rm(tmpArchive, { force: true });

  const binaryPath = await findServerBinary(tagDir, platform);
  if (platform !== 'win32') await fsp.chmod(binaryPath, 0o755);

  await writeRuntimeManifest(path.join(platformDir, 'runtime-manifest.json'), {
    schemaVersion: 1,
    kind: 'llama-cpp',
    releaseTag: release.tag_name,
    asset: asset.name,
    bytes: result.bytes,
    binaryPath,
    installedAt: new Date().toISOString(),
  });
  log?.info('llama.cpp runtime installed', { tag: release.tag_name, path: binaryPath });
  return { source: 'managed', path: binaryPath, releaseTag: release.tag_name };
}

/** Remove the managed llama.cpp runtime directory, if present. */
export async function removeManagedRuntime(cfg: ClefConfig): Promise<boolean> {
  const { runtimeDir } = pathsFor(cfg.clefHome);
  const dir = llamaRuntimeDir(runtimeDir, process.platform, process.arch);
  try {
    await fsp.stat(dir);
  } catch {
    return false;
  }
  await fsp.rm(dir, { recursive: true, force: true });
  return true;
}
