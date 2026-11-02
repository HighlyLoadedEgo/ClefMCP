import { ClefError, ClefErrorCode, errorJson } from '../clef/errors.js';
import type { ClefDecideInput } from '../clef/types.js';
import { fromSystemOneResponse, toSystemOneRequest } from '../clef/systemone.js';
import { loadConfig } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { getModelSpec } from '../models/registry.js';
import { clefDecideInputSchema, validateStateSize } from '../mcp/schema.js';
import { RuntimeLoader } from '../runtime/loader.js';
import { openInput, type InputSource } from '../classify/input.js';
import { openOutput, type OutputSession, type ClassificationResult } from '../classify/output.js';
import { evaluateClassification } from '../classify/policy.js';
import { invalid, loadProfile, profileDigest, profileState, selectRecord } from '../classify/profile.js';

export interface ClassifyOptions { profile: string; output?: string; format?: string; model?: string; resume?: boolean }

export async function runClassify(inputPath: string, options: ClassifyOptions): Promise<number> {
  const config = loadConfig();
  const profile = await loadProfile(options.profile, config.limits);
  const model = options.model ?? profile.model ?? config.model;
  const spec = getModelSpec(model);
  if (options.resume && (inputPath === '-' || !options.output)) throw invalid('--resume requires a regular input file and --output');
  const loader = new RuntimeLoader(config, createLogger(config.logLevel));
  let source: InputSource | undefined, output: OutputSession | undefined;
  let interrupted = false, total = 0;
  const counts = { classified: 0, needs_review: 0, errors: 0, skipped: 0 };
  const interrupt = () => {
    interrupted = true;
    // Unblock a pending read in this CLI process; owned files close in finally.
    if (inputPath === '-') process.stdin.destroy();
  };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    source = await openInput(inputPath, options.format, config.limits);
    if (interrupted) return 130;
    output = await openOutput({ path: options.output, resume: options.resume,
      protectedPaths: [inputPath, options.profile],
      metadata: { schema_version: 1, input_sha256: source.fingerprint ?? '', profile_sha256: profileDigest(profile), profile: profile.name, model, runtime: config.runtime, format: source.format },
    });
    await source.verifyUnchanged();
    const committed = output.completedRows;
    const commit = async (result: ClassificationResult) => {
      await source!.verifyUnchanged();
      await output!.append(result);
    };
    for await (const row of source.records()) {
      if (interrupted) break;
      total = row.row;
      if (row.row <= committed) { counts.skipped++; continue; }
      const rawId = profile.input?.id_field && row.record ? row.record[profile.input.id_field] : undefined;
      const base = { row: row.row, ...(typeof rawId === 'string' || typeof rawId === 'number' && Number.isFinite(rawId) ? { id: String(rawId) } : {}), profile: profile.name, model };
      let doc: ClefDecideInput | undefined;
      let rowError = row.error;
      if (!rowError) {
        try {
          const selected = selectRecord(profile, row.record!);
          doc = { model, state: profileState(profile, selected), questions: {
            classification: { type: 'choice', instructions: profile.instructions, criteria: profile.labels },
          } };
          clefDecideInputSchema(config.limits).parse(doc);
          validateStateSize(doc.state, config.limits);
        } catch (err) {
          rowError = errorJson(err instanceof ClefError ? err : invalid(err instanceof Error ? err.message : String(err))).error;
        }
      }
      if (rowError) {
        await commit({ ...base, status: 'error', label: null, error: rowError }); counts.errors++;
        continue;
      }
      const { runtime } = await loader.ensure(spec);
      if (interrupted) break;
      await source.verifyUnchanged();
      const response = await runtime.decide(toSystemOneRequest(doc!, model));
      const adapted = fromSystemOneResponse(response, doc!.questions, model);
      const result = evaluateClassification(profile, adapted.decisions.classification!);
      await commit({ ...base, ...result, ...(adapted.usage ? { usage: adapted.usage } : {}) });
      counts[result.status]++;
    }
    if (interrupted) return 130;
    await source.verifyUnchanged();
    await output.finish(total);
    return counts.errors ? 1 : 0;
  } catch (err) {
    if (interrupted) return 130;
    throw err;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    try { await loader.dispose(); }
    finally {
      try { await output?.close(); }
      finally {
        try { await source?.close(); }
        finally { process.stderr.write(`classification summary: ${JSON.stringify(counts)}${interrupted ? ' (interrupted)' : ''}\n`); }
      }
    }
  }
}
