import { ClefError, ClefErrorCode } from '../clef/errors.js';
import { loadConfig } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import { createLogger } from '../config/logger.js';
import { ensureLlamaRuntime } from '../models/llama-install.js';
import { installModel } from '../models/hf.js';
import { detectPlatform, formatBytes } from '../models/platform.js';
import { getModelSpec, pickQuant } from '../models/registry.js';
import { probeInference } from '../runtime/probe.js';
import { confirm } from './prompt.js';
import { VERSION } from '../version.js';

export interface InstallOptions {
  model?: string;
  quant?: string;
  yes?: boolean;
  skipRuntime?: boolean;
  skipProbe?: boolean;
  setup?: boolean;
}

const OS_NAMES: Record<string, string> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

function prettyOs(platform: string): string {
  return OS_NAMES[platform] ?? platform;
}

function printProgress(downloaded: number, total?: number): void {
  const dl = formatBytes(downloaded);
  const line = total ? `  Downloading... ${dl} / ${formatBytes(total)}` : `  Downloading... ${dl}`;
  process.stderr.write(`\r${line.padEnd(48)}`);
}

function printHeader(): void {
  console.log();
}

export async function runInstall(opts: InstallOptions): Promise<void> {
  const config = loadConfig();
  const log: Logger = createLogger('info');

  printHeader();
  process.stdout.write('Detecting hardware...\n');
  const info = await detectPlatform();

  const modelId = opts.model ?? config.model;
  const spec = getModelSpec(modelId);
  const quant = pickQuant(spec, info.totalMemBytes, opts.quant);

  const gpuLine = info.gpu?.name ? `  GPU: ${info.gpu.name}${info.gpu.vramBytes ? ` (${formatBytes(info.gpu.vramBytes)})` : ''}` : undefined;
  console.log('\nDetected:');
  console.log(`  OS: ${prettyOs(info.platform)}`);
  console.log(`  Architecture: ${info.arch}`);
  console.log(`  Memory: ${formatBytes(info.totalMemBytes)}`);
  if (gpuLine) console.log(gpuLine);

  console.log('\nRecommended:');
  console.log(`  Model: ${spec.id} (${spec.repo})`);
  console.log(`  Quantization: ${quant.id}`);
  console.log(`  Download size: ~${formatBytes(quant.bytes)}`);
  console.log(`\nModel license: ${spec.licenseId} — ${spec.licenseUrl}`);
  console.log('The model is downloaded from the official GGUF conversion and is not repackaged by clef-mcp.\n');

  const ok = await confirm('Continue?', opts.yes === true);
  if (!ok) {
    console.log('Aborted. Nothing was downloaded.');
    return;
  }

  let runtime;
  if (!opts.skipRuntime) {
    process.stdout.write('\nEnsuring llama.cpp runtime...\n');
    runtime = await ensureLlamaRuntime(config, log);
    console.log(`  Runtime: llama.cpp (${runtime.source}, ${runtime.releaseTag})`);
    console.log(`  Binary: ${runtime.path}`);
  }

  console.log('');
  const { manifest, alreadyInstalled } = await installModel({
    clefHome: config.clefHome,
    modelSpec: spec,
    quantSpec: quant,
    clefMcpVersion: VERSION,
    onProgress: (p) => printProgress(p.bytes, p.total),
    log,
  });
  process.stderr.write('\n');
  console.log(alreadyInstalled ? `  Model already installed: ${manifest.modelPath}` : `  Installed: ${manifest.modelPath}`);
  console.log(`  sha256: ${manifest.sha256 ?? 'n/a (not advertised upstream)'}`);

  if (!opts.skipProbe) {
    process.stdout.write('\nVerifying inference (loads the model; first run can take a few minutes)...\n');
    const probe = await probeInference(config, manifest, log);
    console.log(`  Inference OK (${(probe.latencyMs / 1000).toFixed(1)}s incl. model load, via ${probe.binarySource} binary)`);
  }

  if (opts.setup) {
    const { runSetup } = await import('./setup.js');
    console.log('');
    await runSetup({ yes: opts.yes });
    return;
  }

  console.log('\nDone. Start the MCP server with:\n\n  clef-mcp\n');
  console.log('Register it with your agents (or run `clef-mcp setup` to do it automatically):\n');
  console.log('  Claude Code : claude mcp add clef-mcp -- clef-mcp');
  console.log('  Codex       : add [mcp_servers.clef-mcp] to ~/.codex/config.toml (see README)');
  console.log('  Cursor      : add clef-mcp to .cursor/mcp.json (see README)');
  console.log('  ZCode       : add clef-mcp to ~/.zcode/cli/config.json (see README)\n');
}
