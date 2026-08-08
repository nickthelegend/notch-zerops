import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds into ../web, which the Node server serves as static files. One artifact, one
// origin, no CORS, and nothing fetched from a CDN at runtime -- a demo must not depend on
// the conference wifi.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:7799' } },
});
