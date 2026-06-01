import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');
const wled = readFileSync(resolve(here, '../src/LightweaverWledJsonApi.cpp'), 'utf8');

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
  /searchParams\.set\('cardHost',location\.host\)/,
  'simple local card page should rewrite cardHost to the actual local origin before embedding Studio',
);
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
