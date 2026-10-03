import { ClefError } from '../clef/errors.js';
import { loadConfig } from '../config/env.js';
import { pathsFor } from '../config/paths.js';
import { findInstalledManifest } from '../models/manifest.js';
import { detectPlatform, formatBytes } from '../models/platform.js';
import { getModelSpec } from '../models/registry.js';
import { mlxIsInstalled, resolveUv } from '../models/mlx-install.js';
import { resolveLlamaServerBinary } from '../runtime/binary.js';

export async function runStatus(): Promise<void> {
  const config = loadConfig();
  const info = await detectPlatform();

  let spec;
  try {
    spec = getModelSpec(config.model);
  } catch (err) {
    if (err instanceof ClefError && err.code === 'INVALID_INPUT') {
      console.log(`Runtime: ${config.runtime}`);
      console.log(`Model: ${config.model} (unknown model id)`);
      console.log('Model status: unknown');
      console.log(`Memory: ${formatBytes(info.totalMemBytes)}`);
      return;
    }
    throw err;
  }

  if (config.runtime === 'mlx') {
    const mlx = await mlxIsInstalled(config.clefHome);
    let uvLine = 'not found (install: curl -LsSf https://astral.sh/uv/install.sh | sh)';
    try {
      uvLine = `uv: ${resolveUv(process.env.CLEF_MLX_UV)}`;
    } catch (err) {
      uvLine = `not found — ${(err as Error).message.split('\n')[0]}`;
    }
    console.log(`Runtime: mlx (${uvLine})`);
    console.log(`Model: ${spec.id}${mlx ? ' (MLX 4-bit)' : ''}`);
    console.log(`Model status: ${mlx ? 'installed' : 'not installed (run: clef-mcp install --runtime mlx)'}`);
    console.log(`Memory: ${formatBytes(info.totalMemBytes)}`);
    if (mlx) {
      console.log(`Snapshot: ${mlx.snapshotPath}`);
      console.log(`Installed: ${mlx.installedAt}`);
    } else {
      console.log(`Cache home: ${pathsFor(config.clefHome).root}`);
    }
    return;
  }

  const manifest = await findInstalledManifest(config.clefHome, spec);

  let runtimeLine: string;
  try {
    const binary = resolveLlamaServerBinary(config);
    runtimeLine = `ready (llama.cpp via ${binary.source}: ${binary.path})`;
  } catch (err) {
    const structured = (err as ClefError).hint ? `${(err as ClefError).message}` : String(err);
    runtimeLine = `not found — ${structured}`;
  }

  console.log(`Runtime: llama.cpp`);
  console.log(`Model: ${spec.id}${manifest ? ` ${manifest.quant}` : ''}`);
  console.log(`Model status: ${manifest ? 'installed' : 'not installed (run: clef-mcp install)'}`);
  console.log(`Runtime status: ${runtimeLine}`);
  console.log(`Memory: ${formatBytes(info.totalMemBytes)}`);
  if (manifest) {
    console.log(`Model path: ${manifest.modelPath}`);
    console.log(`Installed: ${manifest.installedAt}`);
  } else {
    console.log(`Cache home: ${pathsFor(config.clefHome).root}`);
  }
}
