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

// Captive-portal IPs the Lightweaver card / WLED AP serve on.
const CAPTIVE_PORTAL_IPS = new Set(['192.168.4.1', '4.3.2.1']);
// Allowed upstream WebSocket ports: stock WLED (:80) and the Lightweaver card (:81).
const ALLOWED_WLED_WS_PORTS = new Set(['80', '81']);

function ipv4Octets(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some(n => n > 255)) return null;
  return octets;
}

/**
 * SSRF guard for the WLED proxy: only permit hosts that live on the local
 * gallery LAN. Accepts RFC1918 / loopback IPv4 ranges, the captive-portal IPs,
 * and *.local mDNS hostnames. Public IPs and cloud metadata addresses
 * (e.g. 169.254.169.254 — link-local is excluded entirely) are rejected.
 */
function isAllowedWledHost(host) {
  const value = normalizeHost(host);
  if (!value) return false;
  if (CAPTIVE_PORTAL_IPS.has(value)) return true;

  const octets = ipv4Octets(value);
  if (octets) {
    const [a, b] = octets;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // 127.0.0.0/8 loopback
    // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254) excluded.
    return false;
  }

  // Hostnames: only mDNS .local names and bare localhost are LAN-local.
  const lower = value.toLowerCase();
  if (lower === 'localhost') return true;
  if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.local$/.test(lower)) return true;
  return false;
}

// True only for the RFC1918 private IPv4 /24 subnets we are allowed to sweep.
function isRfc1918Subnet(subnet) {
  const octets = ipv4Octets(`${subnet}.0`);
  if (!octets) return false;
  const [a, b] = octets;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

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

// In-flight guard for the full-subnet scan: at most one sweep runs at a time.
// Concurrent scan=1 requests await the same promise and share the result.
let _activeScanPromise = null;

async function runBoundedScan(tasks, batchSize = 32) {
  // Process tasks in batches to cap concurrent open sockets.
  for (let i = 0; i < tasks.length; i += batchSize) {
    await Promise.all(tasks.slice(i, i + batchSize).map(fn => fn()));
  }
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
      // Only probe hosts on the local LAN — never an attacker-supplied public host.
      .filter(item => item.host && isAllowedWledHost(item.host))
      .map(item => runtime.probeWled(item.host).then(device => device ? { ...device, source: item.source } : null)));
    probed.forEach(device => runtime.mergeDevice(results, device));
    const mdnsProbed = await Promise.all(results
      .filter(device => device.source === 'mdns')
      .map(device => runtime.probeWled(device.ip, 900).then(probedDevice => probedDevice
        ? { ...probedDevice, source: 'mdns' }
        : device)));
    mdnsProbed.forEach(device => runtime.mergeDevice(results, device));

    if (req.query.scan === '1') {
      if (!_activeScanPromise) {
        const scanResults = results;
        _activeScanPromise = (async () => {
          const tasks = [];
          for (const subnet of runtime.localSubnets()) {
            // Only sweep private LAN ranges, never a public subnet a host happens to be on.
            if (!isRfc1918Subnet(subnet)) continue;
            for (let i = 1; i <= 254; i++) {
              const ip = `${subnet}.${i}`;
              tasks.push(() => runtime.probeWled(ip, 350).then(device => runtime.mergeDevice(scanResults, device)));
            }
          }
          await runBoundedScan(tasks, 32);
        })().finally(() => { _activeScanPromise = null; });
      }
      await _activeScanPromise;
    }

    const devices = sortWledDevices(results, req.query.ip || runtime.defaultWled);
    res.json({ devices, recommended: devices[0] || null });
  });

  api.get('/wled/info', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    if (!isAllowedWledHost(host)) return res.status(400).json({ error: 'WLED host is not on an allowed local network.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, '/json/info')));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.get('/wled/state', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    if (!isAllowedWledHost(host)) return res.status(400).json({ error: 'WLED host is not on an allowed local network.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, '/json/state')));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.get('/wled/cfg', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    if (!isAllowedWledHost(host)) return res.status(400).json({ error: 'WLED host is not on an allowed local network.' });
    try {
      res.json(await runtime.fetchJson(runtime.wledUrl(host, '/json/cfg')));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message, detail: error.data || null });
    }
  });

  api.post('/wled/cfg', async (req, res) => {
    const host = runtime.normalizeRequestHost(req.query.ip);
    if (!host) return res.status(400).json({ error: 'Missing WLED IP. Pass ?ip=<host> or set WLED_HOST.' });
    if (!isAllowedWledHost(host)) return res.status(400).json({ error: 'WLED host is not on an allowed local network.' });
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
    if (!isAllowedWledHost(host)) return res.status(400).json({ error: 'WLED host is not on an allowed local network.' });
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
    if (!isAllowedWledHost(host)) return res.status(400).json({ error: 'WLED host is not on an allowed local network.' });
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
    if (!isAllowedWledHost(host)) return res.status(400).json({ error: 'WLED host is not on an allowed local network.' });
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
    if (!isAllowedWledHost(host)) return res.status(400).json({ error: 'WLED host is not on an allowed local network.' });
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
    if (!isAllowedWledHost(host)) return res.status(400).json({ error: 'WLED host is not on an allowed local network.' });
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

// CSWSH guard: only browser pages served from these origins may open the proxy.
// Mirrors the local dev origins and the deployed Studio origin.
function getAllowedWsOrigins(env) {
  const origins = new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://led.mandalacodes.com',
  ]);
  for (const extra of String(env.WLED_WS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)) {
    origins.add(extra);
  }
  return origins;
}

