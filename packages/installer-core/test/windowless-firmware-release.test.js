import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  assertFirmwareManifestCardStudio,
  validateFirmwareManifest,
} from '../src/firmware-release.js';
import * as releaseCore from '../src/firmware-release.js';

const hash = character => character.repeat(64);
const manifest = {
  schemaVersion: 1,
  target: 'esp32-s3-n16r8',
  firmwareVersion: '1.2.3',
  buildId: 'a'.repeat(40),
  buildNumber: 1216,
  image: {
    url: `/firmware/releases/1.2.3/${'a'.repeat(40)}/lightweaver-controller-esp32s3-factory.bin`,
    size: 1200000,
    sha256: hash('1'),
    cardStudioReadback: { offset: 0, size: 1200000, sha256: hash('1') },
  },
  cardStudio: {
    buildId: 'a'.repeat(40),
    buildNumber: 1216,
    projectSchema: { min: 3, max: 3 },
    firmwareApi: { min: 1, max: 1 },
    totalSize: 333,
    bundleSha256: hash('2'),
    releaseMetadata: { size: 900, sha256: hash('3') },
    assets: [
      { path: '/studio/', size: 111, sha256: hash('4') },
      { path: '/studio/assets/card-a1b2c3d4.js', size: 222, sha256: hash('5') },
    ],
  },
  configSchema: { min: 1, max: 1 },
  minimumInstallerVersion: '1.4.0',
  provenance: {
    sourceRevision: 'a'.repeat(40), platformio: '6.1.19', platform: 'espressif32@7.0.1',
    framework: 'framework-arduinoespressif32@3.20017.241212+sha.dcc1105b',
    libraries: { FastLED: '3.10.3', ArduinoJson: '7.4.3', WebSockets: '2.7.3' },
  },
};

test('new combined releases validate exact card Studio identity and full-image readback', () => {
  assert.equal(validateFirmwareManifest(manifest).cardStudio.bundleSha256, hash('2'));
  assert.equal(assertFirmwareManifestCardStudio(manifest), manifest);
  assert.throws(() => validateFirmwareManifest({
    ...manifest,
    cardStudio: { ...manifest.cardStudio, buildId: 'b'.repeat(40) },
  }), /card Studio buildId/i);
  assert.throws(() => validateFirmwareManifest({
    ...manifest,
    image: { ...manifest.image, cardStudioReadback: { ...manifest.image.cardStudioReadback, sha256: hash('9') } },
  }), /readback/i);
});

test('legacy signed manifests remain readable but cannot pass the new-build card Studio assertion', () => {
  const legacy = structuredClone(manifest);
  delete legacy.cardStudio;
  delete legacy.image.cardStudioReadback;
  assert.doesNotThrow(() => validateFirmwareManifest(legacy));
  assert.throws(() => assertFirmwareManifestCardStudio(legacy), /newly built.*card Studio/i);
});

test('schema 2 requires the immutable application image, exact-byte ticket, and signature descriptors', () => {
  const version2 = {
    ...structuredClone(manifest),
    schemaVersion: 2,
    cardStudio: { ...structuredClone(manifest.cardStudio), firmwareApi: { min: 2, max: 2 } },
    update: {
      image: {
        url: `/firmware/releases/1.2.3/${'a'.repeat(40)}/lightweaver-controller-esp32s3-app.bin`,
        size: 1000000,
        sha256: hash('6'),
      },
      ticket: {
        url: `/firmware/releases/1.2.3/${'a'.repeat(40)}/firmware-update-ticket.json`,
        size: 1200,
        sha256: hash('7'),
      },
      signature: {
        url: `/firmware/releases/1.2.3/${'a'.repeat(40)}/firmware-update-ticket.sig`,
        size: 87,
        sha256: hash('8'),
      },
    },
  };

  assert.equal(validateFirmwareManifest(version2).update.image.size, 1000000);
  assert.throws(() => validateFirmwareManifest({
    ...version2,
    update: { ...version2.update, ticket: { ...version2.update.ticket, url: '/firmware/update.json' } },
  }), /ticket.*immutable/i);
  const missingUpdate = structuredClone(version2);
  delete missingUpdate.update;
  assert.throws(() => validateFirmwareManifest(missingUpdate), /schema 2.*update/i);
});

