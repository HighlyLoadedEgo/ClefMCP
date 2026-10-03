import fs from 'node:fs/promises';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import type { ClefConfig } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { MlxManifest } from '../models/mlx-install.js';
import { resolveUv } from '../models/mlx-install.js';
import type { ModelManifest } from '../models/manifest.js';
import { resolveLlamaServerBinary } from './binary.js';
import { LlamaCppRuntime } from './llama-cpp.js';
import { MlxRuntime } from './mlx.js';

export interface ProbeResult {
  latencyMs: number;
  binarySource: 'env' | 'managed' | 'path' | 'uv';
  binaryPath: string;
}

/**
 * Full end-to-end check: start the runtime with the installed model, run one
 * tiny decision, shut down. Used by `install` (verification) and `doctor`.
 */
export async function probeInference(
  cfg: ClefConfig,
  manifest: ModelManifest,
  log?: Logger,
  loadTimeoutMs = 120_000,
): Promise<ProbeResult> {
  await fs.access(manifest.modelPath).catch(() => {
    throw new ClefError(
      ClefErrorCode.MODEL_NOT_INSTALLED,
      `Model file is missing: ${manifest.modelPath}`,
      'Run `clef-mcp install` to (re-)download the model.',
    );
  });
  const binary = resolveLlamaServerBinary(cfg);
  const runtime = new LlamaCppRuntime({
    serverBin: binary.path,
    modelPath: manifest.modelPath,
    alias: manifest.model,
    loadTimeoutMs,
    log,
  });
  const started = Date.now();
  await runtime.load();
  try {
    await runtime.decide({
      model: manifest.model,
      state: 'This is an internal clef-mcp installation probe.',
      questions: {
        probe: { type: 'noul', instructions: 'Is this a clef-mcp installation probe?' },
      },
    });
  } finally {
    await runtime.unload();
  }
  return { latencyMs: Date.now() - started, binarySource: binary.source, binaryPath: binary.path };
}

/** Same end-to-end probe for the MLX runtime (uv + clef_mlx.py serve). */
export async function probeMlxInference(
  cfg: ClefConfig,
  manifest: MlxManifest,
  log?: Logger,
  loadTimeoutMs = 180_000,
): Promise<ProbeResult> {
  const uvBin = resolveUv(process.env.CLEF_MLX_UV);
  const runtime = new MlxRuntime({ uvBin, snapshotPath: manifest.snapshotPath, loadTimeoutMs, log });
  const started = Date.now();
  await runtime.load();
  try {
    await runtime.decide({
      model: manifest.model,
      state: 'This is an internal clef-mcp installation probe.',
      questions: {
        probe: { type: 'noul', instructions: 'Is this a clef-mcp installation probe?' },
      },
    });
  } finally {
    await runtime.unload();
  }
  return { latencyMs: Date.now() - started, binarySource: 'uv', binaryPath: uvBin };
}
