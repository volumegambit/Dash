import { builtinModules } from 'node:module';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

function debugResolve(): Plugin {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  return {
    name: 'debug-resolve',
    enforce: 'pre',
    configResolved(config) {
      console.log('SSR enabled:', config.build.ssr);
      // biome-ignore lint/suspicious/noExplicitAny: vite SSR config type doesn't expose noExternal publicly
      console.log('SSR noExternal:', (config.ssr as any)?.noExternal);
      // biome-ignore lint/suspicious/noExplicitAny: rollupOptions.external not typed in electron-vite config
      const ext = (config.build.rollupOptions as any)?.external;
      if (Array.isArray(ext)) {
        console.log(
          'Rollup external count:',
          ext.length,
          'includes path:',
          ext.includes('path'),
          'includes node:path:',
          ext.includes('node:path'),
        );
      }
    },
    resolveId(source, importer) {
      if (builtins.has(source)) {
        console.log(`resolveId: "${source}" from "${importer?.split('/').slice(-3).join('/')}"`);
      }
      return null;
    },
  };
}

export default defineConfig({
  main: {
    // ws is excluded from externalization (bundled) because @google/genai does
    // `import * as NodeWs from 'ws'`. When ws is external (CJS), Vite's
    // _interopNamespaceDefault helper crashes on EventEmitter's inherited
    // prototype properties. Bundling ws resolves the namespace import at build
    // time and avoids the CJS interop entirely.
    plugins: [
      externalizeDepsPlugin({ exclude: ['@dash/mc', '@dash/management', 'ws'] }),
      debugResolve(),
    ],
    build: {
      rollupOptions: {
        // @dash/channels is dynamically imported for WhatsApp pairing.
        // It must be externalized so Baileys and pino load from node_modules
        // at runtime instead of being bundled (pino CJS breaks when bundled).
        external: ['@dash/channels'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [
      tailwindcss(),
      TanStackRouterVite({
        routesDirectory: './src/routes',
        generatedRouteTree: './src/routeTree.gen.ts',
      }),
      react(),
    ],
  },
});
