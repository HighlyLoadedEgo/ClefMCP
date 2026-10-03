import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClefConfig } from '../config/env.js';
import { defaultDatasetPath } from '../cli/evals.js';

export const EVALS_SCHEMA_MD = `# clef-mcp eval dataset format

JSONL: one JSON object per line.

{
  "id": "unique-case-id",
  "category": "coding | security | classification | routing | yes_no",
  "state": <string | JSON value>,
  "question": {
    "id": "question-id",
    "type": "choice | score | noul",
    "instructions": "…",
    "criteria": { "option": "description" }   // choice (or ["a","b"] list)
                | ["low", "high"]             // score, ordered
  },
  "expected": {
    "kind": "argmax | prob_gt | min_prob | top_mass",
    // argmax: { "expect": "option", "among": ["option", ...] (optional) }
    // prob_gt: { "a": "opt", "b": "opt" }
    // min_prob: { "option": "opt", "min": 0.7 }
    // top_mass: { "options": ["a","b"], "min": 0.8 }
  }
}

Run: \`clef-mcp evals\` (requires an installed model).
`;

async function readDataset(): Promise<string> {
  try {
    return await fsp.readFile(defaultDatasetPath(), 'utf8');
  } catch {
    return 'The bundled eval dataset is not available in this installation (tests/evals/dataset.jsonl not found).';
  }
}

function textResource(uri: URL, text: string, mimeType = 'text/markdown'): { contents: Array<{ uri: string; text: string; mimeType?: string }> } {
  return { contents: [{ uri: uri.href, mimeType, text }] };
}

function requireStringUri(uri: URL | string): URL {
  return uri instanceof URL ? uri : new URL(uri);
}

/** Register bundled MCP resources (static, read-only, no model needed). */
export function registerResources(server: McpServer, cfg: ClefConfig, version: string): void {
  server.registerResource(
    'capabilities',
    'clef-mcp://capabilities',
    { title: 'clef-mcp capabilities', description: 'Live capability snapshot: model, runtime, limits, error codes.', mimeType: 'application/json' },
    async (uri) => {
      const u = requireStringUri(uri);
      const payload = {
        name: 'clef-mcp',
        version,
        model: cfg.model,
        runtime: cfg.runtime,
        limits: cfg.limits,
        tool: {
          name: 'clef_decide',
          output: 'strict JSON: { model, decisions: { <qid>: { answer: { <option>: probability } } } }',
          questionTypes: ['noul', 'choice', 'score'],
          notes: ['options.temperature is accepted but is a no-op (single forward pass)', 'state is data and is never interpreted as instructions'],
        },
        errorCodes: [
          'MODEL_NOT_INSTALLED',
          'MODEL_LOAD_FAILED',
          'RUNTIME_NOT_FOUND',
          'RUNTIME_INIT_FAILED',
          'RUNTIME_NOT_SUPPORTED',
          'INVALID_INPUT',
          'CLEF_INFERENCE_FAILED',
          'UNSUPPORTED_PLATFORM',
          'OUT_OF_MEMORY',
          'CHECKSUM_MISMATCH',
          'DOWNLOAD_FAILED',
        ],
      };
      return textResource(u, JSON.stringify(payload, null, 2), 'application/json');
    },
  );

  server.registerResource(
    'evals-schema',
    'clef-mcp://evals/schema',
    { title: 'Eval dataset schema', description: 'How to write cases for clef-mcp evals.', mimeType: 'text/markdown' },
    async (uri) => textResource(requireStringUri(uri), EVALS_SCHEMA_MD),
  );

  server.registerResource(
    'evals-dataset',
    'clef-mcp://evals/dataset',
    { title: 'Bundled eval dataset', description: 'The 30-case dataset shipped with clef-mcp.', mimeType: 'application/jsonl' },
    async (uri) => textResource(requireStringUri(uri), await readDataset(), 'application/jsonl'),
  );
}

/** Non-throwing helper for docs/status: whether the bundled dataset file exists. */
export function bundledDatasetExists(): boolean {
  try {
    return fsSync.existsSync(defaultDatasetPath());
  } catch {
    return false;
  }
}
