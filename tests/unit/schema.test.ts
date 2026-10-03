import { describe, expect, it } from 'vitest';
import { ClefError, ClefErrorCode } from '../../src/clef/errors.js';
import { DEFAULT_LIMITS } from '../../src/config/limits.js';
import { clefDecideInputSchema, validateStateSize } from '../../src/mcp/schema.js';

const schema = clefDecideInputSchema(DEFAULT_LIMITS);

const validChoice = {
  type: 'choice' as const,
  instructions: 'What next?',
  criteria: { inspect: 'look', modify: 'change code' },
};
const validScore = { type: 'score' as const, instructions: 'Confidence?', criteria: ['low', 'high'] };
const validNoul = { type: 'noul' as const, instructions: 'Is it on fire?' };

describe('clef_decide input schema', () => {
  it('accepts a valid input with all three question types', () => {
    const parsed = schema.parse({
      state: { task: 't' },
      questions: { c: validChoice, s: validScore, n: validNoul },
    });
    expect(Object.keys(parsed.questions)).toEqual(['c', 's', 'n']);
  });

  it('accepts optional model and temperature', () => {
    const parsed = schema.parse({
      state: 'x',
      questions: { c: validChoice },
      model: 'clef-flash',
      options: { temperature: 0.5 },
    });
    expect(parsed.model).toBe('clef-flash');
  });

  it('rejects empty questions', () => {
    expect(() => schema.parse({ state: 'x', questions: {} })).toThrow(/must not be empty/);
  });

  it('rejects more than maxQuestions', () => {
    const questions: Record<string, unknown> = {};
    for (let i = 0; i <= DEFAULT_LIMITS.maxQuestions; i++) {
      questions[`q${i}`] = validChoice;
    }
    expect(() => schema.parse({ state: 'x', questions })).toThrow(/too many questions/);
  });

  it('accepts choice criteria as a plain list (ids equal to the strings)', () => {
    const parsed = schema.parse({
      state: 'x',
      questions: { c: { type: 'choice', instructions: 'i', criteria: ['rollback', 'hotfix'] } },
    });
    expect(parsed.questions.c?.criteria).toEqual(['rollback', 'hotfix']);
  });

  it('still rejects choice questions without record criteria', () => {
    expect(() => schema.parse({ state: 'x', questions: { c: { type: 'choice', instructions: 'i' } } })).toThrow(/choice/);
  });

  it('rejects score questions without array criteria', () => {
    expect(() =>
      schema.parse({ state: 'x', questions: { s: { type: 'score', instructions: 'i', criteria: { a: 'b' } } } }),
    ).toThrow(/score.*list/);
  });

  it('rejects noul criteria given as array', () => {
    expect(() =>
      schema.parse({ state: 'x', questions: { n: { type: 'noul', instructions: 'i', criteria: ['true'] } } }),
    ).toThrow(/noul/);
  });

  it('rejects empty instructions', () => {
    expect(() => schema.parse({ state: 'x', questions: { n: { type: 'noul', instructions: '' } } })).toThrow();
  });

  it('rejects oversized instructions', () => {
    const instructions = 'x'.repeat(DEFAULT_LIMITS.maxInstructionsChars + 1);
    expect(() => schema.parse({ state: 'x', questions: { n: { type: 'noul', instructions } } })).toThrow();
  });

  it('rejects oversized question ids', () => {
    const id = 'q'.repeat(DEFAULT_LIMITS.maxQuestionIdChars + 1);
    expect(() => schema.parse({ state: 'x', questions: { [id]: validNoul } })).toThrow();
  });

  it('rejects unknown question types', () => {
    expect(() =>
      schema.parse({ state: 'x', questions: { n: { type: 'essay', instructions: 'i' } } }),
    ).toThrow();
  });

  it('rejects temperature out of range', () => {
    expect(() =>
      schema.parse({ state: 'x', questions: { n: validNoul }, options: { temperature: 3 } }),
    ).toThrow();
  });
});

describe('validateStateSize', () => {
  const limits = { ...DEFAULT_LIMITS, maxStateBytes: 100 };

  it('accepts small string and JSON states', () => {
    expect(() => validateStateSize('short', limits)).not.toThrow();
    expect(() => validateStateSize({ a: 1 }, limits)).not.toThrow();
  });

  it('throws INVALID_INPUT when state is missing', () => {
    try {
      validateStateSize(undefined, limits);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClefError);
      expect((err as ClefError).code).toBe(ClefErrorCode.INVALID_INPUT);
    }
  });

  it('throws INVALID_INPUT when over the byte budget', () => {
    try {
      validateStateSize('x'.repeat(101), limits);
      expect.unreachable();
    } catch (err) {
      expect((err as ClefError).code).toBe(ClefErrorCode.INVALID_INPUT);
      expect((err as ClefError).hint).toMatch(/CLEF_MAX_STATE_BYTES/);
    }
  });

  it('throws on non-serializable state', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateStateSize(circular, limits)).toThrow(ClefError);
  });
});
