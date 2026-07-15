'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  NativeSerialTransport,
  discoverCompatiblePorts,
  normalizeUsbId,
  selectCompatiblePort,
} = require('../src/native-serial-transport');

class FakeSerialPort extends EventEmitter {
  constructor({ writeReturns = true, deferWrites = false, deferOpen = false, deferClose = false } = {}) {
    super();
    this.isOpen = false;
    this.writes = [];
    this.signals = [];
    this.writeReturns = writeReturns;
    this.deferWrites = deferWrites;
    this.deferOpen = deferOpen;
    this.deferClose = deferClose;
    this.pendingWrites = [];
    this.pendingOpen = null;
    this.pendingCloses = [];
    this.openCalls = 0;
    this.closeCalls = 0;
    this.drainCalls = 0;
    this.flushCalls = 0;
  }

  open(callback) {
    this.openCalls += 1;
    if (this.deferOpen) this.pendingOpen = callback;
    else {
      this.isOpen = true;
      queueMicrotask(() => callback(null));
    }
  }

  completeOpen(error = null) {
    const callback = this.pendingOpen;
    this.pendingOpen = null;
    this.isOpen = !error;
    if (callback) callback(error);
  }

  close(callback) {
    this.closeCalls += 1;
    if (this.deferClose) this.pendingCloses.push(callback);
    else this._finishClose(callback, null);
  }

  _finishClose(callback, error) {
    if (!error) this.isOpen = false;
    queueMicrotask(() => {
      callback(error);
      if (!error) this.emit('close');
    });
  }

  completeClose(error = null) {
    const callback = this.pendingCloses.shift();
    if (callback) this._finishClose(callback, error);
  }

  write(data, callback) {
    this.writes.push(Uint8Array.from(data));
    if (this.deferWrites) this.pendingWrites.push(callback);
    else queueMicrotask(() => callback(null));
    return this.writeReturns;
  }

  completeWrite(error = null) {
    const callback = this.pendingWrites.shift();
    if (callback) callback(error);
  }

  drain(callback) {
    this.drainCalls += 1;
    queueMicrotask(() => callback(null));
  }

  flush(callback) {
    this.flushCalls += 1;
    queueMicrotask(() => callback(null));
  }

  set(signal, callback) {
    this.signals.push({ ...signal });
    queueMicrotask(() => callback(null));
  }
}

function createHarness(options = {}) {
  const port = options.port || new FakeSerialPort();
  const createdWith = [];
  const transport = new NativeSerialTransport({
    createPort(serialOptions) {
      createdWith.push(serialOptions);
      return port;
    },
    portInfo: {
      path: '/dev/cu.private',
      vendorId: '303A',
      productId: '1001',
    },
    ...options,
  });
  return { createdWith, port, transport };
}

async function connectAndRead(transport) {
  await transport.connect(115200);
  transport.readLoop();
}

test('opens a lazily-created native port with bounded serial options and closes idempotently', async () => {
  const { createdWith, port, transport } = createHarness();

  await transport.connect(921600, { dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'hardware' });
  assert.deepEqual(createdWith, [{
    path: '/dev/cu.private', baudRate: 921600, dataBits: 8, stopBits: 1,
    parity: 'none', rtscts: true, autoOpen: false, highWaterMark: 65536,
  }]);
  assert.equal(transport.baudrate, 921600);
  await transport.disconnect();
  await transport.disconnect();
  assert.equal(port.openCalls, 1);
  assert.equal(port.closeCalls, 1);
});

test('late open success after timeout remains owned and closes exactly once', async () => {
  const port = new FakeSerialPort({ deferOpen: true });
  const { transport } = createHarness({ port, openTimeoutMs: 15, closeTimeoutMs: 100 });
  await assert.rejects(() => transport.connect(), /open timed out/i);
  assert.equal(port.closeCalls, 0);
  assert.equal(port.listenerCount('error'), 1);
  port.completeOpen();
  await transport.disconnect();
  assert.equal(port.closeCalls, 1);
  assert.equal(port.listenerCount('error'), 0);
  assert.equal(port.listenerCount('close'), 0);
});

