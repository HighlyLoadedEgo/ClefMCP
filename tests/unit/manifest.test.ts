import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deepVerifyChecksum,
  readModelManifest,
  verifyModelFiles,
  writeModelManifest,
  type ModelManifest,
} from '../../src/models/manifest.js';
import { writeRuntimeManifest, readRuntimeManifest } from '../../src/models/manifest.js';

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clef-manifest-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function sampleManifest(modelPath: string, bytes: number, sha256?: string): ModelManifest {
  return {
    schemaVersion: 1,
    model: 'clef-flash',
    quant: 'Q4_K_M',
    file: 'model.gguf',
    modelPath,
    bytes,
    sha256,
    repo: 'ggml-org/Clef-Flash-GGUF',
    revision: '4a7a08c09bc63baf043b62b5ba89dd67a0357d95',
    licenseId: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Cloudflare/clef-flash',
    installedAt: new Date().toISOString(),
    clefMcpVersion: '0.1.0',
  };
}

describe('model manifest', () => {
  it('round-trips write/read', async () => {
    const manifestPath = path.join(dir, 'manifest.json');
    await writeModelManifest(manifestPath, sampleManifest(path.join(dir, 'model.gguf'), 10));
    const read = await readModelManifest(manifestPath);
    expect(read?.model).toBe('clef-flash');
    expect(read?.bytes).toBe(10);
  });

  it('returns undefined for missing or corrupt manifests', async () => {
    expect(await readModelManifest(path.join(dir, 'nope.json'))).toBeUndefined();
    await fsp.writeFile(path.join(dir, 'bad.json'), '{nope', 'utf8');
    expect(await readModelManifest(path.join(dir, 'bad.json'))).toBeUndefined();
  });

  it('verifyModelFiles detects size mismatch and missing files', async () => {
    const modelPath = path.join(dir, 'model.gguf');
    await fsp.writeFile(modelPath, Buffer.alloc(10, 1));
    const ok = await verifyModelFiles(sampleManifest(modelPath, 10));
    expect(ok.ok).toBe(true);

    const sizeMismatch = await verifyModelFiles(sampleManifest(modelPath, 11));
    expect(sizeMismatch.ok).toBe(false);
    expect(sizeMismatch.problems[0]).toMatch(/size mismatch/);

    const missing = await verifyModelFiles(sampleManifest(path.join(dir, 'gone.gguf'), 10));
    expect(missing.ok).toBe(false);
    expect(missing.problems[0]).toMatch(/missing/);
  });

  it('deepVerifyChecksum validates sha256', async () => {
    const modelPath = path.join(dir, 'model.gguf');
    const content = Buffer.from('clef model bytes');
    await fsp.writeFile(modelPath, content);
    const sha = createHash('sha256').update(content).digest('hex');

    const good = await deepVerifyChecksum(sampleManifest(modelPath, content.length, sha));
    expect(good.ok).toBe(true);

    const bad = await deepVerifyChecksum(sampleManifest(modelPath, content.length, '0'.repeat(64)));
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toMatch(/checksum mismatch/);

    const noSha = await deepVerifyChecksum(sampleManifest(modelPath, content.length));
    expect(noSha.ok).toBe(false);
    expect(noSha.problems[0]).toMatch(/no recorded sha256/);
  });
});

describe('runtime manifest', () => {
  it('round-trips and rejects junk', async () => {
    const manifestPath = path.join(dir, 'runtime-manifest.json');
    await writeRuntimeManifest(manifestPath, {
      schemaVersion: 1,
      kind: 'llama-cpp',
      releaseTag: 'b11378',
      asset: 'llama-b11378-bin-macos-arm64.tar.gz',
      bytes: 123,
      binaryPath: '/x/llama-server',
      installedAt: new Date().toISOString(),
    });
    const read = readRuntimeManifest(manifestPath);
    expect(read?.releaseTag).toBe('b11378');
    expect(readRuntimeManifest(path.join(dir, 'missing.json'))).toBeUndefined();
  });
});
