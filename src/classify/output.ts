import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { ClefErrorCode, type StructuredError } from '../clef/errors.js';
import type { ClefUsage } from '../clef/types.js';
import { CLASSIFY_LIMITS } from '../config/limits.js';
import { boundedLines, fileChunks, type InputFormat } from './input.js';
import type { PolicyResult } from './policy.js';
import { canonicalJson, invalid } from './profile.js';

export interface OutputMetadata {
  schema_version: 1; input_sha256: string; profile_sha256: string; profile: string;
  model: string; runtime: string; format: InputFormat;
}
type ResultBase = { row: number; id?: string; profile: string; model: string };
export type ClassificationResult = ResultBase & ((PolicyResult & { usage?: ClefUsage }) | { status: 'error'; label: null; error: StructuredError['error'] });
export interface OutputSession {
  readonly completedRows: number;
  append(result: ClassificationResult): Promise<void>;
  finish(totalRows: number): Promise<void>;
  close(): Promise<void>;
}
interface OutputOptions { path?: string; resume?: boolean; metadata: OutputMetadata; protectedPaths?: string[]; stream?: Writable }

const baseShape = { row: z.number().int().positive(), id: z.string().optional(), profile: z.string().min(1), model: z.string().min(1) };
const policyShape = {
  label: z.string().nullable(), suggested_label: z.string(), probability: z.number().min(0).max(1), margin: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)), confidence: z.number().min(0).max(1).optional(),
  review_reasons: z.array(z.enum(['low_probability', 'low_margin', 'tie', 'low_confidence', 'missing_confidence'])),
  usage: z.strictObject({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), latency_ms: z.number().optional() }).optional(),
};
const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...baseShape, ...policyShape, status: z.literal('classified') }),
  z.strictObject({ ...baseShape, ...policyShape, status: z.literal('needs_review') }),
  z.strictObject({ ...baseShape, status: z.literal('error'), label: z.null(), error: z.strictObject({ code: z.enum(Object.values(ClefErrorCode)), message: z.string(), hint: z.string().optional() }) }),
]);

function validateResult(value: unknown, expectedRow: number, metadata: OutputMetadata): asserts value is ClassificationResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw invalid('Invalid classification result in checkpoint');
  const result = parsed.data;
  if (result.row !== expectedRow || result.profile !== metadata.profile || result.model !== metadata.model) throw invalid('Checkpoint row sequence or profile/model identity does not match');
  if (result.status === 'error') return;
  const entries = Object.entries(result.probabilities).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (entries.length < 2 || entries.length > 100 || Math.abs(entries.reduce((s, [, p]) => s + p, 0) - 1) > .001 + 1e-12 || entries[0]![0] !== result.suggested_label || Math.abs(entries[0]![1] - result.probability) > 1e-12 || Math.abs(entries[0]![1] - entries[1]![1] - result.margin) > 1e-12 ||
      (result.status === 'classified' ? result.label !== result.suggested_label || result.review_reasons.length !== 0 || result.margin === 0 : result.label !== null || result.review_reasons.length === 0)) throw invalid('Invalid classification policy fields in checkpoint');
}

async function exists(file: string): Promise<boolean> {
  try { await fsp.lstat(file); return true; } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
}

