import path from 'node:path';

export interface ClefPaths {
  root: string;
  modelsDir: string;
  runtimeDir: string;
  configJson: string;
}

export function pathsFor(clefHome: string): ClefPaths {
  const root = path.resolve(clefHome);
  return {
    root,
    modelsDir: path.join(root, 'models'),
    runtimeDir: path.join(root, 'runtime'),
    configJson: path.join(root, 'config.json'),
  };
}

/** Directory label for a quantization, mirroring the documented cache layout (`models/clef-flash/4bit`). */
export function quantDirLabel(quant: string): string {
  switch (quant) {
    case 'Q4_K_M':
      return '4bit';
    case 'Q8_0':
      return '8bit';
    case 'BF16':
      return 'bf16';
    default:
      return quant.toLowerCase();
  }
}

export function modelQuantDir(modelsDir: string, model: string, quant: string): string {
  return path.join(modelsDir, model, quantDirLabel(quant));
}

export function manifestPathFor(modelsDir: string, model: string, quant: string): string {
  return path.join(modelQuantDir(modelsDir, model, quant), 'manifest.json');
}

/** Platform subfolder for managed llama.cpp binaries, e.g. `runtime/llama.cpp/darwin-arm64`. */
export function llamaRuntimeDir(runtimeDir: string, platform: string, arch: string): string {
  return path.join(runtimeDir, 'llama.cpp', `${platform}-${arch}`);
}

export function llamaServerName(platform: string): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}
