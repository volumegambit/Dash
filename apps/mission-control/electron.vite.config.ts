import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    // ws is excluded from externalization (bundled) because @google/genai does
    // `import * as NodeWs from 'ws'`. When ws is external (CJS), Vite's
    // _interopNamespaceDefault helper crashes on EventEmitter's inherited
    // prototype properties. Bundling ws resolves the namespace import at build
    // time and avoids the CJS interop entirely.
    plugins: [externalizeDepsPlugin({ exclude: ['@dash/mc', '@dash/management', 'ws'] })],
    build: {
      rollupOptions: {
        // @dash/channels is dynamically imported for WhatsApp pairing.
        // It must be externalized so Baileys and pino load from node_modules
        // at runtime instead of being bundled (pino CJS breaks when bundled).
        // ws optional native addons must stay external so ws's try/catch
        // handles their absence gracefully at runtime.
        external: ['@dash/channels', 'bufferutil', 'utf-8-validate'],
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
