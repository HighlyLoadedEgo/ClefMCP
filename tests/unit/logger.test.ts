import { describe, expect, it } from 'vitest';
import { StderrLogger } from '../../src/config/logger.js';

function captureLogger(level: 'error' | 'warn' | 'info' | 'debug') {
  const lines: string[] = [];
  const logger = new StderrLogger(level, (line) => lines.push(line));
  return { logger, lines };
}

describe('StderrLogger', () => {
  it('emits JSON lines with ts/level/msg', () => {
    const { logger, lines } = captureLogger('debug');
    logger.info('hello', { key: 'value' });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.data).toEqual({ key: 'value' });
    expect(typeof parsed.ts).toBe('string');
  });

  it('filters below the configured level', () => {
    const { logger, lines } = captureLogger('error');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('e');
  });

  it('keeps the sink alive when extra data is circular', () => {
    const { logger, lines } = captureLogger('debug');
    const extra: Record<string, unknown> = {};
    extra.self = extra;
    logger.error('boom', extra);
    expect(lines).toHaveLength(0);
  });
});
