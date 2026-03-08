import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Ensure tests in this worktree resolve @dash/mc and @dash/channels from
      // the worktree's own built dist (not the main-branch copy in the root node_modules).
      '@dash/mc': resolve(__dirname, 'packages/mc/dist/index.js'),
      '@dash/channels': resolve(__dirname, 'packages/channels/dist/index.js'),
    },
  },
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
