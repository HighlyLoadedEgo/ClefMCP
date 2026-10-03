import fsp from 'node:fs/promises';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import { loadConfig } from '../config/env.js';
import { modelQuantDir, pathsFor } from '../config/paths.js';
import { findInstalledManifest } from '../models/manifest.js';
import { formatBytes } from '../models/platform.js';
import { getModelSpec } from '../models/registry.js';
import { removeManagedRuntime } from '../models/llama-install.js';
import { mlxIsInstalled, removeMlxModel } from '../models/mlx-install.js';
import { confirm } from './prompt.js';

export interface UninstallOptions {
  model?: string;
  runtime?: boolean;
  yes?: boolean;
}

export async function runUninstall(opts: UninstallOptions): Promise<void> {
  const config = loadConfig();
  const spec = getModelSpec(opts.model ?? config.model);
  const { modelsDir } = pathsFor(config.clefHome);

  if (config.runtime === 'mlx') {
    const mlx = await mlxIsInstalled(config.clefHome);
    if (!mlx) {
      throw new ClefError(ClefErrorCode.MODEL_NOT_INSTALLED, 'The MLX model is not installed.', 'Nothing to remove.');
    }
    const ok = await confirm(`Remove the MLX snapshot for ${spec.id}?`, opts.yes === true);
    if (!ok) {
      console.log('Aborted.');
      return;
    }
    await removeMlxModel(config.clefHome);
    console.log('Removed MLX snapshot.');
    return;
  }

  const manifest = await findInstalledManifest(config.clefHome, spec);

  if (!manifest && !opts.runtime) {
    throw new ClefError(
      ClefErrorCode.MODEL_NOT_INSTALLED,
      `${spec.id} is not installed.`,
      'Nothing to remove. Use --runtime to also remove the managed llama.cpp runtime.',
    );
  }

  const target = manifest ? modelQuantDir(modelsDir, spec.id, manifest.quant) : undefined;
  const sizeLine = manifest ? ` (${formatBytes(manifest.bytes)})` : '';
  const ok = await confirm(
    `Remove ${spec.id}${manifest ? ` ${manifest.quant}` : ''}${sizeLine}${opts.runtime ? ' and the managed runtime' : ''}?`,
    opts.yes === true,
  );
  if (!ok) {
    console.log('Aborted.');
    return;
  }

  if (target) {
    await fsp.rm(target, { recursive: true, force: true });
    console.log(`Removed: ${target}`);
  }
  if (opts.runtime) {
    const removed = await removeManagedRuntime(config);
    console.log(removed ? 'Removed managed llama.cpp runtime.' : 'No managed runtime found.');
  }
}
