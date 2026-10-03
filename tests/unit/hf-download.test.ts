import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClefError, ClefErrorCode } from '../../src/clef/errors.js';
import { downloadFile, fetchFileInfo, installModel } from '../../src/models/hf.js';
import { readModelManifest } from '../../src/models/manifest.js';
import { CLEF_FLASH } from '../../src/models/registry.js';

const SHA = createHash('sha256').update('hello world').digest('hex');
const REAL_FETCH = globalThis.fetch;

function fetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init),
  );
  globalThis.fetch = mock as typeof fetch;
  return mock;
}

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clef-hf-'));
});

describe('fetchFileInfo', () => {
  it('reads sha256/size from the 302 metadata response', async () => {
    fetchMock(() =>
      new Response(null, {
        status: 302,
        headers: {
          location: 'https://cdn.example.com/model.gguf',
          'x-linked-etag': `"${SHA}"`,
          'x-linked-size': '11',
        },
      }),
    );
    const info = await fetchFileInfo('ggml-org/Clef-Flash-GGUF', 'rev', 'Clef-Flash-Q4_K_M.gguf');
    expect(info.sha256).toBe(SHA);
    expect(info.size).toBe(11);
    expect(info.downloadUrl).toBe('https://cdn.example.com/model.gguf');
  });

  it('fails with DOWNLOAD_FAILED on unexpected statuses', async () => {
    fetchMock(() => new Response(null, { status: 500 }));
    await expect(fetchFileInfo('r', 'rev', 'f')).rejects.toMatchObject({ code: ClefErrorCode.DOWNLOAD_FAILED });
  });
});

describe('downloadFile', () => {
  it('streams, hashes and writes the file', async () => {
    fetchMock(() => new Response('hello world', { status: 200 }));
    const dest = path.join(dir, 'model.gguf');
    const result = await downloadFile('https://cdn.example.com/model.gguf', dest, { expectedSha256: SHA });
    expect(result.bytes).toBe(11);
    expect(result.sha256).toBe(SHA);
    expect(await fsp.readFile(dest, 'utf8')).toBe('hello world');
  });

  it('discards the file and throws CHECKSUM_MISMATCH on a bad hash', async () => {
    fetchMock(() => new Response('tampered!', { status: 200 }));
    const dest = path.join(dir, 'model.gguf');
    await expect(
      downloadFile('https://cdn.example.com/model.gguf', dest, { expectedSha256: SHA, attempts: 1 }),
    ).rejects.toMatchObject({ code: ClefErrorCode.CHECKSUM_MISMATCH });
    await expect(fsp.access(dest)).rejects.toThrow();
  });

  it('retries transient HTTP failures and succeeds', async () => {
    const mock = fetchMock(() => new Response('hello world', { status: 200 }));
    mock.mockImplementationOnce(async () => new Response(null, { status: 500 }));
    const dest = path.join(dir, 'model.gguf');
    const result = await downloadFile('https://cdn.example.com/model.gguf', dest, { expectedSha256: SHA, attempts: 2 });
    expect(result.bytes).toBe(11);
  });
});

describe('installModel', () => {
  it('downloads, verifies and writes a manifest', async () => {
    fetchMock((_url, init) => {
      if (init?.redirect === 'manual') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/model.gguf', 'x-linked-etag': `"${SHA}"`, 'x-linked-size': '11' },
        });
      }
      return new Response('hello world', { status: 200 });
    });
    const quant = CLEF_FLASH.quants[0]!;
    const result = await installModel({
      clefHome: dir,
      modelSpec: CLEF_FLASH,
      quantSpec: quant,
      clefMcpVersion: '0.1.0',
    });
    expect(result.alreadyInstalled).toBe(false);
    expect(result.manifest.sha256).toBe(SHA);
    expect(result.manifest.modelPath).toContain(quant.file);
    await expect(fsp.readFile(result.manifest.modelPath, 'utf8')).resolves.toBe('hello world');
    const manifest = await readModelManifest(
      path.join(dir, 'models', 'clef-flash', quant.dirLabel, 'manifest.json'),
    );
    expect(manifest?.bytes).toBe(11);
  });

  it('is a no-op when a valid install already exists', async () => {
    fetchMock((_url, init) => {
      if (init?.redirect === 'manual') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/model.gguf', 'x-linked-etag': `"${SHA}"`, 'x-linked-size': '11' },
        });
      }
      return new Response('hello world', { status: 200 });
    });
    const quant = CLEF_FLASH.quants[0]!;
    await installModel({ clefHome: dir, modelSpec: CLEF_FLASH, quantSpec: quant, clefMcpVersion: '0.1.0' });
    const second = await installModel({ clefHome: dir, modelSpec: CLEF_FLASH, quantSpec: quant, clefMcpVersion: '0.1.0' });
    expect(second.alreadyInstalled).toBe(true);
  });

  it('fails with CHECKSUM_MISMATCH when upstream hash changes mid-download', async () => {
    fetchMock((_url, init) => {
      if (init?.redirect === 'manual') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/model.gguf', 'x-linked-etag': `"${'a'.repeat(64)}"`, 'x-linked-size': '11' },
        });
      }
      return new Response('hello world', { status: 200 });
    });
    await expect(
      installModel({ clefHome: dir, modelSpec: CLEF_FLASH, quantSpec: CLEF_FLASH.quants[0]!, clefMcpVersion: '0.1.0' }),
    ).rejects.toMatchObject({ code: ClefErrorCode.CHECKSUM_MISMATCH });
  });
});
