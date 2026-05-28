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
import { LwUsbController } from './lwUsbController.js';
import { readUsbLedConfig, writeUsbLedConfig } from './usbLedConfigStore.js';
import { makeKnownGoodRecoveryState } from '../src/lib/controllerProfiles.js';
import {
  makeSafeWledTestState,
  normalizeWledHost as normalizeHost,
  sortWledDevices,
  summarizeWledInfo,
} from '../src/lib/wledDiscovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const app = express();
const server = http.createServer(app);
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const DEFAULT_WLED = process.env.WLED_HOST || '';
const HTTP_TIMEOUT_MS = Number.parseInt(process.env.WLED_TIMEOUT_MS || '3000', 10);
const WS_UPSTREAM_TIMEOUT_MS = Number.parseInt(process.env.WLED_WS_TIMEOUT_MS || '5000', 10);
const USB_CONFIG_PATH = process.env.LWUSB_CONFIG || join(rootDir, '.lightweaver-usb.json');
let usbConfig = readUsbLedConfig(USB_CONFIG_PATH);
const usbLed = new LwUsbController({
  portPath: process.env.LWUSB_PORT || '',
  baudRate: Number.parseInt(process.env.LWUSB_BAUD || '115200', 10),
  maxPixels: Number.parseInt(process.env.LWUSB_MAX_PIXELS || '300', 10),
  colorOrder: usbConfig.colorOrder || 'RGB',
});

const mdnsDevices = new Map();

app.use(express.json({ limit: '2mb' }));

function normalizeRequestHost(raw) {
  return normalizeHost(raw || DEFAULT_WLED);
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
    return summarizeWledInfo(info, { ip: target, source: 'probe' });
  } catch {
    return null;
  }
}

function mergeDevice(results, device) {
  if (!device?.ip) return;
  const index = results.findIndex(item => item.ip === device.ip);
  if (index === -1) {
    results.push(device);
    return;
  }
  const existing = results[index];
  results[index] = {
    ...existing,
    ...device,
    source: existing.source === 'default' || device.source === 'default'
      ? 'default'
      : existing.source === 'mdns' || device.source === 'mdns'
        ? 'mdns'
        : device.source || existing.source,
  };
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
  res.json({ ok: true, app: 'Lightweaver', wledDefault: DEFAULT_WLED || null, usbLed: usbLed.status() });
});

app.get('/api/usb-led/status', (_req, res) => {
  res.json(usbLed.status());
});

