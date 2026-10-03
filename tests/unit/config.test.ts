import { describe, expect, it } from 'vitest';
import { loadConfig, parseLogLevel } from '../../src/config/env.js';
import { DEFAULT_LIMITS, limitsFromEnv } from '../../src/config/limits.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.model).toBe('clef-flash');
    expect(cfg.runtime).toBe('llama-cpp');
    expect(cfg.logLevel).toBe('error');
    expect(cfg.clefHome).toMatch(/clef-mcp$/);
    expect(cfg.llamaBin).toBeUndefined();
    expect(cfg.limits).toEqual(DEFAULT_LIMITS);
  });

  it('reads env overrides', () => {
    const cfg = loadConfig({
      CLEF_MODEL: 'clef',
      CLEF_HOME: '/tmp/clef-home',
      CLEF_LOG_LEVEL: 'debug',
      CLEF_LLAMA_BIN: '/opt/llama-server',
      CLEF_LLAMA_RELEASE_TAG: 'b11378',
    });
    expect(cfg.model).toBe('clef');
    expect(cfg.clefHome).toBe('/tmp/clef-home');
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.llamaBin).toBe('/opt/llama-server');
    expect(cfg.llamaReleaseTag).toBe('b11378');
  });

  it('rejects unknown runtime ids', () => {
    expect(() => loadConfig({ CLEF_RUNTIME: 'mlx' })).toThrow(/Unsupported CLEF_RUNTIME/);
  });

  it('ignores blank env values', () => {
    const cfg = loadConfig({ CLEF_MODEL: '  ', CLEF_HOME: '', CLEF_LOG_LEVEL: 'nope' });
    expect(cfg.model).toBe('clef-flash');
    expect(cfg.logLevel).toBe('error');
  });
});

describe('parseLogLevel', () => {
  it('accepts the four levels and is case-insensitive', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('info')).toBe('info');
    expect(parseLogLevel('error')).toBe('error');
  });
  it('returns undefined for junk', () => {
    expect(parseLogLevel('verbose')).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });
});

describe('limitsFromEnv', () => {
  it('defaults', () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS);
  });
  it('overrides numeric limits', () => {
    const limits = limitsFromEnv({ CLEF_MAX_QUESTIONS: '8', CLEF_MAX_STATE_BYTES: '1000' });
    expect(limits.maxQuestions).toBe(8);
    expect(limits.maxStateBytes).toBe(1000);
    expect(limits.maxInstructionsChars).toBe(DEFAULT_LIMITS.maxInstructionsChars);
  });
  it('falls back on garbage', () => {
    const limits = limitsFromEnv({ CLEF_MAX_QUESTIONS: 'not-a-number' });
    expect(limits.maxQuestions).toBe(DEFAULT_LIMITS.maxQuestions);
  });
});
