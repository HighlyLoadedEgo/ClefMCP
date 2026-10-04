import net from 'node:net';

/**
 * Send one newline-delimited request to the clef-mcp daemon and read the one
 * line answer. Resolves undefined if the socket never connects; rejects on
 * timeout or protocol garbage so the caller can fall back to a cold run.
 */
export function decideViaDaemon(socketPath: string, doc: unknown, timeoutMs = 120_000): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`daemon did not answer within ${timeoutMs} ms`));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    socket.once('connect', () => {
      socket.write(`${JSON.stringify(doc)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      finish(() => {
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch {
          reject(new Error('daemon returned a non-JSON answer'));
        }
      });
    });
    socket.once('error', (err) => {
      // ECONNREFUSED / ENOENT simply mean "no daemon"; anything after connect is real.
      if (settled) return;
      finish(() => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' || (err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve(undefined);
        } else {
          reject(err);
        }
      });
    });
  });
}
