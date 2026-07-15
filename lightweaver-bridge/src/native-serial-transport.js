'use strict';

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

const COMPATIBLE_USB_IDS = new Set([
  '303a:1001', // Espressif USB Serial/JTAG
  '303a:1002', // Espressif USB DFU/serial family
  '10c4:ea60', // Silicon Labs CP210x
  '1a86:7523', // WCH CH340
  '1a86:55d4', // WCH CH9102/CH343
  '0403:6001', // FTDI FT232
  '0403:6015', // FTDI FT-X
]);

function normalizeUsbId(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xffff) return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{1,4}$/.test(normalized)) return undefined;
  return Number.parseInt(normalized, 16);
}

function normalizedPortInfo(port) {
  if (!port || typeof port.path !== 'string' || !port.path) return null;
  const vendorId = normalizeUsbId(port.vendorId);
  const productId = normalizeUsbId(port.productId);
  if (vendorId === undefined || productId === undefined) return null;
  return { ...port, vendorId, productId };
}

function isCompatiblePort(port) {
  const normalized = normalizedPortInfo(port);
  if (!normalized) return false;
  return COMPATIBLE_USB_IDS.has(`${normalized.vendorId.toString(16).padStart(4, '0')}:${normalized.productId.toString(16).padStart(4, '0')}`);
}

async function defaultListPorts() {
  // Keep native binding loading in the Electron main-process module and out of tests/renderers.
  const { SerialPort } = require('serialport');
  return SerialPort.list();
}

async function discoverCompatiblePorts({ listPorts = defaultListPorts, discoveryTimeoutMs = 5000 } = {}) {
  if (!Number.isFinite(discoveryTimeoutMs) || discoveryTimeoutMs <= 0 || discoveryTimeoutMs > 30000) {
    throw new RangeError('Serial discovery timeout is outside allowed bounds');
  }
  const ports = await withTimeout(
    Promise.resolve().then(() => listPorts()),
    discoveryTimeoutMs,
    'Serial port discovery timed out',
  );
  if (!Array.isArray(ports)) throw new TypeError('Serial port discovery returned an invalid result');
  return ports.filter(isCompatiblePort).map(normalizedPortInfo);
}

async function selectCompatiblePort(options = {}) {
  const candidates = await discoverCompatiblePorts(options);
  if (candidates.length === 0) throw new Error('No compatible Lightweaver serial candidate found');
  if (candidates.length > 1) throw new Error('Multiple compatible Lightweaver serial candidates found; explicit physical selection is required');
  return candidates[0];
}

function defaultCreatePort(options) {
  const { SerialPort } = require('serialport');
  return new SerialPort(options);
}

function callbackOperation(invoke) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const callback = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    try {
      invoke(callback);
    } catch (error) {
      callback(error);
    }
  });
}

