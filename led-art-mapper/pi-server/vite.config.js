import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: false,
  build: {
    outDir:    'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5175,
    // During dev, proxy API calls to the Express server
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
