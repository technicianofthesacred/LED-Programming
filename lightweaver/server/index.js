import express from 'express';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createAiPatternRouter } from './aiPattern.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = join(__dirname, '..');

export function createLightweaverApiMiddleware({
  env = process.env,
  client = null,
  createOpenAiClient,
  fetchImpl,
} = {}) {
  const api = express();

  api.use(express.json({ limit: '2mb' }));
  api.use('/ai', createAiPatternRouter({ env, client, createOpenAiClient, fetchImpl }));

  api.get('/health', (_req, res) => {
    res.json({ ok: true, app: 'Lightweaver' });
  });

  api.use((_req, res) => {
    res.status(404).json({
      error: {
        code: 'not_found',
        message: 'API route not found.',
      },
    });
  });

  api.use((error, _req, res, next) => {
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return res.status(400).json({
        error: {
          code: 'invalid_json',
          message: 'Request body must be valid JSON.',
        },
      });
    }

    return next(error);
  });

  return api;
}

export function createLightweaverServer({
  env = process.env,
  client = null,
  createOpenAiClient,
  fetchImpl,
  rootDir = defaultRootDir,
} = {}) {
  const distDir = join(rootDir, 'dist');
  const app = express();

  app.use('/api', createLightweaverApiMiddleware({ env, client, createOpenAiClient, fetchImpl }));

  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/.*/, (_req, res) => res.sendFile('index.html', { root: distDir }));
  } else {
    app.get(/.*/, (_req, res) => {
      res.status(404).send('Lightweaver dist/ not found. Run npm run build first.');
    });
  }

  return app;
}

export function startLightweaverServer({ env = process.env } = {}) {
  const app = createLightweaverServer({ env });
  const port = Number.parseInt(env.PORT || '3000', 10);

  return app.listen(port, () => {
    console.log(`Lightweaver server listening on http://localhost:${port}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startLightweaverServer();
}
