import { loadConfig } from '../config/env.js';
import { pathsFor } from '../config/paths.js';
import { quantIsInstalled } from '../models/manifest.js';
import { formatBytes } from '../models/platform.js';
import { MODELS } from '../models/registry.js';

export async function runModels(): Promise<void> {
  const config = loadConfig();
  const { modelsDir } = pathsFor(config.clefHome);
  console.log(`Cache home: ${pathsFor(config.clefHome).root}\n`);
  for (const spec of Object.values(MODELS)) {
    console.log(`${spec.id}  (${spec.repo}, ${spec.licenseId})`);
    for (const quant of spec.quants) {
      const installed = await quantIsInstalled(config.clefHome, spec, quant);
      const defaultMark = quant.id === spec.defaultQuant ? ' [default]' : '';
      console.log(`  ${quant.id.padEnd(8)} ~${formatBytes(quant.bytes).padStart(8)}  ${installed ? 'installed' : 'not installed'}${defaultMark}`);
    }
    console.log();
  }
}
