import { describe, expect, it } from 'vitest';
import { ClefError, ClefErrorCode } from '../../src/clef/errors.js';
import { CLEF_FLASH, getModelSpec, getQuantSpec, pickQuant } from '../../src/models/registry.js';

const GB = 1024 ** 3;

describe('registry', () => {
  it('exposes clef-flash with three quantizations', () => {
    expect(CLEF_FLASH.quants.map((q) => q.id)).toEqual(['Q4_K_M', 'Q8_0', 'BF16']);
    expect(CLEF_FLASH.repo).toBe('ggml-org/Clef-Flash-GGUF');
    expect(CLEF_FLASH.licenseId).toBe('Apache-2.0');
  });

  it('getModelSpec throws INVALID_INPUT for unknown models', () => {
    try {
      getModelSpec('gpt-5');
      expect.unreachable();
    } catch (err) {
      expect((err as ClefError).code).toBe(ClefErrorCode.INVALID_INPUT);
    }
  });

  it('getQuantSpec throws for unknown quantizations', () => {
    expect(() => getQuantSpec(CLEF_FLASH, 'INT4')).toThrow(ClefError);
  });
});

describe('pickQuant', () => {
  it('requires at least 16 GB', () => {
    try {
      pickQuant(CLEF_FLASH, 8 * GB);
      expect.unreachable();
    } catch (err) {
      expect((err as ClefError).code).toBe(ClefErrorCode.UNSUPPORTED_PLATFORM);
    }
  });

  it('auto-selects by memory', () => {
    expect(pickQuant(CLEF_FLASH, 16 * GB).id).toBe('Q4_K_M');
    expect(pickQuant(CLEF_FLASH, 31 * GB).id).toBe('Q4_K_M');
    expect(pickQuant(CLEF_FLASH, 32 * GB).id).toBe('Q8_0');
    expect(pickQuant(CLEF_FLASH, 63 * GB).id).toBe('Q8_0');
    expect(pickQuant(CLEF_FLASH, 64 * GB).id).toBe('BF16');
  });

  it('honors an explicit override', () => {
    expect(pickQuant(CLEF_FLASH, 16 * GB, 'BF16').id).toBe('BF16');
  });

  it('rejects unknown overrides with INVALID_INPUT', () => {
    try {
      pickQuant(CLEF_FLASH, 64 * GB, 'FP8');
      expect.unreachable();
    } catch (err) {
      expect((err as ClefError).code).toBe(ClefErrorCode.INVALID_INPUT);
    }
  });
});
