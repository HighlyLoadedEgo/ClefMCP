import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests spawn dist/cli.js, which is produced by `npm run build`
    // (the `test` npm script builds first). Keep the default timeout generous
    // because spawning llama-server fakes and MCP stdio round-trips take time.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
