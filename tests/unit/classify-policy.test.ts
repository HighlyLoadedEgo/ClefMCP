import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/config/limits.js';
import { parseProfile } from '../../src/classify/profile.js';
import { evaluateClassification } from '../../src/classify/policy.js';

const p = () => parseProfile('schema_version: 1\nname: routing\ninstructions: Route\nlabels: {billing: Payments, other: Other}\n', DEFAULT_LIMITS);
describe('classification policy', () => {
  it('accepts inclusive probability and margin boundaries', () => {
    expect(evaluateClassification(p(), { answer: { billing: .8, other: .2 } })).toMatchObject({ status: 'classified', label: 'billing', review_reasons: [] });
    const profile = p(); profile.policy = { min_probability: .5, min_margin: .15 };
    expect(evaluateClassification(profile, { answer: { billing: .575, other: .425 } }).status).toBe('classified');
  });
  it('retains an uncertain suggestion without accepting it', () => {
    expect(evaluateClassification(p(), { answer: { billing: .55, other: .45 } })).toMatchObject({ status: 'needs_review', label: null, suggested_label: 'billing', review_reasons: ['low_probability', 'low_margin'] });
  });
  it('always reviews exact ties and chooses a stable display order', () => {
    const profile = p(); profile.policy = { min_probability: 0, min_margin: 0 };
    expect(evaluateClassification(profile, { answer: { other: .5, billing: .5 } })).toMatchObject({ label: null, suggested_label: 'billing', review_reasons: ['tie'] });
  });
  it('requires optional confidence and does not confuse it with probability', () => {
    const profile = p(); profile.policy.min_confidence = .7;
    expect(evaluateClassification(profile, { answer: { billing: .9, other: .1 } }).review_reasons).toEqual(['missing_confidence']);
    expect(evaluateClassification(profile, { answer: { billing: .9, other: .1 }, confidence: .6 }).review_reasons).toEqual(['low_confidence']);
    expect(evaluateClassification(profile, { answer: { billing: .9, other: .1 }, confidence: .7 }).status).toBe('classified');
  });
  it.each([
    { billing: 1 }, { billing: .9, other: .1, extra: 0 },
    { billing: -1, other: 2 }, { billing: NaN, other: 0 },
    { billing: Infinity, other: 0 }, { billing: .2, other: .2 },
  ])('rejects invalid runtime distributions %#', (answer) => {
    expect(() => evaluateClassification(p(), { answer })).toThrow();
  });
});