test('late open error after timeout releases listeners without attempting close', async () => {
  const port = new FakeSerialPort({ deferOpen: true });
  const { transport } = createHarness({ port, openTimeoutMs: 15, closeTimeoutMs: 100 });
  await assert.rejects(() => transport.connect(), /open timed out/i);
  port.completeOpen(new Error('late open failure'));
  await transport.disconnect();
  assert.equal(port.closeCalls, 0);
  assert.equal(port.listenerCount('error'), 0);
  assert.equal(port.listenerCount('close'), 0);
});

test('disconnect during open success cancels connect continuation and closes the opened port', async () => {
  const port = new FakeSerialPort({ deferOpen: true });
  const { transport } = createHarness({ port, disconnectTimeoutMs: 100 });
  const connecting = transport.connect();
  await new Promise((resolve) => setImmediate(resolve));
  const disconnecting = transport.disconnect();
  port.completeOpen();
  await assert.rejects(connecting, /cancelled.*disconnect/i);
  await disconnecting;
  assert.equal(port.closeCalls, 1);
  await assert.rejects(transport.readLoop(), /disconnect/i);
});

test('disconnect during open error still owns listener cleanup and never reconnects', async () => {
  const port = new FakeSerialPort({ deferOpen: true });
  const { transport } = createHarness({ port, disconnectTimeoutMs: 100 });
  const connecting = transport.connect();
  await new Promise((resolve) => setImmediate(resolve));
  const disconnecting = transport.disconnect();
  port.completeOpen(new Error('open failed'));
  await assert.rejects(connecting, /open failed|cancelled/i);
  await disconnecting;
  assert.equal(port.closeCalls, 0);
  assert.equal(port.listenerCount('error'), 0);
});

test('disconnect during an open timeout continues cleanup after late success', async () => {
  const port = new FakeSerialPort({ deferOpen: true });
  const { transport } = createHarness({
    port, openTimeoutMs: 10, disconnectTimeoutMs: 100, closeTimeoutMs: 100,
  });
  const connecting = transport.connect();
  const disconnecting = transport.disconnect();
  await assert.rejects(connecting, /open timed out/i);
  port.completeOpen();
  await disconnecting;
  assert.equal(port.closeCalls, 1);
  await assert.rejects(transport.readLoop(), /disconnect|timed out/i);
});

test('late open success after disconnect deadline still closes eventual native ownership once', async () => {
  const port = new FakeSerialPort({ deferOpen: true });
  const { transport } = createHarness({
    port, openTimeoutMs: 100, disconnectTimeoutMs: 10, closeTimeoutMs: 100,
  });
  const connecting = transport.connect();
  const connectionResult = assert.rejects(connecting, /cancelled.*disconnect/i);
  await assert.rejects(transport.disconnect(), /open cleanup timed out/i);
  port.completeOpen();
  await connectionResult;
  assert.equal(port.closeCalls, 1);
  assert.equal(port.isOpen, false);
  assert.equal(port.listenerCount('error'), 0);
  await transport.disconnect();
  assert.equal(port.closeCalls, 1);
});

test('late open cleanup close error remains owned and retryable after disconnect deadline', async () => {
  const port = new FakeSerialPort({ deferOpen: true, deferClose: true });
  const { transport } = createHarness({
    port, openTimeoutMs: 100, disconnectTimeoutMs: 10, closeTimeoutMs: 100,
  });
  const connecting = transport.connect();
  const connectionResult = assert.rejects(connecting, /cancelled.*disconnect/i);
  await assert.rejects(transport.disconnect(), /open cleanup timed out/i);
  port.completeOpen();
  await new Promise((resolve) => setImmediate(resolve));
  port.completeClose(new Error('late close failed'));
  await connectionResult;
  assert.equal(port.isOpen, true);
  assert.equal(port.listenerCount('error'), 1);
  const retry = transport.disconnect();
  await new Promise((resolve) => setImmediate(resolve));
  port.completeClose();
  await retry;
  assert.equal(port.closeCalls, 2);
  assert.equal(port.listenerCount('error'), 0);
});

