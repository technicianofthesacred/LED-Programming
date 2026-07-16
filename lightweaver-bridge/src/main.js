'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const {
  createBoundedResultCoordinator, createLaunchRouter, createNonceStore, createPendingResultStore, createSafeCallbackOpener,
  findProtocolUrlInArgv, parseAcknowledgementUrl, registerProtocolClient,
} = require('./deep-link-protocol');
const { createIpcHandlers } = require('./ipc-handlers');
const { createProductionDependencies } = require('./esptool-runtime');
const { createOperationRunner } = require('./operation-runner');
const { createOperationState } = require('./operation-state');
const { redactSensitiveText } = require('./protocol');
const { createWindowOptions, installWebContentsGuards, isTrustedIpcEvent } = require('./security');

const rendererPath = path.join(__dirname, 'renderer', 'index.html');
const preloadPath = path.join(__dirname, 'preload.js');
const smokeTest = process.argv.includes('--smoke-test');
const inspectCardSmoke = process.argv.includes('--inspect-card');
const operationState = createOperationState();
let mainWindow = null;
let productionRunner = null;
const callbackOpener = createSafeCallbackOpener({ openExternal: url => shell.openExternal(url) });
const nonceStore = createNonceStore({ userDataPath: app.getPath('userData') });
const pendingResultStore = createPendingResultStore({ userDataPath: app.getPath('userData') });

function publicCallbackResult(payload) {
  const status = payload.state === 'awaiting-card-acknowledgement'
    ? payload.state
    : payload.classification === 'usb-ownership-uncertain' || payload.state === 'usb-ownership-uncertain'
      ? 'usb-ownership-uncertain'
      : payload.classification === 'needs-safe-recovery' || payload.state === 'recovery-required'
        ? 'needs-safe-recovery' : 'recoverable-failure';
  return Object.freeze({
    status,
    code: typeof payload.code === 'string' ? payload.code : status,
    ...(status === 'awaiting-card-acknowledgement' ? {
      cardId: payload.cardId, firmwareVersion: payload.firmwareVersion, buildId: payload.buildId,
    } : {}),
    target: 'lightweaver-controller-esp32s3',
    verification: payload.verification === 'flash-verified' ? 'flash-verified' : 'not-verified',
    physicalOutput: 'unconfirmed',
  });
}

const launchRouter = createLaunchRouter({
  consumeNonce: request => nonceStore.consume(request),
  canAccept: () => operationState.current === 'select-card' && !productionRunner?.isActive?.() && !resultCoordinator?.hasPendingResult,
  deliver: request => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Bridge window is unavailable');
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('bridge:launch-request', Object.freeze({ operation: request.operation }));
  },
});
const resultCoordinator = createBoundedResultCoordinator({
  launchRouter,
  openCallback: (request, result, receipt) => callbackOpener.open(request, result, receipt),
  resultStore: pendingResultStore,
});

function routeProtocol(value) {
  try {
    if (value.startsWith('lightweaver://ack?')) {
      const acknowledged = resultCoordinator.acknowledge(parseAcknowledgementUrl(value).receipt);
      if (acknowledged) sendCallbackDelivery('callback-returned', 'The originating Studio acknowledged the saved result. No card operation was rerun.');
      return acknowledged;
    }
    launchRouter.route(value);
    return true;
  } catch (error) {
    process.stderr.write(`Lightweaver Bridge rejected protocol request: ${redactSensitiveText(error?.message)}\n`);
    return false;
  }
}

function sendCallbackDelivery(state, message, returnCode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('bridge:callback-delivery', Object.freeze({ state, message, ...(returnCode ? { returnCode } : {}) }));
}

async function returnBoundedResult(payload, completedOperation, context) {
  try {
    const pending = await resultCoordinator.complete(completedOperation, publicCallbackResult(payload), context);
    if (!pending) return pending;
    const delivery = Object.freeze({
      state: 'return-pending',
      message: 'Return pending. If another browser opened, paste the one-time code into the original Studio tab.',
      returnCode: pending.returnCode,
    });
    sendCallbackDelivery(delivery.state, delivery.message, delivery.returnCode);
    return delivery;
  } catch (error) {
    if (error?.code === 'callback-delivery-failed') {
      const delivery = Object.freeze({ state: 'callback-delivery-failed', message: 'Studio could not be opened. Return to Studio again without rerunning the card operation.' });
      sendCallbackDelivery(delivery.state, delivery.message);
      return delivery;
    }
    if (error?.code === 'launch-expired') {
      const delivery = Object.freeze({ state: 'launch-expired', message: 'The secure return window expired. Open led.mandalacodes.com manually to continue.' });
      sendCallbackDelivery(delivery.state, delivery.message);
      return delivery;
    }
    process.stderr.write(`Lightweaver Bridge rejected callback result: ${redactSensitiveText(error?.message)}\n`);
    return null;
  }
}

async function retryBoundedResult() {
  try {
    const pending = await resultCoordinator.retry();
    if (!pending) return Object.freeze({ state: 'launch-expired', message: 'No pending Studio result remains. Open led.mandalacodes.com manually.' });
    return Object.freeze({ state: 'return-pending', message: 'Return pending; no card operation reran. Paste the code into the original Studio tab.', returnCode: pending.returnCode });
  } catch (error) {
    const state = error?.code === 'launch-expired' ? 'launch-expired' : 'callback-delivery-failed';
    const message = state === 'launch-expired'
      ? 'The secure return window expired. Open led.mandalacodes.com manually to continue.'
      : 'Studio still could not be opened. Try Return to Studio again.';
    sendCallbackDelivery(state, message);
    return Object.freeze({ state, message });
  }
}

