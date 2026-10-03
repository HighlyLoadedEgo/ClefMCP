import type { LogLevel } from './env.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export type LogSink = (line: string) => void;

function stderrSink(line: string): void {
  // stderr only: stdout is reserved for the MCP protocol on stdio transport.
  process.stderr.write(line + '\n');
}

export interface Logger {
  error(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  debug(msg: string, extra?: Record<string, unknown>): void;
}

export class StderrLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly sink: LogSink = stderrSink,
  ) {}

  private write(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[this.level]) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(extra ? { data: extra } : {}),
    };
    try {
      this.sink(JSON.stringify(entry));
    } catch {
      // Logging must never take the server down (e.g. circular extra data).
    }
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    this.write('error', msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this.write('warn', msg, extra);
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this.write('info', msg, extra);
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.write('debug', msg, extra);
  }
}

export function createLogger(level: LogLevel, sink?: LogSink): Logger {
  return new StderrLogger(level, sink);
}