function isAllowedWsOrigin(origin, allowedOrigins) {
  // Same-origin / non-browser clients send no Origin header — allow those
  // (curl, the card itself); reject only cross-site browser origins.
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

export function attachWledWebSocketProxy(server, { env = process.env } = {}) {
  const defaultWled = env.WLED_HOST || '';
  const timeoutMs = Number.parseInt(env.WLED_WS_TIMEOUT_MS || '5000', 10);
  const normalizeRequestHost = raw => normalizeHost(raw || defaultWled);
  const allowedOrigins = getAllowedWsOrigins(env);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/api/wled/ws') return;
    if (!isAllowedWsOrigin(req.headers.origin, allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
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
    if (!isAllowedWledHost(host)) {
      client.close(1008, 'WLED host is not on an allowed local network');
      return;
    }

    const requestedPort = url.searchParams.get('wsPort') || '80';
    // Clamp to known WLED WebSocket ports so the proxy can't be aimed at arbitrary ports.
    const wsPort = ALLOWED_WLED_WS_PORTS.has(requestedPort) ? requestedPort : '80';
    const wsPath = url.searchParams.get('wsPath') || '/ws';
    // The Lightweaver card serves its WebSocket on :81/, stock WLED on :80/ws.
    // Try the hinted endpoint first, then fall back to the other so one proxy
    // works for either firmware without the client having to know which it is.
    const primary = wsPort === '81' ? `ws://${host}:81/` : `ws://${host}:${wsPort}${wsPath}`;
    const fallback = wsPort === '81' ? `ws://${host}:80/ws` : `ws://${host}:81/`;
    const candidates = [primary, fallback];

    let upstream = null;
    let opened = false;
    let closedByClient = false;

    const connect = index => {
      let settled = false;
      upstream = new WebSocket(candidates[index]);
      const upstreamTimer = setTimeout(() => {
        if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      }, timeoutMs);

      // Fires once per attempt on connect failure / close. Before the socket
      // has opened, a failure re-dials the alternate endpoint; after it has
      // opened, it just tears down the client.
      const settle = (code, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(upstreamTimer);
        if (closedByClient) return;
        if (!opened && index + 1 < candidates.length) {
          connect(index + 1);
          return;
        }
        if (client.readyState === WebSocket.OPEN) {
          client.close(opened ? (code || 1011) : 1011, opened ? reason : 'WLED upstream unreachable');
        }
      };

      upstream.on('open', () => {
        opened = true;
        clearTimeout(upstreamTimer);
        while (client._queuedMessages?.length) upstream.send(client._queuedMessages.shift());
      });
      upstream.on('message', data => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      });
      upstream.on('close', (code, reason) => settle(code, reason));
      upstream.on('error', error => settle(1011, error.message));
    };

    client.on('message', data => {
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else {
        client._queuedMessages ||= [];
        if (client._queuedMessages.length < 4) client._queuedMessages.push(data);
      }
    });

    client.on('close', () => {
      closedByClient = true;
      if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
        upstream.close();
      }
    });

    connect(0);
  });

  return wss;
}

export function startLightweaverServer({ env = process.env } = {}) {
  const app = createLightweaverServer({ env, enableMdns: true });
  const server = http.createServer(app);
  attachWledWebSocketProxy(server, { env });
  const port = Number.parseInt(env.PORT || '3000', 10);

  // listen(port) binds to all interfaces, so the AI endpoint is reachable beyond
  // localhost. Warn the operator if it has no auth token configured.
  if (!env.AI_PATTERN_AUTH_TOKEN) {
    console.warn(
      '[lightweaver] WARNING: AI pattern endpoint is unauthenticated and reachable beyond localhost. '
      + 'Set AI_PATTERN_AUTH_TOKEN to require a token for /api/ai requests.'
    );
  }

  return server.listen(port, () => {
    console.log(`Lightweaver Pi server listening on http://localhost:${port}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startLightweaverServer();
}
