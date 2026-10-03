import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      cli: 'src/cli/index.ts',
      index: 'src/index.ts',
    },
    format: ['esm'],
    target: 'node20',
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    dts: { entry: 'src/index.ts' },
    splitting: false,
  },
]);
