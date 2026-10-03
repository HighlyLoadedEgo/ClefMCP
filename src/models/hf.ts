import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import { manifestPathFor, pathsFor } from '../config/paths.js';
import type { Logger } from '../config/logger.js';
import { writeModelManifest, readModelManifest, verifyModelFiles, type ModelManifest } from './manifest.js';
import { getQuantSpec, type ModelSpec, type QuantSpec } from './registry.js';

export const HF_BASE_URL = 'https://huggingface.co';

export function resolveUrl(repo: string, revision: string, file: string): string {
  return `${HF_BASE_URL}/${repo}/resolve/${revision}/${file}`;
}

export interface HfFileInfo {
  downloadUrl: string;
  /** sha256 from the HF xet/LFS hash, when advertised. */
  sha256?: string;
  size?: number;
}

/**
 * Resolve download URL + expected checksum. The sha256 arrives as the
 * `x-linked-etag` header on HF's 302, so we probe with redirect: 'manual'.
 */
export async function fetchFileInfo(repo: string, revision: string, file: string): Promise<HfFileInfo> {
  const url = resolveUrl(repo, revision, file);
  let res: Response;
  try {
    res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
  } catch (err) {
    throw new ClefError(
      ClefErrorCode.DOWNLOAD_FAILED,
      `Could not reach Hugging Face: ${err instanceof Error ? err.message : String(err)}`,
      'Check network connectivity and try again.',
    );
  }
  // 302 → metadata lives on the redirect response; some CDN configs answer 200 directly.
  if (res.status !== 302 && res.status !== 200) {
    throw new ClefError(
      ClefErrorCode.DOWNLOAD_FAILED,
      `Hugging Face returned HTTP ${res.status} for ${repo}@${revision}/${file}`,
      res.status === 404 ? 'The pinned model revision may have moved. Re-check the model registry.' : undefined,
    );
  }
  const sha256 = res.headers.get('x-linked-etag')?.replace(/"/g, '');
  const size = res.headers.get('x-linked-size') ? Number(res.headers.get('x-linked-size')) : undefined;
  return {
    downloadUrl: res.headers.get('location') ?? url,
    sha256: sha256 && /^[0-9a-f]{64}$/i.test(sha256) ? sha256 : undefined,
    size: Number.isFinite(size) ? size : undefined,
  };
}

export interface DownloadProgress {
  bytes: number;
  total?: number;
}

export interface DownloadOptions {
  expectedSha256?: string;
  expectedSize?: number;
  onProgress?(p: DownloadProgress): void;
  signal?: AbortSignal;
  attempts?: number;
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
}

/**
 * Stream a file to dest, hashing while writing. Retries transient failures by
 * restarting the download; checksum/size mismatches fail hard.
 */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  const attempts = opts.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await downloadOnce(url, dest, opts);
    } catch (err) {
      if (err instanceof ClefError && err.code === ClefErrorCode.CHECKSUM_MISMATCH) throw err;
      lastError = err;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
  }
  throw new ClefError(
    ClefErrorCode.DOWNLOAD_FAILED,
    `Download failed after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function downloadOnce(url: string, dest: string, opts: DownloadOptions): Promise<DownloadResult> {
  const res = await fetch(url, { redirect: 'follow', signal: opts.signal });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }
  const total = opts.expectedSize ?? (res.headers.get('content-length') ? Number(res.headers.get('content-length')) : undefined);
  const hash = createHash('sha256');
  const handle = await fsp.open(dest, 'w');
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      const buf = chunk as Buffer;
      hash.update(buf);
      await handle.write(buf);
      bytes += buf.length;
      opts.onProgress?.({ bytes, total });
    }
  } finally {
    await handle.close();
  }
  const sha256 = hash.digest('hex');
  if (opts.expectedSha256 && sha256 !== opts.expectedSha256) {
    await fsp.rm(dest, { force: true });
    throw new ClefError(
      ClefErrorCode.CHECKSUM_MISMATCH,
      `Checksum mismatch after download: expected ${opts.expectedSha256}, got ${sha256}`,
      'The download was discarded. Re-run `clef-mcp install`.',
    );
  }
  if (opts.expectedSize !== undefined && bytes !== opts.expectedSize) {
    await fsp.rm(dest, { force: true });
    throw new ClefError(
      ClefErrorCode.DOWNLOAD_FAILED,
      `Downloaded size mismatch: expected ${opts.expectedSize} bytes, got ${bytes}`,
    );
  }
  return { bytes, sha256 };
}

export interface InstallModelOptions {
  clefHome: string;
  modelSpec: ModelSpec;
  quantSpec: QuantSpec;
  clefMcpVersion: string;
  onProgress?(p: DownloadProgress): void;
  log?: Logger;
}

export interface InstallModelResult {
  manifest: ModelManifest;
  alreadyInstalled: boolean;
}

/**
 * Download a model quantization from its pinned HF revision, verify checksum,
 * and write the manifest. Safe to re-run: an intact install is a no-op.
 */
export async function installModel(opts: InstallModelOptions): Promise<InstallModelResult> {
  const { modelSpec, quantSpec } = opts;
  const { modelsDir } = pathsFor(opts.clefHome);
  const manifestPath = manifestPathFor(modelsDir, modelSpec.id, quantSpec.id);
  const existing = await readModelManifest(manifestPath);
  if (existing && (await verifyModelFiles(existing)).ok) {
    opts.log?.debug('model already installed', { model: modelSpec.id, quant: quantSpec.id });
    return { manifest: existing, alreadyInstalled: true };
  }

  const info = await fetchFileInfo(modelSpec.repo, modelSpec.revision, quantSpec.file);
  const finalPath = path.join(path.dirname(manifestPath), quantSpec.file);
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  const tmpPath = path.join(path.dirname(finalPath), `.download-${quantSpec.file}`);
  await fsp.rm(tmpPath, { force: true });

  opts.log?.info('downloading model', { repo: modelSpec.repo, file: quantSpec.file });
  const result = await downloadFile(info.downloadUrl, tmpPath, {
    expectedSha256: info.sha256,
    expectedSize: info.size ?? quantSpec.bytes,
    onProgress: opts.onProgress,
  });
  await fsp.rename(tmpPath, finalPath);

  const manifest: ModelManifest = {
    schemaVersion: 1,
    model: modelSpec.id,
    quant: quantSpec.id,
    file: quantSpec.file,
    modelPath: finalPath,
    bytes: result.bytes,
    sha256: result.sha256,
    repo: modelSpec.repo,
    revision: modelSpec.revision,
    licenseId: modelSpec.licenseId,
    licenseUrl: modelSpec.licenseUrl,
    installedAt: new Date().toISOString(),
    clefMcpVersion: opts.clefMcpVersion,
  };
  await writeModelManifest(manifestPath, manifest);
  opts.log?.info('model installed', { model: modelSpec.id, quant: quantSpec.id, sha256: result.sha256 });
  return { manifest, alreadyInstalled: false };
}
