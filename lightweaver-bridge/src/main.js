'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const {
  createLaunchRouter, createNonceStore, createSafeCallbackOpener, findLaunchUrlInArgv, registerProtocolClient,
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
const callbackOpener = createSafeCallbackOpener({ openExternal: url => shell.openExternal(url) });
const nonceStore = createNonceStore({ userDataPath: app.getPath('userData') });

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
  deliver: request => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Bridge window is unavailable');
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('bridge:launch-request', Object.freeze({ operation: request.operation }));
  },
});

function routeLaunch(value) {
  try { launchRouter.route(value); } catch (error) {
    process.stderr.write(`Lightweaver Bridge rejected launch request: ${redactSensitiveText(error?.message)}\n`);
  }
}

async function returnBoundedResult(payload, completedOperation) {
  const request = launchRouter.active;
  if (!request) return;
  if (request.operation !== completedOperation) {
    launchRouter.complete();
    return;
  }
  try { await callbackOpener.open(request, publicCallbackResult(payload)); }
  finally { launchRouter.complete(); }
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
  routeLaunch(url);
});

app.on('second-instance', (_event, argv) => {
  try {
    const value = findLaunchUrlInArgv(argv);
    if (value) routeLaunch(value);
  } catch (error) {
    process.stderr.write(`Lightweaver Bridge rejected argv: ${redactSensitiveText(error?.message)}\n`);
  }
});

if (singleInstance) {
  try {
    const initialLaunch = findLaunchUrlInArgv(process.argv);
    if (initialLaunch) routeLaunch(initialLaunch);
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
