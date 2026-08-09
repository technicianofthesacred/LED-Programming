import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const web = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');
const wled = readFileSync(resolve(here, '../src/LightweaverWledJsonApi.cpp'), 'utf8');
const websocket = readFileSync(resolve(here, '../src/LightweaverWledWebSocket.cpp'), 'utf8');

const bridgeStart = web.indexOf('String studioBridgeScript()');
assert.notEqual(bridgeStart, -1, 'firmware should define the card-page Studio bridge');
const predicateEnd = web.indexOf('const lwBridgeRawParams', bridgeStart);
assert.notEqual(predicateEnd, -1, 'bridge should define its origin predicate before parsing launch data');
const predicateSource = web.slice(bridgeStart, predicateEnd);
const emittedPredicate = [...predicateSource.matchAll(/"(?:\\.|[^"\\])*"/g)]
  .map(match => JSON.parse(match[0]))
  .join('');
const bridgeContext = {};
vm.runInNewContext(emittedPredicate + ';globalThis.allowed=lwBridgeAllowed', bridgeContext);

const openScriptStart = web.indexOf('String studioOpenScript()');
const openScriptEnd = web.indexOf('String studioBridgeScript()', openScriptStart);
assert.notEqual(openScriptStart, -1, 'firmware should define the card-page Studio opener');
assert.notEqual(openScriptEnd, -1, 'firmware should bound the card-page Studio opener script');
const emittedOpenScript = [...web.slice(openScriptStart, openScriptEnd).matchAll(/"(?:\\.|[^"\\])*"/g)]
  .map(match => JSON.parse(match[0]))
  .join('');
const bridgeLaunchEnd = web.indexOf('"const lwBridgeReadyOrigin', bridgeStart);
assert.notEqual(bridgeLaunchEnd, -1, 'bridge should validate its launch fragment before ready handling');
const emittedBridgeLaunch = [...web.slice(bridgeStart, bridgeLaunchEnd).matchAll(/"(?:\\.|[^"\\])*"/g)]
  .map(match => JSON.parse(match[0]))
  .join('');
assert.match(emittedBridgeLaunch, /const lwBridgeUtilityIntent=/,
  'bridge launch parsing must define the bounded first-load utility intent before ready handling');

function bridgeUtilityLaunch(hash) {
  const context = {
    URLSearchParams,
    location: { hash },
    window: { opener: { closed: false } },
  };
  vm.runInNewContext(
    `${emittedBridgeLaunch};globalThis.hasLaunch=!!lwBridgeLaunch;globalThis.utilityIntent=lwBridgeUtilityIntent()`,
    context,
  );
  return { hasLaunch: context.hasLaunch, utilityIntent: context.utilityIntent };
}

assert.deepEqual(
  bridgeUtilityLaunch('#studioBridge=1&studioOrigin=https%3A%2F%2Fled.mandalacodes.com&bridgeUtility=1'),
  { hasLaunch: true, utilityIntent: true },
  'one exact bridgeUtility=1 flag on the verified bridge-only launch must activate the passive utility on first load',
);
assert.deepEqual(
  bridgeUtilityLaunch('#studioBridge=1&studioOrigin=https%3A%2F%2Fled.mandalacodes.com'),
  { hasLaunch: true, utilityIntent: false },
  'a verified visible card-page launch without utility intent must stay visible',
);
for (const hash of [
  '#studioBridge=1&studioOrigin=https%3A%2F%2Fled.mandalacodes.com&bridgeUtility=0',
  '#studioBridge=1&studioOrigin=https%3A%2F%2Fled.mandalacodes.com&bridgeUtility=1&bridgeUtility=1',
]) {
  assert.deepEqual(bridgeUtilityLaunch(hash), { hasLaunch: false, utilityIntent: false },
    'invalid or duplicate bridgeUtility values must invalidate the bridge launch');
}
assert.deepEqual(
  bridgeUtilityLaunch('#studioBridge=1&studioOrigin=https%3A%2F%2Fled.mandalacodes.com&bridgeUtility=1&unexpected=1'),
  { hasLaunch: true, utilityIntent: false },
  'utility intent must reject unknown fragment fields instead of turning a visible card page passive',
);