test('readLoop collects chunks and read unescapes complete and partial SLIP packets', async () => {
  const { port, transport } = createHarness();
  await connectAndRead(transport);

  port.emit('data', Buffer.from([0xc0, 0x01, 0xdb]));
  setTimeout(() => port.emit('data', Buffer.from([0xdc, 0xdb, 0xdd, 0x02, 0xc0])), 5);
  assert.deepEqual(await transport.read(100), Uint8Array.from([0x01, 0xc0, 0xdb, 0x02]));
  await transport.disconnect();
});

test('read preserves the next packet, supports peek/inWaiting, and flushes input', async () => {
  const { port, transport } = createHarness();
  await connectAndRead(transport);
  port.emit('data', Buffer.from([0xc0, 1, 0xc0, 0xc0, 2, 0xc0]));

  assert.equal(transport.inWaiting(), 6);
  assert.deepEqual(transport.peek(), Uint8Array.from([0xc0, 1, 0xc0, 0xc0, 2, 0xc0]));
  assert.deepEqual(await transport.read(50), Uint8Array.of(1));
  assert.deepEqual(await transport.read(50), Uint8Array.of(2));
  transport.flushInput();
  assert.equal(transport.inWaiting(), 0);
  await transport.disconnect();
});

test('read rejects deterministic timeout and invalid or unfinished escape sequences', async () => {
  const { port, transport } = createHarness();
  await connectAndRead(transport);
  await assert.rejects(() => transport.read(10), /timed out/i);
  port.emit('data', Buffer.from([0xc0, 1, 0xdb, 0x99]));
  await assert.rejects(() => transport.read(20), /invalid SLIP escape/i);
  port.emit('data', Buffer.from([0xc0, 1, 0xdb]));
  await assert.rejects(() => transport.read(10), /partial SLIP packet/i);
  await transport.disconnect();
});

test('write applies esptool SLIP escaping, waits for callback/backpressure, and serializes writes', async () => {
  const port = new FakeSerialPort({ writeReturns: false, deferWrites: true });
  const { transport } = createHarness({ port, writeTimeoutMs: 200 });
  await transport.connect();
  const first = transport.write(Uint8Array.from([0xc0, 0xdb, 1]));
  const second = transport.write(Uint8Array.of(2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.writes.length, 1);
  assert.deepEqual(port.writes[0], Uint8Array.from([0xc0, 0xdb, 0xdc, 0xdb, 0xdd, 1, 0xc0]));
  port.completeWrite();
  port.emit('drain');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.writes.length, 2);
  port.completeWrite();
  port.emit('drain');
  await Promise.all([first, second]);
  assert.equal(port.drainCalls, 0);
  await transport.flushOutput();
  assert.equal(port.drainCalls, 1);
  await transport.disconnect();
});

test('disconnect waits for an active write success before resetting signals and closing', async () => {
  const port = new FakeSerialPort({ deferWrites: true });
  const { transport } = createHarness({ port, writeTimeoutMs: 1000, disconnectTimeoutMs: 200 });
  await transport.connect();
  const write = transport.write(Uint8Array.of(1));
  await new Promise((resolve) => setImmediate(resolve));
  const disconnect = transport.disconnect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.closeCalls, 0);
  assert.deepEqual(port.signals, []);
  port.completeWrite();
  await Promise.all([write, disconnect]);
  assert.deepEqual(port.signals.slice(-2), [{ dtr: false }, { rts: false }]);
  assert.equal(port.closeCalls, 1);
});

test('disconnect waits for an active write error before closing without a race', async () => {
  const port = new FakeSerialPort({ deferWrites: true });
  const { transport } = createHarness({ port, writeTimeoutMs: 1000, disconnectTimeoutMs: 200 });
  await transport.connect();
  const write = assert.rejects(transport.write(Uint8Array.of(1)), /write failed/i);
  await new Promise((resolve) => setImmediate(resolve));
  const disconnect = transport.disconnect();
  assert.equal(port.closeCalls, 0);
  port.completeWrite(new Error('write failed'));
  await Promise.all([write, disconnect]);
  assert.equal(port.closeCalls, 1);
});

