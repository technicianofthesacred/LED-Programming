/**
 * server.js — Express server for the LED Pi web interface
 *
 * Endpoints:
 *   GET  /api/config      — artist branding + WLED IP + scene list
 *   GET  /api/ledmap      — ledmap.json exported from LED Art Mapper
 *   GET  /api/discover    — fast: mDNS + probe well-known WLED addresses
 *   GET  /api/scan        — thorough: full local subnet scan (~0.5s)
 *   *    static           — serves the built Vite frontend from dist/
 */

import express             from 'express';
import { readFileSync }    from 'fs';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';
import { networkInterfaces } from 'os';
import Bonjour             from 'bonjour-service';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── mDNS WLED discovery ───────────────────────────────────────────────────────
//
// WLED advertises itself as _wled._tcp on port 80.
// We keep a live map updated as devices appear / disappear.

const mdnsDevices = new Map(); // ip → { name, ip, port, ver? }

function initMDNS() {
  try {
    const bonjour = new Bonjour();

    const browser = bonjour.find({ type: 'wled' });
    browser.on('up', svc => {
      // Prefer an IPv4 address from the addresses array, fall back to host
      const ip = svc.addresses?.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a))
               ?? svc.referer?.address
               ?? svc.host?.replace(/\.$/, '');
      if (ip) {
        mdnsDevices.set(ip, {
          name: svc.name ?? 'WLED',
          ip,
          port: svc.port ?? 80,
          source: 'mdns',
        });
        console.log(`[mDNS] Found WLED: ${svc.name} @ ${ip}`);
      }
    });

    browser.on('down', svc => {
      for (const [ip, dev] of mdnsDevices) {
        if (dev.name === svc.name) {
          mdnsDevices.delete(ip);
          console.log(`[mDNS] Lost WLED: ${svc.name} @ ${ip}`);
        }
      }
    });

  } catch (e) {
    // mDNS may be unavailable (e.g. Docker without multicast) — not fatal
    console.warn('[mDNS] Unavailable:', e.message);
  }
}

// ── WLED HTTP probe ───────────────────────────────────────────────────────────

async function probeWLED(host, timeoutMs = 1200) {
  try {
    const r = await fetch(`http://${host}/json/info`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const info = await r.json();
    if (!info?.ver) return null;
    return {
      name:   info.name  ?? 'WLED',
      ip:     host,
      port:   80,
      ver:    info.ver,
      leds:   info.leds?.count ?? null,
      source: 'probe',
    };
  } catch { return null; }
}

// Merge a new result into a results array, de-duplicating by IP
function mergeDevice(results, device) {
  if (device && !results.find(r => r.ip === device.ip)) {
    results.push(device);
  }
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function readJSON(filename) {
  return JSON.parse(readFileSync(join(__dirname, 'data', filename), 'utf8'));
}

// ── API routes ────────────────────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  try {
    res.json(readJSON('config.json'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ledmap', (_req, res) => {
  try {
    res.json(readJSON('ledmap.json'));
  } catch (e) {
    res.status(404).json({ error: 'No ledmap configured yet' });
  }
});

/**
 * GET /api/discover
 * Fast path: returns mDNS-found devices + probes a few well-known addresses.
 * Typical latency: 1–2 s (limited by probe timeout).
 */
app.get('/api/discover', async (_req, res) => {
  const results = [...mdnsDevices.values()];

  // Probe well-known WLED addresses in parallel
  const probed = await Promise.all([
    probeWLED('wled.local'),   // WLED default mDNS hostname
    probeWLED('4.3.2.1'),      // WLED AP mode (older firmware)
    probeWLED('192.168.4.1'),  // WLED AP mode (common default)
  ]);
  probed.forEach(d => mergeDevice(results, d));

  res.json(results);
});

/**
 * GET /api/scan
 * Thorough path: scans every host on the local subnet(s).
 * Typical latency: 400–600 ms (all 254 hosts probed in parallel).
 */
app.get('/api/scan', async (_req, res) => {
  // Discover local IPv4 subnets from network interfaces
  const subnets = new Set();
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        subnets.add(iface.address.split('.').slice(0, 3).join('.'));
      }
    }
  }

  const results = [];
  const tasks   = [];

  for (const subnet of subnets) {
    for (let i = 1; i <= 254; i++) {
      tasks.push(
        probeWLED(`${subnet}.${i}`, 400)
          .then(d => mergeDevice(results, d))
      );
    }
  }

  // Also probe well-known addresses (covers cross-subnet AP mode)
  tasks.push(probeWLED('wled.local').then(d => mergeDevice(results, d)));
  tasks.push(probeWLED('4.3.2.1').then(d => mergeDevice(results, d)));

  await Promise.all(tasks);

  // Merge mDNS results too
  for (const dev of mdnsDevices.values()) mergeDevice(results, dev);

  console.log(`[scan] Found ${results.length} WLED device(s):`, results.map(d => d.ip));
  res.json(results);
});

// ── Static frontend ───────────────────────────────────────────────────────────

app.use(express.static(join(__dirname, 'dist')));
app.get('*', (_req, res) => res.sendFile(join(__dirname, 'dist', 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────

initMDNS();

app.listen(PORT, () => {
  console.log(`LED web interface running on http://localhost:${PORT}`);
});
