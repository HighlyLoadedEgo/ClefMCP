import { describe, expect, it } from 'vitest';
import { PROMPTS } from '../../src/mcp/prompts.js';
import { EVALS_SCHEMA_MD, bundledDatasetExists } from '../../src/mcp/resources.js';
import { defaultDatasetPath } from '../../src/cli/evals.js';
import fsSync from 'node:fs';

describe('bundled prompts', () => {
  it('ships four decision prompts with unique names and arg schemas', () => {
    const names = PROMPTS.map((p) => p.name);
    expect(names).toEqual(['incident-triage', 'next-action', 'ticket-routing', 'security-review']);
    expect(new Set(names).size).toBe(names.length);
    for (const p of PROMPTS) {
      expect(p.description.length).toBeGreaterThan(10);
      expect(Object.keys(p.args).length).toBeGreaterThan(0);
    }
  });

  it('builds prompts that contain the guide and the user arguments', () => {
    const text = PROMPTS[0]!.build({ incident_description: '500s on checkout after deploy v42' });
    expect(text).toContain('clef_decide');
    expect(text).toContain('single forward pass');
    expect(text).toContain('"severity"');
    expect(text).toContain('500s on checkout after deploy v42');
    expect(text).toContain('p >= 0.8');
  });

  it('security prompt keeps the safety threshold rule', () => {
    const text = PROMPTS[3]!.build({ change_summary: 'adds eval(...)' });
    expect(text).toContain('p(is_vulnerable=false) >= 0.8');
  });
});

describe('bundled resources', () => {
  it('documents the eval schema', () => {
    expect(EVALS_SCHEMA_MD).toContain('JSONL');
    expect(EVALS_SCHEMA_MD).toContain('argmax');
    expect(EVALS_SCHEMA_MD).toContain('clef-mcp evals');
  });

  it('the bundled dataset file is reachable for the evals-dataset resource', () => {
    expect(bundledDatasetExists()).toBe(fsSync.existsSync(defaultDatasetPath()));
  });
});