function withTimeout(promise, timeout, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

function requirePositiveSafeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

class NativeSerialTransport {
  constructor({
    createPort = defaultCreatePort,
    portInfo,
    tracing = false,
    enableSlipReader = true,
    maxBufferBytes = 1024 * 1024,
    maxWriteBytes = 1024 * 1024,
    maxTraceBytes = 64 * 1024,
    maxHexBytes = 256,
    maxReadTimeoutMs = 120000,
    maxQueuedOperations = 32,
    maxQueuedBytes = 2 * 1024 * 1024,
    writeTimeoutMs = 30000,
    disconnectTimeoutMs = 5000,
    openTimeoutMs = 10000,
    closeTimeoutMs = 5000,
    logger = null,
  } = {}) {
    const limits = {
      maxBufferBytes, maxWriteBytes, maxTraceBytes, maxHexBytes, maxReadTimeoutMs,
      maxQueuedOperations, maxQueuedBytes, writeTimeoutMs, disconnectTimeoutMs,
      openTimeoutMs, closeTimeoutMs,
    };
    for (const [name, value] of Object.entries(limits)) requirePositiveSafeInteger(name, value);
    const info = normalizedPortInfo(portInfo);
    if (!info) throw new TypeError('A serial port with normalized USB metadata is required');
    this._createPort = createPort;
    this._portInfo = info;
    this._port = null;
    this.tracing = tracing;
    this.slipReaderEnabled = enableSlipReader;
    this.baudrate = 0;
    this._maxBufferBytes = maxBufferBytes;
    this._maxWriteBytes = maxWriteBytes;
    this._maxTraceBytes = maxTraceBytes;
    this._maxHexBytes = maxHexBytes;
    this._maxReadTimeoutMs = maxReadTimeoutMs;
    this._maxQueuedOperations = maxQueuedOperations;
    this._maxQueuedBytes = maxQueuedBytes;
    this._writeTimeoutMs = writeTimeoutMs;
    this._disconnectTimeoutMs = disconnectTimeoutMs;
    this._openTimeoutMs = openTimeoutMs;
    this._closeTimeoutMs = closeTimeoutMs;
    this._logger = logger;
    this._buffer = Buffer.alloc(0);
    this._traceLog = '';
    this._lastTraceTime = Date.now();
    this._waiters = new Set();
    this._ioTail = Promise.resolve();
    this._ioAbortWaiters = new Set();
    this._queuedOperationCount = 0;
    this._queuedWriteBytes = 0;
    this._nativeIo = new Set();
    this._nativeIoStuck = false;
    this._connected = false;
    this._readLoopStarted = false;
    this._activeRead = false;
    this._intentionalClose = false;
    this._disconnecting = null;
    this._disconnectRequested = false;
    this._connectionGeneration = 0;
    this._openingSettlement = null;
    this._closeAttempt = null;
    this._terminalError = null;
    this._deviceLostCallback = null;
    this._deviceLostNotified = false;
    this._dtrState = false;
    this._boundData = (data) => this._onData(data);
    this._boundError = (error) => this._onFatal(error instanceof Error ? error : new Error(String(error)));
    this._boundClose = (error) => {
      if (!this._intentionalClose) this._onFatal(error instanceof Error ? error : new Error('Serial device lost'));
    };
  }

  setDeviceLostCallback(callback) {
    if (callback !== null && typeof callback !== 'function') throw new TypeError('Device-lost callback must be a function or null');
    this._deviceLostCallback = callback;
  }

  updateDevice(portInfo) {
    if (this._connected) throw new Error('Cannot replace a connected serial device');
    const info = normalizedPortInfo(portInfo);
    if (!info) throw new TypeError('A serial port with normalized USB metadata is required');
    this._portInfo = info;
  }

  getInfo() {
    return `NativeSerial VendorID 0x${this._portInfo.vendorId.toString(16).padStart(4, '0')} ProductID 0x${this._portInfo.productId.toString(16).padStart(4, '0')}`;
  }

  getPid() {
    return this._portInfo.productId;
  }

  trace(message) {
    const delta = Date.now() - this._lastTraceTime;
    this._lastTraceTime = Date.now();
    const prefix = `TRACE ${delta.toFixed(3)} `;
    const messageBudget = Math.max(0, this._maxTraceBytes - Buffer.byteLength(prefix) - 1);
    let boundedMessage = String(message);
    while (Buffer.byteLength(boundedMessage, 'utf8') > messageBudget) boundedMessage = boundedMessage.slice(1);
    const line = `${prefix}${boundedMessage}\n`;
    this._traceLog += line;
    while (Buffer.byteLength(this._traceLog, 'utf8') > this._maxTraceBytes) this._traceLog = this._traceLog.slice(1);
    if (this._logger && typeof this._logger.debug === 'function') this._logger.debug(line.trimEnd());
  }

  async returnTrace() {
    return this._traceLog;
  }

  hexify(data) {
    return Array.from(data)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .padEnd(16, ' ');
  }

  hexConvert(data, autoSplit = true) {
    const bytes = Uint8Array.from(data);
    const shown = bytes.slice(0, this._maxHexBytes);
    let result;
    if (autoSplit && shown.length > 16) {
      result = '';
      for (let offset = 0; offset < shown.length; offset += 16) {
        const line = shown.slice(offset, offset + 16);
        const ascii = Array.from(line, (byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')).join('');
        result += `\n    ${this.hexify(line.slice(0, 8))} ${this.hexify(line.slice(8))} | ${ascii}`;
      }
    } else result = this.hexify(shown);
    if (shown.length < bytes.length) result += ` … (${bytes.length - shown.length} bytes truncated)`;
    return result;
  }

  slipWriter(data) {
    const bytes = Uint8Array.from(data);
    if (bytes.length > this._maxWriteBytes) throw new RangeError(`Serial write exceeds ${this._maxWriteBytes}-byte limit`);
    const framed = [SLIP_END];
    for (const byte of bytes) {
      if (byte === SLIP_END) framed.push(SLIP_ESC, SLIP_ESC_END);
      else if (byte === SLIP_ESC) framed.push(SLIP_ESC, SLIP_ESC_ESC);
      else framed.push(byte);
    }
    framed.push(SLIP_END);
    return Uint8Array.from(framed);
  }

  async connect(baud = 115200, serialOptions = {}) {
    if (this._connected || this._port) throw new Error('Serial transport is already connected or opening');
    this._disconnectRequested = false;
    const generation = ++this._connectionGeneration;
    if (!Number.isInteger(baud) || baud <= 0 || baud > 5000000) throw new RangeError('Unsupported serial baud rate');
    const dataBits = serialOptions.dataBits === undefined ? 8 : serialOptions.dataBits;
    const stopBits = serialOptions.stopBits === undefined ? 1 : serialOptions.stopBits;
    const parity = serialOptions.parity === undefined ? 'none' : serialOptions.parity;
    if (![7, 8].includes(dataBits) || ![1, 2].includes(stopBits) || !['none', 'even', 'odd'].includes(parity)) {
      throw new RangeError('Unsupported serial framing options');
    }
    const options = {
      path: this._portInfo.path,
      baudRate: baud,
      dataBits,
      stopBits,
      parity,
      rtscts: serialOptions.flowControl === 'hardware',
      autoOpen: false,
      highWaterMark: Math.min(Math.max(serialOptions.bufferSize || 65536, 1024), this._maxBufferBytes),
    };
    this._terminalError = null;
    this._deviceLostNotified = false;
    this._nativeIo.clear();
    this._nativeIoStuck = false;
    this._buffer = Buffer.alloc(0);
    const port = this._createPort(options);
    this._port = port;
    this._attachLifecycleListeners(port);
    try {
      await this._openPort(port);
      if (this._disconnectRequested || generation !== this._connectionGeneration) {
        const error = new Error('Serial connect cancelled during disconnect');
        error.code = 'SERIAL_CONNECT_CANCELLED';
        throw error;
      }
      this._connected = true;
      this.baudrate = baud;
    } catch (error) {
      this._terminalError = error;
      if (error.code !== 'SERIAL_OPEN_TIMEOUT') {
        try {
          await this._cleanupPort(true, {
            port,
            resetSignals: error.code === 'SERIAL_CONNECT_CANCELLED',
          });
        } catch (_) {
          // Retain failed close ownership for a later explicit disconnect retry.
        }
      }
      throw error;
    }
  }

  _openPort(port) {
    let timedOut = false;
    let callbackSettled = false;
    let resolveSettlement;
    const settlement = new Promise((resolve) => { resolveSettlement = resolve; });
    this._openingSettlement = settlement;
    return new Promise((resolve, reject) => {
      const finishPromptly = (error) => {
        if (callbackSettled) return;
        callbackSettled = true;
        clearTimeout(timer);
        if (!timedOut) {
          this._openingSettlement = null;
          resolveSettlement();
          if (error) reject(error);
          else resolve();
          return;
        }
        const cleanup = error
          ? this._releaseFailedOpen(port)
          : this._cleanupPort(true, { port, resetSignals: true });
        Promise.resolve(cleanup).catch(() => {}).finally(() => {
          if (this._openingSettlement === settlement) this._openingSettlement = null;
          resolveSettlement();
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        const error = new Error('Serial open timed out');
        error.code = 'SERIAL_OPEN_TIMEOUT';
        reject(error);
      }, this._openTimeoutMs);
      try {
        port.open(finishPromptly);
      } catch (error) {
        finishPromptly(error);
      }
    });
  }

  _releaseFailedOpen(port) {
    this._removeListeners(port);
    if (this._port === port) this._port = null;
    this._buffer = Buffer.alloc(0);
  }

  readLoop() {
    if (!this._connected || !this._port) return Promise.reject(this._terminalError || new Error('Serial transport is disconnected'));
    if (!this._readLoopStarted) {
      this._readLoopStarted = true;
      this._port.on('data', this._boundData);
    }
    return Promise.resolve();
  }

  _attachLifecycleListeners(port) {
    port.on('error', this._boundError);
    port.on('close', this._boundClose);
  }

  _removeListeners(port) {
    port.removeListener('data', this._boundData);
    port.removeListener('error', this._boundError);
    port.removeListener('close', this._boundClose);
  }

  _onData(data) {
    if (!this._readLoopStarted || this._terminalError) return;
    const chunk = Buffer.from(data || []);
    if (chunk.length === 0) return;
    if (this._buffer.length + chunk.length > this._maxBufferBytes) {
      this._onFatal(new Error(`Serial buffer overflow (${this._maxBufferBytes}-byte limit)`));
      return;
    }
    this._buffer = Buffer.concat([this._buffer, chunk], this._buffer.length + chunk.length);
    if (this.tracing) this.trace(`Read ${chunk.length} bytes: ${this.hexConvert(chunk)}`);
    this._wakeWaiters();
  }

  _wakeWaiters() {
    for (const waiter of this._waiters) waiter();
    this._waiters.clear();
  }

  _onFatal(error) {
    if (this._terminalError || this._intentionalClose) return;
    this._terminalError = error;
    if (!this._deviceLostNotified) {
      this._deviceLostNotified = true;
      if (this._deviceLostCallback) {
        try {
          this._deviceLostCallback();
        } catch (_) {
          // Observers cannot be allowed to interrupt mandatory device cleanup.
        }
      }
    }
    this._wakeWaiters();
    this._abortPendingIo(error);
    if (!this._disconnecting) {
      this._disconnecting = this._cleanupPort(true, { resetSignals: false })
        .catch(() => {})
        .finally(() => { this._disconnecting = null; });
    }
  }

  flushInput() {
    this._buffer = Buffer.alloc(0);
  }

  inWaiting() {
    return this._buffer.length;
  }

  peek() {
    return Uint8Array.from(this._buffer);
  }

  _nextByte() {
    if (this._buffer.length === 0) return undefined;
    const byte = this._buffer[0];
    this._buffer = this._buffer.subarray(1);
    return byte;
  }

  _waitForData(remaining) {
    if (this._terminalError) return Promise.reject(this._terminalError);
    if (this._buffer.length) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        this._waiters.delete(wake);
        if (this._terminalError) reject(this._terminalError);
        else resolve(true);
      };
      this._waiters.add(wake);
      timer = setTimeout(() => {
        this._waiters.delete(wake);
        resolve(false);
      }, remaining);
    });
  }

  async read(timeout) {
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > this._maxReadTimeoutMs) throw new RangeError('Serial read timeout is outside allowed bounds');
    if (this._activeRead) throw new Error('Concurrent serial reads are not supported');
    if (!this._connected) throw this._terminalError || new Error('Serial transport is disconnected');
    this._activeRead = true;
    const deadline = Date.now() + timeout;
    let started = false;
    let escaping = false;
    const packet = [];
    try {
      while (true) {
        while (this._buffer.length) {
          const byte = this._nextByte();
          if (!started) {
            if (byte !== SLIP_END) throw new Error(`Invalid head of packet (0x${byte.toString(16)})`);
            started = true;
          } else if (escaping) {
            escaping = false;
            if (byte === SLIP_ESC_END) packet.push(SLIP_END);
            else if (byte === SLIP_ESC_ESC) packet.push(SLIP_ESC);
            else throw new Error(`Invalid SLIP escape (0xdb, 0x${byte.toString(16)})`);
          } else if (byte === SLIP_ESC) escaping = true;
          else if (byte === SLIP_END) return Uint8Array.from(packet);
          else packet.push(byte);
          if (packet.length > this._maxBufferBytes) throw new Error(`SLIP packet exceeds ${this._maxBufferBytes}-byte limit`);
        }
        if (this._terminalError) throw this._terminalError;
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !(await this._waitForData(remaining))) {
          if (started) throw new Error('Serial read timed out with partial SLIP packet');
          throw new Error('Serial read timed out');
        }
      }
    } finally {
      this._activeRead = false;
    }
  }

  _admitIo(bytes) {
    if (!this._connected || !this._port || this._terminalError) {
      throw this._terminalError || new Error('Serial transport is disconnected');
    }
    if (this._queuedOperationCount + 1 > this._maxQueuedOperations) {
      throw new Error(`Serial queued operation limit exceeded (${this._maxQueuedOperations})`);
    }
    if (this._queuedWriteBytes + bytes > this._maxQueuedBytes) {
      throw new Error(`Serial queued byte limit exceeded (${this._maxQueuedBytes})`);
    }
    this._queuedOperationCount += 1;
    this._queuedWriteBytes += bytes;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this._queuedOperationCount -= 1;
        this._queuedWriteBytes -= bytes;
      },
    };
  }

  _enqueue(task, reservation = null) {
    let admitted = reservation;
    try {
      if (!admitted) admitted = this._admitIo(0);
    } catch (error) {
      return Promise.reject(error);
    }
    const admittedPort = this._port;
    const operation = this._ioTail.then(() => {
      if (this._port !== admittedPort || !admittedPort.isOpen) throw this._terminalError || new Error('Serial transport is disconnected');
      return task(admittedPort);
    });
    const completed = operation.finally(() => admitted.release());
    this._ioTail = completed.catch(() => {});
    return completed;
  }

  _abortable(promise) {
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = (error) => reject(error);
      this._ioAbortWaiters.add(abort);
    });
    return Promise.race([promise, aborted]).finally(() => this._ioAbortWaiters.delete(abort));
  }

  _abortPendingIo(error) {
    for (const abort of this._ioAbortWaiters) abort(error);
  }

  _trackNativeIo(promise) {
    const token = { settled: false, settlement: null };
    token.settlement = Promise.resolve(promise)
      .then(() => undefined, () => undefined)
      .finally(() => {
        token.settled = true;
        this._nativeIo.delete(token);
      });
    this._nativeIo.add(token);
    return token;
  }

  async _awaitTrackedNative(promise, timeout, message) {
    const token = this._trackNativeIo(promise);
    try {
      return await withTimeout(this._abortable(promise), timeout, message);
    } catch (error) {
      if (!token.settled && error instanceof Error && /timed out/i.test(error.message)) this._nativeIoStuck = true;
      throw error;
    }
  }

  async write(data) {
    const length = data && data.length;
    if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('Serial write data must have a safe byte length');
    if (length > this._maxWriteBytes) throw new RangeError(`Serial write exceeds ${this._maxWriteBytes}-byte limit`);
    const reservation = this._admitIo(length);
    let framed;
    try {
      framed = this.slipWriter(data);
    } catch (error) {
      reservation.release();
      throw error;
    }
    return this._enqueue(async (port) => {
      if (this.tracing) this.trace(`Write ${framed.length} bytes: ${this.hexConvert(framed)}`);
      let accepted = true;
      const callbackDone = callbackOperation((callback) => { accepted = port.write(Buffer.from(framed), callback); });
      let cleanupBackpressure = () => {};
      const backpressureDone = accepted ? Promise.resolve() : new Promise((resolve, reject) => {
          const onDrain = () => { cleanupBackpressure(); resolve(); };
          const onError = (error) => { cleanupBackpressure(); reject(error); };
          cleanupBackpressure = () => {
            port.removeListener('drain', onDrain);
            port.removeListener('error', onError);
          };
          port.once('drain', onDrain);
          port.once('error', onError);
        });
      try {
        await this._awaitTrackedNative(
          Promise.all([callbackDone, backpressureDone]),
          this._writeTimeoutMs,
          'Serial write timed out',
        );
      } finally {
        cleanupBackpressure();
      }
    }, reservation);
  }

  async flushOutput() {
    return this._enqueue(async (port) => {
      const drain = callbackOperation((callback) => port.drain(callback));
      await this._awaitTrackedNative(drain, this._writeTimeoutMs, 'Serial output flush timed out');
    });
  }

  async setDTR(state) {
    const next = Boolean(state);
    return this._enqueue(async (port) => {
      const update = callbackOperation((callback) => port.set({ dtr: next }, callback));
      await this._awaitTrackedNative(update, this._writeTimeoutMs, 'Serial DTR update timed out');
      this._dtrState = next;
    });
  }

  async setRTS(state) {
    const next = Boolean(state);
    return this._enqueue(async (port) => {
      const rts = callbackOperation((callback) => port.set({ rts: next }, callback));
      await this._awaitTrackedNative(rts, this._writeTimeoutMs, 'Serial RTS update timed out');
      const dtr = callbackOperation((callback) => port.set({ dtr: this._dtrState }, callback));
      await this._awaitTrackedNative(dtr, this._writeTimeoutMs, 'Serial DTR refresh timed out');
    });
  }

  async waitForUnlock(timeout = 5000) {
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120000) throw new RangeError('Serial unlock timeout is outside allowed bounds');
    await withTimeout(this._ioTail, timeout, 'Serial transport unlock timed out');
  }

  async disconnect() {
    if (this._disconnecting) return this._disconnecting;
    if (!this._port && !this._connected) return;
    if (!this._disconnectRequested) {
      this._disconnectRequested = true;
      this._connectionGeneration += 1;
    }
    if (!this._terminalError) this._terminalError = new Error('Serial transport disconnected');
    this._wakeWaiters();
    this._disconnecting = this._disconnectSequence().finally(() => { this._disconnecting = null; });
    return this._disconnecting;
  }

  async _disconnectSequence() {
    if (this._openingSettlement) {
      await withTimeout(this._openingSettlement, this._disconnectTimeoutMs, 'Serial open cleanup timed out');
    }
    const admittedIo = this._ioTail;
    const nativeIo = Promise.all(Array.from(this._nativeIo, (token) => token.settlement));
    let ioDrained = !(this._nativeIoStuck && this._nativeIo.size > 0);
    if (ioDrained) {
      try {
        await withTimeout(
          Promise.all([admittedIo, nativeIo]),
          this._disconnectTimeoutMs,
          'Serial I/O drain timed out during disconnect',
        );
      } catch (_) {
        ioDrained = false;
      }
    }
    if (!ioDrained) {
      this._abortPendingIo(new Error('Serial I/O aborted during disconnect'));
      try {
        await withTimeout(admittedIo, Math.min(this._closeTimeoutMs, 1000), 'Serial I/O abort timed out');
      } catch (_) {
        // The native close below is the final ownership boundary for a stuck callback.
      }
    }
    await this._cleanupPort(false, { resetSignals: ioDrained });
  }

  _disconnectFailure(message, cause) {
    const error = new Error(`Serial disconnect failed: ${message}`);
    error.code = 'SERIAL_DISCONNECT_FAILED';
    error.cause = cause;
    return error;
  }

  _finalizeClosedPort(port, generation = this._connectionGeneration, attempt = null) {
    if (attempt && this._closeAttempt === attempt) this._closeAttempt = null;
    if (this._port !== port || generation !== this._connectionGeneration) return;
    this._removeListeners(port);
    this._buffer = Buffer.alloc(0);
    this._port = null;
    this._nativeIo.clear();
    this._nativeIoStuck = false;
    if (this._closeAttempt && this._closeAttempt.port === port) this._closeAttempt = null;
    this._intentionalClose = false;
  }

  async _closePort(port) {
    let attempt = this._closeAttempt;
    if (attempt && attempt.port === port) {
      try {
        await withTimeout(attempt.settlement, this._closeTimeoutMs, 'Serial close timed out');
        return;
      } catch (error) {
        throw this._disconnectFailure(error.message || 'close failed', error);
      }
    }
    if (!port.isOpen) {
      this._finalizeClosedPort(port);
      return;
    }
    if (!attempt || attempt.port !== port) {
      let resolveSettlement;
      let rejectSettlement;
      const settlement = new Promise((resolve, reject) => {
        resolveSettlement = resolve;
        rejectSettlement = reject;
      });
      attempt = {
        port,
        settlement,
        settled: false,
        generation: this._connectionGeneration,
      };
      this._closeAttempt = attempt;
      const callback = (error) => {
        if (attempt.settled) return;
        attempt.settled = true;
        if (error) {
          if (this._closeAttempt === attempt) this._closeAttempt = null;
          if (attempt.generation === this._connectionGeneration) this._intentionalClose = false;
          rejectSettlement(error);
          return;
        }
        this._finalizeClosedPort(port, attempt.generation, attempt);
        resolveSettlement();
      };
      try {
        port.close(callback);
      } catch (error) {
        callback(error);
      }
    }
    try {
      await withTimeout(attempt.settlement, this._closeTimeoutMs, 'Serial close timed out');
    } catch (error) {
      throw this._disconnectFailure(error.message || 'close failed', error);
    }
  }

  async _cleanupPort(preserveError, { port = this._port, resetSignals = true } = {}) {
    if (!port) return;
    this._intentionalClose = true;
    if (this._port === port) {
      this._connected = false;
      this._readLoopStarted = false;
    }
    this._wakeWaiters();
    if (this._closeAttempt && this._closeAttempt.port === port) {
      await this._closePort(port);
      return;
    }
    if (port.isOpen) {
      if (resetSignals) {
        try {
          await withTimeout(callbackOperation((callback) => port.set({ dtr: false }, callback)), Math.min(this._closeTimeoutMs, 1000), 'Serial signal reset timed out');
          await withTimeout(callbackOperation((callback) => port.set({ rts: false }, callback)), Math.min(this._closeTimeoutMs, 1000), 'Serial signal reset timed out');
        } catch (_) {
          // Closing the port remains mandatory even when a disconnected adapter rejects signal changes.
        }
      }
      await this._closePort(port);
      return;
    }
    this._finalizeClosedPort(port);
  }
}

module.exports = {
  COMPATIBLE_USB_IDS,
  NativeSerialTransport,
  discoverCompatiblePorts,
  isCompatiblePort,
  normalizeUsbId,
  selectCompatiblePort,
};
