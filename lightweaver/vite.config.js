import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { createLightweaverApiMiddleware } from './server/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function lightweaverApiPlugin() {
  return {
    name: 'lightweaver-api',
    apply: 'serve',
    configureServer(server) {
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
