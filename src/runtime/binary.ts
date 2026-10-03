import fs from 'node:fs';
import path from 'node:path';
import { ClefError, ClefErrorCode } from '../clef/errors.js';
import type { ClefConfig } from '../config/env.js';
import { llamaRuntimeDir, llamaServerName, pathsFor } from '../config/paths.js';
import { readRuntimeManifest } from '../models/manifest.js';

export interface ResolvedBinary {
  source: 'env' | 'managed' | 'path';
  path: string;
}

export interface BinaryResolveDeps {
  existsExecutable?(p: string): boolean;
  which?(name: string): string | undefined;
  platform?: string;
  arch?: string;
}

function existsExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function whichBin(name: string, platform: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? (process.env.PATHEXT ?? '.exe').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (existsExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function managedBinary(clefHome: string, platform: string, arch: string, exists: (p: string) => boolean): string | undefined {
  const platformDir = llamaRuntimeDir(pathsFor(clefHome).runtimeDir, platform, arch);
  // Preferred: the runtime manifest records the real binary path inside the
  // extracted release layout (required on macOS: @rpath dylibs are siblings).
  const manifest = readRuntimeManifest(path.join(platformDir, 'runtime-manifest.json'));
  if (manifest && exists(manifest.binaryPath)) return manifest.binaryPath;
  // Legacy/symlinked layout: llama-server directly in the platform dir.
  const legacy = path.join(platformDir, llamaServerName(platform));
  if (exists(legacy)) return legacy;
  return undefined;
}

/**
 * Resolution order: CLEF_LLAMA_BIN → managed binary under CLEF_HOME → `llama-server` on PATH.
 * Managed wins over PATH because a user's PATH binary may predate clef support.
 */
export function resolveLlamaServerBinary(cfg: ClefConfig, deps: BinaryResolveDeps = {}): ResolvedBinary {
  const exists = deps.existsExecutable ?? existsExecutable;
  const which = deps.which ?? ((name: string) => whichBin(name, deps.platform ?? process.platform));
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  if (cfg.llamaBin) {
    if (!exists(cfg.llamaBin)) {
      throw new ClefError(
        ClefErrorCode.RUNTIME_NOT_FOUND,
        `CLEF_LLAMA_BIN points to a missing or non-executable file: ${cfg.llamaBin}`,
      );
    }
    return { source: 'env', path: cfg.llamaBin };
  }

  const managed = managedBinary(cfg.clefHome, platform, arch, exists);
  if (managed) return { source: 'managed', path: managed };

  const onPath = which('llama-server');
  if (onPath) return { source: 'path', path: onPath };

  throw new ClefError(
    ClefErrorCode.RUNTIME_NOT_FOUND,
    'No llama-server binary found.',
    'Install llama.cpp with clef support (`brew install llama.cpp`, or `curl -LsSf https://llama.app/install.sh | sh`), or run `clef-mcp install` to download a managed runtime.',
  );
}
