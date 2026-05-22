import express from 'express';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createAiPatternRouter } from './aiPattern.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = join(__dirname, '..');

export function createLightweaverServer({
  env = process.env,
  client = null,
  createOpenAiClient,
  rootDir = defaultRootDir,
} = {}) {
  const distDir = join(rootDir, 'dist');
  const app = express();

  app.use(express.json({ limit: '2mb' }));
  app.use('/api/ai', createAiPatternRouter({ env, client, createOpenAiClient }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, app: 'Lightweaver' });
  });

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
