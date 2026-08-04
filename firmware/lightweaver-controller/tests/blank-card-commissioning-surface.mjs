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

const visitorRoot = functionBody(web, /void\s+handleRoot\s*\(\)\s*\{/);
const advancedRoot = functionBody(web, /void\s+handleAdvancedRoot\s*\(\)\s*\{/);
const studioBridgeUrl = functionBody(web, /String\s+studioBridgeUrl\s*\([^;]*\)\s*\{/);

assert.match(studioBridgeUrl, /#screen=card&section=overview/,
  'configured and recovery card links must enter the Studio project resolver/overview first');
assert.doesNotMatch(studioBridgeUrl, /#screen=patterns/,
  'card-to-Studio links must not consume pattern intent against an arbitrary open project');

const studioSetupUrl = functionBody(web, /String\s+studioSetupUrl\s*\([^;]*\)\s*\{/);
assert.match(studioSetupUrl, /#screen=layout(?:&mode=draw)?/,
  'factory-blank cards must open the existing LED layout/setup flow');
assert.doesNotMatch(studioSetupUrl, /#screen=patterns/,
  'factory-blank setup must never drop the operator into runtime Patterns');

assert.match(web, /const studioUrlForPattern=id=>[\s\S]*?u\.searchParams\.set\('editPattern',id\)[\s\S]*?u\.hash='#screen=card&section=overview'/,
  'ready-card Edit in Studio must preserve pattern intent while routing through exact project resolution');

for (const [name, body] of [['visitor root', visitorRoot], ['advanced root', advancedRoot]]) {
  assert.match(body, /bool projectReady = cfg\.configValid && cfg\.knownGoodProject;/,
    `${name} must derive visitor eligibility from valid known-good project truth`);
  assert.match(body, /bool needsWifiSetup = !wifiConfigured \|\| \(!stationActive && !projectReady\);/,
    `${name} must keep WiFi setup for blank cards without a usable station connection`);
}

assert.match(visitorRoot, /if \(!projectReady \|\| needsWifiSetup\)\s*\{\s*handleAdvancedRoot\(\);/,
  'a card without a valid known-good project must never render visitor pattern controls');

assert.match(advancedRoot, /bool needsCommissioning = !projectReady && !needsWifiSetup;/,
  'a station-connected blank card must receive a distinct commissioning surface');
assert.match(advancedRoot, /bool factoryBlank = cfg\.runtimePhase == ProvisioningPhase::Factory;/,
  'commissioning must distinguish an untouched factory card from a project that needs recovery');
assert.match(advancedRoot, /else if \(needsCommissioning\) \{/,
  'advanced root must render blank-card commissioning separately from WiFi setup and controls');

const commissioningStart = advancedRoot.indexOf('else if (needsCommissioning) {');
const controlsStart = advancedRoot.indexOf('} else {', commissioningStart);
assert.ok(commissioningStart >= 0 && controlsStart > commissioningStart,
  'blank-card commissioning markup must precede the visitor control branch');
const commissioningMarkup = advancedRoot.slice(commissioningStart, controlsStart);

assert.match(commissioningMarkup, /Connected to gallery WiFi/,
  'blank-card commissioning must acknowledge the usable station connection');
assert.match(commissioningMarkup, /No project loaded/,
  'factory commissioning must explain that no project has been loaded');
assert.match(commissioningMarkup, /Project needs recovery\/verification/,
  'non-factory commissioning must explain that the project needs recovery or verification');
assert.match(commissioningMarkup, /Set up LED strips and install on card/,
  'factory-blank commissioning must provide one explicit setup CTA');
assert.match(commissioningMarkup, /(?:Return to|Open) Lightweaver Studio/,
  'recovery commissioning must retain its existing Studio CTA');
assert.match(commissioningMarkup, /If you are viewing this from the Lightweaver AP, rejoin gallery WiFi before (?:opening|returning to) Studio\./,
  'commissioning must tell AP-connected operators to restore gallery WiFi before using Studio');
assert.match(commissioningMarkup, /factoryBlank\s*\?\s*studioSetupUrl\(cfg\)\s*:\s*studioBridgeUrl\(cfg\)/,
  'factory blank must use setup while recovery retains the existing station-targeted Studio URL');
assert.match(commissioningMarkup, /target='lightweaver-studio'/,
  'commissioning must reuse the stable Studio window so session recovery remains available');
assert.doesNotMatch(commissioningMarkup, /target='_blank'/,
  'commissioning must not create an unrelated Studio browsing context');
assert.doesNotMatch(commissioningMarkup, /lwOpenStudio/,
  'commissioning CTA must not rewrite the station cardHost to the AP page location');
assert.doesNotMatch(commissioningMarkup, /id='pw'|Save and join Wi|Pattern bank|id='brightness'/,
  'station-connected blank cards must not be asked for WiFi again or receive visitor controls');

const bridgeScript = advancedRoot.indexOf('page += studioBridgeScript();');
assert.ok(bridgeScript > controlsStart,
  'the card bridge script must remain unconditional across setup, commissioning, and controls');

const setupScriptStart = advancedRoot.indexOf('if (needsWifiSetup) {', bridgeScript);
assert.ok(setupScriptStart > bridgeScript,
  'WiFi setup behavior must remain isolated to the WiFi setup surface');
assert.match(advancedRoot.slice(setupScriptStart), /else if \(!needsCommissioning\) \{/,
  'visitor control scripts must not initialize on the blank-card commissioning surface');

console.log('blank-card commissioning surface tests passed');
