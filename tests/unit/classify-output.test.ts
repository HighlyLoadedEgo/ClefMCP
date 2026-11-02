import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOutput, type OutputMetadata } from '../../src/classify/output.js';

let dir: string, file: string;
const metadata: OutputMetadata = { schema_version: 1, input_sha256: 'a'.repeat(64), profile_sha256: 'b'.repeat(64), profile: 'routing', model: 'clef-flash', runtime: 'llama-cpp', format: 'jsonl' };
const row = (n: number) => ({ row: n, profile: 'routing', model: 'clef-flash', status: 'classified' as const, label: 'billing', suggested_label: 'billing', probability: .9, margin: .8, probabilities: { billing: .9, other: .1 }, review_reasons: [] });
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clef-output-')); file = path.join(dir, 'results.jsonl'); });
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });
async function seed(text = JSON.stringify(row(1)) + '\n') { await fsp.writeFile(file, text); await fsp.writeFile(file + '.meta.json', JSON.stringify(metadata)); }
describe('classification output checkpoints', () => {
  it('creates private files, writes committed rows and resumes once', async () => {
    const first = await openOutput({ path: file, metadata });
    await first.append(row(1)); await first.close();
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(file + '.meta.json')).mode & 0o777).toBe(0o600);
    const second = await openOutput({ path: file, metadata, resume: true });
    expect(second.completedRows).toBe(1);
    await second.append(row(2)); await second.finish(2); await second.close();
    expect((await fsp.readFile(file, 'utf8')).trim().split('\n').map((s) => JSON.parse(s).row)).toEqual([1, 2]);
    await expect(fsp.stat(file + '.lock')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not overwrite existing output or metadata', async () => {
    await seed('important');
    await expect(openOutput({ path: file, metadata })).rejects.toThrow();
    expect(await fsp.readFile(file, 'utf8')).toBe('important');
  });
  it('truncates an incomplete final fragment after a valid prefix', async () => {
    await seed(JSON.stringify(row(1)) + '\n{"row":2');
    const out = await openOutput({ path: file, metadata, resume: true });
    expect(out.completedRows).toBe(1);
    await out.append(row(2)); await out.close();
    expect((await fsp.readFile(file, 'utf8')).trim().split('\n').map((s) => JSON.parse(s).row)).toEqual([1, 2]);
  });
  it('counts BOM and CRLF bytes when recovering a checkpoint tail', async () => {
    await seed('\uFEFF' + JSON.stringify(row(1)) + '\r\n{"row":2');
    const out = await openOutput({ path: file, metadata, resume: true });
    await out.append(row(2)); await out.close();
    const text = (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    expect(text.trim().split('\n').map((s) => JSON.parse(s).row)).toEqual([1, 2]);
  });
  it('recovers an interrupted final record split inside a UTF-8 character', async () => {
    await seed();
    await fsp.appendFile(file, Buffer.concat([Buffer.from('{"row":2,"id":"'), Buffer.from([0xd0])]));
    const out = await openOutput({ path: file, metadata, resume: true });
    expect(out.completedRows).toBe(1);
    await out.append(row(2)); await out.close();
    expect((await fsp.readFile(file, 'utf8')).trim().split('\n').map((s) => JSON.parse(s).row)).toEqual([1, 2]);
  });
  it('preserves complete checkpoint rows containing invalid UTF-8', async () => {
    await seed();
    await fsp.appendFile(file, Buffer.from([0xd0, 0x0a]));
    const before = await fsp.readFile(file);
    await expect(openOutput({ path: file, metadata, resume: true })).rejects.toThrow();
    expect(await fsp.readFile(file)).toEqual(before);
  });
  it.each(['broken\n', JSON.stringify(row(2)) + '\n', JSON.stringify({ ...row(1), model: 'other' }) + '\n', JSON.stringify({ ...row(1), label: null }) + '\n'])('rejects complete checkpoint corruption %#', async (text) => {
    await seed(text);
    await expect(openOutput({ path: file, metadata, resume: true })).rejects.toThrow();
    expect(await fsp.readFile(file, 'utf8')).toBe(text);
  });
  it.each(['input_sha256', 'profile_sha256', 'model', 'runtime', 'format'])('rejects changed %s', async (key) => {
    await seed();
    await expect(openOutput({ path: file, metadata: { ...metadata, [key]: 'changed' }, resume: true })).rejects.toThrow();
  });
  it('refuses a checkpoint longer than the current input', async () => {
    await seed(); const out = await openOutput({ path: file, metadata, resume: true });
    try { await expect(out.finish(0)).rejects.toThrow(/input|rows/); } finally { await out.close(); }
  });
  it('refuses concurrent writers and reclaims a dead local lock', async () => {
    const first = await openOutput({ path: file, metadata });
    await expect(openOutput({ path: file, metadata, resume: true })).rejects.toThrow(/lock|writer/);
    await first.close();
    // Negative PID is never treated as a process group to signal.
    await fsp.writeFile(file + '.lock', JSON.stringify({ pid: -1, host: os.hostname(), token: 'dead' }));
    await expect(openOutput({ path: file, metadata, resume: true })).rejects.toThrow(/lock/);
    await fsp.writeFile(file + '.lock', JSON.stringify({ pid: 2147483647, host: os.hostname(), token: 'dead' }));
    const resumed = await openOutput({ path: file, metadata, resume: true }); await resumed.close();
  });
  it('preserves protected input aliases and refuses symlink/hardlink checkpoints', async () => {
    const input = path.join(dir, 'input.jsonl'); await fsp.writeFile(input, 'source');
    await fsp.link(input, file);
    await expect(openOutput({ path: file, metadata, resume: true, protectedPaths: [input] })).rejects.toThrow();
    expect(await fsp.readFile(input, 'utf8')).toBe('source');
    await fsp.unlink(file); await fsp.symlink(input, file);
    await expect(openOutput({ path: file, metadata, resume: true })).rejects.toThrow();
    expect(await fsp.readFile(input, 'utf8')).toBe('source');
  });
  it('refuses a symlink sidecar and missing metadata', async () => {
    await seed(); await fsp.unlink(file + '.meta.json');
    await expect(openOutput({ path: file, metadata, resume: true })).rejects.toThrow();
    await fsp.writeFile(path.join(dir, 'meta'), JSON.stringify(metadata));
    await fsp.symlink(path.join(dir, 'meta'), file + '.meta.json');
    await expect(openOutput({ path: file, metadata, resume: true })).rejects.toThrow();
  });
  it('awaits writable backpressure without closing a caller-owned stream', async () => {
    let written = ''; let closed = false;
    const stream = new Writable({ highWaterMark: 1, write(chunk, _, cb) { setTimeout(() => { written += chunk; cb(); }, 10); }, final(cb) { closed = true; cb(); } });
    const out = await openOutput({ metadata, stream });
    await out.append(row(1)); await out.close();
    expect(JSON.parse(written).row).toBe(1); expect(closed).toBe(false);
    stream.destroy();
  });
});
