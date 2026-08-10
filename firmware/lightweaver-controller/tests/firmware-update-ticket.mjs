import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourceRoot = resolve(import.meta.dirname, '../src');
const headerPath = resolve(sourceRoot, 'LightweaverFirmwareUpdate.h');
const sourcePath = resolve(sourceRoot, 'LightweaverFirmwareUpdate.cpp');

assert.ok(existsSync(headerPath) && existsSync(sourcePath),
  'signed preserving firmware updater module must exist');

const header = readFileSync(headerPath, 'utf8');
const source = readFileSync(sourcePath, 'utf8');

assert.match(header, /LW_FIRMWARE_UPDATE_TICKET_MAX_BYTES/);
assert.match(header, /LW_FIRMWARE_UPDATE_SIGNATURE_BYTES\s*=\s*64/);
assert.match(source, /LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM/,
  'firmware must pin the production release verification key');
assert.match(source, /mbedtls_ecdsa_verify|mbedtls_pk_verify/,
  'the card independently verifies the P-256 publisher signature');
assert.match(source, /mbedtls_sha256/,
  'ticket and image authorization are SHA-256 bound');
assert.match(source, /dataPartitionsIncluded/);
assert.match(source, /default_16MB\.csv/);
assert.match(source, /0x10000|65536/);
assert.match(source, /0x650000|6619136/);
assert.match(source, /0x640000|6553600/);
assert.match(source, /0x8000/);
assert.match(source, /0x1000/,
  'partition identity covers the exact 4096-byte flash table sector');
assert.match(source, /unsupported ticket fields/,
  'ticket parsing rejects unknown fields instead of ignoring them');
assert.match(source, /firmwareVersion[\s\S]*buildId[\s\S]*buildNumber[\s\S]*target[\s\S]*image[\s\S]*partition[\s\S]*compatibility[\s\S]*preservation/,
  'all fixed ticket fields are consumed by the verifier');

console.log('firmware update ticket contract tests passed');