const trustedOrigins = [
  'https://led.mandalacodes.com',
  'https://lightweaver-edw.pages.dev',
  'http://localhost',
  'http://localhost:5173',
  'https://localhost',
  'https://localhost:5173',
  'http://127.0.0.1',
  'http://127.0.0.1:5173',
];
for (const origin of trustedOrigins) {
  assert.equal(bridgeContext.allowed(origin), true, 'bridge should trust the direct CORS origin ' + origin);
}

const untrustedOrigins = [
  'https://attacker.lightweaver-edw.pages.dev',
  'https://studio.lightweaver-edw.pages.dev',
  'https://127.0.0.1',
  'https://evil.example',
];
for (const origin of untrustedOrigins) {
  assert.equal(bridgeContext.allowed(origin), false, 'bridge should reject ' + origin);
}
assert.doesNotMatch(
  predicateSource,
  /\[a-z0-9-\]\+.*lightweaver-edw.*pages.*dev/,
  'bridge source must not trust arbitrary Cloudflare Pages preview subdomains',
);

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

// WebServer::sendHeader appends to _responseHeaders with no dedupe, and that
// vector is only cleared inside _prepareHeader once send() runs. So a handler
// that calls sendCors() and then delegates to another sendCors()-emitting
// handler puts TWO Access-Control-Allow-Origin values on one response, which
// browsers reject outright — every Studio fetch() against that route dies with
// an opaque CORS error. handleRoot() -> handleAdvancedRoot() shipped exactly
// that bug. This walks every handler and fails if any path can stage a second
// CORS block before the first send() flushes the first one.
// Blank out comments, string literals and char literals (keeping newlines and
// length so line structure survives) so the scan below sees code only — the
// embedded card-page HTML/JS is full of braces and prose that would otherwise
// confuse both the brace matcher and the call detection.
function codeOnly(source) {
  let out = '';
  let i = 0;
  const blank = text => text.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) j += source[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, source.length);
      out += quote + blank(source.slice(i + 1, stop - 1)) + quote;
      i = stop;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

