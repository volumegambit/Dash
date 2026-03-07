import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['apps/mission-control/**/*.test.{ts,tsx}', 'jsdom']],
    setupFiles: ['apps/mission-control/vitest.setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--experimental-require-module'],
      },
    },
  },
});
