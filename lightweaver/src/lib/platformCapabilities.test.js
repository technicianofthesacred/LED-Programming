import test from 'node:test';
import assert from 'node:assert/strict';

import { detectPlatformCapabilities } from './platformCapabilities.js';

test('enables Web Serial installation in a secure context when the capability is present', () => {
  const result = detectPlatformCapabilities({ secureContext: true, serial: {} });

  assert.equal(result.canWebSerialInstall, true);
});

test('disables Web Serial installation in an insecure context even when the capability is present', () => {
  const result = detectPlatformCapabilities({ secureContext: false, serial: {} });

  assert.equal(result.canWebSerialInstall, false);
});

test('keeps installed-card control available when Web Serial is absent', () => {
  const result = detectPlatformCapabilities({
    secureContext: true,
    serial: null,
    userAgent: 'Mozilla/5.0 Chrome/126.0 Safari/537.36',
  });

  assert.equal(result.canWebSerialInstall, false);
  assert.equal(result.canControlInstalledCard, true);
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

test('normalizes platform and handoff guidance without using it as USB authorization', () => {
  const cases = [
    [{ platform: 'MacIntel' }, 'macos', 'supported-browser-handoff'],
    [{ platform: 'Win32' }, 'windows', 'supported-browser-handoff'],
    [{ platform: 'Linux x86_64' }, 'linux', 'supported-browser-handoff'],
    [{ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 15917.65.0)' }, 'linux', 'supported-browser-handoff'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' }, 'android', 'supported-device-handoff'],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' }, 'ios', 'supported-device-handoff'],
    [{ userAgent: 'LightweaverBrowser/1.0', platform: 'MysteryOS' }, 'unknown', 'supported-device-handoff'],
  ];

  for (const [input, platform, handoffKind] of cases) {
    const result = detectPlatformCapabilities({ secureContext: true, serial: null, ...input });
    assert.equal(result.platform, platform);
    assert.equal(result.handoffKind, handoffKind);
    assert.equal(result.canWebSerialInstall, false);
  }
});
