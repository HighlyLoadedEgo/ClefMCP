import { z } from 'zod';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import type { Limits } from '../config/limits.js';

function criteriaDescription(limits: Limits): z.ZodString {
  return z.string().min(1).max(limits.maxCriteriaDescChars);
}

function choiceCriteria(limits: Limits) {
  return z
    .record(z.string().min(1).max(limits.maxCriteriaDescChars), criteriaDescription(limits))
    .check((ctx) => {
      const count = Object.keys(ctx.value).length;
      if (count === 0) ctx.issues.push({ code: 'custom', message: 'criteria must not be empty', input: ctx.value });
      if (count > limits.maxCriteriaPerQuestion) {
        ctx.issues.push({ code: 'custom', message: `too many criteria (max ${limits.maxCriteriaPerQuestion})`, input: ctx.value });
      }
    });
}

function scoreCriteria(limits: Limits) {
  return z
    .array(criteriaDescription(limits))
    .check((ctx) => {
      if (ctx.value.length === 0) ctx.issues.push({ code: 'custom', message: 'criteria must not be empty', input: ctx.value });
      if (ctx.value.length > limits.maxCriteriaPerQuestion) {
        ctx.issues.push({ code: 'custom', message: `too many criteria (max ${limits.maxCriteriaPerQuestion})`, input: ctx.value });
      }
    });
}

function questionSchema(limits: Limits) {
  return z
    .object({
      type: z.enum(['noul', 'choice', 'score']),
      instructions: z.string().min(1).max(limits.maxInstructionsChars),
      criteria: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
    })
    .superRefine((q, ctx) => {
      if (q.type === 'choice') {
        const parsed = choiceCriteria(limits).safeParse(q.criteria);
        if (!parsed.success) {
          ctx.addIssue({
            code: 'custom',
            message: `"choice" questions require non-empty criteria as a map of option id -> description (${parsed.error.issues[0]?.message ?? 'invalid criteria'})`,
          });
        }
      } else if (q.type === 'score') {
        const parsed = scoreCriteria(limits).safeParse(q.criteria);
        if (!parsed.success) {
          ctx.addIssue({
            code: 'custom',
            message: `"score" questions require non-empty criteria as an ordered list (${parsed.error.issues[0]?.message ?? 'invalid criteria'})`,
          });
        }
      } else if (q.criteria !== undefined && Array.isArray(q.criteria)) {
        ctx.addIssue({ code: 'custom', message: '"noul" criteria (if given) must be a map with "true"/"false" descriptions' });
      }
    });
}

/** Zod raw shape for the clef_decide tool input (MCP SDK expects a shape, not a wrapped object). */
export function clefDecideInputShape(limits: Limits) {
  return {
    state: z.unknown(),
    questions: z
      .record(z.string().min(1).max(limits.maxQuestionIdChars), questionSchema(limits))
      .check((ctx) => {
        const count = Object.keys(ctx.value).length;
        if (count === 0) ctx.issues.push({ code: 'custom', message: 'questions must not be empty', input: ctx.value });
        if (count > limits.maxQuestions) {
          ctx.issues.push({ code: 'custom', message: `too many questions (max ${limits.maxQuestions})`, input: ctx.value });
        }
      }),
    model: z.string().min(1).optional(),
    options: z
      .object({
        /**
         * Accepted for forward compatibility. Clef scores all options in a
         * single forward pass — there is no sampling, so temperature is a
         * documented no-op.
         */
        temperature: z.number().min(0).max(2).optional(),
      })
      .optional(),
  };
}

export type ClefDecideArgs = {
  state: unknown;
  questions: Record<string, { type: 'noul' | 'choice' | 'score'; instructions: string; criteria?: string[] | Record<string, string> }>;
  model?: string;
  options?: { temperature?: number };
};

export function clefDecideInputSchema(limits: Limits) {
  return z.object(clefDecideInputShape(limits));
}

/** Output schema mirrored by the MCP tool result (structuredContent). */
export function clefDecideOutputSchema() {
  return z.object({
    model: z.string(),
    decisions: z.record(z.string(), z.object({ answer: z.record(z.string(), z.number()) })),
  });
}

/** `state` cannot be size-checked inside zod (it is `unknown`), so it is validated separately. */
export function validateStateSize(state: unknown, limits: Limits): void {
  if (state === undefined) {
    throw new ClefError(ClefErrorCode.INVALID_INPUT, 'state is required', 'Pass the task state as a string or JSON value.');
  }
  let bytes: number;
  if (typeof state === 'string') {
    bytes = Buffer.byteLength(state, 'utf8');
  } else {
    let json: string;
    try {
      json = JSON.stringify(state) ?? '';
    } catch (err) {
      throw new ClefError(
        ClefErrorCode.INVALID_INPUT,
        `state must be JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    bytes = Buffer.byteLength(json, 'utf8');
  }
  if (bytes > limits.maxStateBytes) {
    throw new ClefError(
      ClefErrorCode.INVALID_INPUT,
      `state exceeds the maximum size of ${limits.maxStateBytes} bytes (got ${bytes})`,
      `Trim the state or raise the limit with CLEF_MAX_STATE_BYTES. Note the model context is 16k tokens.`,
    );
  }
}
