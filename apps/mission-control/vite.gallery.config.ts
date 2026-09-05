/**
 * Dev-only Vite config for the tool-card gallery
 * (`src/renderer/gallery.html`).
 *
 *   npx vite --config vite.gallery.config.ts      # from apps/mission-control
 *   http://localhost:5201/gallery.html
 *
 * Mirrors the `renderer` section of electron.vite.config.ts — Tailwind and
 * React — minus the TanStack router plugin, which the gallery does not use.
 * It exists because `electron-vite dev` needs the Electron shell, a gateway
 * and a live conversation to reach a tool card, which is why this client's
 * tool rendering had never been looked at.
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  plugins: [tailwindcss(), react()],
  server: { port: 5201 },
});
