import type { SystemOneRequest, SystemOneResponse } from '../clef/systemone.js';

export interface RuntimeHealth {
  status: 'ready' | 'loading' | 'unavailable';
  detail?: string;
}

/**
 * Inference runtime abstraction. Implementations load/unload the model and
 * answer SystemOne requests, so the MCP layer never talks to an engine
 * directly. Swapping runtimes (MLX, remote) must not change the MCP API.
 */
export interface ClefRuntime {
  load(): Promise<void>;
  decide(input: SystemOneRequest): Promise<SystemOneResponse>;
  unload(): Promise<void>;
  health(): Promise<RuntimeHealth>;
}