test('disconnect aborts a never-callback write within a bound, skips racing signals, and is idempotent', async () => {
  const port = new FakeSerialPort({ deferWrites: true });
  const { transport } = createHarness({
    port, writeTimeoutMs: 1000, disconnectTimeoutMs: 15, closeTimeoutMs: 100,
  });
  await transport.connect();
  const write = assert.rejects(transport.write(Uint8Array.of(1)), /aborted.*disconnect/i);
  await new Promise((resolve) => setImmediate(resolve));
  const first = transport.disconnect();
  const second = transport.disconnect();
  await Promise.all([first, second, write]);
  assert.deepEqual(port.signals, []);
  assert.equal(port.closeCalls, 1);
  port.completeWrite(new Error('late callback'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.closeCalls, 1);
});

test('disconnect skips signals when a public write timeout leaves its native callback pending', async () => {
  const port = new FakeSerialPort({ deferWrites: true });
  const { transport } = createHarness({ port, writeTimeoutMs: 10, closeTimeoutMs: 100 });
  await transport.connect();
  await assert.rejects(transport.write(Uint8Array.of(1)), /write timed out/i);
  assert.equal(port.pendingWrites.length, 1);
  await transport.disconnect();
  assert.deepEqual(port.signals, []);
  assert.equal(port.closeCalls, 1);
  port.completeWrite(new Error('late callback after close'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.closeCalls, 1);
});

test('queued I/O admission caps operations and raw bytes, then recovers reservations', async () => {
  const port = new FakeSerialPort({ deferWrites: true });
  const { transport } = createHarness({
    port, maxQueuedOperations: 2, maxQueuedBytes: 4, writeTimeoutMs: 1000,
  });
  await transport.connect();
  const first = transport.write(Uint8Array.of(1, 2, 3));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(transport.write(Uint8Array.of(4, 5)), /queued.*byte/i);
  const second = transport.write(Uint8Array.of(4));
  await assert.rejects(transport.write(Uint8Array.of()), /queued.*operation/i);
  port.completeWrite();
  await new Promise((resolve) => setImmediate(resolve));
  port.completeWrite();
  await Promise.all([first, second]);
  const recovered = transport.write(Uint8Array.of(1, 2, 3, 4));
  await new Promise((resolve) => setImmediate(resolve));
  port.completeWrite();
  await recovered;
  await transport.disconnect();
});

test('rejects oversized and stalled writes rather than buffering without a bound', async () => {
  const port = new FakeSerialPort({ deferWrites: true, writeReturns: false });
  const { transport } = createHarness({ port, maxWriteBytes: 4, writeTimeoutMs: 15 });
  await transport.connect();
  await assert.rejects(() => transport.write(Uint8Array.of(1, 2, 3, 4, 5)), /write.*limit/i);
  await assert.rejects(() => transport.write(Uint8Array.of(1)), /write timed out/i);
  assert.equal(port.listenerCount('drain'), 0);
  await transport.disconnect();
});

test('serializes DTR/RTS with writes and preserves esptool Windows RTS workaround ordering', async () => {
  const { port, transport } = createHarness();
  await transport.connect();
  await transport.setDTR(true);
  await transport.setRTS(true);
  await transport.setDTR(false);
  assert.deepEqual(port.signals, [
    { dtr: true }, { rts: true }, { dtr: true }, { dtr: false },
  ]);
  await transport.disconnect();
  assert.deepEqual(port.signals.slice(-2), [{ dtr: false }, { rts: false }]);
});

test('reports numeric PID and redacted vendor/product info with bounded tracing helpers', async () => {
  const { transport } = createHarness({ maxTraceBytes: 80, maxHexBytes: 4 });
  assert.equal(transport.getPid(), 0x1001);
  assert.equal(transport.getInfo(), 'NativeSerial VendorID 0x303a ProductID 0x1001');
  assert.equal(transport.getInfo().includes('/dev/'), false);
  assert.equal(transport.hexify(Uint8Array.of(0, 255)), '00ff            ');
  assert.match(transport.hexConvert(Uint8Array.of(1, 2, 3, 4, 5)), /truncated/);
  transport.trace('x'.repeat(200));
  assert.ok((await transport.returnTrace()).length <= 80);
});

test('disconnect rejects pending reads, removes listeners, resets buffers, and invokes device-lost at most once', async () => {
  const { port, transport } = createHarness();
  let lost = 0;
  transport.setDeviceLostCallback(() => { lost += 1; });
  await connectAndRead(transport);
  const pending = transport.read(1000);
  await transport.disconnect();
  await assert.rejects(() => pending, /disconnected/i);
  assert.equal(port.listenerCount('data'), 0);
  assert.equal(port.listenerCount('error'), 0);
  assert.equal(port.listenerCount('close'), 0);
  assert.equal(transport.inWaiting(), 0);
  assert.equal(lost, 0);
});

test('close timeout rejects with ownership and listeners retained until late success confirms release', async () => {
  const port = new FakeSerialPort({ deferClose: true });
  const { transport } = createHarness({ port, closeTimeoutMs: 10 });
  await transport.connect();
  await assert.rejects(transport.disconnect(), (error) => error.code === 'SERIAL_DISCONNECT_FAILED');
  assert.equal(port.isOpen, true);
  assert.equal(port.listenerCount('error'), 1);
  assert.equal(port.closeCalls, 1);
  port.completeClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.listenerCount('error'), 0);
  await transport.disconnect();
  assert.equal(port.closeCalls, 1);
});

test('close error retains ownership and permits a bounded retry', async () => {
  const port = new FakeSerialPort({ deferClose: true });
  const { transport } = createHarness({ port, closeTimeoutMs: 50 });
  await transport.connect();
  const first = transport.disconnect();
  await new Promise((resolve) => setImmediate(resolve));
  port.completeClose(new Error('close failed'));
  await assert.rejects(first, (error) => error.code === 'SERIAL_DISCONNECT_FAILED');
  assert.equal(port.isOpen, true);
  assert.equal(port.listenerCount('error'), 1);
  const retry = transport.disconnect();
  await new Promise((resolve) => setImmediate(resolve));
  port.completeClose();
  await retry;
  assert.equal(port.closeCalls, 2);
  assert.equal(port.listenerCount('error'), 0);
});

test('double disconnect callers share one timed-out close attempt safely', async () => {
  const port = new FakeSerialPort({ deferClose: true });
  const { transport } = createHarness({ port, closeTimeoutMs: 10 });
  await transport.connect();
  const first = transport.disconnect();
  const second = transport.disconnect();
  await Promise.all([
    assert.rejects(first, /disconnect.*close|close.*timed out/i),
    assert.rejects(second, /disconnect.*close|close.*timed out/i),
  ]);
  assert.equal(port.closeCalls, 1);
  assert.equal(port.listenerCount('error'), 1);
  port.completeClose();
  await new Promise((resolve) => setImmediate(resolve));
});

test('port errors and unexpected close reject reads, close resources, and notify device-lost once', async () => {
  for (const event of ['error', 'close']) {
    const { port, transport } = createHarness();
    let lost = 0;
    transport.setDeviceLostCallback(() => { lost += 1; });
    await connectAndRead(transport);
    const pending = transport.read(1000);
    if (event === 'error') port.emit('error', new Error('cable failed'));
    else {
      port.isOpen = false;
      port.emit('close', new Error('removed'));
    }
    await assert.rejects(() => pending, /cable failed|device.*lost|removed/i);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lost, 1);
    port.emit('close', new Error('again'));
    assert.equal(lost, 1);
    await transport.disconnect();
  }
});

