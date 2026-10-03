import { describe, expect, it } from 'vitest';
import { ClefError, ClefErrorCode } from '../../src/clef/errors.js';
import { loadConfig } from '../../src/config/env.js';
import { resolveLlamaServerBinary } from '../../src/runtime/binary.js';

const baseConfig = loadConfig({ CLEF_HOME: '/tmp/clef-test-home' });

describe('resolveLlamaServerBinary', () => {
  it('prefers CLEF_LLAMA_BIN when set and valid', () => {
    const cfg = loadConfig({ CLEF_HOME: '/tmp/clef-test-home', CLEF_LLAMA_BIN: '/custom/llama-server' });
    const resolved = resolveLlamaServerBinary(cfg, {
      existsExecutable: (p) => p === '/custom/llama-server',
      which: () => '/path/llama-server',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(resolved).toEqual({ source: 'env', path: '/custom/llama-server' });
  });

  it('throws when CLEF_LLAMA_BIN is missing on disk', () => {
    try {
      resolveLlamaServerBinary(loadConfig({ CLEF_HOME: '/tmp/clef-test-home', CLEF_LLAMA_BIN: '/gone/llama-server' }), {
        existsExecutable: () => false,
        platform: 'darwin',
        arch: 'arm64',
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ClefError).code).toBe(ClefErrorCode.RUNTIME_NOT_FOUND);
      expect((err as ClefError).message).toMatch(/CLEF_LLAMA_BIN/);
    }
  });

  it('prefers the managed binary over PATH', () => {
    const resolved = resolveLlamaServerBinary(baseConfig, {
      existsExecutable: (p) => p.includes('runtime/llama.cpp/darwin-arm64'),
      which: () => '/usr/local/bin/llama-server',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(resolved.source).toBe('managed');
    expect(resolved.path).toContain('runtime/llama.cpp/darwin-arm64/llama-server');
  });

  it('falls back to PATH when nothing else exists', () => {
    const resolved = resolveLlamaServerBinary(baseConfig, {
      existsExecutable: () => false,
      which: () => '/opt/homebrew/bin/llama-server',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(resolved).toEqual({ source: 'path', path: '/opt/homebrew/bin/llama-server' });
  });

  it('throws RUNTIME_NOT_FOUND with an install hint when nothing resolves', () => {
    try {
      resolveLlamaServerBinary(baseConfig, {
        existsExecutable: () => false,
        which: () => undefined,
        platform: 'darwin',
        arch: 'arm64',
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClefError);
      expect((err as ClefError).code).toBe(ClefErrorCode.RUNTIME_NOT_FOUND);
      expect((err as ClefError).hint).toMatch(/clef-mcp install/);
    }
  });
});
