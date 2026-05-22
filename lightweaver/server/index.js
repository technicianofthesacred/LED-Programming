/**
 * Lightweaver Pi server
 *
 * Serves the built Vite app and proxies WLED HTTP/WebSocket traffic from the
 * browser to controllers on the gallery LAN. Browser-side direct WLED access is
 * kept as a development fallback in the client.
 */

import express from 'express';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';
import http from 'http';
import { Bonjour } from 'bonjour-service';
import { WebSocket, WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const app = express();
const server = http.createServer(app);
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const DEFAULT_WLED = process.env.WLED_HOST || '';
const HTTP_TIMEOUT_MS = Number.parseInt(process.env.WLED_TIMEOUT_MS || '3000', 10);

const mdnsDevices = new Map();

app.use(express.json({ limit: '2mb' }));

function normalizeHost(raw) {
  const value = String(raw || DEFAULT_WLED || '').trim();
  if (!value) return '';
  return value.replace(/^https?:\/\//, '').replace(/^ws:\/\//, '').replace(/\/.*$/, '');
}

function wledUrl(host, path) {
  return `http://${host}${path.startsWith('/') ? path : `/${path}`}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs || HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { raw: text }; }
  }
  if (!response.ok) {
    const err = new Error(`WLED HTTP ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function probeWled(host, timeoutMs = 1200) {
  const target = normalizeHost(host);
  if (!target) return null;
  try {
    const info = await fetchJson(wledUrl(target, '/json/info'), { timeoutMs });
    if (!info?.ver) return null;
    return {
      name: info.name || 'WLED',
      ip: target,
      port: 80,
      ver: info.ver,
      leds: info.leds?.count ?? null,
      source: 'probe',
    };
  } catch {
    return null;
  }
}

function mergeDevice(results, device) {
  if (device && !results.some(item => item.ip === device.ip)) results.push(device);
}

function initMdns() {
  try {
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: 'wled' });

    browser.on('up', service => {
      const ip = service.addresses?.find(addr => /^\d+\.\d+\.\d+\.\d+$/.test(addr))
        || service.referer?.address
        || service.host?.replace(/\.$/, '');
      if (!ip) return;
      mdnsDevices.set(ip, {
        name: service.name || 'WLED',
        ip,
        port: service.port || 80,
        source: 'mdns',
      });
      console.log(`[wled] mDNS up ${service.name || 'WLED'} @ ${ip}`);
    });

    browser.on('down', service => {
      for (const [ip, device] of mdnsDevices) {
        if (device.name === service.name) mdnsDevices.delete(ip);
      }
    });
  } catch (error) {
    console.warn(`[wled] mDNS unavailable: ${error.message}`);
  }
}

function localSubnets() {
  const subnets = new Set();
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        subnets.add(iface.address.split('.').slice(0, 3).join('.'));
      }
    }
  }
  return [...subnets];
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'Lightweaver', wledDefault: DEFAULT_WLED || null });
});

app.get('/api/wled/discover', async (req, res) => {
  const results = [...mdnsDevices.values()];
  const quickHosts = [
    req.query.ip,
    DEFAULT_WLED,
    'wled.local',
    'lightweaver-wled.local',
    '192.168.4.1',
    '4.3.2.1',
  ].filter(Boolean);

  const probed = await Promise.all(quickHosts.map(host => probeWled(host)));
  probed.forEach(device => mergeDevice(results, device));

  if (req.query.scan === '1') {
    const tasks = [];
    for (const subnet of localSubnets()) {
      for (let i = 1; i <= 254; i++) {
        tasks.push(probeWled(`${subnet}.${i}`, 350).then(device => mergeDevice(results, device)));
      }
    }
    await Promise.all(tasks);
  }

  res.json({ devices: results });
});

app.get('/api/wled/info', async (req, res) => {
  const host = normalizeHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  try {
    res.json(await fetchJson(wledUrl(host, '/json/info')));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
  }
});

app.get('/api/wled/state', async (req, res) => {
  const host = normalizeHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  try {
    res.json(await fetchJson(wledUrl(host, '/json/state')));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
  }
});

app.post('/api/wled/state', async (req, res) => {
  const host = normalizeHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  try {
    res.json(await fetchJson(wledUrl(host, '/json/state'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    }));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/api/wled/ws') return;
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req, url);
  });
});

wss.on('connection', (client, _req, url) => {
  const host = normalizeHost(url.searchParams.get('ip'));
  if (!host) {
    client.close(1008, 'Missing WLED IP');
    return;
  }

  const upstream = new WebSocket(`ws://${host}/ws`);

  upstream.on('open', () => {
    while (client._queuedMessages?.length) upstream.send(client._queuedMessages.shift());
  });

  client.on('message', data => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
    else {
      client._queuedMessages ||= [];
      if (client._queuedMessages.length < 4) client._queuedMessages.push(data);
    }
  });

  upstream.on('message', data => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });

  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN) client.close(code || 1011, reason);
  });

  upstream.on('error', error => {
    if (client.readyState === WebSocket.OPEN) client.close(1011, error.message);
  });

  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });
});

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(join(distDir, 'index.html')));
} else {
  app.get('*', (_req, res) => {
    res.status(404).send('Lightweaver dist/ not found. Run npm run build first.');
  });
}

initMdns();

server.listen(PORT, () => {
  console.log(`Lightweaver Pi server listening on http://localhost:${PORT}`);
});
