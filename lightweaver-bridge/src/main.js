'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { validateOperation, validateToken, sanitizeText } = require('./bridge-api');
const { createOperationState } = require('./operation-state');
const { createWindowOptions, installWebContentsGuards } = require('./security');

const rendererPath = path.join(__dirname, 'renderer', 'index.html');
const preloadPath = path.join(__dirname, 'preload.js');
const smokeTest = process.argv.includes('--smoke-test');
const operationState = createOperationState();
let confirmationToken = null;
let mainWindow = null;

function boundedResult(state, message, extra = {}) {
  return Object.freeze({ state, message: sanitizeText(message), ...extra });
}

function registerIpcHandlers() {
  ipcMain.handle('bridge:inspect', () => {
    operationState.transition('inspect');
    return boundedResult('select-card', 'No compatible card selected. USB inspection is added in the next bridge task.', {
      compatible: false,
    });
  });
  ipcMain.handle('bridge:start-operation', (_event, requestedOperation) => {
    validateOperation(requestedOperation);
    if (operationState.isCritical()) throw new Error('An operation is already in its critical section');
    confirmationToken = crypto.randomBytes(24).toString('hex');
    operationState.transition('confirm');
    return boundedResult('confirm', 'Confirm that reinstalling firmware will replace the card configuration.', {
      confirmationToken,
    });
  });
  ipcMain.handle('bridge:confirm-destructive', (_event, token) => {
    validateToken(token);
    if (!confirmationToken || token !== confirmationToken || operationState.current !== 'confirm') {
      throw new Error('Confirmation token is expired or does not match');
    }
    confirmationToken = null;
    return boundedResult('recovery-required', 'USB installation is not included in this scaffold. No card changes were made.');
  });
  ipcMain.handle('bridge:cancel', () => {
    const cancelled = operationState.cancel();
    if (cancelled) confirmationToken = null;
    return Object.freeze({ cancelled, state: operationState.current });
  });
}

async function createMainWindow() {
  const window = new BrowserWindow(createWindowOptions(preloadPath, { show: !smokeTest }));
  const preloadReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Preload did not become ready')), 5_000);
    ipcMain.once('bridge:preload-ready', (event) => {
      if (event.sender !== window.webContents) {
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
    const message = sanitizeText(event.message);
    if (message) process.stderr.write(`[renderer] ${message}\n`);
  });
  window.on('close', (event) => {
    if (operationState.shouldPreventClose()) event.preventDefault();
  });
  await window.loadFile(rendererPath);
  await preloadReady;
  return window;
}

async function run() {
  registerIpcHandlers();
  mainWindow = await createMainWindow();
  if (smokeTest) {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Smoke-test window was not created');
    process.stdout.write('Lightweaver Bridge smoke test passed\n');
    mainWindow.destroy();
    app.exit(0);
  }
}

app.whenReady().then(run).catch((error) => {
  process.stderr.write(`Lightweaver Bridge failed: ${sanitizeText(error && error.message)}\n`);
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
