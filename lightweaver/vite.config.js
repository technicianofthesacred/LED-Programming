import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// NOTE: do NOT import server/index.js at the top level. It pulls in native
// modules (serialport, bonjour-service, …) that break `vite build` in CI and
// on machines without those native deps. The dynamic import below is only
// evaluated when Vite actually starts a dev server (apply:'serve'), so the
// static build path never loads the server module.

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function lightweaverApiPlugin() {
  return {
    name: 'lightweaver-api',
    apply: 'serve',
    async configureServer(server) {
      const { createLightweaverApiMiddleware } = await import('./server/index.js');
      server.middlewares.use('/api', createLightweaverApiMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [react(), lightweaverApiPlugin()],
  server: { port: 9998, strictPort: true, watch: { usePolling: true, interval: 500 } },
  build: {
    rollupOptions: {
      input: {
        main:    resolve(__dirname, 'index.html'),
        visitor: resolve(__dirname, 'src/visitor/visitor.html'),
      },
    },
  },
});