app.get('/api/usb-led/ports', async (_req, res) => {
  try {
    res.json({ ports: await usbLed.ports() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/usb-led/connect', async (req, res) => {
  try {
    const status = await usbLed.connect({
      colorOrder: usbConfig.colorOrder || usbLed.status().colorOrder,
      ...(req.body || {}),
    });
    usbConfig = writeUsbLedConfig(USB_CONFIG_PATH, { colorOrder: status.colorOrder });
    res.json(status);
  } catch (error) {
    res.status(502).json({ error: error.message, status: usbLed.status() });
  }
});

app.post('/api/usb-led/disconnect', async (_req, res) => {
  try {
    await usbLed.disconnect();
    res.json(usbLed.status());
  } catch (error) {
    res.status(500).json({ error: error.message, status: usbLed.status() });
  }
});

app.post('/api/usb-led/command', async (req, res) => {
  const command = String(req.body?.command || '').trim();
  const allowed = /^(ID\?|HELP|CLEAR|WARM|TEST|ORDER\s+(RGB|GRB|BRG|BGR|RBG|GBR)|BRI\s+\d{1,3}|COUNT\s+\d{1,4}|SOLID\s+\d{1,3}\s+\d{1,3}\s+\d{1,3}|CHASE\s+\d{1,3}\s+\d{1,3}\s+\d{1,3})$/i;
  if (!allowed.test(command)) return res.status(400).json({ error: 'Unsupported USB LED command' });
  try {
    const result = await usbLed.sendCommand(command.toUpperCase());
    const status = usbLed.status();
    if (/^ORDER\s+/i.test(command)) usbConfig = writeUsbLedConfig(USB_CONFIG_PATH, { colorOrder: status.colorOrder });
    res.json({ ok: true, result, status });
  } catch (error) {
    res.status(502).json({ error: error.message, status: usbLed.status() });
  }
});

app.post('/api/usb-led/frame', (req, res) => {
  try {
    res.json({ ...usbLed.sendFrame(req.body || {}), status: usbLed.status() });
  } catch (error) {
    res.status(502).json({ error: error.message, status: usbLed.status() });
  }
});

app.get('/api/wled/discover', async (req, res) => {
  const results = [...mdnsDevices.values()];
  const quickHosts = [
    { host: req.query.ip, source: 'preferred' },
    { host: DEFAULT_WLED, source: 'default' },
    { host: 'wled.local', source: 'mdns' },
    { host: 'lightweaver-wled.local', source: 'mdns' },
    { host: '192.168.4.1', source: 'ap' },
    { host: '4.3.2.1', source: 'ap' },
  ].filter(Boolean);

  const probed = await Promise.all(quickHosts
    .filter(item => item.host)
    .map(item => probeWled(item.host).then(device => device ? { ...device, source: item.source } : null)));
  probed.forEach(device => mergeDevice(results, device));
  const mdnsProbed = await Promise.all(results
    .filter(device => device.source === 'mdns')
    .map(device => probeWled(device.ip, 900).then(probedDevice => probedDevice
      ? { ...probedDevice, source: 'mdns' }
      : device)));
  mdnsProbed.forEach(device => mergeDevice(results, device));

  if (req.query.scan === '1') {
    const tasks = [];
    for (const subnet of localSubnets()) {
      for (let i = 1; i <= 254; i++) {
        tasks.push(probeWled(`${subnet}.${i}`, 350).then(device => mergeDevice(results, device)));
      }
    }
    await Promise.all(tasks);
  }

  const devices = sortWledDevices(results, req.query.ip || DEFAULT_WLED);
  res.json({ devices, recommended: devices[0] || null });
});

app.get('/api/wled/info', async (req, res) => {
  const host = normalizeRequestHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  try {
    res.json(await fetchJson(wledUrl(host, '/json/info')));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
  }
});

app.get('/api/wled/state', async (req, res) => {
  const host = normalizeRequestHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  try {
    res.json(await fetchJson(wledUrl(host, '/json/state')));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
  }
});

app.get('/api/wled/cfg', async (req, res) => {
  const host = normalizeRequestHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  try {
    res.json(await fetchJson(wledUrl(host, '/json/cfg')));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
  }
});

app.post('/api/wled/cfg', async (req, res) => {
  const host = normalizeRequestHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  try {
    res.json(await fetchJson(wledUrl(host, '/json/cfg'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    }));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
  }
});

app.get('/api/wled/raw', async (req, res) => {
  const host = normalizeRequestHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  const path = String(req.query.path || '');
  const allowed = new Set(['/json/info', '/json/state', '/cfg.json', '/presets.json', '/ledmap.json']);
  if (!allowed.has(path)) return res.status(400).json({ error: 'Unsupported WLED resource path.' });
  try {
    res.json(await fetchJson(wledUrl(host, path)));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
  }
});

app.post('/api/wled/state', async (req, res) => {
  const host = normalizeRequestHost(req.query.ip);
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

app.post('/api/wled/test', async (req, res) => {
  const host = normalizeRequestHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  try {
    res.json(await fetchJson(wledUrl(host, '/json/state'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSafeWledTestState(req.body?.color || 'blue')),
    }));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
  }
});

app.get('/api/wled/snapshot', async (req, res) => {
  const host = normalizeRequestHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  try {
    const snapshot = await fetchJson(wledUrl(host, '/json'));
    res.json({ success: true, ...snapshot });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
  }
});

app.post('/api/wled/recover', async (req, res) => {
  const host = normalizeRequestHost(req.query.ip);
  if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
  try {
    res.json(await fetchJson(wledUrl(host, '/json/state'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeKnownGoodRecoveryState()),
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
  const host = normalizeRequestHost(url.searchParams.get('ip'));
  if (!host) {
    client.close(1008, 'Missing WLED IP');
    return;
  }

  const upstream = new WebSocket(`ws://${host}/ws`);
  const upstreamTimer = setTimeout(() => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      upstream.terminate();
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, 'WLED upstream timeout');
      }
    }
  }, WS_UPSTREAM_TIMEOUT_MS);

  upstream.on('open', () => {
    clearTimeout(upstreamTimer);
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
    clearTimeout(upstreamTimer);
    if (client.readyState === WebSocket.OPEN) client.close(code || 1011, reason);
  });

  upstream.on('error', error => {
    clearTimeout(upstreamTimer);
    if (client.readyState === WebSocket.OPEN) client.close(1011, error.message);
  });

  client.on('close', () => {
    clearTimeout(upstreamTimer);
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