async function createProductionRunner() {
  const dependencies = await createProductionDependencies();
  return createOperationRunner({
    ...dependencies,
    randomBytes: size => crypto.randomBytes(size),
  });
}

function registerIpcHandlers(runner) {
  const handlers = createIpcHandlers({
    getActiveWindow: () => mainWindow,
    rendererPath,
    operation: operationState,
    runner,
    onBoundedResult: returnBoundedResult,
    claimLaunchContext: requestedOperation => launchRouter.active ? launchRouter.claim(requestedOperation) : null,
    retryCallback: retryBoundedResult,
    dismissExpiredLaunch: () => launchRouter.dismissExpired(),
  });
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
}

async function createMainWindow() {
  const window = new BrowserWindow(createWindowOptions(preloadPath, { show: !smokeTest }));
  mainWindow = window;
  const preloadReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Preload did not become ready')), 5_000);
    ipcMain.once('bridge:preload-ready', (event) => {
      if (!isTrustedIpcEvent(event, window, rendererPath)) {
        clearTimeout(timeout);
        reject(new Error('Preload readiness came from an unexpected renderer'));
        return;
      }
      clearTimeout(timeout);
      resolve();
    });
  });
  installWebContentsGuards(window.webContents);
  window.webContents.on('console-message', (event) => {
    const message = redactSensitiveText(event.message);
    if (message) process.stderr.write(`[renderer] ${message}\n`);
  });
  window.on('close', (event) => {
    if (operationState.shouldPreventClose()) event.preventDefault();
  });
  await window.loadFile(rendererPath);
  await preloadReady;
  if (window.webContents.mainFrame.url !== pathToFileURL(rendererPath).href) {
    throw new Error('Renderer loaded an unexpected URL');
  }
  launchRouter.setReady();
  if (resultCoordinator.returnCode) {
    sendCallbackDelivery('return-pending', 'A saved return is pending. Paste the code into the original Studio tab.', resultCoordinator.returnCode);
  }
  return window;
}

function verifyNavigationIsDenied(window) {
  return new Promise((resolve, reject) => {
    let navigationAttempted = false;
    const timeout = setTimeout(() => reject(new Error('Navigation denial check timed out')), 3_000);
    window.webContents.once('will-navigate', (_event, url) => {
      if (url !== 'https://unexpected.invalid/') {
        reject(new Error('Navigation check targeted an unexpected URL'));
        return;
      }
      navigationAttempted = true;
    });
    ipcMain.once('bridge:smoke-navigation-attempted', (event) => {
      clearTimeout(timeout);
      if (!isTrustedIpcEvent(event, window, rendererPath)) {
        reject(new Error('Navigation check came from an untrusted renderer'));
        return;
      }
      setImmediate(() => {
        if (!navigationAttempted) {
          reject(new Error('Unexpected navigation was not attempted'));
          return;
        }
        if (window.webContents.mainFrame.url !== pathToFileURL(rendererPath).href) {
          reject(new Error('Unexpected renderer navigation was not denied'));
          return;
        }
        resolve();
      });
    });
    window.webContents.send('bridge:smoke-attempt-navigation');
  });
}

async function run() {
  const runner = await createProductionRunner();
  productionRunner = runner;
  if (inspectCardSmoke) {
    const inspection = await runner.inspect();
    process.stdout.write(`Compatible card inspected and USB released: ${inspection.cardId}\n`);
    app.exit(0);
    return;
  }
  registerIpcHandlers(runner);
  mainWindow = await createMainWindow();
  if (smokeTest) {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Smoke-test window was not created');
    await verifyNavigationIsDenied(mainWindow);
    process.stdout.write('Lightweaver Bridge smoke test passed\n');
    mainWindow.destroy();
    app.exit(0);
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else registerProtocolClient(app);

app.on('open-url', (event, url) => {
  event.preventDefault();
  routeProtocol(url);
});

app.on('second-instance', (_event, argv) => {
  try {
    const value = findProtocolUrlInArgv(argv);
    if (value) routeProtocol(value);
  } catch (error) {
    process.stderr.write(`Lightweaver Bridge rejected argv: ${redactSensitiveText(error?.message)}\n`);
  }
});

if (singleInstance) {
  try {
    const initialLaunch = findProtocolUrlInArgv(process.argv);
    if (initialLaunch) routeProtocol(initialLaunch);
  } catch (error) {
    process.stderr.write(`Lightweaver Bridge rejected initial argv: ${redactSensitiveText(error?.message)}\n`);
  }
}

if (singleInstance) app.whenReady().then(run).catch((error) => {
  process.stderr.write(`Lightweaver Bridge failed: ${redactSensitiveText(error && error.message)}\n`);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (!smokeTest && !inspectCardSmoke) app.quit();
});

app.on('activate', async () => {
  if (!smokeTest && !inspectCardSmoke && BrowserWindow.getAllWindows().length === 0) mainWindow = await createMainWindow();
});

if (smokeTest) {
  setTimeout(() => {
    process.stderr.write('Lightweaver Bridge smoke test timed out\n');
    app.exit(1);
  }, 10_000).unref();
}
