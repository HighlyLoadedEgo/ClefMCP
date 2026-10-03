import fsp from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { defaultDatasetPath } from '../../src/cli/evals.js';

interface EvalLine {
  id: string;
  category: string;
  state: unknown;
  question: { id: string; type: 'noul' | 'choice' | 'score'; instructions: string; criteria?: string[] | Record<string, string> };
  expected: { kind: string; [key: string]: unknown };
}

const KINDS = new Set(['argmax', 'prob_gt', 'min_prob', 'top_mass']);

describe('eval dataset', () => {
  it('exists and parses as JSONL', async () => {
    const content = await fsp.readFile(defaultDatasetPath(), 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(25);
    const cases = lines.map((l, i) => {
      try {
        return JSON.parse(l) as EvalLine;
      } catch (err) {
        throw new Error(`line ${i + 1} is not valid JSON: ${err}`);
      }
    });

    const ids = new Set<string>();
    const categories = new Set<string>();
    for (const c of cases) {
      expect(c.id, 'unique ids').toBeTruthy();
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
      ids.add(c.id);
      categories.add(c.category);

      expect(['noul', 'choice', 'score']).toContain(c.question.type);
      expect(c.question.instructions.length).toBeGreaterThan(0);
      expect(c.state).toBeDefined();

      if (c.question.type === 'choice') {
        expect(typeof c.question.criteria, `${c.id}: choice needs a criteria map`).toBe('object');
        expect(Array.isArray(c.question.criteria)).toBe(false);
      } else if (c.question.type === 'score') {
        expect(Array.isArray(c.question.criteria), `${c.id}: score needs an array`).toBe(true);
      }

      expect(KINDS.has(c.expected.kind), `${c.id}: unknown kind`).toBe(true);
      if (c.expected.kind === 'argmax') {
        const criteria = c.question.criteria;
        const keys =
          c.expected.among ??
          (Array.isArray(criteria) ? criteria : Object.keys(criteria ?? {}));
        expect(
          keys.includes(String(c.expected.expect)),
          `${c.id}: expected option not in criteria`,
        ).toBe(true);
      }
      if (c.expected.kind === 'min_prob') {
        if (c.question.type === 'noul') {
          expect(['true', 'false']).toContain(c.expected.option);
        } else {
          const keys = Object.keys(c.question.criteria ?? {});
          expect(keys).toContain(c.expected.option);
        }
      }
    }
    expect(categories.size).toBeGreaterThanOrEqual(5);
  });
});
