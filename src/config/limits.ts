export interface Limits {
  /** Maximum number of questions per clef_decide call. */
  maxQuestions: number;
  /** Maximum serialized size of `state`, in bytes. */
  maxStateBytes: number;
  /** Maximum characters per question `instructions`. */
  maxInstructionsChars: number;
  /** Maximum number of criteria per question. */
  maxCriteriaPerQuestion: number;
  /** Maximum characters per criterion label/description. */
  maxCriteriaDescChars: number;
  /** Maximum characters per question id (the questions map key). */
  maxQuestionIdChars: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxQuestions: 64,
  maxStateBytes: 1024 * 1024,
  maxInstructionsChars: 10_000,
  maxCriteriaPerQuestion: 100,
  maxCriteriaDescChars: 1_000,
  maxQuestionIdChars: 128,
};

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw?.trim()) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
  return {
    maxQuestions: intFromEnv(env, 'CLEF_MAX_QUESTIONS', DEFAULT_LIMITS.maxQuestions),
    maxStateBytes: intFromEnv(env, 'CLEF_MAX_STATE_BYTES', DEFAULT_LIMITS.maxStateBytes),
    maxInstructionsChars: intFromEnv(env, 'CLEF_MAX_INSTRUCTION_CHARS', DEFAULT_LIMITS.maxInstructionsChars),
    maxCriteriaPerQuestion: intFromEnv(env, 'CLEF_MAX_CRITERIA', DEFAULT_LIMITS.maxCriteriaPerQuestion),
    maxCriteriaDescChars: intFromEnv(env, 'CLEF_MAX_CRITERIA_DESC_CHARS', DEFAULT_LIMITS.maxCriteriaDescChars),
    maxQuestionIdChars: intFromEnv(env, 'CLEF_MAX_QUESTION_ID_CHARS', DEFAULT_LIMITS.maxQuestionIdChars),
  };
}
