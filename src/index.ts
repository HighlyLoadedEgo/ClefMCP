/**
 * clef-mcp public library API.
 *
 * Most users only need the CLI (`clef-mcp install`, `clef-mcp`). These exports
 * exist for embedding the server into other Node programs and for tests.
 */
export { loadConfig, defaultClefHome, type ClefConfig, type LogLevel } from './config/env.js';
export { DEFAULT_LIMITS, limitsFromEnv, type Limits } from './config/limits.js';
export { pathsFor, modelQuantDir, manifestPathFor } from './config/paths.js';
export { createLogger, StderrLogger, type Logger } from './config/logger.js';
export { ClefError, ClefErrorCode, errorJson, exitCodeFor } from './clef/errors.js';
export * from './clef/types.js';
export { toSystemOneRequest, fromSystemOneResponse, type SystemOneRequest, type SystemOneResponse } from './clef/systemone.js';
export type { ClefRuntime, RuntimeHealth } from './runtime/types.js';
export { LlamaCppRuntime, type LlamaCppRuntimeOptions } from './runtime/llama-cpp.js';
export { resolveLlamaServerBinary, type ResolvedBinary } from './runtime/binary.js';
export { probeInference, type ProbeResult } from './runtime/probe.js';
export { MODELS, CLEF_FLASH, getModelSpec, getQuantSpec, pickQuant, type ModelSpec, type QuantSpec } from './models/registry.js';
export {
  installModel,
  downloadFile,
  fetchFileInfo,
  type InstallModelResult,
  type DownloadProgress,
} from './models/hf.js';
export {
  findInstalledManifest,
  readModelManifest,
  writeModelManifest,
  verifyModelFiles,
  deepVerifyChecksum,
  type ModelManifest,
} from './models/manifest.js';
export { ensureLlamaRuntime, downloadManagedLlama, removeManagedRuntime } from './models/llama-install.js';
export { detectPlatform, assertSupportedPlatform, formatBytes, type PlatformInfo } from './models/platform.js';
export { createClefServer, SERVER_INSTRUCTIONS, TOOL_NAME, type ClefServerDeps, type RunningClefServer } from './mcp/server.js';
export { clefDecideInputSchema, clefDecideOutputSchema, validateStateSize } from './mcp/schema.js';
export { VERSION } from './version.js';
