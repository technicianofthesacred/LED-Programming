import { SerialPort, ReadlineParser } from 'serialport';
import { DEFAULT_LWUSB_MAX_PIXELS, isLwUsbFrameHex, pixelsToLwUsbFrameHex } from '../src/lib/usbLedFrame.js';
import { normalizeUsbLedColorOrder } from '../src/lib/usbLedColorOrder.js';
import { parseUsbRotaryInputLine } from '../src/lib/usbRotaryInput.js';

const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_RESPONSE_TIMEOUT_MS = 1800;
const DEFAULT_CONNECT_SETTLE_MS = 900;
const MAX_RECENT_LINES = 24;
const MAX_INPUT_EVENTS = 48;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizePortPath(path) {
  return String(path || '').trim();
}

function hashFrameHex(frameHex) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < frameHex.length; i++) {
    hash ^= frameHex.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function lineMatches(command, line) {
  if (!line) return false;
  if (line.startsWith('LWUSB ERR')) return true;
  if (command === 'ID?') return line.startsWith('LWUSB CONFIG');
  if (command === 'HELP') return line.startsWith('LWUSB HELP');
  if (command.startsWith('ORDER ')) return line.startsWith('LWUSB OK colorOrder=');
  if (command.startsWith('COUNT ')) return line.startsWith('LWUSB OK pixels=');
  if (command.startsWith('BRI ')) return line.startsWith('LWUSB OK brightness=');
  if (command.startsWith('SOLID ')) return line === 'LWUSB OK solid';
  if (command.startsWith('CHASE ')) return line === 'LWUSB OK chase';
  if (command === 'WARM') return line === 'LWUSB OK warm';
  if (command === 'CLEAR') return line === 'LWUSB OK clear';
  if (command === 'TEST') return line === 'LWUSB OK test';
  if (command.startsWith('FRAME ')) return line.startsWith('LWUSB OK frame');
  return line.startsWith('LWUSB OK');
}

function isRecoverableSerialNoise(error) {
  return /^LWUSB ERR (invalid-frame|command-too-long)\b/.test(error?.message || '');
}

function summarizePort(port) {
  return {
    path: port.path,
    manufacturer: port.manufacturer || null,
    serialNumber: port.serialNumber || null,
    vendorId: port.vendorId || null,
    productId: port.productId || null,
  };
}

function isLikelyUsbController(port) {
  const text = `${port.path || ''} ${port.manufacturer || ''} ${port.vendorId || ''} ${port.productId || ''}`.toLowerCase();
  return text.includes('usbmodem') || text.includes('usbserial') || text.includes('1a86') || text.includes('wch');
}

export class LwUsbController {
  constructor({
    portPath = '',
    baudRate = DEFAULT_BAUD_RATE,
    maxPixels = DEFAULT_LWUSB_MAX_PIXELS,
    responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
    colorOrder = 'RGB',
  } = {}) {
    this.defaultPortPath = normalizePortPath(portPath);
    this.baudRate = normalizePositiveInt(baudRate, DEFAULT_BAUD_RATE, 9600, 2000000);
    this.maxPixels = normalizePositiveInt(maxPixels, DEFAULT_LWUSB_MAX_PIXELS, 1, DEFAULT_LWUSB_MAX_PIXELS);
    this.responseTimeoutMs = responseTimeoutMs;
    this.port = null;
    this.parser = null;
    this.portPath = '';
    this.pending = [];
    this.recentLines = [];
    this.lastError = null;
    this.lastFrameAt = 0;
    this.lastFramePixels = 0;
    this.lastFrameHash = null;
    this.lastFrameChanged = false;
    this.lastFrameHead = '';
    this.frameWritePending = false;
    this.frameWriteTimer = null;
    this.colorOrder = normalizeUsbLedColorOrder(colorOrder);
    this.inputEvents = [];
    this.inputEventSeq = 0;
  }

  status() {
    return {
      connected: !!this.port?.isOpen,
      portPath: this.portPath || null,
      baudRate: this.baudRate,
      maxPixels: this.maxPixels,
      lastError: this.lastError,
      lastFrameAt: this.lastFrameAt || null,
      lastFramePixels: this.lastFramePixels || 0,
      lastFrameHash: this.lastFrameHash,
      lastFrameChanged: this.lastFrameChanged,
      lastFrameHead: this.lastFrameHead,
      colorOrder: this.colorOrder,
      recentLines: this.recentLines.slice(-8),
      inputEvents: this.inputEvents.slice(-16),
    };
  }

  async ports() {
    const ports = await SerialPort.list();
    return ports.map(summarizePort);
  }

  async findPort() {
    if (this.defaultPortPath) return this.defaultPortPath;
    const ports = await SerialPort.list();
    const likely = ports.find(isLikelyUsbController) || ports.find(port => /usb/i.test(port.path || ''));
    return likely?.path || '';
  }

  async connect({ portPath, baudRate, pixelCount, brightness, colorOrder } = {}) {
    const targetPort = normalizePortPath(portPath) || await this.findPort();
    if (!targetPort) throw new Error('No USB LED controller serial port found');

    const targetBaud = normalizePositiveInt(baudRate, this.baudRate, 9600, 2000000);
    const alreadyOpen = this.port?.isOpen && this.portPath === targetPort && this.baudRate === targetBaud;
    if (!alreadyOpen) {
      await this.disconnect();
      this.portPath = targetPort;
      this.baudRate = targetBaud;
      this.port = new SerialPort({ path: targetPort, baudRate: targetBaud, autoOpen: false });
      this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
      this.parser.on('data', line => this.handleLine(line));
      this.port.on('error', error => {
        this.lastError = error.message;
      });
      this.port.on('close', () => {
        this.rejectAll(new Error('USB LED serial port closed'));
      });
      await new Promise((resolve, reject) => {
        this.port.open(error => error ? reject(error) : resolve());
      });
      await sleep(DEFAULT_CONNECT_SETTLE_MS);
    }

    await this.sendCommandRecoveringSerialNoise('ID?', { timeoutMs: 2400 });
    await this.sendCommandRecoveringSerialNoise(`ORDER ${normalizeUsbLedColorOrder(colorOrder, this.colorOrder)}`);
    if (pixelCount != null) {
      const count = normalizePositiveInt(pixelCount, 30, 1, this.maxPixels);
      await this.sendCommandRecoveringSerialNoise(`COUNT ${count}`);
    }
    if (brightness != null) {
      const bri = normalizePositiveInt(brightness, 64, 0, 255);
      await this.sendCommandRecoveringSerialNoise(`BRI ${bri}`);
    }
    this.lastError = null;
    return this.status();
  }

  async disconnect() {
    this.rejectAll(new Error('USB LED serial port disconnected'));
    this.releaseFrameWrite();
    const port = this.port;
    this.port = null;
    this.parser = null;
    if (!port?.isOpen) return;
    await new Promise(resolve => port.close(() => resolve()));
  }

  async sendCommand(command, { timeoutMs = this.responseTimeoutMs } = {}) {
    const clean = String(command || '').trim();
    if (!clean) throw new Error('Missing USB LED command');
    this.ensureOpen();

    return new Promise((resolve, reject) => {
      const pending = {
        command: clean,
        lines: [],
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending = this.pending.filter(item => item !== pending);
          reject(new Error(`USB LED command timed out: ${clean}`));
        }, timeoutMs),
      };
      this.pending.push(pending);
      this.port.write(`${clean}\n`, error => {
        if (error) {
          this.pending = this.pending.filter(item => item !== pending);
          clearTimeout(pending.timer);
          reject(error);
        }
      });
    });
  }

  async sendCommandRecoveringSerialNoise(command, options = {}) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.sendCommand(command, options);
      } catch (error) {
        lastError = error;
        if (!isRecoverableSerialNoise(error) || attempt === 2) throw error;
        await sleep(80);
      }
    }
    throw lastError;
  }

  sendFrame({ pixels, hex } = {}) {
    this.ensureOpen();
    const frameHex = hex != null ? String(hex).trim() : pixelsToLwUsbFrameHex(pixels, { maxPixels: this.maxPixels });
    if (!isLwUsbFrameHex(frameHex)) throw new Error('Invalid USB LED frame hex');
    if (!frameHex.length) return { skipped: true, pixels: 0 };
    const framePixels = frameHex.length / 6;
    if (framePixels > this.maxPixels) throw new Error(`USB LED frame has ${framePixels} pixels, max ${this.maxPixels}`);
    if (this.frameWritePending) return { skipped: true, pixels: framePixels, reason: 'serial write pending' };
    if (this.port.writableLength > 24000) return { skipped: true, pixels: framePixels, reason: 'serial backpressure' };

    this.frameWritePending = true;
    this.frameWriteTimer = setTimeout(() => {
      this.releaseFrameWrite();
    }, 250);
    this.frameWriteTimer.unref?.();

    this.port.write(`FRAME ${frameHex}\n`, error => {
      if (error) this.lastError = error.message;
      this.releaseFrameWrite();
    });
    const frameHash = hashFrameHex(frameHex);
    this.lastFrameAt = Date.now();
    this.lastFramePixels = framePixels;
    this.lastFrameChanged = this.lastFrameHash !== frameHash;
    this.lastFrameHash = frameHash;
    this.lastFrameHead = frameHex.slice(0, 24);
    return { ok: true, pixels: framePixels };
  }

  releaseFrameWrite() {
    if (this.frameWriteTimer) {
      clearTimeout(this.frameWriteTimer);
      this.frameWriteTimer = null;
    }
    this.frameWritePending = false;
  }

  ensureOpen() {
    if (!this.port?.isOpen) throw new Error('USB LED controller is not connected');
  }

  handleLine(rawLine) {
    const line = String(rawLine || '').trim();
    if (!line) return;
    this.recentLines.push(line);
    if (this.recentLines.length > MAX_RECENT_LINES) this.recentLines.shift();
    const orderMatch = line.match(/\bcolorOrder=(RGB|GRB|BRG|BGR|RBG|GBR)\b/i);
    if (orderMatch) this.colorOrder = orderMatch[1].toUpperCase();
    const inputEvent = parseUsbRotaryInputLine(line);
    if (inputEvent) this.pushInputEvent(inputEvent, line);

    for (const pending of [...this.pending]) {
      pending.lines.push(line);
      if (!lineMatches(pending.command, line)) continue;
      this.pending = this.pending.filter(item => item !== pending);
      clearTimeout(pending.timer);
      if (line.startsWith('LWUSB ERR')) {
        pending.reject(new Error(line));
      } else {
        pending.resolve({ line, lines: pending.lines });
      }
      break;
    }
  }

  pushInputEvent(event, line = '') {
    this.inputEventSeq += 1;
    this.inputEvents.push({
      id: this.inputEventSeq,
      at: Date.now(),
      source: 'usb-serial',
      line,
      ...event,
    });
    if (this.inputEvents.length > MAX_INPUT_EVENTS) {
      this.inputEvents.splice(0, this.inputEvents.length - MAX_INPUT_EVENTS);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending = [];
  }
}
