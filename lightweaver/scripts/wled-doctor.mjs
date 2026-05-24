#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import {
  makeSafeWledTestState,
  normalizeWledHost,
  sortWledDevices,
  summarizeWledInfo,
} from '../src/lib/wledDiscovery.js';

const execFileAsync = promisify(execFile);

const args = parseArgs(process.argv.slice(2));
const host = normalizeWledHost(args.host || process.env.WLED_HOST || '');
const scan = Boolean(args.scan);
const testColor = args.test || '';
const port = args.port || 'auto';

main().catch(error => {
  console.error(`\nDoctor failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  console.log('Lightweaver WLED doctor');
  console.log('=======================');

  const serialPorts = await listSerialPorts();
  printSerial(serialPorts);

  const selectedPort = port === 'auto' ? pickSerialPort(serialPorts) : port;
  if (selectedPort) await printEspProbe(selectedPort);
  else console.log('\nESP32 serial: no USB serial/JTAG port detected');

  const candidates = buildCandidates(host, scan);
  const devices = sortWledDevices(await probeCandidates(candidates), host);
  printDevices(devices);

  if (testColor) {
    const target = devices[0]?.ip || host;
    if (!target) throw new Error('No WLED device available for test pattern');
    await sendTestPattern(target, testColor);
    console.log(`\nTest pattern: sent ${testColor} to ${target} at brightness 32`);
  }

  if (devices[0]) {
    console.log(`\nRecommended WLED_HOST=${devices[0].ip}`);
    console.log(`Run: PORT=3000 WLED_HOST=${devices[0].ip} npm run serve:pi`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scan') out.scan = true;
    else if (arg === '--host') out.host = argv[++i];
    else if (arg.startsWith('--host=')) out.host = arg.slice('--host='.length);
    else if (arg === '--port') out.port = argv[++i];
    else if (arg.startsWith('--port=')) out.port = arg.slice('--port='.length);
    else if (arg === '--test') out.test = argv[++i] || 'blue';
    else if (arg.startsWith('--test=')) out.test = arg.slice('--test='.length) || 'blue';
  }
  return out;
}

async function listSerialPorts() {
  try {
    const { stdout } = await execFileAsync('python3', ['-m', 'serial.tools.list_ports', '-v'], { timeout: 5000 });
    const ports = [];
    let current = null;
    for (const line of stdout.split('\n')) {
      if (/^\/dev\/|^COM\d+/i.test(line.trim())) {
        current = { path: line.trim(), detail: [] };
        ports.push(current);
      } else if (current && line.trim()) {
        current.detail.push(line.trim());
      }
    }
    return ports;
  } catch {
    return [];
  }
}

function pickSerialPort(ports) {
  return ports.find(port =>
    /usbmodem|usbserial/i.test(port.path) ||
    port.detail.some(line => /303A:1001|USB JTAG|serial debug/i.test(line))
  )?.path || '';
}

function printSerial(ports) {
  console.log('\nSerial ports:');
  if (!ports.length) {
    console.log('  none found by pyserial');
    return;
  }
  for (const port of ports) {
    const label = port.detail.find(line => /desc:|hwid:/i.test(line)) || '';
    console.log(`  ${port.path}${label ? `, ${label}` : ''}`);
  }
}

async function printEspProbe(selectedPort) {
  console.log(`\nESP32 probe on ${selectedPort}:`);
  for (const [label, cmd] of [
    ['chip', ['-m', 'esptool', '--chip', 'esp32s3', '--port', selectedPort, '--baud', '115200', 'chip_id']],
    ['flash', ['-m', 'esptool', '--chip', 'esp32s3', '--port', selectedPort, '--baud', '115200', 'flash_id']],
  ]) {
    try {
      const { stdout } = await execFileAsync('python3', cmd, { timeout: 12000, maxBuffer: 256_000 });
      const lines = stdout.split('\n').filter(line =>
        /Chip is|Features:|MAC:|Detected flash size|Flash type|Secure Boot|Flash Encryption/.test(line)
      );
      console.log(`  ${label}: ${lines.join(' | ') || 'ok'}`);
    } catch (error) {
      console.log(`  ${label}: ${String(error.stderr || error.message).trim()}`);
    }
  }
}

function buildCandidates(preferredHost, includeScan) {
  const set = new Set([
    preferredHost,
    'wled.local',
    'lightweaver-wled.local',
    '192.168.4.1',
    '4.3.2.1',
  ].filter(Boolean));

  if (includeScan) {
    for (const subnet of localSubnets()) {
      for (let i = 1; i <= 254; i++) set.add(`${subnet}.${i}`);
    }
  }

  return [...set];
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

async function probeCandidates(candidates) {
  const out = [];
  let index = 0;
  const workerCount = Math.min(48, Math.max(1, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < candidates.length) {
      const candidate = candidates[index++];
      const device = await probeWled(candidate);
      if (device) out.push(device);
    }
  }));
  return out;
}

async function probeWled(candidate) {
  const ip = normalizeWledHost(candidate);
  if (!ip) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(`http://${ip}/json/info`, { signal: controller.signal });
    if (!response.ok) return null;
    return summarizeWledInfo(await response.json(), { ip, source: 'probe' });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function printDevices(devices) {
  console.log('\nWLED network devices:');
  if (!devices.length) {
    console.log('  none found. Try --scan, connect to WLED-AP, or pass --host <ip>');
    return;
  }
  for (const device of devices) {
    const details = [
      device.ver && `v${device.ver}`,
      device.release,
      device.mac && `MAC ${device.mac}`,
      device.signal != null && `WiFi ${device.signal}%`,
      device.freeheap && `heap ${Math.round(device.freeheap / 1024)} kB`,
    ].filter(Boolean).join(', ');
    console.log(`  ${device.name || 'WLED'} @ ${device.ip}${details ? `, ${details}` : ''}`);
  }
}

async function sendTestPattern(ip, color) {
  const response = await fetch(`http://${ip}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeSafeWledTestState(color)),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`WLED test pattern returned HTTP ${response.status}`);
}
