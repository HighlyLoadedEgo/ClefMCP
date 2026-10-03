import { execFile } from 'node:child_process';
import os from 'node:os';
import { ClefError, ClefErrorCode } from '../clef/errors.js';

export interface GpuInfo {
  name?: string;
  vramBytes?: number;
}

export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  totalMemBytes: number;
  gpu?: GpuInfo;
}

function exec(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function parseSizeToBytes(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/^([\d.]+)\s*(GB|MB|GiB|MiB|B)?$/i);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? 'B').toLowerCase();
  const mult = unit === 'gb' || unit === 'gib' ? 1024 ** 3 : unit === 'mb' || unit === 'mib' ? 1024 ** 2 : 1;
  return Math.round(n * mult);
}

async function gpuInfoDarwin(): Promise<GpuInfo | undefined> {
  try {
    const out = await exec('system_profiler', ['SPDisplaysDataType', '-json'], 10_000);
    const parsed = JSON.parse(out) as {
      SPDisplaysDataType?: Array<Record<string, unknown>>;
    };
    const gpu = parsed.SPDisplaysDataType?.[0];
    if (!gpu) return undefined;
    const info: GpuInfo = { name: typeof gpu.sppci_model === 'string' ? gpu.sppci_model : undefined };
    for (const key of ['spdisplays_vram_shared', 'spdisplays_vram']) {
      const bytes = parseSizeToBytes(typeof gpu[key] === 'string' ? (gpu[key] as string) : undefined);
      if (bytes) {
        info.vramBytes = bytes;
        break;
      }
    }
    return info;
  } catch {
    return undefined;
  }
}

async function gpuInfoLinux(): Promise<GpuInfo | undefined> {
  try {
    const out = await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], 5_000);
    const [name, mib] = out.trim().split(',').map((s) => s.trim());
    if (name && mib) return { name, vramBytes: Number.parseFloat(mib) * 1024 ** 2 };
    return undefined;
  } catch {
    return undefined;
  }
}

export async function detectPlatform(): Promise<PlatformInfo> {
  const platform = process.platform;
  const info: PlatformInfo = {
    platform,
    arch: process.arch,
    totalMemBytes: os.totalmem(),
  };
  if (platform === 'darwin') info.gpu = await gpuInfoDarwin();
  else if (platform === 'linux') info.gpu = await gpuInfoLinux();
  return info;
}

/** llama.cpp clef builds ship for these platforms; anything else is rejected early. */
export function assertSupportedPlatform(info: Pick<PlatformInfo, 'platform' | 'arch'>): void {
  const ok =
    (info.platform === 'darwin' && (info.arch === 'arm64' || info.arch === 'x64')) ||
    (info.platform === 'linux' && (info.arch === 'x64' || info.arch === 'arm64')) ||
    (info.platform === 'win32' && info.arch === 'x64');
  if (!ok) {
    throw new ClefError(
      ClefErrorCode.UNSUPPORTED_PLATFORM,
      `Unsupported platform: ${info.platform}/${info.arch}`,
      'clef-mcp v0.1 supports macOS (arm64/x64), Linux (x64/arm64) and Windows x64.',
    );
  }
}

export function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
