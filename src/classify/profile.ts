import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import { CLASSIFY_LIMITS, type Limits } from '../config/limits.js';

export function invalid(message: string): ClefError {
  return new ClefError(ClefErrorCode.INVALID_INPUT, message);
}

const safeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const threshold = z.number().finite().min(0).max(1);
const reserved = new Set(['__proto__', 'constructor', 'prototype', '<<']);

function validateData(value: unknown, depth = 0): void {
  if (depth > CLASSIFY_LIMITS.maxDepth) throw invalid('Profile nesting exceeds the limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value instanceof Date || value instanceof Map || value instanceof Set) throw invalid('Profile must contain JSON-compatible data');
  for (const [key, child] of Object.entries(value)) {
    if (reserved.has(key)) throw invalid(`Reserved profile key "${key}"`);
    validateData(child, depth + 1);
  }
}

/** Canonical ordering also fixes label presentation order across resumed runs. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function profileSchema(limits: Limits) {
  return z.strictObject({
    schema_version: z.literal(1),
    name: safeId.max(64),
    instructions: z.string().trim().min(1).max(limits.maxInstructionsChars),
    labels: z.record(safeId, z.string().trim().min(1).max(limits.maxCriteriaDescChars)).refine((v) => Object.keys(v).length >= 2 && Object.keys(v).length <= Math.min(100, limits.maxCriteriaPerQuestion), 'Expected 2–100 labels within the configured criteria limit'),
    model: z.string().trim().min(1).optional(),
    input: z.strictObject({
      id_field: z.string().min(1).optional(),
      fields: z.array(z.string().min(1)).min(1).max(CLASSIFY_LIMITS.maxFields).refine((v) => new Set(v).size === v.length, 'Selected fields must be unique').optional(),
    }).optional(),
    policy: z.strictObject({
      min_probability: threshold.default(.8),
      min_margin: threshold.default(.15),
      min_confidence: threshold.optional(),
    }).default({ min_probability: .8, min_margin: .15 }),
    examples: z.array(z.strictObject({ input: z.record(z.string(), z.unknown()), label: safeId })).max(CLASSIFY_LIMITS.maxExamples).optional(),
  }).superRefine((p, ctx) => {
    for (const example of p.examples ?? []) {
      if (!Object.hasOwn(p.labels, example.label)) ctx.addIssue({ code: 'custom', message: `Example label "${example.label}" is not configured` });
    }
  });
}

export type ClassificationProfile = z.output<ReturnType<typeof profileSchema>>;

export function parseProfile(text: string, limits: Limits): ClassificationProfile {
  if (Buffer.byteLength(text) > CLASSIFY_LIMITS.maxProfileBytes) throw invalid('Profile exceeds the maximum size in bytes');
  try {
    const docs = parseAllDocuments(text, { version: '1.2', schema: 'core', uniqueKeys: true, stringKeys: true, strict: true, resolveKnownTags: false, customTags: [], merge: false, logLevel: 'silent' });
    if (docs.length !== 1) throw invalid('Profile must contain exactly one YAML document');
    const doc = docs[0]!;
    if (doc.errors.length || doc.warnings.length) throw invalid(`Invalid YAML profile: ${(doc.errors[0] ?? doc.warnings[0])!.message}`);
    const data: unknown = doc.toJS({ maxAliasCount: 0 });
    validateData(data);
    return profileSchema(limits).parse(JSON.parse(canonicalJson(data)));
  } catch (err) {
    if (err instanceof ClefError) throw err;
    throw invalid(`Invalid profile: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function loadProfile(file: string, limits: Limits): Promise<ClassificationProfile> {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > CLASSIFY_LIMITS.maxProfileBytes) throw invalid('Profile must be a regular file within the size limit');
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      size += (chunk as Buffer).length;
      if (size > CLASSIFY_LIMITS.maxProfileBytes) throw invalid('Profile exceeds the maximum size in bytes');
      chunks.push(chunk as Buffer);
    }
    return parseProfile(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), limits);
  } finally { await handle.close(); }
}

export function selectRecord(profile: ClassificationProfile, record: Record<string, unknown>): Record<string, unknown> {
  if (profile.input?.id_field) {
    const id = record[profile.input.id_field];
    if (!Object.hasOwn(record, profile.input.id_field) || !(typeof id === 'string' || typeof id === 'number' && Number.isFinite(id))) throw invalid(`Missing or invalid id field "${profile.input.id_field}"`);
  }
  if (!profile.input?.fields) return record;
  return Object.fromEntries(profile.input.fields.map((field) => {
    if (!Object.hasOwn(record, field)) throw invalid(`Missing selected field "${field}"`);
    return [field, record[field]];
  }));
}

export function profileState(profile: ClassificationProfile, record: Record<string, unknown>): unknown {
  return { record, ...(profile.examples?.length ? { examples: profile.examples } : {}) };
}

export function profileDigest(profile: ClassificationProfile): string {
  return createHash('sha256').update(canonicalJson(profile)).digest('hex');
}
