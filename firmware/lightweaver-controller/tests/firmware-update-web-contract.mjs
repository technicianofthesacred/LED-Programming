import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../src');
const sourcePath = resolve(root, 'LightweaverFirmwareUpdate.cpp');
assert.ok(existsSync(sourcePath), 'firmware updater web module must exist');
const updater = readFileSync(sourcePath, 'utf8');
const grant = readFileSync(resolve(root, 'LightweaverFirmwareUpdateGrant.cpp'), 'utf8');
const web = readFileSync(resolve(root, 'LightweaverWeb.cpp'), 'utf8');
const main = readFileSync(resolve(root, 'main.cpp'), 'utf8');
const runtime = readFileSync(resolve(root, 'LightweaverRuntimeApi.h'), 'utf8');

for (const route of ['/api/update/preflight', '/api/update/begin', '/api/update/chunk',
  '/api/update/commit', '/api/update/cancel', '/api/update/status', '/api/update/challenge']) {
  assert.match(updater, new RegExp(route.replaceAll('/', '\\/')), `${route} is registered`);
}
assert.match(updater, /RAW_START[\s\S]*clientContentLength\(\)[\s\S]*LW_FIRMWARE_UPDATE_HTTP_MAX_BODY_BYTES/,
  'raw requests are rejected by declared size before buffering');
assert.match(updater, /RAW_ABORTED[\s\S]*(?:abort|cancel)/i,
  'interrupted requests abandon the inactive update');
assert.match(updater, /LightweaverOwnerValidation::Accepted/);
assert.match(updater, /runtimeOwnerPairingAuthorized\(\)/,
  'preflight/begin require a recent physical card confirmation');
assert.match(updater, /releaseBuildId[\s\S]*ticketSha256[\s\S]*physicalConfirmationNonce/,
  'release and physical confirmation evidence are carried in the mutation envelope');
assert.match(updater, /Access-Control-Allow-Headers[\s\S]*X-Lightweaver-Capability/);
assert.match(updater,
  /Access-Control-Allow-Headers[\s\S]*X-Lightweaver-Release-Build[\s\S]*X-Lightweaver-Ticket-Sha256/,
  'public Studio preflight may send the release and ticket binding headers');
assert.match(updater, /Cache-Control[\s\S]*no-store/);
assert.match(updater, /consumeSignedGrant/,
  'preflight may consume one exact signed software grant');
assert.match(updater, /validateCapability/,
  'begin, chunk, commit, and cancel may use only the update-scoped capability');
assert.match(updater, /revokeCapability/,
  'terminal and abort paths revoke update-only authority');
assert.match(grant, /LW_UPDATE_GRANT_TTL_MS/);
assert.doesNotMatch(grant, /runtimeOwnerPairingAuthorized|lightweaverOwnerCapability/,
  'software grants neither require nor create general physical owner authority');
assert.match(updater, /authorizePhysicalUpdate[\s\S]*runtimeOwnerPairingAuthorized\(\)/,
  'the existing physical fallback remains independently present');
assert.match(updater, /method\s*==\s*HTTP_POST[\s\S]*\/api\/update\/challenge/,
  'the challenge endpoint consumes the bounded POST body used by Studio');
assert.match(updater, /handleChallenge[\s\S]*cardId[\s\S]*bootId[\s\S]*studioOrigin[\s\S]*expectedProjectHead[\s\S]*releaseBuildId[\s\S]*ticketSha256/,
  'the card checks every caller-supplied challenge binding before emitting signed bytes');
assert.match(web, /registerLightweaverFirmwareUpdate\(server\)/);
assert.match(web, /handleLightweaverFirmwareUpdate\(\)/);
assert.match(runtime, /runtimeFirmwareUpdateStatusJson\(\)/);
assert.match(main, /"firmwareUpdate"[\s\S]*"network"/,
  'status and firmware-info advertise preserving network update capability');
assert.match(main, /"firmwareUpdate"[\s\S]*"softwareGrant"/,
  'status and firmware-info advertise secure software update grants separately');
assert.match(main, /runtimeFirmwareUpdateStatusJson\(\)/,
  'status and firmware-info include current transfer/rollback evidence');
for (const field of ['restoredFirmwareVersion', 'restoredBuildId', 'restoredBuildNumber']) {
  assert.match(updater, new RegExp(`doc\\["${field}"\\]`),
    `rollback status publishes ${field}`);
}

console.log('firmware update web contract tests passed');
