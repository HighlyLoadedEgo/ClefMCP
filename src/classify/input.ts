import { createHash } from 'node:crypto';
import fsp, { type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { errorJson, type StructuredError } from '../clef/errors.js';
import { CLASSIFY_LIMITS, type Limits } from '../config/limits.js';
import { invalid } from './profile.js';

export type InputFormat = 'jsonl' | 'csv';
export interface InputRow { row: number; record?: Record<string, unknown>; error?: StructuredError['error'] }
export interface InputSource {
  format: InputFormat;
  fingerprint?: string;
  records(): AsyncIterable<InputRow>;
  verifyUnchanged(): Promise<void>;
  close(): Promise<void>;
}

async function* decoded(source: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of source) yield decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, { stream: true });
    const tail = decoder.decode();
    if (tail) yield tail;
  } catch (err) { throw invalid(`Cannot read UTF-8 input: ${err instanceof Error ? err.message : String(err)}`); }
}

/** Bounded physical lines, also reused for JSONL checkpoint validation. */
export async function* boundedLines(source: AsyncIterable<Buffer | string>, maxBytes: number): AsyncGenerator<{ text: string; oversized: boolean; terminated: boolean }> {
  let text = '', size = 0, oversized = false;
  for await (const chunk of decoded(source)) {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf('\n', start);
      const part = chunk.slice(start, end < 0 ? undefined : end);
      if (!oversized) {
        size += Buffer.byteLength(part);
        if (size > maxBytes) { oversized = true; text = ''; }
        else text += part;
      }
      if (end < 0) break;
      yield { text: text.endsWith('\r') ? text.slice(0, -1) : text, oversized, terminated: true };
      text = ''; size = 0; oversized = false; start = end + 1;
    }
  }
  if (text || oversized) yield { text, oversized, terminated: false };
}

export async function* readRows(source: AsyncIterable<Buffer | string>, format: InputFormat): AsyncGenerator<InputRow> {
  let row = 0;
  if (format === 'jsonl') {
    for await (const line of boundedLines(source, CLASSIFY_LIMITS.maxRecordBytes)) {
      if (!line.oversized && !line.text.trim()) continue;
      row++;
      try {
        if (line.oversized) throw invalid('Record exceeds the maximum size');
        const record: unknown = JSON.parse(line.text);
        if (record === null || typeof record !== 'object' || Array.isArray(record)) throw invalid('JSONL records must be JSON objects');
        yield { row, record: record as Record<string, unknown> };
      } catch (err) {
        yield { row, error: errorJson(invalid(`Row ${row}: ${err instanceof Error ? err.message : String(err)}`)).error };
      }
    }
    return;
  }
  const parser = parse({
    bom: true, cast: false, skip_empty_lines: true, relax_column_count: false,
    max_record_size: CLASSIFY_LIMITS.maxRecordBytes,
    columns: (headers: string[]) => {
      if (headers.length > CLASSIFY_LIMITS.maxFields || headers.some((h) => !h.trim()) || new Set(headers).size !== headers.length) throw invalid('CSV headers must be nonempty, unique and within the field limit');
      if (headers.some((h) => ['__proto__', 'constructor', 'prototype'].includes(h))) throw invalid('Reserved CSV header');
      return headers;
    },
  });
  const upstream = Readable.from(decoded(source));
  upstream.on('error', (err) => parser.destroy(err));
  upstream.pipe(parser);
  try {
    for await (const record of parser) yield { row: ++row, record: record as Record<string, unknown> };
  } catch (err) { throw invalid(`Invalid CSV: ${err instanceof Error ? err.message : String(err)}`); }
  finally { upstream.destroy(); parser.destroy(); }
}

export async function* fileChunks(handle: FileHandle): AsyncGenerator<Buffer> {
  let position = 0;
  for (;;) {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export async function openInput(file: string, requestedFormat: string | undefined, _limits: Limits): Promise<InputSource> {
  const format = requestedFormat ?? (file === '-' ? 'jsonl' : file.toLowerCase().endsWith('.jsonl') ? 'jsonl' : file.toLowerCase().endsWith('.csv') ? 'csv' : undefined);
  if (format !== 'jsonl' && format !== 'csv') throw invalid('Use --format jsonl|csv for this input');
  if (file === '-') return { format, records: () => readRows(process.stdin.iterator({ destroyOnReturn: false }), format), verifyUnchanged: async () => {}, close: async () => {} };
  const handle = await fsp.open(file, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw invalid('Input must be a regular file or stdin');
    const verifyUnchanged = async () => {
      let currentPath: Stats;
      try { currentPath = await fsp.stat(file); } catch { throw invalid('Input changed during classification'); }
      if (!sameFile(initial, await handle.stat()) || !sameFile(initial, currentPath)) throw invalid('Input changed during classification');
    };
    const hash = createHash('sha256');
    for await (const chunk of fileChunks(handle)) hash.update(chunk);
    await verifyUnchanged();
    return { format, fingerprint: hash.digest('hex'), records: () => readRows(fileChunks(handle), format), verifyUnchanged, close: () => handle.close() };
  } catch (err) { await handle.close(); throw err; }
}