test('fatal teardown shares cleanup with immediate disconnect and tolerates a throwing lost callback', async () => {
  const { port, transport } = createHarness();
  transport.setDeviceLostCallback(() => { throw new Error('observer failed'); });
  await connectAndRead(transport);
  assert.doesNotThrow(() => port.emit('error', new Error('cable failed')));
  await transport.disconnect();
  assert.equal(port.closeCalls, 1);
});

test('buffer overflow fails deterministically and releases the port', async () => {
  const { port, transport } = createHarness({ maxBufferBytes: 4 });
  let lost = 0;
  transport.setDeviceLostCallback(() => { lost += 1; });
  await connectAndRead(transport);
  const pending = transport.read(1000);
  port.emit('data', Buffer.from([1, 2, 3, 4, 5]));
  await assert.rejects(() => pending, /buffer overflow/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.isOpen, false);
  assert.equal(lost, 1);
});

test('normalizes USB IDs and only discovers conservative exact VID/PID candidates', async () => {
  assert.equal(normalizeUsbId('0X303A'), 0x303a);
  assert.equal(normalizeUsbId('303a'), 0x303a);
  assert.equal(normalizeUsbId(0x303a), 0x303a);
  assert.equal(normalizeUsbId('nope'), undefined);
  const ports = await discoverCompatiblePorts({ listPorts: async () => [
    { path: '/dev/a', vendorId: '303A', productId: '1001', friendlyName: 'anything' },
    { path: '/dev/b', vendorId: '10c4', productId: 'ea60' },
    { path: '/dev/c', vendorId: '303a', productId: 'ffff', friendlyName: 'Lightweaver ESP32' },
    { path: '/dev/d', friendlyName: 'Lightweaver ESP32' },
  ] });
  assert.deepEqual(ports.map((port) => port.path), ['/dev/a', '/dev/b']);
});

