import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 9999, strictPort: true, watch: { usePolling: true, interval: 500 } },
  preview: { port: 9999, strictPort: true },
});
