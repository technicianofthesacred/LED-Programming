'use strict';

const crypto = require('node:crypto');
const { NativeSerialTransport, selectCompatiblePort } = require('./native-serial-transport');

function normalizeMac(value) {
  const hex = String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  if (!/^[a-f0-9]{12}$/.test(hex)) throw new Error('Card eFuse MAC is invalid');
  return hex;
}

function runtimeFailure(code, message, phase) {
  const error = new Error(message);
  error.code = code;
  error.phase = phase;
  return error;
}

async function connectWithTrackedCleanup({ core, port, createTransport, createLoader }) {
  let releaseFailure = null;
  const trackedTransport = candidate => {
    const transport = createTransport(candidate);
    const disconnect = transport.disconnect.bind(transport);
    transport.disconnect = async () => {
      try { return await disconnect(); } catch (error) {
        releaseFailure ||= error;
        throw error;
      }
    };
    return transport;
  };
  let connection;
  try {
    connection = await core.connectEspWithResetSequence({ port, createTransport: trackedTransport, createLoader });
  } catch (error) {
    if (releaseFailure) throw new Error(`USB release failed: ${releaseFailure?.message || 'unknown close failure'}`);
    throw error;
  }
  if (releaseFailure) {
    await connection.transport.disconnect().catch(() => {});
    throw new Error(`USB release failed: ${releaseFailure?.message || 'unknown close failure'}`);
  }
  return connection;
}

function createEsptoolRuntime({ selectPort, connect, reset }) {
  const ownedConnections = new Set();
  async function identify(connection) {
    const { loader } = connection;
    const chipName = loader?.chip?.CHIP_NAME || connection.chip;
    const flashSize = await loader.detectFlashSize();
    const mac = normalizeMac(await loader.chip.readMac(loader));
    const fingerprint = crypto.createHash('sha256').update(`${mac}|${chipName}|${flashSize}`).digest('hex');
    return Object.freeze({ cardId: `lw-${mac}`, fingerprint, chipName, flashSize });
  }

  async function connectOne() {
    const port = await selectPort();
    const connection = await connect(port);
    const disconnect = connection.transport.disconnect.bind(connection.transport);
    connection.transport.disconnect = async () => {
      try {
        const result = await disconnect();
        ownedConnections.delete(connection);
        return result;
      } catch (error) { throw error; }
    };
    ownedConnections.add(connection);
    return connection;
  }

  return Object.freeze({
    async inspectOne() {
      const connection = await connectOne();
      let identity;
      let inspectionError = null;
      let restorationError = null;
      let releaseError = null;
      try {
        try {
          identity = await identify(connection);
        } catch (error) {
          inspectionError = error;
        }
        try {
          await reset(connection);
        } catch (error) {
          restorationError = runtimeFailure('card-restoration-failed', `Card restoration failed: ${error?.message || 'hard reset failed'}`, 'inspection-restoration');
        }
      } finally {
        try { await connection.transport.disconnect(); } catch (error) {
          releaseError = runtimeFailure('usb-release-failed', `USB release failed: ${error?.message || 'unknown close failure'}`, 'usb-release');
        }
      }
      if (releaseError) throw releaseError;
      if (restorationError) throw restorationError;
      if (inspectionError) throw inspectionError;
      return identity;
    },
    async connectForWrite() {
      const connection = await connectOne();
      try {
        return { ...connection, identity: await identify(connection) };
      } catch (error) {
        try { await connection.transport.disconnect(); } catch (releaseError) {
          throw new Error(`USB release failed: ${releaseError?.message || 'unknown close failure'}`);
        }
        throw error;
      }
    },
    async restartOne() {
      const connection = await connectOne();
      try {
        const identity = await identify(connection);
        await reset(connection);
        return identity;
      } finally {
        await connection.transport.disconnect();
      }
    },
    async releaseUsb() {
      const failures = [];
      for (const connection of [...ownedConnections]) {
        try { await connection.transport.disconnect(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw runtimeFailure('usb-release-failed', `USB release failed: ${failures[0]?.message || 'unknown close failure'}`, 'usb-release');
      return Object.freeze({ released: true });
    },
    reset,
  });
}

async function createProductionDependencies() {
  const [esptool, core] = await Promise.all([
    import('esptool-js/bundle.js'),
    import('@lightweaver/installer-core'),
  ]);
  const terminal = Object.freeze({ clean() {}, writeLine() {}, write() {} });
  const runtime = createEsptoolRuntime({
    selectPort: () => selectCompatiblePort({ discoveryTimeoutMs: 5_000 }),
    connect: port => connectWithTrackedCleanup({
      core,
      port,
      createTransport: candidate => new NativeSerialTransport({ portInfo: candidate, tracing: false }),
      createLoader: ({ transport }) => new esptool.ESPLoader({ transport, baudrate: 115200, terminal }),
    }),
    reset: connection => core.resetEspIntoApp(connection.transport),
  });
  return Object.freeze({
    runtime,
    core,
    loadRelease: () => core.loadProductionFirmwareRelease(globalThis.fetch, crypto.webcrypto, { runtime: 'node' }),
  });
}

module.exports = { connectWithTrackedCleanup, createEsptoolRuntime, createProductionDependencies };
