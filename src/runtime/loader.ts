import { ClefError, ClefErrorCode } from '../clef/errors.js';
import type { ClefConfig } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import { findInstalledManifest } from '../models/manifest.js';
import { mlxIsInstalled, resolveUv } from '../models/mlx-install.js';
import type { ModelSpec } from '../models/registry.js';
import { resolveLlamaServerBinary } from './binary.js';
import { LlamaCppRuntime } from './llama-cpp.js';
import { MlxRuntime } from './mlx.js';
import type { ClefRuntime } from './types.js';

/** Test seam: override runtime construction (defaults per config.runtime). */
export type RuntimeFactory = (opts: {
  kind: 'llama-cpp' | 'mlx';
  serverBin?: string;
  modelPath?: string;
  snapshotPath?: string;
  alias: string;
  log?: Logger;
}) => ClefRuntime;

export interface LoadedRuntime {
  runtime: ClefRuntime;
  model: string;
}

/**
 * Loads and caches the runtime for a model spec. Shared by the MCP server and
 * the one-shot `decide` CLI so both exercise the identical resolution chain:
 * config → manifest → binary → runtime instance.
 */
export class RuntimeLoader {
  private loaded?: LoadedRuntime;
  private loadPromise?: Promise<LoadedRuntime>;

  constructor(
    private readonly config: ClefConfig,
    private readonly log: Logger,
    private readonly runtimeFactory?: RuntimeFactory,
  ) {}

  async ensure(spec: ModelSpec): Promise<LoadedRuntime> {
    if (this.loaded && this.loaded.model === spec.id) return this.loaded;
    if (this.loaded && this.loaded.model !== spec.id) {
      await this.loaded.runtime.unload();
      this.loaded = undefined;
    }
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      if (this.config.runtime === 'mlx') {
        const manifest = await mlxIsInstalled(this.config.clefHome);
        if (!manifest) {
          throw new ClefError(
            ClefErrorCode.MODEL_NOT_INSTALLED,
            `Clef model "${spec.id}" is not installed for the MLX runtime.`,
            'Run `clef-mcp install --runtime mlx`.',
          );
        }
        const uvBin = resolveUv(process.env.CLEF_MLX_UV);
        const runtime = this.runtimeFactory
          ? this.runtimeFactory({ kind: 'mlx', snapshotPath: manifest.snapshotPath, alias: spec.id, log: this.log })
          : new MlxRuntime({ uvBin, snapshotPath: manifest.snapshotPath, log: this.log });
        this.log.debug('loading model (mlx)', { model: spec.id, snapshot: manifest.snapshotPath });
        const loadStarted = Date.now();
        await runtime.load();
        this.log.info('model ready', { model: spec.id, runtime: 'mlx', loadMs: Date.now() - loadStarted });
        return { runtime, model: spec.id };
      }

      const manifest = await findInstalledManifest(this.config.clefHome, spec);
      if (!manifest) {
        throw new ClefError(
          ClefErrorCode.MODEL_NOT_INSTALLED,
          `Clef model "${spec.id}" is not installed.`,
          'Run `clef-mcp install`.',
        );
      }
      const binary = resolveLlamaServerBinary(this.config);
      const runtime = this.runtimeFactory
        ? this.runtimeFactory({ kind: 'llama-cpp', serverBin: binary.path, modelPath: manifest.modelPath, alias: spec.id, log: this.log })
        : new LlamaCppRuntime({ serverBin: binary.path, modelPath: manifest.modelPath, alias: spec.id, log: this.log });
      this.log.debug('loading model', { model: spec.id, quant: manifest.quant, bin: binary.path });
      const loadStarted = Date.now();
      await runtime.load();
      this.log.info('model ready', { model: spec.id, quant: manifest.quant, loadMs: Date.now() - loadStarted });
      return { runtime, model: spec.id };
    })();

    try {
      this.loaded = await this.loadPromise;
      return this.loaded;
    } finally {
      this.loadPromise = undefined;
    }
  }

  /** Unload the current runtime (kills the llama-server subprocess, if any). */
  async dispose(): Promise<void> {
    if (this.loaded) {
      await this.loaded.runtime.unload();
      this.loaded = undefined;
    }
  }
}