function topLevelFunctions(source) {
  const signature = /^(?:static\s+)?(?:void|bool|String|int|size_t|uint\d+_t)\s+(\w+)\s*\([^;{)]*\)\s*\{\s*$/gm;
  const found = new Map();
  let match;
  while ((match = signature.exec(source)) !== null) {
    const open = source.indexOf('{', match.index);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    found.set(match[1], source.slice(open + 1, end));
  }
  return found;
}

for (const [name, source] of [
  ['LightweaverWeb.cpp', web],
  ['LightweaverWledJsonApi.cpp', wled],
]) {
  const functions = topLevelFunctions(codeOnly(source));
  assert.ok(functions.size > 0, `${name} should expose parsable top-level functions`);

  // Handlers that stage CORS headers before their first send() — calling one of
  // these is equivalent to calling sendCors() yourself.
  const emitters = new Set();
  for (const [fnName, body] of functions) {
    if (fnName === 'sendCors') continue;
    const cors = body.search(/\bsendCors\s*\(\s*\)/);
    if (cors === -1) continue;
    const sent = body.search(/(?:server\.|serverPtr->)send\s*\(/);
    if (sent === -1 || cors < sent) emitters.add(fnName);
  }
  assert.ok(emitters.size > 0, `${name} should contain at least one CORS-emitting handler`);
  // Guard against the scan silently going vacuous if the parser stops matching.
  for (const required of name === 'LightweaverWeb.cpp'
    ? ['handleRoot', 'handleAdvancedRoot', 'handleOptions', 'handleStatus']
    : ['handleOptions', 'handleInfo', 'handleState']) {
    assert.ok(emitters.has(required), `${name}: ${required}() should be seen staging CORS headers`);
  }

  const delegates = [...emitters].join('|');
  const token = new RegExp(
    `\\bsendCors\\s*\\(\\s*\\)|(?:server\\.|serverPtr->)send\\s*\\(|\\breturn\\b|\\b(${delegates})\\s*\\(`,
    'g',
  );
  for (const [fnName, body] of functions) {
    if (fnName === 'sendCors') continue;
    let staged = 0;
    let match;
    token.lastIndex = 0;
    while ((match = token.exec(body)) !== null) {
      const text = match[0];
      if (/^sendCors/.test(text)) {
        staged += 1;
      } else if (match[1] && match[1] !== fnName) {
        // The delegate stages its own CORS block, then flushes it with send().
        assert.equal(
          staged, 0,
          `${name}: ${fnName}() stages CORS headers and then delegates to ` +
          `${match[1]}(), which stages them again before either one calls ` +
          'send(). That emits duplicate Access-Control-Allow-Origin headers ' +
          'and browsers reject the response. Move the sendCors() call below ' +
          'the delegation (or flush before delegating).',
        );
        staged = 0;
      } else if (/^return/.test(text)) {
        staged = 0;
      } else {
        // A send() flushes _responseHeaders, so anything staged is now on the wire.
        assert.ok(
          staged <= 1,
          `${name}: ${fnName}() stages ${staged} CORS blocks before a single send()`,
        );
        staged = 0;
      }
    }
  }
}

for (const route of ['/api/status', '/api/firmware-info', '/api/patterns', '/api/zones']) {
  assert.ok(
    web.includes(`server.on("${route}", HTTP_OPTIONS, handleOptions)`),
    `${route} should answer PNA OPTIONS preflight before public Studio GET requests`,
  );
}

assert.match(
  web,
  /p\["runtimePatternId"\]\s*=\s*cfg\.looks\[i\]\.preset\.length\(\)\s*\?\s*cfg\.looks\[i\]\.preset\s*:\s*cfg\.looks\[i\]\.id/,
  '/api/patterns must expose the installed look\'s underlying editable runtime pattern',
);
assert.match(
  web,
  /controls\["customColor"\][\s\S]{0,300}controls\["breathe"\][\s\S]{0,300}controls\["drift"\]/,
  '/api/patterns must expose truthful customer tuning capabilities',
);

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
assert.ok(
  web.includes("m.type==='patterns'){response=await get('/api/patterns')"),
  'card bridge should expose the bounded read-only pattern catalog to the Studio drawer',
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
assert.doesNotMatch(
  web,
  /target='lightweaver-studio'/,
  'commissioning and recovery links must not bypass the verified Studio opener handoff',
);
assert.ok(
  (web.match(/onclick=\\"return lwOpenStudio\(event,this\.href\)\\"/g) || []).length >= 3,
  'live, commissioning, and recovery Studio links should all use the verified opener handoff',
);
assert.ok(
  web.includes("!editing&&requested.hash==='#screen=layout'?'#screen=layout':!editing&&requested.hash==='#screen=card&section=setup'?'#screen=card&section=setup':'#screen=card&section=overview'"),
  'bounded Studio handoff should preserve both the Layout and guided Setup destinations',
);
assert.doesNotMatch(
  web,
  /document\.createElement\(['"]iframe['"]\)/,
  'new card firmware must never embed Studio in the local HTTP page',
);
assert.match(
  web,
  /window\.open\(url,'lightweaver-studio'\)/,
  'the card page should open Studio as a separate top-level HTTPS window',
);
assert.match(
  web,
  /https:\/\/led\.mandalacodes\.com\/\?cardBridge=1&cardHost=/,
  'the card page should compile the canonical HTTPS Studio origin into its handoff URL',
);
assert.match(
  web,
  /u\.searchParams\.set\('cardHost',location\.host\)/,
  'the card page should rewrite only the local cardHost hint before opening Studio',
);
assert.doesNotMatch(
  web,
  /studioAutoOpen|(?:searchParams|p)\.get\(['"](?:studioUrl|callback|firmwareUrl|origin)['"]\)/,
  'card query parameters must not select or auto-open an arbitrary Studio URL',
);
assert.match(
  web,
  /Allow pop-ups for this page, then tap Open Studio again\./,
  'the card page should give concise, actionable help when the Studio popup is blocked',
);
{
  const openCalls = [];
  const alerts = [];
  const opener = {
    closed: false,
    location: { href: 'https://led.mandalacodes.com/#screen=production' },
    focusCalls: 0,
    focus() { this.focusCalls += 1; },
  };
  const context = {
    URL,
    URLSearchParams,
    location: {
      host: '192.168.4.1',
      hash: '#studioBridge=1&studioOrigin=https%3A%2F%2Fled.mandalacodes.com',
    },
    alert(message) { alerts.push(message); },
    window: {
      opener,
      open(url, name) {
        openCalls.push({ url, name });
        return { focus() {} };
      },
    },
  };
  vm.runInNewContext(`${emittedOpenScript}${emittedBridgeLaunch};globalThis.openStudio=lwOpenStudio`, context);
  let prevented = 0;
  assert.equal(context.openStudio({ preventDefault() { prevented += 1; } },
    'https://led.mandalacodes.com/?cardBridge=1&cardHost=192.168.4.1#screen=layout'), false);
  assert.equal(prevented, 1);
  assert.equal(opener.focusCalls, 1,
    'a card page opened by Studio should focus that exact installer/commissioning tab');
  assert.equal(opener.location.href,
    'https://led.mandalacodes.com/?cardBridge=1&cardHost=192.168.4.1#screen=layout',
    'commissioning handoff must navigate the verified opener to the requested safe Layout route');
  opener.location.href = 'https://led.mandalacodes.com/#screen=production';
  assert.equal(context.openStudio({ preventDefault() { prevented += 1; } },
    'https://led.mandalacodes.com/?cardBridge=1&cardHost=192.168.4.1&editPattern=calm#screen=card&section=overview'), false);
  assert.equal(prevented, 2);
  assert.equal(opener.focusCalls, 2);
  assert.equal(opener.location.href,
    'https://led.mandalacodes.com/?cardBridge=1&cardHost=192.168.4.1&editPattern=calm#screen=card&section=overview',
    'Edit in Studio must preserve the bounded pattern intent when navigating the verified opener');
  assert.deepEqual(openCalls, [],
    'a live Studio opener must be reused without opening or targeting another Studio window');
  assert.deepEqual(alerts, []);
}
{
  const openCalls = [];
  const alerts = [];
  const unrelatedOpener = {
    closed: false,
    focusCalls: 0,
    focus() { this.focusCalls += 1; },
  };
  const context = {
    URL,
    URLSearchParams,
    location: { host: '192.168.4.1', hash: '' },
    alert(message) { alerts.push(message); },
    window: {
      opener: unrelatedOpener,
      open(url, name) {
        openCalls.push({ url, name });
        return null;
      },
    },
  };
  vm.runInNewContext(`${emittedOpenScript}${emittedBridgeLaunch};globalThis.openStudio=lwOpenStudio`, context);
  context.openStudio({ preventDefault() {} },
    'https://evil.example/?editPattern=calm#screen=layout');
  assert.equal(unrelatedOpener.focusCalls, 0,
    'a direct or captive-portal card page must not focus an unrelated opener');
  assert.equal(openCalls.length, 1,
    'a card page without a verified bridge launch should use the named Studio fallback');
  assert.equal(openCalls[0].name, 'lightweaver-studio');
  assert.equal(openCalls[0].url,
    'https://led.mandalacodes.com/?cardBridge=1&cardHost=192.168.4.1&editPattern=calm#screen=card&section=overview',
    'the non-bridge fallback must remain pinned to the canonical Studio origin and bounded parameters');
  assert.deepEqual(alerts, ['Allow pop-ups for this page, then tap Open Studio again.']);
}
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
assert.ok(
  (web.match(/On this Lightweaver card/g) || []).length >= 2,
  'both local card pages must clearly identify themselves as controls served by the physical card',
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
