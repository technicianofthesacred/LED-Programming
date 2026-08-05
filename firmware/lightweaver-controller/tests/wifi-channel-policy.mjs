// The setup hotspot and the station link share one radio. If they are on
// different channels the SDK drags the AP onto the station's channel during the
// join and deauthenticates every phone connected to it. Aligning the AP first
// was already shipped — but its channel lookup read only the scan cache, and
// the boot scan that filled that cache had been removed in the same commit for
// parking the radio off-channel. So the lookup answered "unknown" on every
// boot, the alignment never ran, and a reset card's hotspot could vanish the
// moment it reached the LAN.
//
// The fix is to remember the channel instead of looking for it. These
// assertions pin the pure decisions (compiled and run on the host) and the
// wiring that has to stay in place around them, including that no scan crept
// back onto the AP-start path.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const dir = mkdtempSync(join(tmpdir(), 'lw-wifi-channel-'));
try {
  const binary = join(dir, 'wifi-channel-policy');
  execFileSync(process.env.CXX || 'c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror',
    'wifi-channel-policy.cpp',
    '-o', binary,
  ], { cwd: new URL('.', import.meta.url), stdio: 'inherit' });
  execFileSync(binary, { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const web = readFileSync(resolve(root, 'src/LightweaverWeb.cpp'), 'utf8');
const storage = readFileSync(resolve(root, 'src/LightweaverStorage.cpp'), 'utf8');
const types = readFileSync(resolve(root, 'src/LightweaverTypes.h'), 'utf8');

function functionBody(source, signature) {
  const match = source.match(signature);
  assert.ok(match, `missing function matching ${signature}`);
  const start = match.index;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

// The channel has to live with the credentials, not in runtime state: it is
// only useful across a reboot.
assert.match(types, /struct\s+WifiConfig\s*\{[\s\S]*?uint8_t\s+channel\s*=\s*0;[\s\S]*?\};/,
  'WifiConfig must carry the remembered channel, since it is only useful after a reboot');

// Every path that raises the setup AP has to consult both sources. Reading the
// scan cache alone is the exact regression this replaces.
for (const signature of [
  /void\s+startApMode\s*\(\s*RuntimeConfig&\s*config\s*\)\s*\{/,
  /void\s+ensureRecoveryAp\s*\(\s*RuntimeConfig&\s*config\s*\)\s*\{/,
  /void\s+alignSetupApChannel\s*\(\s*RuntimeConfig&\s*config\s*\)\s*\{/,
]) {
  const body = functionBody(web, signature);
  assert.match(body, /setupApChannelFor\(config\)/,
    `${signature} must pick its channel from both the scan cache and the remembered channel`);
  assert.ok(!/lastScanChannelForSsid/.test(body),
    `${signature} must not read the scan cache directly: it is always empty at boot, which is what made the alignment dead code`);
}

const chooser = functionBody(web, /uint8_t\s+setupApChannelFor\s*\(/);
assert.match(chooser, /lightweaver::setupApChannel\(/,
  'the channel choice must go through the shared policy, which is host-tested');
assert.match(chooser, /config\.wifi\.channel/,
  'the remembered channel is the only source available on the boot path and must be consulted there');
assert.ok(!/WiFi\.scanNetworks/.test(chooser),
  'choosing a channel must never start a scan: scanning is what parks the radio off-channel and knocks phones off the hotspot');

// The regression guard from the scan work, restated for the path this change
// touches: nothing here may re-arm scanning at boot.
const setupWeb = functionBody(web, /void\s+setupLightweaverWeb\s*\(/);
assert.ok(!/WiFi\.scanNetworks/.test(setupWeb),
  'boot must not start a scan to discover the channel; that is what the persisted channel exists to avoid');

// The channel is free at association time — the radio is sitting on it.
const maintain = functionBody(web, /void\s+maintainConnectivity\s*\(\s*\)\s*\{/);
assert.match(maintain, /markWifiCredentialsProven\(cfg,\s*associatedStationChannel\(\)\)/,
  'a successful association must record the channel it landed on, which is the only way a later boot knows it without scanning');
assert.match(functionBody(web, /uint8_t\s+associatedStationChannel\s*\(/), /WiFi\.channel\(\)/,
  'the association channel comes from the radio, not from a scan');

// Storage round-trip: written on association, read back at boot, cleared when
// the credentials it describes are replaced.
const proven = functionBody(storage, /bool\s+markWifiCredentialsProven\s*\(/);
assert.match(proven, /lightweaver::planWifiProvenRecord\(/,
  'when to persist is a decision with several cases and belongs in the host-tested policy');
assert.match(proven, /out\["channel"\]\s*=\s*record\.channel/,
  'the channel must be written into the stored credential blob');

const overlay = functionBody(storage, /void\s+overlayNvsWifi\s*\(/);
assert.match(overlay, /config\.wifi\.channel\s*=\s*lightweaver::normalizeWifiChannel\(doc\["channel"\]/,
  'the stored channel must be read back at boot and clamped, so a corrupt blob cannot reach WiFi.softAP()');

const save = functionBody(storage, /bool\s+saveWifiConfigJson\s*\(/);
assert.match(save, /out\["channel"\]\s*=\s*0/,
  'new credentials must clear the remembered channel: it described the previous network and would aim the hotspot at the wrong channel');

assert.match(functionBody(storage, /void\s+resetWifi\s*\(/), /wifi\.channel\s*=\s*0/,
  'clearing the credentials must clear the channel that described them');

console.log('wifi-channel-policy tests passed');
