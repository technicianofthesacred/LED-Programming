'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

function createWindowOptions(preloadPath, overrides = {}) {
  return {
    width: 760,
    height: 640,
    minWidth: 620,
    minHeight: 520,
    show: false,
    backgroundColor: '#11100e',
    title: 'Lightweaver Bridge',
    ...overrides,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };
}

function isAllowedApplicationUrl(candidate, rendererPath) {
  try {
    const expected = pathToFileURL(path.resolve(rendererPath));
    const actual = new URL(candidate);
    return actual.protocol === 'file:' && actual.href === expected.href;
  } catch {
    return false;
  }
}

function installWebContentsGuards(webContents) {
  webContents.on('will-navigate', (event) => event.preventDefault());
  webContents.on('will-attach-webview', (event) => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  webContents.session.setPermissionCheckHandler(() => false);
}

function isTrustedIpcEvent(event, activeWindow, rendererPath) {
  if (!event || !activeWindow || activeWindow.isDestroyed()) return false;
  const webContents = activeWindow.webContents;
  if (!webContents || event.sender !== webContents) return false;
  if (!webContents.mainFrame || event.senderFrame !== webContents.mainFrame) return false;
  return isAllowedApplicationUrl(event.senderFrame.url, rendererPath);
}

module.exports = {
  createWindowOptions,
  installWebContentsGuards,
  isAllowedApplicationUrl,
  isTrustedIpcEvent,
};
