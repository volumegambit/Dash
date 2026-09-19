import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Ensure tests resolve @dash/mc and @dash/channels from
      // the worktree's own built dist (not the main-branch copy in the root node_modules).
      '@dash/mc/provider-keys': resolve(__dirname, 'packages/mc/dist/runtime/provider-keys.js'),
      '@dash/mc/gateway-client': resolve(__dirname, 'packages/mc/dist/runtime/gateway-client.js'),
      '@dash/mc': resolve(__dirname, 'packages/mc/dist/index.js'),
      '@dash/channels': resolve(__dirname, 'packages/channels/dist/index.js'),
      // Without this, a worktree (which has no node_modules of its own) resolves
      // @dash/agent up to the main checkout's built dist, so gateway tests run
      // against the main branch's agent code rather than the branch's own.
      '@dash/agent': resolve(__dirname, 'packages/agent/src/index.ts'),
      '@dash/speech': resolve(__dirname, 'packages/speech/src/index.ts'),
      '@dash/management': resolve(__dirname, 'packages/management/src/index.ts'),
      '@dash/projects': resolve(__dirname, 'packages/projects/src/index.ts'),
      '@dash/plugin-sdk': resolve(__dirname, 'packages/plugin-sdk/src/index.ts'),
      '@dash/plugins': resolve(__dirname, 'packages/plugins/src/index.ts'),
    },
  },
  test: {
    globals: true,
    clearMocks: true,
    include: [
      'contracts/*/*/src/**/*.test.ts',
      'ios/scripts/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.{ts,tsx}',
      'scripts/**/*.test.ts',
    ],
    environmentMatchGlobs: [
      ['apps/mission-control/**/*.test.{ts,tsx}', 'jsdom'],
      // apps/web's own vitest.config.ts uses happy-dom for its React
      // component tests (Shell, GatewayPicker, AppRoot, App) — match that
      // here so the root `npm test` run doesn't execute them under the
      // default `node` environment, where `render()` fails with
      // "document is not defined".
      ['apps/web/**/*.test.{ts,tsx}', 'happy-dom'],
    ],
    setupFiles: ['apps/mission-control/vitest.setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--experimental-require-module'],
      },
    },
  },
});
