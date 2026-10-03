import os from 'node:os';
import path from 'node:path';
import { limitsFromEnv, type Limits } from './limits.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export type RuntimeId = 'llama-cpp' | 'mlx';

export const SUPPORTED_RUNTIMES: readonly RuntimeId[] = ['llama-cpp', 'mlx'];

export interface ClefConfig {
  /** Model id, e.g. "clef-flash". */
  model: string;
  /** Cache/model home. Override with CLEF_HOME. */
  clefHome: string;
  /** Inference runtime. v0.1 ships only llama-cpp. */
  runtime: RuntimeId;
  logLevel: LogLevel;
  /** Explicit path to a llama-server binary (CLEF_LLAMA_BIN). */
  llamaBin?: string;
  /** Pin the llama.cpp release tag used by the managed runtime download. */
  llamaReleaseTag?: string;
  limits: Limits;
}

export const SUPPORTED_LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  return (SUPPORTED_LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : undefined;
}

export function defaultClefHome(): string {
  return path.join(os.homedir(), '.cache', 'clef-mcp');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClefConfig {
  const logLevel = parseLogLevel(env.CLEF_LOG_LEVEL) ?? 'error';
  const runtimeRaw = (env.CLEF_RUNTIME?.trim() || 'llama-cpp').toLowerCase();
  if (!(SUPPORTED_RUNTIMES as readonly string[]).includes(runtimeRaw)) {
    throw new Error(`Unsupported CLEF_RUNTIME "${runtimeRaw}". Supported: ${SUPPORTED_RUNTIMES.join(', ')}`);
  }
  const runtime = runtimeRaw as RuntimeId;
  const llamaBin = env.CLEF_LLAMA_BIN?.trim() || undefined;
  const llamaReleaseTag = env.CLEF_LLAMA_RELEASE_TAG?.trim() || undefined;
  return {
    model: env.CLEF_MODEL?.trim() || 'clef-flash',
    clefHome: env.CLEF_HOME?.trim() || defaultClefHome(),
    runtime,
    logLevel,
    llamaBin: runtime === 'llama-cpp' ? llamaBin : undefined,
    llamaReleaseTag: runtime === 'llama-cpp' ? llamaReleaseTag : undefined,
    limits: limitsFromEnv(env),
  };
}
