import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import type { SystemOneRequest, SystemOneResponse } from '../clef/systemone.js';
import type { Logger } from '../config/logger.js';
import type { ClefRuntime, RuntimeHealth } from './types.js';

export interface LlamaCppRuntimeOptions {
  serverBin: string;
  modelPath: string;
  alias?: string;
  host?: string;
  port?: number;
  /** Max wait for the server to report ready after spawn. */
  loadTimeoutMs?: number;
  /** Per-request timeout for /v1/systemone. */
  requestTimeoutMs?: number;
  log?: Logger;
}

const STDERR_TAIL_LIMIT = 4000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('could not acquire a free port'))));
    });
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const OOM_PATTERNS = [
  'out of memory',
  'failed to allocate',
  'unable to allocate',
  'not enough memory',
  'cannot allocate memory',
];

export class LlamaCppRuntime implements ClefRuntime {
  private proc?: ChildProcess;
  private resolvedPort?: number;
  private readonly host: string;
  private readonly loadTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  /** Serializes decide() calls: the llama.cpp clef path handles one sequence per batch. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: LlamaCppRuntimeOptions) {
    this.host = opts.host ?? '127.0.0.1';
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 120_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  }

  get endpoint(): string {
    if (!this.resolvedPort) throw new ClefError(ClefErrorCode.RUNTIME_INIT_FAILED, 'Runtime is not started');
    return `http://${this.host}:${this.resolvedPort}`;
  }

  get running(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null;
  }

  async load(): Promise<void> {
    if (this.running) return;
    const port = this.opts.port ?? (await freePort());
    this.resolvedPort = port;
    const args = [
      '-m',
      this.opts.modelPath,
      '--host',
      this.host,
      '--port',
      String(port),
      '--no-webui',
      ...(this.opts.alias ? ['--alias', this.opts.alias] : []),
    ];
    this.opts.log?.debug('spawning llama-server', { bin: this.opts.serverBin, args });

    let proc: ChildProcess;
    try {
      proc = spawn(this.opts.serverBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new ClefError(
        ClefErrorCode.RUNTIME_INIT_FAILED,
        `Failed to start llama-server: ${err instanceof Error ? err.message : String(err)}`,
        'Check that the runtime binary is executable, or run `clef-mcp doctor`.',
      );
    }
    this.proc = proc;

    let stderrTail = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      this.opts.log?.debug(text.trimEnd());
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.opts.log?.debug(chunk.toString().trimEnd());
    });

    let rejectOnExit: ((err: ClefError) => void) | undefined;
    const exitedBeforeReady = new Promise<never>((_resolve, reject) => {
      rejectOnExit = reject;
    });
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const oom = OOM_PATTERNS.some((p) => stderrTail.toLowerCase().includes(p));
      const message = `llama-server exited before becoming ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      const tail = stderrTail.trim();
      rejectOnExit?.(
        oom
          ? new ClefError(
              ClefErrorCode.OUT_OF_MEMORY,
              message,
              'Not enough free memory for this model. Try a smaller quantization (`clef-mcp install --quant Q4_K_M`).',
            )
          : new ClefError(
              ClefErrorCode.RUNTIME_INIT_FAILED,
              message + (tail ? `\nstderr tail:\n${tail}` : ''),
              'Run `clef-mcp doctor` for a full diagnosis.',
            ),
      );
    };
    proc.once('exit', onEarlyExit);

    try {
      await Promise.race([this.waitUntilReady(), exitedBeforeReady]);
    } finally {
      proc.removeListener('exit', onEarlyExit);
    }
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.loadTimeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      if (!this.running) throw new ClefError(ClefErrorCode.RUNTIME_INIT_FAILED, 'llama-server is not running');
      try {
        const res = await fetchWithTimeout(`${this.endpoint}/health`, { method: 'GET' }, 2_000);
        if (res.status === 200) return;
        lastError = `health status ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new ClefError(
      ClefErrorCode.MODEL_LOAD_FAILED,
      `llama-server did not become ready within ${Math.round(this.loadTimeoutMs / 1000)}s (last health check: ${lastError})`,
      'Large models can take minutes to load. Run `clef-mcp doctor` or try a smaller quantization.',
    );
  }

  async decide(input: SystemOneRequest): Promise<SystemOneResponse> {
    const run = this.queue.then(() => this.decideOnce(input));
    // Keep the chain alive even after failures.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async decideOnce(input: SystemOneRequest): Promise<SystemOneResponse> {
    if (!this.running) {
      throw new ClefError(ClefErrorCode.RUNTIME_INIT_FAILED, 'Runtime is not loaded; call load() first');
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.endpoint}/v1/systemone`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
        this.requestTimeoutMs,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ClefError(
        ClefErrorCode.CLEF_INFERENCE_FAILED,
        `Inference request failed: ${msg}`,
        msg.includes('abort') ? 'Request timed out. Reduce state size or increase the request timeout.' : undefined,
      );
    }

    const bodyText = await res.text();
    let body: unknown = undefined;
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      // Non-JSON body: fall through to the status-based error below.
    }

    if (!res.ok) {
      const apiMessage =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: { message?: unknown } }).error?.message ?? bodyText)
          : bodyText;
      if (res.status === 413) {
        throw new ClefError(
          ClefErrorCode.CLEF_INFERENCE_FAILED,
          `Input exceeds the model context window: ${apiMessage}`,
          'Reduce the state size or the number/size of questions.',
        );
      }
      throw new ClefError(
        ClefErrorCode.CLEF_INFERENCE_FAILED,
        `Inference failed with HTTP ${res.status}: ${apiMessage.slice(0, 2000)}`,
      );
    }

    if (!body || typeof body !== 'object') {
      throw new ClefError(
        ClefErrorCode.CLEF_INFERENCE_FAILED,
        `Runtime returned a non-JSON response (HTTP ${res.status})`,
        'The installed llama.cpp build may not support clef models. Run `clef-mcp doctor`.',
      );
    }
    return body as SystemOneResponse;
  }

  async health(): Promise<RuntimeHealth> {
    if (!this.running) return { status: 'unavailable', detail: 'not started' };
    try {
      const res = await fetchWithTimeout(`${this.endpoint}/health`, { method: 'GET' }, 1_500);
      if (res.status === 200) return { status: 'ready' };
      return { status: 'loading', detail: `health status ${res.status}` };
    } catch (err) {
      return { status: 'unavailable', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async unload(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    if (proc.exitCode !== null || proc.signalCode) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, 3_000);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }
}
