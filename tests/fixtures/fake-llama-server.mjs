#!/usr/bin/env node
/**
 * Fake `llama-server` for integration tests. Implements just enough of the
 * llama.cpp HTTP interface for clef-mcp:
 *
 *   GET  /health        → 200 {"status":"ok"} after a configurable delay
 *   POST /v1/systemone  → deterministic probability distributions
 *
 * Usage: fake-llama-server.mjs -m <model> --host <h> --port <p> [--health-delay-ms N]
 */
import http from 'node:http';

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const healthDelayMs = Number(argValue('--health-delay-ms') ?? 0);
const port = Number(argValue('--port') ?? 0);
const host = argValue('--host') ?? '127.0.0.1';
const modelPath = argValue('-m') ?? 'fake-model.gguf';
const failHealth = args.includes('--fail-health');

// Mimic llama-server's --version behavior: print and exit.
if (args.includes('--version') || args.includes('-V')) {
  process.stdout.write('fake-llama-server version b-test\n');
  process.exit(0);
}

function answerFor(question) {
  const criteria = question.criteria;
  if (question.type === 'noul') {
    // Mirrors the real llama.cpp /v1/systemone shape.
    return { type: 'noul', noul: 0.87 };
  }
  if (question.type === 'choice') {
    const keys = Object.keys(criteria ?? { a: 'a', b: 'b' });
    const probabilities = {};
    const w = 0.6;
    const rest = (1 - w) / Math.max(1, keys.length - 1);
    keys.forEach((k, i) => {
      probabilities[k] = i === 0 ? w : keys.length === 1 ? 1 : rest;
    });
    return { type: 'choice', probabilities, confidence: w };
  }
  // score: llama.cpp keys probabilities by option index and adds a legend.
  const list = Array.isArray(criteria) ? criteria : ['1', '2', '3'];
  const probabilities = {};
  const legend = {};
  const w = 0.5;
  const rest = (1 - w) / Math.max(1, list.length - 1);
  list.forEach((c, i) => {
    probabilities[String(i)] = i === 0 ? w : list.length === 1 ? 1 : rest;
    legend[String(i)] = c;
  });
  return { type: 'score', probabilities, legend, score: w, confidence: w };
}

const readyAt = Date.now() + healthDelayMs;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const ok = !failHealth && Date.now() >= readyAt;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'loading' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/systemone') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
        return;
      }
      if (request.overflow_probe) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'maximum context length exceeded' } }));
        return;
      }
      const answers = {};
      for (const [qid, question] of Object.entries(request.questions ?? {})) {
        answers[qid] = answerFor(question);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: request.model ?? 'clef-flash',
          answers,
          // Live llama.cpp /v1/systemone usage shape (verified end-to-end).
          usage: { input_tokens: 42, output_tokens: 0, latency_ms: 3 },
        }),
      );
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }));
});

server.listen(port, host, () => {
  process.stderr.write(`fake-llama-server listening on ${host}:${port} (model: ${modelPath})\n`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
