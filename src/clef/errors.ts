export const ClefErrorCode = {
  MODEL_NOT_INSTALLED: 'MODEL_NOT_INSTALLED',
  MODEL_LOAD_FAILED: 'MODEL_LOAD_FAILED',
  RUNTIME_NOT_FOUND: 'RUNTIME_NOT_FOUND',
  RUNTIME_INIT_FAILED: 'RUNTIME_INIT_FAILED',
  RUNTIME_NOT_SUPPORTED: 'RUNTIME_NOT_SUPPORTED',
  INVALID_INPUT: 'INVALID_INPUT',
  CLEF_INFERENCE_FAILED: 'CLEF_INFERENCE_FAILED',
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
} as const;

export type ClefErrorCode = (typeof ClefErrorCode)[keyof typeof ClefErrorCode];

export class ClefError extends Error {
  readonly code: ClefErrorCode;
  readonly hint?: string;

  constructor(code: ClefErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ClefError';
    this.code = code;
    this.hint = hint;
  }
}

export interface StructuredError {
  error: {
    code: ClefErrorCode;
    message: string;
    hint?: string;
  };
}

/** Serialized form used both in MCP tool results and CLI output. */
export function errorJson(err: unknown): StructuredError {
  if (err instanceof ClefError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.hint ? { hint: err.hint } : {}),
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: ClefErrorCode.CLEF_INFERENCE_FAILED, message } };
}

export function toClefError(err: unknown): ClefError {
  if (err instanceof ClefError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ClefError(ClefErrorCode.CLEF_INFERENCE_FAILED, message);
}

/** Exit codes for CLI commands. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof ClefError) {
    switch (err.code) {
      case ClefErrorCode.INVALID_INPUT:
        return 2;
      case ClefErrorCode.MODEL_NOT_INSTALLED:
        return 3;
      case ClefErrorCode.RUNTIME_NOT_FOUND:
      case ClefErrorCode.RUNTIME_NOT_SUPPORTED:
        return 4;
      default:
        return 1;
    }
  }
  return 1;
}
