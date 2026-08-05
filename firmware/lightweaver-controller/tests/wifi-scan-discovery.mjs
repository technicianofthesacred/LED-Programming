// The setup page exists to show the list of nearby WiFi networks. Two ways to
// break that have already shipped, one in each direction:
//
//   - Re-arming a scan after every successful read, while the page polled the
//     endpoint every 1.5s, parked the shared radio off-channel more or less
//     permanently and kept knocking the phone off the setup hotspot.
//   - Over-correcting by refusing to scan whenever a join was in flight. A card
//     that already has credentials sits in Joining almost continuously, so the
//     network list stayed permanently empty and setup could not be completed.
//
// These assertions pin the shape that satisfies both: on demand, rate limited,
// never re-armed, never refused on the basis of connectivity phase.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const web = readFileSync(resolve(root, 'src/LightweaverWeb.cpp'), 'utf8');

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

const scan = functionBody(web, /void\s+handleWifiScan\s*\(\)\s*\{/);

// The regression that stranded setup: a phase check that could refuse a scan.
assert.ok(!/connectivityPhaseIsPending|wifiRuntime\.connectivity\.phase/.test(scan),
  'the scan endpoint must never refuse to scan based on connectivity phase: a card with saved credentials is in a pending phase nearly all the time, and refusing there leaves the setup page with a permanently empty network list');
assert.ok(!/"joining"/.test(scan),
  'no joining short-circuit may remain in the scan endpoint');

// The opposite regression: scanning without bound.
const successBranch = scan.slice(scan.indexOf('JsonDocument doc;'));
assert.ok(!/WiFi\.scanNetworks/.test(successBranch),
  'a successful scan read must not re-arm another scan; that is what made the radio scan continuously while the setup page polled');

// Exactly one place starts a scan, and it is rate limited.
assert.equal((scan.match(/WiFi\.scanNetworks/g) || []).length, 1,
  'the scan endpoint starts a scan in exactly one place');
assert.match(scan, /lastScanStartMs\s*==\s*0\s*\|\|[\s\S]{0,120}LW_WIFI_SCAN_RETRY_MS/,
  'a scan restart must be rate limited so a failing scan retries instead of hammering the radio on every poll');
assert.match(web, /constexpr\s+uint32_t\s+LW_WIFI_SCAN_RETRY_MS\s*=\s*(\d+);/,
  'the scan retry cadence must be a named constant');
const retryMs = Number(web.match(/LW_WIFI_SCAN_RETRY_MS\s*=\s*(\d+);/)[1]);
assert.ok(retryMs >= 2000 && retryMs <= 10000,
  `scan retry cadence must stay between 2s and 10s, got ${retryMs}ms`);

// Rescan must be able to discard a cached list, or the button does nothing.
assert.match(scan, /server\.arg\("refresh"\)\s*==\s*"1"/,
  'an explicit refresh must be able to discard cached results');
assert.match(scan, /WiFi\.scanDelete\(\)/,
  'refresh must delete the cached scan so a new one starts');

// The page has to keep polling long enough to outlast one failed join attempt
// (15s) plus the gap before the card retries, or it gives up before the radio
// is ever free to scan.
const pollBudget = web.match(/scanPolls\+\+<(\d+)\)\{scanTimer=setTimeout\(pollScan,(\d+)\)/);
assert.ok(pollBudget, 'setup page scan polling loop not found');
const windowMs = Number(pollBudget[1]) * Number(pollBudget[2]);
assert.ok(windowMs >= 40000,
  `setup page must poll for at least 40s so a scan blocked by an in-flight join still lands, got ${windowMs}ms`);

// No speculative scan at boot: that ran the radio off-channel during the exact
// seconds a phone is joining the hotspot.
const setupWeb = functionBody(web, /void\s+setupLightweaverWeb\s*\(/);
assert.ok(!/WiFi\.scanNetworks/.test(setupWeb),
  'boot must not start a speculative scan while a phone may be joining the hotspot');

console.log('wifi-scan-discovery tests passed');
