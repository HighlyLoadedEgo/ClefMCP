import fsp from 'node:fs/promises';
import { ZodError } from 'zod';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import { fromSystemOneResponse, toSystemOneRequest } from '../clef/systemone.js';
import { loadConfig } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { getModelSpec } from '../models/registry.js';
import { clefDecideInputSchema, validateStateSize, type ClefDecideValidated } from '../mcp/schema.js';
import { RuntimeLoader } from '../runtime/loader.js';
import { daemonSocketPath } from '../daemon/daemon.js';
import { decideViaDaemon } from '../daemon/client.js';

export interface DecideOptions {
  /** Path to a state file, "-" for stdin, or an inline JSON/text value. */
  state?: string;
  /** Path to a JSON file with the questions map ("-" for stdin). */
  questions?: string;
  model?: string;
  /** Route the request through a running `clef-mcp daemon` (falls back to a cold run). */
  daemon?: boolean;
}

function invalid(message: string, hint?: string): ClefError {
  return new ClefError(ClefErrorCode.INVALID_INPUT, message, hint);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse a JSON document, mapping failures to INVALID_INPUT with a useful hint. */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw invalid(
      `${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      `${what} must be a JSON document (object for state, { "qid": {...} } map for questions).`,
    );
  }
}

/** Read a source that is either a file path, "-" (stdin) or an inline value. */
async function readSource(source: string | undefined, what: string, stdin: string): Promise<unknown> {
  if (source === undefined || source === '') {
    throw invalid(`${what} is required`, `Pass --${what} <file|"-" for stdin|inline JSON> or pipe a full document to stdin.`);
  }
  if (source === '-') {
    if (!stdin) throw invalid(`no data on stdin for --${what} -`, 'Pipe the JSON in or pass a file path.');
    return parseJson(stdin, what);
  }
  try {
    await fsp.access(source);
    const content = await fsp.readFile(source, 'utf8');
    return parseJson(content, what);
  } catch (err) {
    if (err instanceof ClefError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Not an existing file: treat the value as inline JSON (or a bare string).
    // A typo'd path must not silently become the state text, so say so.
    if (!source.includes('\n')) {
      process.stderr.write(`clef-mcp decide: ${source} is not an existing file; using the value as inline ${what}\n`);
    }
    const trimmed = source.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJson(trimmed, what);
    return source;
  }
}

/**
 * One-shot decision: read state + questions, run a single inference through
 * the shared runtime loader, print the strict JSON result to stdout and exit.
 * Nothing is ever downloaded here; a missing model is a structured error.
 */
export async function runDecide(opts: DecideOptions): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const stdin = await readStdin();

  let state: unknown;
  let questions: unknown;
  let model: string | undefined;

  if (opts.questions !== undefined) {
    questions = await readSource(opts.questions, 'questions', stdin);
    state = await readSource(opts.state, 'state', opts.state === '-' ? stdin : '');
  } else {
    if (!stdin) {
      throw invalid(
        'no input on stdin',
        'Pipe a JSON document {"state": ..., "questions": {...}} to stdin, or pass --questions <file> (and optionally --state <file>).',
      );
    }
    const doc = parseJson(stdin, 'input');
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw invalid('stdin input must be a JSON object with "state" and "questions"', 'See the clef-mcp README for the document shape.');
    }
    const record = doc as Record<string, unknown>;
    state = record.state;
    questions = record.questions;
    if (typeof record.model === 'string') model = record.model;
  }

  const doc = { state, questions, ...(model ? { model } : {}) };

  if (opts.daemon) {
    const answered = await tryDaemon(config, doc);
    if (answered) {
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(`${JSON.stringify(answered)}\n`, (err) => (err ? reject(err) : resolve())),
      );
      return;
    }
  }

  const parsed = validateDoc(config, doc);
  const spec = getModelSpec(parsed.model ?? config.model);
  const loader = new RuntimeLoader(config, log);
  try {
    const request = toSystemOneRequest({ state: parsed.state, questions: parsed.questions, model: spec.id }, spec.id);
    const { runtime } = await loader.ensure(spec);
    const response = await runtime.decide(request);
    const output = fromSystemOneResponse(response, parsed.questions, spec.id);
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(`${JSON.stringify(output)}\n`, (err) => (err ? reject(err) : resolve())),
    );
  } finally {
    await loader.dispose();
  }
}

/** Try the local daemon; undefined means "not reachable, fall back to a cold run". */
async function tryDaemon(config: ReturnType<typeof loadConfig>, doc: unknown): Promise<Record<string, unknown> | undefined> {
  const result = await decideViaDaemon(daemonSocketPath(config.clefHome), doc);
  if (result === undefined) {
    process.stderr.write('clef-mcp decide: no daemon reachable; running a cold decision\n');
    return undefined;
  }
  if (result.error && typeof result.error === 'object') {
    const e = result.error as { code: string; message: string; hint?: string };
    throw new ClefError(e.code as ClefErrorCode, e.message, e.hint);
  }
  return result;
}

function validateDoc(config: ReturnType<typeof loadConfig>, doc: { state: unknown; questions: unknown; model?: string }) {
  let parsed: ClefDecideValidated;
  try {
    parsed = clefDecideInputSchema(config.limits).parse(doc);
  } catch (err) {
    // CLI callers (hooks, scripts) need the structured INVALID_INPUT code, not a raw ZodError.
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path?.length ? issue.path.join('.') : 'input';
      throw invalid(
        `${where}: ${issue?.message ?? 'invalid input'}`,
        'Fix the field the path names and retry. Shapes: state is a JSON value or string; questions map qid -> {type, instructions, criteria?}.',
      );
    }
    throw err;
  }
  validateStateSize(parsed.state, config.limits);
  return parsed;
}
