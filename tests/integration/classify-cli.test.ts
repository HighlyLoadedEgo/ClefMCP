import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath, makeFakeInstall, type FakeInstall } from '../helpers.js';

let install: FakeInstall, empty: FakeInstall, profile: string, input: string;
const yaml = 'schema_version: 1\nname: support-routing\ninstructions: Route the current record\nlabels: {billing: Payments, technical: Errors}\ninput: {id_field: id, fields: [body]}\n';
beforeAll(async () => {
  install = await makeFakeInstall(); empty = await makeFakeInstall({ withModel: false });
  profile = path.join(install.clefHome, 'profile.yaml'); input = path.join(install.clefHome, 'tickets.jsonl');
  await fsp.writeFile(profile, yaml); await fsp.writeFile(input, '{"id":"001","body":"refund"}\n{"id":"002","body":"error"}\n');
});
afterAll(async () => { await fsp.rm(install.clefHome, { recursive: true, force: true }); await fsp.rm(empty.clefHome, { recursive: true, force: true }); });
function run(args: string[], env = install.env, stdin?: string): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => stdout += c); child.stderr.on('data', (c) => stderr += c);
    child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
const rows = (s: string) => s.trim() ? s.trim().split('\n').map((line) => JSON.parse(line)) : [];
describe('classify CLI', () => {
  it('classifies separate records, preserves IDs and reuses one runtime', async () => {
    const starts = path.join(install.clefHome, 'starts');
    const out = await run(['classify', input, '--profile', profile], { ...install.env, FAKE_LLAMA_START_LOG: starts });
    expect(out.code).toBe(0);
    expect(rows(out.stdout)).toMatchObject([
      { row: 1, id: '001', status: 'needs_review', label: null, suggested_label: 'billing', review_reasons: ['low_probability'] },
      { row: 2, id: '002', status: 'needs_review', label: null },
    ]);
    expect((await fsp.readFile(starts, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(out.stderr).toContain('needs_review');
  });
  it('accepts explicit thresholds and distinguishes confidence', async () => {
    const file = path.join(install.clefHome, 'accept.yaml'); await fsp.writeFile(file, yaml + 'policy: {min_probability: 0.6, min_margin: 0.1, min_confidence: 0.6}\n');
    const out = await run(['classify', input, '--profile', file]);
    expect(out.code).toBe(0); expect(rows(out.stdout)[0]).toMatchObject({ status: 'classified', label: 'billing', confidence: .6 });
  });
  it('reads CSV and stdin with explicit format', async () => {
    const out = await run(['classify', '-', '--format', 'csv', '--profile', profile], install.env, 'id,body\r\n001,"refund, please"\r\n');
    expect(out.code).toBe(0); expect(rows(out.stdout)).toMatchObject([{ row: 1, id: '001', status: 'needs_review' }]);
  });
  it('writes row errors and continues, returning partial-failure exit 1', async () => {
    const out = await run(['classify', '-', '--profile', profile], install.env, 'broken\n{"id":"001"}\n{"id":"002","body":"ok"}\n');
    expect(out.code).toBe(1); expect(rows(out.stdout)).toMatchObject([
      { row: 1, status: 'error', error: { code: 'INVALID_INPUT' } },
      { row: 2, status: 'error', error: { code: 'INVALID_INPUT' } },
      { row: 3, status: 'needs_review' },
    ]);
  });
  it('does not load a missing model for empty input', async () => {
    const out = await run(['classify', '-', '--profile', profile], empty.env, '');
    expect(out.code).toBe(0); expect(out.stdout).toBe('');
  });
  it('returns missing-model exit 3 and invalid-model exit 2', async () => {
    expect((await run(['classify', input, '--profile', profile], empty.env)).code).toBe(3);
    expect((await run(['classify', input, '--profile', profile, '--model', 'missing'])).code).toBe(2);
  });
  it('lets CLI model override profile and environment', async () => {
    const file = path.join(install.clefHome, 'model.yaml'); await fsp.writeFile(file, yaml + 'model: missing-profile\n');
    const out = await run(['classify', input, '--profile', file, '--model', 'clef-flash'], { ...install.env, CLEF_MODEL: 'missing-env' });
    expect(out.code).toBe(0); expect(rows(out.stdout)[0].model).toBe('clef-flash');
  });
  it('rejects invalid profiles before creating output', async () => {
    const bad = path.join(install.clefHome, 'bad.yaml'), output = path.join(install.clefHome, 'not-created');
    await fsp.writeFile(bad, yaml + 'policy: {min_probability: 2}\n');
    expect((await run(['classify', input, '--profile', bad, '--output', output])).code).toBe(2);
    await expect(fsp.stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('resumes committed results without inference and rejects changed input', async () => {
    const output = path.join(install.clefHome, 'resume.jsonl');
    const args = ['classify', input, '--profile', profile, '--output', output];
    expect((await run(args)).code).toBe(0);
    const before = await fsp.readFile(output, 'utf8');
    const resumed = await run([...args, '--resume'], empty.env);
    expect(resumed.code).toBe(0); expect(resumed.stdout).toBe(''); expect(await fsp.readFile(output, 'utf8')).toBe(before);
    const changed = path.join(install.clefHome, 'changed.jsonl'); await fsp.writeFile(changed, '{}\n');
    expect((await run(['classify', changed, '--profile', profile, '--output', output, '--resume'])).code).toBe(2);
    expect(await fsp.readFile(output, 'utf8')).toBe(before);
  });
  it('rejects stdin resume and malformed CSV', async () => {
    expect((await run(['classify', '-', '--profile', profile, '--resume'], install.env, '')).code).toBe(2);
    expect((await run(['classify', '-', '--format', 'csv', '--profile', profile], install.env, 'id,id\n1,2\n')).code).toBe(2);
  });
  it('never accepts an invalid model distribution as a classification', async () => {
    const out = await run(['classify', input, '--profile', profile], { ...install.env, FAKE_LLAMA_BAD_DISTRIBUTION: '1' });
    expect(out.code).toBe(1); expect(out.stdout).toBe(''); expect(out.stderr).toContain('CLEF_INFERENCE_FAILED');
  });
  it('finishes safely on SIGINT and resumes the remaining records', async () => {
    const slow = await makeFakeInstall({ inferenceDelayMs: 100 });
    try {
      const data = path.join(slow.clefHome, 'input.jsonl'), output = path.join(slow.clefHome, 'out.jsonl');
      await fsp.writeFile(data, Array.from({ length: 15 }, (_, i) => JSON.stringify({ id: String(i), body: 'test' })).join('\n') + '\n');
      const args = ['classify', data, '--profile', profile, '--output', output];
      const child = spawn(process.execPath, [cliPath(), ...args], { env: slow.env, stdio: 'ignore' });
      const done = new Promise((resolve) => child.on('close', resolve));
      const deadline = Date.now() + 10000;
      for (;;) {
        const text = await fsp.readFile(output, 'utf8').catch(() => '');
        if (text.includes('\n')) break;
        if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('No first output row'); }
        await new Promise((r) => setTimeout(r, 20));
      }
      child.kill('SIGINT'); expect(await done).toBe(130);
      const partial = rows(await fsp.readFile(output, 'utf8')); expect(partial.length).toBeLessThan(15);
      expect((await run([...args, '--resume'], slow.env)).code).toBe(0);
      expect(rows(await fsp.readFile(output, 'utf8')).map((r) => r.row)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    } finally { await fsp.rm(slow.clefHome, { recursive: true, force: true }); }
  });
});
