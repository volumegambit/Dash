import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@dash/mc', '@dash/management'] })],
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
