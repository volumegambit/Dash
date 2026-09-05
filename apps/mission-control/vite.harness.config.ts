import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Serves Mission Control's renderer in a plain browser against a stubbed
 * `window.api`, so its screens can be captured without launching Electron,
 * touching the keychain, or opening a window on someone's desktop.
 *
 * Deliberately NOT electron-vite: that config builds main + preload too and
 * assumes an Electron runtime. This is the renderer alone.
 *
 * The route tree is committed (`routeTree.gen.ts`), so the TanStack router
 * plugin is not needed here — regenerating it is `mc:dev`'s job.
 *
 *   npx vite --config apps/mission-control/vite.harness.config.ts
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [tailwindcss(), react()],
  server: { port: 5233, strictPort: true },
  build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/harness.html') } },
});
