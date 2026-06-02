import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const WLED_IP = process.env.WLED_IP || '192.168.4.1';
const WLED_TIMEOUT_MS = Number(process.env.WLED_TIMEOUT_MS || 3000);

const app = express();
app.use(express.json());

const distDir = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distDir));

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function wledRequest(method, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WLED_TIMEOUT_MS);
  try {
    const init = {
      method,
      signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    };
    const res = await fetch(`http://${WLED_IP}/json/state`, init);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function bridgeError(res, err) {
  const message = err && err.name === 'AbortError' ? 'WLED request timed out' : 'WLED unreachable';
  res.status(502).json({ error: message, wledIp: WLED_IP });
}

app.post('/api/preset/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1 || id > 250) {
    return res.status(400).json({ error: 'preset id must be 1-250' });
  }
  try {
    const r = await wledRequest('POST', { ps: id });
    res.status(r.ok ? 200 : 502).json(r.body);
  } catch (e) {
    bridgeError(res, e);
  }
});

app.post('/api/power', async (req, res) => {
  const on = Boolean(req.body?.on);
  try {
    const r = await wledRequest('POST', { on });
    res.status(r.ok ? 200 : 502).json(r.body);
  } catch (e) {
    bridgeError(res, e);
  }
});

app.post('/api/brightness', async (req, res) => {
  const raw = Number(req.body?.bri);
  if (!Number.isFinite(raw)) {
    return res.status(400).json({ error: 'bri must be a number' });
  }
  const bri = clamp(Math.round(raw), 0, 255);
  try {
    const r = await wledRequest('POST', { bri });
    res.status(r.ok ? 200 : 502).json(r.body);
  } catch (e) {
    bridgeError(res, e);
  }
});

app.get('/api/state', async (_req, res) => {
  try {
    const r = await wledRequest('GET');
    res.status(r.ok ? 200 : 502).json(r.body);
  } catch (e) {
    bridgeError(res, e);
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, wledIp: WLED_IP });
});

// Captive-portal probes. To make iOS/macOS POP the portal we must NOT return
// Apple's expected "Success" body — any non-Success 200 (or redirect) flags the
// network as captive and opens the setup/scene UI. Android/Windows treat a
// non-204 / redirect as captive, so those stay as 302s.
const applePortalPage =
  "<!DOCTYPE html><html><head><meta http-equiv='refresh' content='0; url=/'>" +
  "</head><body>Lightweaver</body></html>";
app.get('/generate_204', (_req, res) => res.redirect(302, '/'));
app.get('/gen_204', (_req, res) => res.redirect(302, '/'));
app.get('/hotspot-detect.html', (_req, res) => res.status(200).type('html').send(applePortalPage));
app.get('/library/test/success.html', (_req, res) => res.status(200).type('html').send(applePortalPage));
app.get('/ncsi.txt', (_req, res) => res.redirect(302, '/'));
app.get('/connecttest.txt', (_req, res) => res.redirect(302, '/'));
app.get('/redirect', (_req, res) => res.redirect(302, '/'));

app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) res.status(404).send('UI not built. Run `npm run build` first.');
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lightweaver visitor UI listening on :${PORT} (WLED=${WLED_IP})`);
});
