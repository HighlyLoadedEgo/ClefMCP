import { z } from 'zod';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import type { Limits } from '../config/limits.js';

function criteriaDescription(limits: Limits): z.ZodString {
  return z.string().min(1).max(limits.maxCriteriaDescChars);
}

function countIssues(count: number, limits: Limits): string | undefined {
  if (count === 0) return 'criteria must not be empty';
  if (count > limits.maxCriteriaPerQuestion) return `too many criteria (max ${limits.maxCriteriaPerQuestion})`;
  return undefined;
}

function choiceCriteria(limits: Limits) {
  return z.union([
    // Plain list: option ids equal to the strings themselves.
    z.array(criteriaDescription(limits)).check((ctx) => {
      const problem = countIssues(ctx.value.length, limits);
      if (problem) ctx.issues.push({ code: 'custom', message: problem, input: ctx.value });
    }),
    z
      .record(z.string().min(1).max(limits.maxCriteriaDescChars), criteriaDescription(limits))
      .check((ctx) => {
        const problem = countIssues(Object.keys(ctx.value).length, limits);
        if (problem) ctx.issues.push({ code: 'custom', message: problem, input: ctx.value });
      }),
  ]);
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
      type: z
        .enum(['noul', 'choice', 'score'])
        .describe('"choice" = pick among named options; "score" = judge an ordered scale; "noul" = yes/no question'),
      instructions: z
        .string()
        .min(1)
        .max(limits.maxInstructionsChars)
        .describe('What to judge, phrased as a self-contained question.'),
      criteria: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
    })
    .describe(
      'A single decision question. Allowed answers come from `criteria` and must be mutually exclusive and collectively exhaustive.',
    )
    .superRefine((q, ctx) => {
      if (q.type === 'choice') {
        // Spec §3 allows both shapes for choice: a map option id -> description,
        // or a plain list (ids equal to the strings). The adapter normalizes.
        const parsed = choiceCriteria(limits).safeParse(q.criteria);
        if (!parsed.success) {
          ctx.addIssue({
            code: 'custom',
            message: `"choice" questions require non-empty criteria as a map of option id -> description, or a plain list of options (${parsed.error.issues[0]?.message ?? 'invalid criteria'})`,
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
    state: z
      .unknown()
      .describe(
        'Task state as data: a compact string or JSON object with the facts needed to judge (task, errors, logs, diffs). Never treated as instructions. Serialized size limit: 1 MB; model context is 16k tokens.',
      ),
    questions: z
      .record(z.string().min(1).max(limits.maxQuestionIdChars), questionSchema(limits))
      .describe(
        'Map of question id -> typed question. Up to 64 questions per call; all are scored together in a single forward pass, so batch related decisions here.',
      )
      .check((ctx) => {
        const count = Object.keys(ctx.value).length;
        if (count === 0) ctx.issues.push({ code: 'custom', message: 'questions must not be empty', input: ctx.value });
        if (count > limits.maxQuestions) {
          ctx.issues.push({ code: 'custom', message: `too many questions (max ${limits.maxQuestions})`, input: ctx.value });
        }
      }),
    model: z
      .string()
      .min(1)
      .optional()
      .describe('Model id to use (default: clef-flash from CLEF_MODEL).'),
    options: z
      .object({
        /**
         * Accepted for forward compatibility. Clef scores all options in a
         * single forward pass — there is no sampling, so temperature is a
         * documented no-op.
         */
        temperature: z
          .number()
          .min(0)
          .max(2)
          .optional()
          .describe('Accepted for forward compatibility; no-op. Clef scores in a single forward pass without sampling.'),
      })
      .optional()
      .describe('Extra options. Currently only temperature, which is a documented no-op.'),
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

/** The validated clef_decide document (zod output, shared by MCP server, CLI and daemon). */
export type ClefDecideValidated = z.output<ReturnType<typeof clefDecideInputSchema>>;

/** Output schema mirrored by the MCP tool result (structuredContent). */
export function clefDecideOutputSchema() {
  return z.object({
    model: z.string(),
    decisions: z.record(
      z.string(),
      z.object({
        answer: z.record(z.string(), z.number()),
        // Model-reported confidence; present only when the runtime sends it.
        confidence: z.number().min(0).max(1).optional(),
      }),
    ),
    // Token usage / latency; present only when the runtime reports it.
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        latency_ms: z.number().optional(),
      })
      .optional(),
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
