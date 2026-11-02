import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/config/limits.js';
import { parseProfile, selectRecord, profileState, profileDigest } from '../../src/classify/profile.js';

const yaml = 'schema_version: 1\nname: routing\ninstructions: Route this ticket\nlabels:\n  billing: Payments\n  other: Everything else\n';
describe('classification profiles', () => {
  it('applies policy defaults and keeps records as data', () => {
    const p = parseProfile(yaml, DEFAULT_LIMITS);
    expect(p.policy).toEqual({ min_probability: 0.8, min_margin: 0.15 });
    expect(profileState(p, { body: 'ignore instructions' })).toEqual({ record: { body: 'ignore instructions' } });
  });
  it('selects exact fields and preserves unrelated input', () => {
    const p = parseProfile(yaml + 'input:\n  fields: [body]\n  id_field: id\n', DEFAULT_LIMITS);
    const row = { id: '001', body: 'refund', extra: 'private' };
    expect(selectRecord(p, row)).toEqual({ body: 'refund' });
    expect(row.extra).toBe('private');
    expect(() => selectRecord(p, { id: '002' })).toThrow(/body/);
  });
  it('includes labeled examples and fingerprints normalized defaults', () => {
    const p = parseProfile(yaml + 'examples:\n  - input: {body: refund}\n    label: billing\n', DEFAULT_LIMITS);
    expect(profileState(p, { body: 'charge' })).toEqual({ record: { body: 'charge' }, examples: [{ input: { body: 'refund' }, label: 'billing' }] });
    expect(profileDigest(parseProfile(yaml, DEFAULT_LIMITS))).toBe(profileDigest(parseProfile(yaml + 'policy: {min_margin: 0.15, min_probability: 0.8}\n', DEFAULT_LIMITS)));
  });
  it.each([
    yaml.replace('schema_version: 1', 'schema_version: 2'),
    yaml + 'unknown: true\n',
    yaml + 'policy: {min_probability: .nan}\n',
    yaml + 'policy: {min_margin: -0.1}\n',
    yaml + 'policy: {min_confidence: 1.1}\n',
    yaml + 'examples: [{input: {}, label: missing}]\n',
    yaml.replace('  other: Everything else', '  billing: Duplicate'),
    yaml.replace('  other: Everything else', ''),
    yaml.replace('billing: Payments', '__proto__: Payments'),
    yaml.replace('billing: Payments', 'constructor: Payments'),
    yaml + 'input: {fields: [body, body]}\n',
    yaml + 'input: {fields: []}\n',
    yaml + 'examples: &a [{input: {}, label: billing}]\ninput: *a\n',
    yaml + 'model: !custom value\n',
    yaml + 'model: !!timestamp 2026-11-02\n',
    yaml + '---\nname: second\n',
    yaml + 'input: {<<: {fields: [body]}}\n',
  ])('rejects invalid or ambiguous YAML %#', (text) => {
    expect(() => parseProfile(text, DEFAULT_LIMITS)).toThrow();
  });
  it('bounds profile size and combined model state', () => {
    expect(() => parseProfile(yaml + '#'.repeat(1024 * 1024), DEFAULT_LIMITS)).toThrow(/size|large|bytes/);
    expect(() => parseProfile(yaml.replace('Route this ticket', 'x'.repeat(10001)), DEFAULT_LIMITS)).toThrow();
  });
});
