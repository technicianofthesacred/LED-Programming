import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveStudioReleaseIdentity } from './scripts/studio-release-identity.mjs';
import { serializeStudioRelease } from './src/lib/studioRelease.js';
import {
  FIRMWARE_RELEASE_BUILD_GRAPH_PATH,
  createFirmwareReleaseBuildGraphFromRoot,
  serializeFirmwareReleaseBuildGraph,
} from '../scripts/verify-production-artifacts.mjs';

// NOTE: do NOT import server/index.js at the top level. It pulls in native
// modules (serialport, bonjour-service, …) that break `vite build` in CI and
// on machines without those native deps. The dynamic import below is only
// evaluated when Vite actually starts a dev server (apply:'serve'), so the
// static build path never loads the server module.

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const studioRelease = resolveStudioReleaseIdentity({ cwd: __dirname });

function studioReleasePlugin() {
  return {
    name: 'lightweaver-studio-release',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'studio-release.json',
        source: serializeStudioRelease(studioRelease),
      });
    },
  };
}

function firmwareReleaseBuildGraphPlugin() {
  return {
    name: 'lightweaver-firmware-release-build-graph',
    async generateBundle() {
      const graph = await createFirmwareReleaseBuildGraphFromRoot(resolve(__dirname, 'public'));
      this.emitFile({
        type: 'asset',
        fileName: FIRMWARE_RELEASE_BUILD_GRAPH_PATH,
        source: serializeFirmwareReleaseBuildGraph(graph),
      });
    },
  };
}

function cardLocalAssetsPlugin() {
  const fontRoot = resolve(__dirname, 'public/fonts');
  return {
    name: 'lightweaver-card-local-assets',
    buildStart() {
      const emitTree = directory => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) emitTree(path);
          else this.emitFile({
            type: 'asset',
            fileName: `fonts/${relative(fontRoot, path).replaceAll('\\\\', '/')}`,
            source: readFileSync(path),
          });
        }
      };
      emitTree(fontRoot);
    },
  };
}

function lightweaverApiPlugin() {
  return {
    name: 'lightweaver-api',
    apply: 'serve',
    async configureServer(server) {
      // Pages Functions are not mounted by plain Vite. Return a successful,
      // empty session probe so local Studio use is truthfully signed out
      // without Chrome reporting a missing API resource as a console error.
      server.middlewares.use('/api/library/session', (request, response, next) => {
        if (request.method !== 'GET') return next();
        response.statusCode = 204;
        response.setHeader('cache-control', 'no-store');
        response.end();
      });
      const { createLightweaverApiMiddleware } = await import('./server/index.js');
      server.middlewares.use('/api', createLightweaverApiMiddleware());
    },
  };
}

export default defineConfig(({ mode }) => {
  const cardTarget = mode === 'card';
  return {
    base: cardTarget ? '/studio/' : '/',
    publicDir: cardTarget ? false : 'public',
    plugins: cardTarget
      ? [react(), cardLocalAssetsPlugin()]
      : [react(), lightweaverApiPlugin(), studioReleasePlugin(), firmwareReleaseBuildGraphPlugin()],
    define: {
      __LIGHTWEAVER_STUDIO_RELEASE__: JSON.stringify(studioRelease),
      __LIGHTWEAVER_BUILD_TARGET__: JSON.stringify(cardTarget ? 'card-local' : 'public-https'),
    },
    server: { port: 9998, strictPort: true, watch: { usePolling: true, interval: 500 } },
    build: {
      // LW_CARD_STUDIO_RAW_DIR lets the canonical comparison build (see
      // build-card-studio.mjs --canonical) run without clobbering a real
      // card build's output.
      outDir: cardTarget ? (process.env.LW_CARD_STUDIO_RAW_DIR || '.card-dist-raw') : 'dist',
      emptyOutDir: true,
      manifest: true,
      sourcemap: false,
      rollupOptions: {
        input: cardTarget
          ? resolve(__dirname, 'card.html')
          : {
              main: resolve(__dirname, 'index.html'),
              visitor: resolve(__dirname, 'src/visitor/visitor.html'),
            },
      },
    },
  };
});