test('port selection distinguishes zero, one, and ambiguous compatible candidates', async () => {
  await assert.rejects(() => selectCompatiblePort({ listPorts: async () => [] }), /no compatible/i);
  const only = { path: '/dev/only', vendorId: '303a', productId: '1001' };
  assert.equal((await selectCompatiblePort({ listPorts: async () => [only] })).path, only.path);
  await assert.rejects(() => selectCompatiblePort({ listPorts: async () => [
    only, { path: '/dev/other', vendorId: '10c4', productId: 'ea60' },
  ] }), /multiple compatible/i);
});

test('port discovery has a bounded deadline', async () => {
  await assert.rejects(() => discoverCompatiblePorts({
    listPorts: () => new Promise(() => {}),
    discoveryTimeoutMs: 15,
  }), /discovery timed out/i);
});

test('constructor rejects invalid resource and timeout limits before creating state', () => {
  const keys = [
    'maxBufferBytes', 'maxWriteBytes', 'maxTraceBytes', 'maxHexBytes',
    'maxReadTimeoutMs', 'writeTimeoutMs', 'disconnectTimeoutMs', 'openTimeoutMs',
    'closeTimeoutMs', 'maxQueuedOperations', 'maxQueuedBytes',
  ];
  for (const key of keys) {
    for (const value of [Infinity, Number.NaN, -1, 0, 1.5]) {
      assert.throws(() => createHarness({ [key]: value }), new RegExp(key, 'i'), `${key} accepted ${value}`);
    }
  }
});

test('pinned ESPLoader connects through the native transport contract without missing methods', async () => {
  const port = new FakeSerialPort();
  const { transport } = createHarness({ port });
  const originalWrite = port.write.bind(port);
  port.write = (data, callback) => {
    const accepted = originalWrite(data, callback);
    const response = [0xc0, 1, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0xc0];
    queueMicrotask(() => port.emit('data', Buffer.from(Array(8).fill(response).flat())));
    return accepted;
  };
  // The pinned package's source ESM uses extensionless imports that Node cannot
  // resolve directly; the published bundle is the executable Node artifact.
  const { ESPLoader } = require('esptool-js/bundle.js');
  const terminal = { clean() {}, write() {}, writeLine() {} };
  const loader = new ESPLoader({ transport, baudrate: 115200, terminal });

  await loader.connect('no_reset', 1, false);
  assert.equal(transport.baudrate, 115200);
  await transport.disconnect();
});
