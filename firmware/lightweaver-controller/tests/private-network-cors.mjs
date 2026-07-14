import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');
const wled = readFileSync(resolve(here, '../src/LightweaverWledJsonApi.cpp'), 'utf8');
const websocket = readFileSync(resolve(here, '../src/LightweaverWledWebSocket.cpp'), 'utf8');

assert.match(
  websocket,
  /if \(!headerName\.equalsIgnoreCase\("origin"\)\) return true;/,
  'WebSocket origin validation must ignore ordinary handshake headers such as Host',
);
assert.match(
  websocket,
  /kWsMandatoryHeaders\[\] = \{"origin"\}/,
  'browser WebSocket clients must still provide an Origin header',
);

for (const [name, source] of [
  ['LightweaverWeb.cpp', web],
  ['LightweaverWledJsonApi.cpp', wled],
]) {
  const corsStart = source.indexOf('void sendCors()');
  assert.notEqual(corsStart, -1, `${name} should define sendCors`);
  const corsEnd = source.indexOf('}', corsStart);
  const corsBody = source.slice(corsStart, corsEnd);
  assert.match(
    corsBody,
    /Access-Control-Allow-Private-Network"\s*,\s*"true"/,
    `${name} should allow Chrome private-network preflights from the public Studio`,
  );
}

for (const route of ['/api/status', '/api/firmware-info', '/api/patterns', '/api/zones']) {
  assert.ok(
    web.includes(`server.on("${route}", HTTP_OPTIONS, handleOptions)`),
    `${route} should answer PNA OPTIONS preflight before public Studio GET requests`,
  );
}

assert.match(
  web,
  /lwconfig/,
  'card page should accept public Studio config handoff fragments after Chrome blocks HTTPS-to-local HTTP writes',
);
assert.ok(
  web.includes("fetch('/api/config'"),
  'card page handoff should save the Studio package to the card from the card origin',
);
assert.match(
  web,
  /LightweaverStudioBridge/,
  'card page should accept Studio bridge messages from the public HTTPS app',
);
assert.match(
  web,
  /LightweaverCardBridge/,
  'card page should reply to Studio bridge messages after proxying local card commands',
);
assert.match(
  web,
  /cardBridge=1/,
  'card page Open Studio link should hand the browser back with bridge mode enabled',
);
assert.ok(
  (web.match(/Open Lightweaver Studio/g) || []).length >= 2,
  'both local card pages should expose an Open Lightweaver Studio link',
);
assert.match(
  web,
  /lwOpenStudio/,
  'simple local card page should use an explicit Studio click handoff instead of relying only on target=_blank',
);
assert.match(
  web,
  /function lwOpenStudio\(event,url\)/,
  'simple local card page should define the Studio click handoff as a global function callable from inline onclick',
);
assert.match(
  web,
  /document\.createElement\('iframe'\)/,
  'simple local card page should load Studio in an iframe so the local card page stays available as the bridge',
);
assert.match(
  web,
  /frame\.src=url/,
  'simple local card page should point the embedded Studio iframe at the bridge-enabled Studio URL',
);
assert.match(
  web,
  /contentWindow\.postMessage\(\{app:'LightweaverCardBridge',type:'ready'/,
  'card page should send a ready bridge message into the embedded Studio iframe',
);
assert.match(
  web,
  /searchParams\.set\('cardHost',location\.host\)/,
  'simple local card page should rewrite cardHost to the actual local origin before embedding Studio',
);
assert.match(
  web,
  /studioAutoOpen/,
  'card page should support public Studio opening the local card bridge and auto-launching the embedded Studio handoff',
);
assert.match(
  web,
  /editPattern/,
  'local card pages should pass the selected pattern id into Studio when editing the active look',
);
assert.match(
  web,
  /editLook/,
  'local card pages should pass compound card looks into Studio as editable saved looks',
);
assert.ok(
  (web.match(/id='edit-studio'/g) || []).length >= 2,
  'both local card pages should expose a selected-pattern Edit in Studio button',
);
assert.match(
  web,
  /studioUrlForPattern/,
  'local card pages should build pattern-aware Studio handoff URLs',
);
assert.match(
  web,
  /tile-edit/,
  'the main local card page should show a small edit affordance on the selected pattern tile',
);
for (const swatchClass of ['sw-plasma', 'sw-fire', 'sw-ocean', 'sw-sparkle']) {
  assert.match(
    web,
    new RegExp(`\\.${swatchClass}`),
    `main local card page should include a visual swatch for ${swatchClass.replace('sw-', '')}`,
  );
}
{
  const rootStart = web.indexOf('void handleRoot()');
  const controlsIndex = web.indexOf("<div class='bright'>", rootStart);
  const gridIndex = web.indexOf("<div class='grid' id='grid'></div>", rootStart);
  assert.ok(
    controlsIndex > -1 && gridIndex > -1 && controlsIndex < gridIndex,
    'main local card page should keep brightness and speed controls above the long pattern grid',
  );
}
assert.doesNotMatch(
  web,
  /Open Lightweaver app[^;]+rel='noopener'/,
  'card page Open Studio link must preserve window.opener so Studio can use the card as a local bridge',
);

for (const route of ['/json/info', '/json/effects', '/json/palettes', '/json']) {
  assert.ok(
    wled.includes(`server.on("${route}", HTTP_OPTIONS, handleOptions)`),
    `${route} should answer PNA OPTIONS preflight before public Studio GET requests`,
  );
}

console.log('private-network-cors tests passed');