test('update ticket is exact, preserving, and bound to the raw 4096-byte partition-table range', () => {
  assert.equal(typeof releaseCore.validateFirmwareUpdateTicket, 'function');
  assert.equal(typeof releaseCore.canonicalFirmwareUpdateTicketBytes, 'function');
  assert.deepEqual(releaseCore.LIGHTWEAVER_PARTITION_LAYOUT, {
    layout: 'default_16MB.csv',
    tableOffset: 0x8000,
    tableSize: 0x1000,
    app0Offset: 0x10000,
    app1Offset: 0x650000,
    slotSize: 0x640000,
  });
  const ticket = {
    schemaVersion: 1,
    firmwareVersion: '1.2.3',
    buildId: 'a'.repeat(40),
    buildNumber: 1216,
    target: 'esp32-s3-n16r8',
    image: {
      url: `/firmware/releases/1.2.3/${'a'.repeat(40)}/lightweaver-controller-esp32s3-app.bin`,
      size: 1000000,
      sha256: hash('6'),
    },
    partition: {
      layout: 'default_16MB.csv',
      tableSha256: hash('9'),
      app0Offset: 0x10000,
      app1Offset: 0x650000,
      slotSize: 0x640000,
    },
    compatibility: {
      firmwareApiMin: 2,
      firmwareApiMax: 2,
      projectSchemaMin: 3,
      projectSchemaMax: 3,
      minimumUpdaterVersion: 1,
      minimumBootstrapBuild: 1198,
    },
    preservation: { dataPartitionsIncluded: false },
  };

  assert.equal(releaseCore.validateFirmwareUpdateTicket(ticket), ticket);
  assert.deepEqual(
    releaseCore.canonicalFirmwareUpdateTicketBytes(ticket),
    new TextEncoder().encode(JSON.stringify(ticket)),
  );
  assert.throws(() => releaseCore.validateFirmwareUpdateTicket({ ...ticket, extra: true }), /unsupported fields/i);
  assert.throws(() => releaseCore.validateFirmwareUpdateTicket({
    ...ticket,
    preservation: { dataPartitionsIncluded: true },
  }), /data partitions/i);
  assert.throws(() => releaseCore.validateFirmwareUpdateTicket({
    ...ticket,
    partition: { ...ticket.partition, tableSha256: 'bad' },
  }), /partition.*sha-256/i);
  assert.throws(() => releaseCore.validateFirmwareUpdateTicket({
    ...ticket,
    image: { ...ticket.image, size: 0x640001 },
  }), /slot/i);
});

test('update release loader verifies manifest, exact ticket/signature bytes, and app bytes before returning', async () => {
  assert.equal(typeof releaseCore.loadProductionFirmwareUpdateRelease, 'function');
  const version2 = {
    ...structuredClone(manifest),
    schemaVersion: 2,
    cardStudio: { ...structuredClone(manifest.cardStudio), firmwareApi: { min: 2, max: 2 } },
    update: {
      image: {
        url: `/firmware/releases/1.2.3/${'a'.repeat(40)}/lightweaver-controller-esp32s3-app.bin`,
        size: 4,
        sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
      },
      ticket: {
        url: `/firmware/releases/1.2.3/${'a'.repeat(40)}/firmware-update-ticket.json`,
        size: 0,
        sha256: hash('0'),
      },
      signature: {
        url: `/firmware/releases/1.2.3/${'a'.repeat(40)}/firmware-update-ticket.sig`,
        size: 87,
        sha256: hash('0'),
      },
    },
  };
  const ticket = {
    schemaVersion: 1,
    firmwareVersion: '1.2.3',
    buildId: 'a'.repeat(40),
    buildNumber: 1216,
    target: 'esp32-s3-n16r8',
    image: version2.update.image,
    partition: {
      layout: 'default_16MB.csv', tableSha256: hash('9'),
      app0Offset: 0x10000, app1Offset: 0x650000, slotSize: 0x640000,
    },
    compatibility: {
      firmwareApiMin: 2, firmwareApiMax: 2,
      projectSchemaMin: 3, projectSchemaMax: 3,
      minimumUpdaterVersion: 1, minimumBootstrapBuild: 1198,
    },
    preservation: { dataPartitionsIncluded: false },
  };
  const ticketBytes = Buffer.from(JSON.stringify(ticket));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const ticketRawSignature = sign('sha256', ticketBytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const ticketSignatureBytes = Buffer.from(`${ticketRawSignature.toString('base64url')}\n`);
  version2.update.ticket.size = ticketBytes.byteLength;
  version2.update.ticket.sha256 = createHash('sha256').update(ticketBytes).digest('hex');
  version2.update.signature.sha256 = createHash('sha256').update(ticketSignatureBytes).digest('hex');
  const manifestSignature = sign(
    'sha256',
    Buffer.from(releaseCore.canonicalFirmwareManifestBytes(version2)),
    { key: privateKey, dsaEncoding: 'ieee-p1363' },
  );
  const responses = new Map([
    ['/firmware/release-manifest.json', Buffer.from(JSON.stringify(version2))],
    ['/firmware/release-manifest.sig', Buffer.from(`${manifestSignature.toString('base64url')}\n`)],
    [version2.update.ticket.url, ticketBytes],
    [version2.update.signature.url, ticketSignatureBytes],
    [version2.update.image.url, Buffer.from([1, 2, 3, 4])],
  ]);
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push({ url, init });
    const body = responses.get(url);
    return body ? new Response(body, { status: 200, headers: { 'content-length': body.byteLength } }) : new Response('', { status: 404 });
  };

  const loaded = await releaseCore.loadProductionFirmwareUpdateRelease(fetchImpl, webcrypto, { publicKeyPem });
  assert.equal(loaded.ticketSha256, version2.update.ticket.sha256);
  assert.deepEqual(loaded.ticketBytes, new Uint8Array(ticketBytes));
  assert.deepEqual(loaded.imageBytes, new Uint8Array([1, 2, 3, 4]));
  assert.equal(loaded.ticketSignature.byteLength, 64);
  assert.ok(requested.every(call => call.init.cache === 'no-store'));

  responses.set(version2.update.ticket.url, Buffer.concat([ticketBytes, Buffer.from('\n')]));
  await assert.rejects(
    releaseCore.loadProductionFirmwareUpdateRelease(fetchImpl, webcrypto, { publicKeyPem }),
    /ticket size mismatch/i,
  );
});
