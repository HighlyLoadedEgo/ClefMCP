import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ClefError, ClefErrorCode, errorJson } from '../clef/errors.js';
import { fromSystemOneResponse, toSystemOneRequest } from '../clef/systemone.js';
import type { ClefConfig } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import { getModelSpec } from '../models/registry.js';
import { clefDecideInputSchema, validateStateSize } from '../mcp/schema.js';
import { RuntimeLoader } from '../runtime/loader.js';

export function daemonSocketPath(clefHome: string): string {
  return path.join(clefHome, 'daemon.sock');
}

export interface RunningDaemon {
  /** Resolves once the socket is listening. */
  ready: Promise<void>;
  close(): Promise<void>;
}

interface DaemonRequest {
  ping?: boolean;
  state?: unknown;
  questions?: unknown;
  model?: unknown;
}

/**
 * Serialize inference: the model is a serial GPU resource, so requests are
 * answered strictly one at a time in arrival order.
 */
function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Long-lived local daemon: keeps the model warm and answers newline-delimited
 * JSON requests on a 0600 unix socket inside CLEF_HOME. Protocol per line:
 *   -> {state, questions, model?} | {ping: true}
 *   <- {model, decisions, usage?} | {error: {code, message, hint?}}
 * Nothing is downloaded and no TCP port is opened; the socket file's own
 * permissions (default umask) are the access control.
 */
export function startDaemon(config: ClefConfig, log: Logger): RunningDaemon {
  const socketPath = daemonSocketPath(config.clefHome);
  const loader = new RuntimeLoader(config, log);
  const enqueue = createQueue();
  let lastUsedAt = Date.now();
  let closed = false;

  const ready = (async () => {
    await fsp.mkdir(config.clefHome, { recursive: true });
    // A leftover socket file from a crashed daemon must not wedge startup:
    // if something alive answers on it, refuse; otherwise remove and rebind.
    const live = await new Promise<boolean>((resolve) => {
      const probe = net.connect(socketPath);
      // A successful connect means a listener exists — the daemon protocol is
      // silent until a request is sent, so we must not wait for data.
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (live) {
      throw new ClefError(
        ClefErrorCode.RUNTIME_INIT_FAILED,
        `Another clef-mcp daemon is already listening on ${socketPath}.`,
        'Stop it (kill $(cat the daemon pid)) or remove CLEF_DAEMON_IDLE-stale sockets and retry.',
      );
    }
    await fsp.rm(socketPath, { force: true });

    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          handleLine(line, socket).catch((err) => {
            log.error('daemon request failed', errorJson(err).error);
            writeLine(socket, errorJson(err));
          });
        }
      });
    });

    server.listen(socketPath);
    log.info('clef-mcp daemon listening', { socket: socketPath });

    const idleMs = config.daemonIdleSeconds * 1000;
    const idleTimer = config.daemonIdleSeconds > 0
      ? setInterval(() => {
          if (closed || Date.now() - lastUsedAt < idleMs) return;
          void loader.dispose().then(() => log.info('daemon idle, model unloaded'));
        }, Math.min(idleMs, 60_000))
      : undefined;
    if (idleTimer) idleTimer.unref();

    const shutdown = () => {
      closed = true;
      if (idleTimer) clearInterval(idleTimer);
      void (async () => {
        server.close();
        await fsp.rm(socketPath, { force: true });
        await loader.dispose();
        log.info('clef-mcp daemon stopped');
      })().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  })();

  async function handleLine(line: string, socket: net.Socket): Promise<void> {
    let request: DaemonRequest;
    try {
      request = JSON.parse(line) as DaemonRequest;
    } catch (err) {
      writeLine(socket, errorJson(new ClefError(ClefErrorCode.INVALID_INPUT, `request is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)));
      return;
    }
    if (request.ping) {
      writeLine(socket, { pong: true, model: config.model });
      return;
    }
    lastUsedAt = Date.now();
    const result = await enqueue(() => decideOnce(request));
    writeLine(socket, result);
  }

  async function decideOnce(request: DaemonRequest): Promise<Record<string, unknown>> {
    let parsed: ReturnType<typeof clefDecideInputSchema>;
    try {
      parsed = clefDecideInputSchema(config.limits).parse({ state: request.state, questions: request.questions, ...(typeof request.model === 'string' ? { model: request.model } : {}) });
    } catch (err) {
      if (err instanceof ClefError) throw err;
      const issue = (err as { issues?: Array<{ path?: Array<string | number>; message: string }> }).issues?.[0];
      const where = issue?.path?.length ? issue.path.join('.') : 'input';
      throw new ClefError(ClefErrorCode.INVALID_INPUT, `${where}: ${issue?.message ?? 'invalid input'}`);
    }
    validateStateSize(parsed.state, config.limits);
    const spec = getModelSpec(parsed.model ?? config.model);
    const { runtime } = await loader.ensure(spec);
    const response = await runtime.decide(toSystemOneRequest({ state: parsed.state, questions: parsed.questions, model: spec.id }, spec.id));
    return fromSystemOneResponse(response, parsed.questions, spec.id) as unknown as Record<string, unknown>;
  }

  return {
    ready,
    close: async () => {
      closed = true;
      await loader.dispose();
      await fsp.rm(socketPath, { force: true });
    },
  };
}

function writeLine(socket: net.Socket, payload: unknown): void {
  socket.write(`${JSON.stringify(payload)}\n`);
}
