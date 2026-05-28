/**
 * Lightweaver Pi server
 *
 * Serves the built Vite app, hosts the AI pattern API, and proxies WLED
 * HTTP/WebSocket traffic from the browser to controllers on the gallery LAN.
 */

import express from 'express';
import { existsSync } from 'fs';
import { networkInterfaces } from 'os';
import http from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Bonjour } from 'bonjour-service';
import { WebSocket, WebSocketServer } from 'ws';
import { createAiPatternRouter } from './aiPattern.js';
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
const defaultRootDir = join(__dirname, '..');

function makeRuntime({ env = process.env, rootDir = defaultRootDir, usbLedController = null } = {}) {
  const defaultWled = env.WLED_HOST || '';
  const httpTimeoutMs = Number.parseInt(env.WLED_TIMEOUT_MS || '3000', 10);
  const usbConfigPath = env.LWUSB_CONFIG || join(rootDir, '.lightweaver-usb.json');
  let usbConfig = readUsbLedConfig(usbConfigPath);
  const usbLed = usbLedController || new LwUsbController({
    portPath: env.LWUSB_PORT || '',
    baudRate: Number.parseInt(env.LWUSB_BAUD || '115200', 10),
    maxPixels: Number.parseInt(env.LWUSB_MAX_PIXELS || '300', 10),
    colorOrder: usbConfig.colorOrder || 'RGB',
  });
  const mdnsDevices = new Map();

  function normalizeRequestHost(raw) {
    return normalizeHost(raw || defaultWled);
  }

  function wledUrl(host, path) {
    return `http://${host}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(options.timeoutMs || httpTimeoutMs),
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

      return browser;
    } catch (error) {
      console.warn(`[wled] mDNS unavailable: ${error.message}`);
      return null;
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

  function persistUsbConfig(patch) {
    usbConfig = writeUsbLedConfig(usbConfigPath, patch);
    return usbConfig;
  }

  return {
    defaultWled,
    fetchJson,
    initMdns,
    localSubnets,
    mdnsDevices,
    mergeDevice,
    normalizeRequestHost,
    persistUsbConfig,
    probeWled,
    usbConfig: () => usbConfig,
    usbLed,
    wledUrl,
  };
}

export function createLightweaverApiMiddleware({
  env = process.env,
  client = null,
  createOpenAiClient,
  fetchImpl,
  rootDir = defaultRootDir,
  settingsPath = join(rootDir, '.lightweaver-ai.local'),
  enableMdns = false,
  usbLedController = null,
} = {}) {
  const runtime = makeRuntime({ env, rootDir, usbLedController });
  if (enableMdns) runtime.initMdns();

  const api = express();
  api.use(express.json({ limit: '2mb' }));
  api.use('/ai', createAiPatternRouter({ env, client, createOpenAiClient, fetchImpl, settingsPath }));

  api.get('/health', (_req, res) => {
    res.json({ ok: true, app: 'Lightweaver' });
  });

  api.get('/usb-led/status', (_req, res) => {
    res.json(runtime.usbLed.status());
  });

  api.get('/usb-led/ports', async (_req, res) => {
    try {
      res.json({ ports: await runtime.usbLed.ports() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  api.post('/usb-led/connect', async (req, res) => {
    try {
      const status = await runtime.usbLed.connect({
        colorOrder: runtime.usbConfig().colorOrder || runtime.usbLed.status().colorOrder,
        ...(req.body || {}),
      });
      runtime.persistUsbConfig({ colorOrder: status.colorOrder });
      res.json(status);
    } catch (error) {
      res.status(502).json({ error: error.message, status: runtime.usbLed.status() });
    }
  });

  api.post('/usb-led/disconnect', async (_req, res) => {
    try {
      await runtime.usbLed.disconnect();
      res.json(runtime.usbLed.status());
    } catch (error) {
      res.status(500).json({ error: error.message, status: runtime.usbLed.status() });
    }
  });

  api.post('/usb-led/command', async (req, res) => {
    const command = String(req.body?.command || '').trim();
    const allowed = /^(ID\?|HELP|CLEAR|WARM|TEST|ORDER\s+(RGB|GRB|BRG|BGR|RBG|GBR)|BRI\s+\d{1,3}|COUNT\s+\d{1,4}|SOLID\s+\d{1,3}\s+\d{1,3}\s+\d{1,3}|CHASE\s+\d{1,3}\s+\d{1,3}\s+\d{1,3})$/i;
    if (!allowed.test(command)) return res.status(400).json({ error: 'Unsupported USB LED command' });
    try {
      const result = await runtime.usbLed.sendCommand(command.toUpperCase());
      const status = runtime.usbLed.status();
      if (/^ORDER\s+/i.test(command)) runtime.persistUsbConfig({ colorOrder: status.colorOrder });
      res.json({ ok: true, result, status });
    } catch (error) {
      res.status(502).json({ error: error.message, status: runtime.usbLed.status() });
    }
  });

  api.post('/usb-led/frame', (req, res) => {
    try {
      res.json({ ...runtime.usbLed.sendFrame(req.body || {}), status: runtime.usbLed.status() });
    } catch (error) {
      res.status(502).json({ error: error.message, status: runtime.usbLed.status() });
    }
  });

  api.get('/wled/discover', async (req, res) => {
    const results = [...runtime.mdnsDevices.values()];
    const quickHosts = [
      { host: req.query.ip, source: 'preferred' },
      { host: runtime.defaultWled, source: 'default' },
      { host: 'wled.local', source: 'mdns' },
      { host: 'lightweaver-wled.local', source: 'mdns' },
      { host: '192.168.4.1', source: 'ap' },
      { host: '4.3.2.1', source: 'ap' },
    ].filter(Boolean);

    const probed = await Promise.all(quickHosts
      .filter(item => item.host)
      .map(item => runtime.probeWled(item.host).then(device => device ? { ...device, source: item.source } : null)));
    probed.forEach(device => runtime.mergeDevice(results, device));
    const mdnsProbed = await Promise.all(results
      .filter(device => device.source === 'mdns')
      .map(device => runtime.probeWled(device.ip, 900).then(probedDevice => probedDevice
        ? { ...probedDevice, source: 'mdns' }
        : device)));
    mdnsProbed.forEach(device => runtime.mergeDevice(results, device));

    if (req.query.scan === '1') {
      const tasks = [];
      for (const subnet of runtime.localSubnets()) {
        for (let i = 1; i <= 254; i++) {
          tasks.push(runtime.probeWled(`${subnet}.${i}`, 350).then(device => runtime.mergeDevice(results, device)));
        }
      }
      await Promise.all(tasks);
    }

    const devices = sortWledDevices(results, req.query.ip || runtime.defaultWled);
    res.json({ devices, recommended: devices[0] || null });
  });

  api.get('/wled/info', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, '/json/info')));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.get('/wled/state', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, '/json/state')));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.get('/wled/cfg', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, '/json/cfg')));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.post('/wled/cfg', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, '/json/cfg'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      }));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.get('/wled/raw', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    const path = String(req.query.path || '');
    const allowed = new Set(['/json/info', '/json/state', '/cfg.json', '/presets.json', '/ledmap.json']);
    if (!allowed.has(path)) return res.status(400).json({ error: 'Unsupported WLED resource path.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, path)));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.post('/wled/state', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, '/json/state'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      }));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.post('/wled/test', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, '/json/state'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeSafeWledTestState(req.body?.color || 'blue')),
      }));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.get('/wled/snapshot', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    try {
      const snapshot = await runtime.fetchJson(runtime.wledUrl(host, '/json'));
      res.json({ success: true, ...snapshot });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.post('/wled/recover', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, '/json/state'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeKnownGoodRecoveryState()),
      }));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
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
  settingsPath = join(rootDir, '.lightweaver-ai.local'),
  enableMdns = false,
  usbLedController = null,
} = {}) {
  const distDir = join(rootDir, 'dist');
  const app = express();

  app.use('/api', createLightweaverApiMiddleware({
    env,
    client,
    createOpenAiClient,
    fetchImpl,
    rootDir,
    settingsPath,
    enableMdns,
    usbLedController,
  }));

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

export function attachWledWebSocketProxy(server, { env = process.env } = {}) {
  const defaultWled = env.WLED_HOST || '';
  const timeoutMs = Number.parseInt(env.WLED_WS_TIMEOUT_MS || '5000', 10);
  const normalizeRequestHost = raw => normalizeHost(raw || defaultWled);
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
    }, timeoutMs);

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

  return wss;
}

export function startLightweaverServer({ env = process.env } = {}) {
  const app = createLightweaverServer({ env, enableMdns: true });
  const server = http.createServer(app);
  attachWledWebSocketProxy(server, { env });
  const port = Number.parseInt(env.PORT || '3000', 10);

  return server.listen(port, () => {
    console.log(`Lightweaver Pi server listening on http://localhost:${port}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startLightweaverServer();
}
