import express from 'express';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createAiPatternRouter } from './aiPattern.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);

app.use(express.json({ limit: '2mb' }));
app.use('/api/ai', createAiPatternRouter());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'Lightweaver' });
});

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => res.sendFile(join(distDir, 'index.html')));
} else {
  app.get(/.*/, (_req, res) => {
    res.status(404).send('Lightweaver dist/ not found. Run npm run build first.');
  });
}

app.listen(PORT, () => {
  console.log(`Lightweaver server listening on http://localhost:${PORT}`);
});
