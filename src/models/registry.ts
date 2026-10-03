import { ClefError, ClefErrorCode } from '../clef/errors.js';

export type QuantId = 'Q4_K_M' | 'Q8_0' | 'BF16';

export interface QuantSpec {
  id: QuantId;
  file: string;
  bytes: number;
  dirLabel: string;
  /** Minimum total memory (RAM; on macOS unified) needed to run this quant comfortably. */
  minTotalMemBytes: number;
}

export interface ModelSpec {
  id: string;
  repo: string;
  /** Pinned upstream revision for reproducible downloads + checksums. */
  revision: string;
  licenseId: string;
  licenseUrl: string;
  originUrl: string;
  defaultQuant: QuantId;
  quants: QuantSpec[];
}

const GB = 1024 ** 3;

export const CLEF_FLASH: ModelSpec = {
  id: 'clef-flash',
  repo: 'ggml-org/Clef-Flash-GGUF',
  revision: '4a7a08c09bc63baf043b62b5ba89dd67a0357d95',
  licenseId: 'Apache-2.0',
  licenseUrl: 'https://huggingface.co/Cloudflare/clef-flash',
  originUrl: 'https://huggingface.co/Cloudflare/clef-flash',
  defaultQuant: 'Q4_K_M',
  quants: [
    { id: 'Q4_K_M', file: 'Clef-Flash-Q4_K_M.gguf', bytes: 6_486_448_192, dirLabel: '4bit', minTotalMemBytes: 16 * GB },
    { id: 'Q8_0', file: 'Clef-Flash-Q8_0.gguf', bytes: 9_657_260_096, dirLabel: '8bit', minTotalMemBytes: 32 * GB },
    { id: 'BF16', file: 'Clef-Flash-BF16.gguf', bytes: 18_164_488_256, dirLabel: 'bf16', minTotalMemBytes: 64 * GB },
  ],
};

export const MODELS: Record<string, ModelSpec> = {
  [CLEF_FLASH.id]: CLEF_FLASH,
};

export function getModelSpec(model: string): ModelSpec {
  const spec = MODELS[model];
  if (!spec) {
    throw new ClefError(
      ClefErrorCode.INVALID_INPUT,
      `Unknown model "${model}".`,
      `Available models: ${Object.keys(MODELS).join(', ')}`,
    );
  }
  return spec;
}

export function getQuantSpec(spec: ModelSpec, quant: string): QuantSpec {
  const found = spec.quants.find((q) => q.id === quant);
  if (!found) {
    throw new ClefError(
      ClefErrorCode.INVALID_INPUT,
      `Unknown quantization "${quant}" for model ${spec.id}.`,
      `Available: ${spec.quants.map((q) => q.id).join(', ')}`,
    );
  }
  return found;
}

/**
 * Auto-pick the largest quantization that fits in memory. The 9B clef-flash
 * model needs headroom: Q4_K_M fits in 16 GB, Q8_0 in 32 GB, BF16 in 64 GB.
 */
export function pickQuant(spec: ModelSpec, totalMemBytes: number, requested?: string): QuantSpec {
  if (requested) return getQuantSpec(spec, requested);
  const fitting = [...spec.quants].sort((a, b) => b.minTotalMemBytes - a.minTotalMemBytes).find((q) => totalMemBytes >= q.minTotalMemBytes);
  if (!fitting) {
    throw new ClefError(
      ClefErrorCode.UNSUPPORTED_PLATFORM,
      `This machine has less than ${Math.round(spec.quants[spec.quants.length - 1]!.minTotalMemBytes / GB)} GB of memory; the smallest Clef-Flash build (Q4_K_M) needs 16 GB.`,
    );
  }
  return fitting;
}

/** Preference order when several quantizations are installed for one model. */
export const QUANT_PREFERENCE: readonly QuantId[] = ['Q4_K_M', 'Q8_0', 'BF16'];
