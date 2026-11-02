import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/config/limits.js';
import { openInput, readRows } from '../../src/classify/input.js';

let dir: string;
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clef-input-')); });
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });
async function collect(stream: AsyncIterable<unknown>) { const out = []; for await (const row of stream) out.push(row); return out; }
describe('classification input', () => {
  it('reads JSONL with BOM, blanks, CRLF and row errors', async () => {
    const rows = await collect(readRows(Readable.from(['\uFEFF{"body":"привет"}\r\n\ninvalid\n[]\n{"id":2}']), 'jsonl'));
    expect(rows).toMatchObject([{ row: 1, record: { body: 'привет' } }, { row: 2, error: { code: 'INVALID_INPUT' } }, { row: 3, error: { code: 'INVALID_INPUT' } }, { row: 4, record: { id: 2 } }]);
  });
  it('decodes multibyte text split across chunks', async () => {
    const data = Buffer.from('{"body":"я"}\n');
    expect(await collect(readRows(Readable.from([...data].map((b) => Buffer.from([b]))), 'jsonl'))).toEqual([{ row: 1, record: { body: 'я' } }]);
  });
  it('bounds overlong JSONL records and continues with the next row', async () => {
    const data = 'x'.repeat(1024 * 1024 + 1) + '\n{}\n';
    const rows = await collect(readRows(Readable.from([data]), 'jsonl'));
    expect(rows).toMatchObject([{ row: 1, error: { code: 'INVALID_INPUT' } }, { row: 2, record: {} }]);
  });
  it('preserves CSV multiline cells, quotes and leading zeroes', async () => {
    expect(await collect(readRows(Readable.from(['\uFEFFid,body\r\n001,"first\nsecond, ""quoted"""\r\n']), 'csv'))).toEqual([{ row: 1, record: { id: '001', body: 'first\nsecond, "quoted"' } }]);
  });
  it('enforces the CSV record byte limit for multibyte text', async () => {
    const text = 'body\n' + 'я'.repeat(524289) + '\n';
    await expect(collect(readRows(Readable.from([text]), 'csv'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it.each(['id,id\n1,2\n', ',body\n1,2\n', 'id,body\n1\n', 'id,body\n1,"unclosed', 'id,body\n1,2,3\n'])('rejects malformed CSV %#', async (text) => {
    await expect(collect(readRows(Readable.from([text]), 'csv'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('rejects invalid UTF-8 instead of silently changing a record', async () => {
    await expect(collect(readRows(Readable.from([Buffer.from([0xff])]), 'jsonl'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('handles empty input without producing rows', async () => {
    expect(await collect(readRows(Readable.from([]), 'jsonl'))).toEqual([]);
    expect(await collect(readRows(Readable.from([]), 'csv'))).toEqual([]);
  });
  it('fingerprints one open file and detects rewrites and path replacement', async () => {
    const file = path.join(dir, 'input.jsonl'); await fsp.writeFile(file, '{}\n');
    const source = await openInput(file, undefined, DEFAULT_LIMITS);
    try {
      expect(source.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(await collect(source.records())).toEqual([{ row: 1, record: {} }]);
      await source.verifyUnchanged();
      await fsp.rename(file, file + '.old'); await fsp.writeFile(file, '{}\n');
      await expect(source.verifyUnchanged()).rejects.toThrow(/changed/);
    } finally { await source.close(); }
  });
  it('requires explicit format for unknown extensions', async () => {
    const file = path.join(dir, 'input.txt'); await fsp.writeFile(file, '{}\n');
    await expect(openInput(file, undefined, DEFAULT_LIMITS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const source = await openInput(file, 'jsonl', DEFAULT_LIMITS);
    await source.close();
  });
});
