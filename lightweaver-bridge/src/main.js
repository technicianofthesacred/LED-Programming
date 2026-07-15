'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createIpcHandlers } = require('./ipc-handlers');
const { createOperationState } = require('./operation-state');
const { redactSensitiveText } = require('./protocol');
const { createWindowOptions, installWebContentsGuards, isTrustedIpcEvent } = require('./security');

const rendererPath = path.join(__dirname, 'renderer', 'index.html');
const preloadPath = path.join(__dirname, 'preload.js');
const smokeTest = process.argv.includes('--smoke-test');
const operationState = createOperationState();
let mainWindow = null;

function registerIpcHandlers() {
  const handlers = createIpcHandlers({
    getActiveWindow: () => mainWindow,
    rendererPath,
    operation: operationState,
    inspectCard: async () => ({ compatible: false }),
    createToken: () => crypto.randomBytes(24).toString('hex'),
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
  registerIpcHandlers();
  mainWindow = await createMainWindow();
  if (smokeTest) {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Smoke-test window was not created');
    await verifyNavigationIsDenied(mainWindow);
    process.stdout.write('Lightweaver Bridge smoke test passed\n');
    mainWindow.destroy();
    app.exit(0);
  }
}

app.whenReady().then(run).catch((error) => {
  process.stderr.write(`Lightweaver Bridge failed: ${redactSensitiveText(error && error.message)}\n`);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (!smokeTest) app.quit();
});

app.on('activate', async () => {
  if (!smokeTest && BrowserWindow.getAllWindows().length === 0) mainWindow = await createMainWindow();
});

if (smokeTest) {
  setTimeout(() => {
    process.stderr.write('Lightweaver Bridge smoke test timed out\n');
    app.exit(1);
  }, 10_000).unref();
}
