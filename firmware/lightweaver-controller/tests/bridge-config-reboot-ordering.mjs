// Locks the one invariant that makes "Save to card" effortless when the public
// HTTPS Studio (led.mandalacodes.com) pushes a layout-changing config through
// the card-page postMessage bridge: the bridge must reply to Studio BEFORE the
// card reboots.
//
// The card reboots whenever the LED output layout changes. If the firmware
// bridge script rebooted inline (e.g. `await post('/api/reboot')`) before
// sending its reply, the card would drop the HTTP/postMessage channel mid-flight
// and Studio's bridge request would time out — surfacing a false "couldn't reach
// the card" error even though the save actually succeeded. So the reboot must be
// deferred (setTimeout) and the success reply (with response.rebooting=true so
// Studio shows "rebooting", not an error) must be sent first.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');

// Scope every assertion to the embedded studioBridgeScript() so we are reasoning
// about the actual bridge handler and not some unrelated reboot path elsewhere.
const fnStart = web.indexOf('String studioBridgeScript()');
assert.notEqual(fnStart, -1, 'LightweaverWeb.cpp should define studioBridgeScript()');
const fnEnd = web.indexOf('return script;', fnStart);
assert.notEqual(fnEnd, -1, 'studioBridgeScript() should return its assembled script');
const script = web.slice(fnStart, fnEnd);

// The bridge must handle the config push and decide on a reboot.
assert.match(
  script,
  /m\.type===['"]config['"]/,
  'bridge script should handle the Studio config push message',
);
assert.match(
  script,
  /fetch\(['"]\/api\/config['"]/,
  'bridge config handler should POST the Studio package to /api/config from the card origin',
);
assert.match(
  script,
  /shouldReboot/,
  'bridge config handler should compute whether the layout change requires a reboot',
);

// The reboot must be deferred via setTimeout, never awaited/blocking inline.
assert.match(
  script,
  /setTimeout\([^;]*\/api\/reboot/,
  'bridge config handler should schedule /api/reboot on a timer so the reply goes out first',
);
const configBranchStart = script.search(/m\.type===['"]config['"]/);
const configBranchEnd = script.indexOf('}else{throw', configBranchStart);
const configBranch = script.slice(configBranchStart, configBranchEnd);
assert.doesNotMatch(
  configBranch,
  /await\s+(?:post|fetch)\(['"]\/api\/reboot/,
  'bridge config handler must NOT await the reboot before replying (would drop the channel and surface a false save failure)',
);

// Studio needs response.rebooting=true to render the "saved, rebooting" success
// state instead of a connection error (see PatternsScreen savePreviewToCard).
assert.match(
  script,
  /response\.rebooting\s*=\s*true/,
  'bridge config handler should mark the reply rebooting:true so Studio shows success, not an error',
);

// Ordering: the deferred reboot is scheduled, then the success reply is sent.
const rebootAt = script.search(/setTimeout\([^;]*\/api\/reboot/);
const replyAt = script.search(/lwBridgeReply\(ev,\s*\{[^}]*ok:\s*true/);
assert.ok(rebootAt > -1, 'bridge config handler should schedule the deferred reboot');
assert.ok(replyAt > -1, 'bridge script should send a success reply to Studio');
assert.ok(
  rebootAt < replyAt,
  'the deferred reboot must be scheduled before the success reply is dispatched, so the reply wins the race',
);

console.log('bridge-config-reboot-ordering tests passed');