async function protectFiles(candidates: string[], protectedPaths: string[]): Promise<void> {
  for (const candidate of candidates) {
    for (const source of protectedPaths.filter((p) => p !== '-')) {
      if (path.resolve(candidate) === path.resolve(source)) throw invalid('Output must not overwrite an input or profile file');
      try {
        const [a, b] = await Promise.all([fsp.stat(candidate), fsp.stat(source)]);
        if (a.dev === b.dev && a.ino === b.ino) throw invalid('Output aliases an input or profile file');
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
  }
}

async function openRegular(file: string, write = false): Promise<FileHandle> {
  const handle = await fsp.open(file, (write ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || (await fsp.lstat(file)).isSymbolicLink()) { await handle.close(); throw invalid('Checkpoint and metadata must be regular files without links'); }
  return handle;
}

async function readJson(file: string): Promise<unknown> {
  const handle = await openRegular(file);
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of fileChunks(handle)) {
      size += chunk.length;
      if (size > CLASSIFY_LIMITS.maxMetadataBytes) throw invalid('Checkpoint metadata or lock exceeds the size limit');
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await handle.close(); }
}

async function acquireLock(file: string, resume: boolean): Promise<() => Promise<void>> {
  const lock = `${file}.lock`, claim = `${lock}.claim`, token = randomUUID();
  let guard: FileHandle;
  try { guard = await fsp.open(claim, 'wx', 0o600); }
  catch { throw invalid(`Output lock acquisition is busy: ${claim}. Preserve active locks; inspect a crash-left claim before removing it.`); }
  try {
    if (await exists(lock)) {
      const owner = await readJson(lock) as { pid?: number; host?: string; token?: string };
      let dead = false;
      if (resume && owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid! > 0 && owner.pid! <= 2147483647 && typeof owner.token === 'string') {
        try { process.kill(owner.pid!, 0); } catch (err) { dead = (err as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
      if (!dead) throw invalid(`Output lock belongs to an active or unverifiable writer: ${lock}`);
      await fsp.unlink(lock);
    }
    const handle = await fsp.open(lock, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), token })); await handle.sync(); }
    finally { await handle.close(); }
  } finally { await guard.close(); await fsp.unlink(claim); }
  return async () => {
    const owner = await readJson(lock) as { token?: string };
    if (owner.token === token) await fsp.unlink(lock);
  };
}

async function writeMetadata(file: string, metadata: OutputMetadata): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fsp.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(metadata) + '\n'); await handle.sync();
    // Link publishes the complete metadata atomically without replacing a file.
    await fsp.link(temp, file);
  } finally { await handle.close(); await fsp.unlink(temp); }
}

export async function openOutput(options: OutputOptions): Promise<OutputSession> {
  const { metadata } = options;
  let handle: FileHandle | undefined, release: (() => Promise<void>) | undefined;
  let completed = 0, closed = false, createdOutput = false;
  try {
    if (options.resume && !options.path) throw invalid('--resume requires --output');
    if (options.path) {
      const file = options.path;
      await protectFiles([file, `${file}.meta.json`, `${file}.lock`, `${file}.lock.claim`], options.protectedPaths ?? []);
      if (!options.resume && (await exists(file) || await exists(`${file}.meta.json`))) throw invalid('Output or metadata already exists; use --resume or a new output path');
      release = await acquireLock(file, !!options.resume);
      if (options.resume) {
        if (canonicalJson(await readJson(`${file}.meta.json`)) !== canonicalJson(metadata)) throw invalid('Resume metadata does not match input, profile, model, runtime or format');
        handle = await openRegular(file, true);
        let safeOffset = 0, partial = false;
        for await (const line of boundedLines(fileChunks(handle), CLASSIFY_LIMITS.maxResultBytes, true)) {
          if (!line.terminated) { partial = true; break; }
          if (line.oversized) throw invalid('Checkpoint result exceeds the size limit');
          let value: unknown;
          try { value = JSON.parse(line.text); } catch { throw invalid('Corrupt complete JSONL checkpoint row'); }
          validateResult(value, completed + 1, metadata);
          completed++; safeOffset += line.bytes;
        }
        if (partial) { await handle.truncate(safeOffset); await handle.sync(); }
      } else {
        handle = await fsp.open(file, 'wx', 0o600); createdOutput = true;
        await writeMetadata(`${file}.meta.json`, metadata);
      }
    }
  } catch (err) {
    try { await handle?.close(); } finally {
      if (createdOutput && options.path) await fsp.unlink(options.path);
      await release?.();
    }
    throw err;
  }
  const stream = options.stream ?? process.stdout;
  return {
    get completedRows() { return completed; },
    async append(result) {
      if (closed) throw invalid('Output is closed');
      validateResult(result, completed + 1, metadata);
      const line = JSON.stringify(result) + '\n';
      if (Buffer.byteLength(line) > CLASSIFY_LIMITS.maxResultBytes) throw invalid('Result exceeds the maximum size');
      if (handle) { await handle.writeFile(line, 'utf8'); await handle.sync(); }
      else await new Promise<void>((resolve, reject) => stream.write(line, (err) => err ? reject(err) : resolve()));
      completed = result.row;
    },
    async finish(totalRows) { if (completed !== totalRows) throw invalid('Checkpoint rows exceed the input or processing is incomplete'); },
    async close() {
      if (closed) return; closed = true;
      try { await handle?.close(); } finally { await release?.(); }
    },
  };
}
