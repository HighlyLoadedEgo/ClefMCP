import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { manifestPathFor, modelQuantDir, pathsFor } from '../config/paths.js';
import { QUANT_PREFERENCE, getQuantSpec, type ModelSpec, type QuantSpec } from './registry.js';

export interface ModelManifest {
  schemaVersion: 1;
  model: string;
  quant: string;
  file: string;
  /** Absolute path to the model file. */
  modelPath: string;
  bytes: number;
  /** sha256 of the model file (from the HF xet/LFS hash, verified after download). */
  sha256?: string;
  repo: string;
  revision: string;
  licenseId: string;
  licenseUrl: string;
  installedAt: string;
  clefMcpVersion: string;
}

export interface RuntimeManifest {
  schemaVersion: 1;
  kind: 'llama-cpp';
  releaseTag: string;
  asset: string;
  bytes: number;
  binaryPath: string;
  installedAt: string;
}

function isModelManifest(v: unknown): v is ModelManifest {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    m.schemaVersion === 1 &&
    typeof m.model === 'string' &&
    typeof m.quant === 'string' &&
    typeof m.file === 'string' &&
    typeof m.modelPath === 'string' &&
    typeof m.bytes === 'number'
  );
}

export async function readModelManifest(manifestPath: string): Promise<ModelManifest | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isModelManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeModelManifest(manifestPath: string, manifest: ModelManifest): Promise<void> {
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Installed quantization for a model, in preference order (smallest first so
 * the default works everywhere). Returns undefined when nothing is installed.
 */
export async function findInstalledQuant(modelsDir: string, model: string, specs: QuantSpec[]): Promise<QuantSpec | undefined> {
  const installed: QuantSpec[] = [];
  for (const spec of specs) {
    const manifest = await readModelManifest(manifestPathFor(modelsDir, model, spec.id));
    if (!manifest) continue;
    try {
      const stat = await fsp.stat(manifest.modelPath);
      if (stat.isFile() && stat.size === manifest.bytes) installed.push(spec);
    } catch {
      // Manifest without a matching model file counts as not installed.
    }
  }
  return QUANT_PREFERENCE.map((id) => installed.find((s) => s.id === id)).find(Boolean);
}

export interface ManifestCheck {
  ok: boolean;
  problems: string[];
}

/** Cheap structural verification: manifest present, file exists, size matches. */
export async function verifyModelFiles(manifest: ModelManifest): Promise<ManifestCheck> {
  const problems: string[] = [];
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(manifest.modelPath);
  } catch {
    return { ok: false, problems: [`model file missing: ${manifest.modelPath}`] };
  }
  if (!stat.isFile()) problems.push(`model path is not a file: ${manifest.modelPath}`);
  if (stat.size !== manifest.bytes) {
    problems.push(`size mismatch: expected ${manifest.bytes} bytes, found ${stat.size}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Full sha256 verification of the model file against the manifest hash. */
export async function deepVerifyChecksum(manifest: ModelManifest): Promise<ManifestCheck> {
  const base = await verifyModelFiles(manifest);
  if (!base.ok) return base;
  if (!manifest.sha256) return { ok: false, problems: ['manifest has no recorded sha256'] };
  const hash = createHash('sha256');
  const stream = fs.createReadStream(manifest.modelPath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  const digest = hash.digest('hex');
  if (digest !== manifest.sha256) {
    return { ok: false, problems: [`checksum mismatch: expected ${manifest.sha256}, got ${digest}`] };
  }
  return { ok: true, problems: [] };
}

/** Manifest for the newest installed quantization of a model, if any. */
export async function findInstalledManifest(clefHome: string, spec: ModelSpec): Promise<ModelManifest | undefined> {
  const { modelsDir } = pathsFor(clefHome);
  const quant = await findInstalledQuant(modelsDir, spec.id, spec.quants);
  if (!quant) return undefined;
  return readModelManifest(manifestPathFor(modelsDir, spec.id, quant.id));
}

export async function quantIsInstalled(clefHome: string, spec: ModelSpec, quant: QuantSpec): Promise<boolean> {
  const manifest = await readModelManifest(manifestPathFor(pathsFor(clefHome).modelsDir, spec.id, quant.id));
  if (!manifest) return false;
  return (await verifyModelFiles(manifest)).ok;
}

function isRuntimeManifest(v: unknown): v is RuntimeManifest {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    m.schemaVersion === 1 &&
    m.kind === 'llama-cpp' &&
    typeof m.releaseTag === 'string' &&
    typeof m.asset === 'string' &&
    typeof m.binaryPath === 'string'
  );
}

export async function writeRuntimeManifest(manifestPath: string, manifest: RuntimeManifest): Promise<void> {
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

export function readRuntimeManifest(manifestPath: string): RuntimeManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return isRuntimeManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export { getQuantSpec, modelQuantDir };
