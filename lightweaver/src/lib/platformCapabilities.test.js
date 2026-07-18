import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SECURE_INSTALLER_URL,
  detectPlatformCapabilities,
} from './platformCapabilities.js';

test('uses one fixed canonical secure installer URL', () => {
  assert.equal(SECURE_INSTALLER_URL, 'https://led.mandalacodes.com/#screen=flash&mode=install');
  assert.doesNotMatch(SECURE_INSTALLER_URL, /callback|target|url=/i);
});

test('allows browser USB only from a secure top-level page with Web Serial', () => {
  const result = detectPlatformCapabilities({
    secureContext: true,
    topLevel: true,
    serial: {},
    platform: 'MacIntel',
  });

  assert.equal(result.secureContext, true);
  assert.equal(result.topLevel, true);
  assert.equal(result.embedded, false);
  assert.equal(result.canWebSerialInstall, true);
  assert.equal(result.mustEscapeToSecureInstaller, false);
});

test('detects an embedded Studio beneath an insecure ancestor as needing a secure installer', () => {
  const result = detectPlatformCapabilities({
    secureContext: false,
    topLevel: false,
    serial: {},
    userAgent: 'Mozilla/5.0 Chrome/126.0 Safari/537.36',
    platform: 'MacIntel',
  });

  assert.equal(result.secureContext, false);
  assert.equal(result.topLevel, false);
  assert.equal(result.embedded, true);
  assert.equal(result.canWebSerialInstall, false);
  assert.equal(result.mustEscapeToSecureInstaller, true);
});

test('keeps secure Web Serial working when a legacy caller omits page position', () => {
  const result = detectPlatformCapabilities({ secureContext: true, serial: {} });

  assert.equal(result.topLevel, true);
  assert.equal(result.embedded, false);
  assert.equal(result.canWebSerialInstall, true);
});

test('escapes whenever page position or security blocks the installer', () => {
  const secureFrame = detectPlatformCapabilities({ secureContext: true, topLevel: false, serial: {} });
  const insecureTopLevel = detectPlatformCapabilities({ secureContext: false, topLevel: true, serial: {} });

  assert.equal(secureFrame.mustEscapeToSecureInstaller, true);
  assert.equal(insecureTopLevel.mustEscapeToSecureInstaller, true);
});

test('an explicit secure iframe observation cannot use Web Serial', () => {
  const result = detectPlatformCapabilities({ secureContext: true, topLevel: false, serial: {} });

  assert.equal(result.embedded, true);
  assert.equal(result.canWebSerialInstall, false);
  assert.equal(result.mustEscapeToSecureInstaller, true);
});

test('a context that can install over Web Serial never needs the secure-installer escape', () => {
  // Regression guard for the install flow: when canWebSerialInstall is true the
  // UI must never render the secure-installer escape link, so the two flags can
  // never both be true for any observed environment.
  for (const secureContext of [true, false]) {
    for (const topLevel of [true, false]) {
      for (const serial of [{}, null]) {
        const result = detectPlatformCapabilities({ secureContext, topLevel, serial });
        assert.equal(
          result.canWebSerialInstall && result.mustEscapeToSecureInstaller,
          false,
          `escape and browser USB may not coexist (secureContext=${secureContext}, topLevel=${topLevel}, serial=${Boolean(serial)})`,
        );
      }
    }
  }
});

test('keeps installed-card control available when Web Serial is absent', () => {
  const result = detectPlatformCapabilities({
    secureContext: true,
    topLevel: true,
    serial: null,
    userAgent: 'Mozilla/5.0 Chrome/126.0 Safari/537.36',
  });

  assert.equal(result.canWebSerialInstall, false);
  assert.equal(result.canControlInstalledCard, true);
});

test('production USB is limited to secure top-level desktop Chrome or Edge', () => {
  for (const userAgent of [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36 Edg/126.0',
  ]) {
    assert.equal(detectPlatformCapabilities({ secureContext: true, topLevel: true, serial: {}, userAgent }).canProductionWebSerial, true);
  }
  assert.equal(detectPlatformCapabilities({ secureContext: true, topLevel: true, serial: {}, userAgent: 'Mozilla/5.0 Firefox/128.0' }).canProductionWebSerial, false);
  assert.equal(detectPlatformCapabilities({ secureContext: true, topLevel: true, serial: {}, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile Chrome/126.0' }).canProductionWebSerial, false);
  assert.equal(detectPlatformCapabilities({ secureContext: true, topLevel: false, serial: {}, userAgent: 'Mozilla/5.0 Chrome/126.0' }).canProductionWebSerial, false);
});

test('detects mobile environments from user agent and iPad touch capability', () => {
  assert.equal(detectPlatformCapabilities({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' }).isMobile, true);
  assert.equal(detectPlatformCapabilities({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/17.5 Safari/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  }).isMobile, true);
  assert.equal(detectPlatformCapabilities({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    platform: 'Win32',
    maxTouchPoints: 0,
  }).isMobile, false);
});

test('normalizes platform without using browser identity as USB authorization', () => {
  const cases = [
    [{ platform: 'MacIntel' }, 'macos', false],
    [{ platform: 'Win32' }, 'windows', false],
    [{ platform: 'Linux x86_64' }, 'linux', false],
    [{ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 15917.65.0)' }, 'linux', false],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' }, 'android', true],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' }, 'ios', true],
    [{ userAgent: 'LightweaverBrowser/1.0', platform: 'MysteryOS' }, 'unknown', false],
  ];

  for (const [input, platform, isMobile] of cases) {
    const result = detectPlatformCapabilities({ secureContext: true, topLevel: true, serial: null, ...input });
    assert.equal(result.platform, platform);
    assert.equal(result.isMobile, isMobile);
    assert.equal(result.canWebSerialInstall, false);
  }
});
