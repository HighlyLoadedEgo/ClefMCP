import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import { fromSystemOneResponse, toSystemOneRequest } from '../clef/systemone.js';
import type { ClefQuestion } from '../clef/types.js';
import { loadConfig } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { findInstalledManifest } from '../models/manifest.js';
import { mlxIsInstalled, resolveUv } from '../models/mlx-install.js';
import { getModelSpec } from '../models/registry.js';
import { resolveLlamaServerBinary } from '../runtime/binary.js';
import { LlamaCppRuntime } from '../runtime/llama-cpp.js';
import { MlxRuntime } from '../runtime/mlx.js';

export interface EvalsOptions {
  dataset?: string;
  limit?: number;
  minRate?: number;
}

type Expected =
  | { kind: 'argmax'; expect: string; among?: string[] }
  | { kind: 'prob_gt'; a: string; b: string }
  | { kind: 'min_prob'; option: string; min: number }
  | { kind: 'top_mass'; options: string[]; min: number };

interface EvalCase {
  id: string;
  category: string;
  state: unknown;
  question: ClefQuestion & { id: string };
  expected: Expected;
}

export function defaultDatasetPath(): string {
  // Works from dist/ (packaged layout: <root>/dist/cli.js + <root>/tests/evals)
  // and from src/ under vitest. Walk up until the dataset is found.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'tests', 'evals', 'dataset.jsonl');
    if (fsSync.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return fileURLToPath(new URL('../tests/evals/dataset.jsonl', import.meta.url));
}

function parseLine(line: string, lineNo: number): EvalCase {
  const raw = JSON.parse(line) as EvalCase;
  if (typeof raw.id !== 'string' || !raw.question?.id || !raw.expected?.kind) {
    throw new ClefError(ClefErrorCode.INVALID_INPUT, `Eval dataset line ${lineNo} is missing id/question/expected`);
  }
  return raw;
}

function evaluate(answer: Record<string, number>, exp: Expected): { pass: boolean; detail: string } {
  const prob = (key: string): number => answer[key] ?? 0;
  switch (exp.kind) {
    case 'argmax': {
      const keys = exp.among ?? Object.keys(answer);
      let best = '';
      let bestP = -1;
      for (const k of keys) {
        if (prob(k) > bestP) {
          bestP = prob(k);
          best = k;
        }
      }
      return { pass: best === exp.expect, detail: `argmax=${best || 'n/a'} (${bestP.toFixed(3)}), expected=${exp.expect}` };
    }
    case 'prob_gt':
      return { pass: prob(exp.a) > prob(exp.b), detail: `p(${exp.a})=${prob(exp.a).toFixed(3)} vs p(${exp.b})=${prob(exp.b).toFixed(3)}` };
    case 'min_prob': {
      const p = prob(exp.option);
      return { pass: p >= exp.min, detail: `p(${exp.option})=${p.toFixed(3)}, required >= ${exp.min}` };
    }
    case 'top_mass': {
      const mass = exp.options.reduce((sum, k) => sum + prob(k), 0);
      return { pass: mass >= exp.min, detail: `mass(${exp.options.join('+')})=${mass.toFixed(3)}, required >= ${exp.min}` };
    }
  }
}

export async function runEvals(opts: EvalsOptions): Promise<boolean> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const spec = getModelSpec(config.model);
  let mlxManifest;
  if (config.runtime === 'mlx') {
    mlxManifest = await mlxIsInstalled(config.clefHome);
    if (!mlxManifest) {
      throw new ClefError(
        ClefErrorCode.MODEL_NOT_INSTALLED,
        `Model "${spec.id}" is not installed for the MLX runtime.`,
        'Run `clef-mcp install --runtime mlx` first.',
      );
    }
  }
  const manifest = config.runtime === 'mlx' ? undefined : await findInstalledManifest(config.clefHome, spec);
  if (!manifest && !mlxManifest) {
    throw new ClefError(
      ClefErrorCode.MODEL_NOT_INSTALLED,
      `Model "${spec.id}" is not installed; evals need the local model.`,
      'Run `clef-mcp install` first.',
    );
  }

  const datasetPath = opts.dataset ?? defaultDatasetPath();
  const content = await fsp.readFile(datasetPath, 'utf8');
  let cases = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l, i) => parseLine(l, i + 1));
  if (opts.limit && opts.limit > 0) cases = cases.slice(0, opts.limit);
  if (cases.length === 0) {
    throw new ClefError(ClefErrorCode.INVALID_INPUT, `No eval cases found in ${datasetPath}`);
  }

  const binary = resolveLlamaServerBinary(config);
  const runtime =
    config.runtime === 'mlx'
      ? new MlxRuntime({ uvBin: resolveUv(process.env.CLEF_MLX_UV), snapshotPath: mlxManifest!.snapshotPath, log })
      : new LlamaCppRuntime({ serverBin: binary.path, modelPath: manifest!.modelPath, alias: spec.id, log });
  const runtimeLabel = config.runtime === 'mlx' ? 'MLX' : manifest!.quant;
  console.log(`Running ${cases.length} eval case(s) with ${spec.id} ${runtimeLabel}...\n`);
  await runtime.load();

  let passed = 0;
  const results: Array<{ id: string; category: string; ok: boolean; detail: string }> = [];
  try {
    for (const [i, c] of cases.entries()) {
      process.stderr.write(`\r  case ${i + 1}/${cases.length} — ${c.id}`);
      try {
        const request = toSystemOneRequest({ state: c.state, questions: { [c.question.id]: c.question } }, spec.id);
        const response = await runtime.decide(request);
        const output = fromSystemOneResponse(response, { [c.question.id]: c.question }, spec.id);
        const answer = output.decisions[c.question.id]?.answer ?? {};
        const verdict = evaluate(answer, c.expected);
        if (verdict.pass) passed++;
        results.push({ id: c.id, category: c.category, ok: verdict.pass, detail: verdict.detail });
      } catch (err) {
        results.push({
          id: c.id,
          category: c.category,
          ok: false,
          detail: `error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } finally {
    process.stderr.write('\n');
    await runtime.unload();
  }

  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? '✔' : '✘'}  [${r.category}] ${r.id} — ${r.detail}`);
  }
  const rate = passed / results.length;
  const minRate = opts.minRate ?? 0.8;
  console.log(`\n${passed}/${results.length} passed (${(rate * 100).toFixed(1)}%), required >= ${(minRate * 100).toFixed(0)}%`);
  return rate >= minRate;
}
