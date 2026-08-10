import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
  PRESERVING_BOOTSTRAP_RANGE,
  inspectPreservingBootstrapEvidence,
  planPreservingBootstrap,
  runPreservingUsbBootstrap,
} from './preservingUsbBootstrap.js';

const CARD_ID = 'lw-b0fe81f61b44';
const SOURCE_BUILD = '1'.repeat(40);
const TARGET_BUILD = '2'.repeat(40);
const TABLE = new Uint8Array(4096).fill(0xff);
TABLE.set([0xaa, 0x50, 0x01, 0x02], 0);
const TABLE_SHA = createHash('sha256').update(TABLE).digest('hex');
const IMAGE = new Uint8Array(8193).fill(7);
IMAGE[0] = 0xe9;
const IMAGE_SHA = createHash('sha256').update(IMAGE).digest('hex');

function release() {
  return {
    manifest: { firmwareVersion: '1.2.0', buildId: TARGET_BUILD, buildNumber: 1300 },
    ticket: {
      schemaVersion: 1,
      firmwareVersion: '1.2.0', buildId: TARGET_BUILD, buildNumber: 1300,
      target: 'esp32-s3-n16r8',
      image: { size: IMAGE.byteLength, sha256: IMAGE_SHA },
      partition: {
        layout: 'default_16MB.csv', tableSha256: TABLE_SHA,
        app0Offset: 0x10000, app1Offset: 0x650000, slotSize: 0x640000,
      },
      compatibility: {
        firmwareApiMin: 2, firmwareApiMax: 2, projectSchemaMin: 3, projectSchemaMax: 3,
        minimumUpdaterVersion: 1, minimumBootstrapBuild: 1198,
      },
      preservation: { dataPartitionsIncluded: false },
    },
    imageBytes: IMAGE,
  };
}

function evidence() {
  return {
    cardId: CARD_ID, chipName: 'ESP32-S3', flashBytes: 16 * 1024 * 1024,
    firmwareVersion: '1.1.1', buildId: SOURCE_BUILD, buildNumber: 1198,
    source: 'usb-flash', partitionTableSha256: TABLE_SHA,
    installedAppOffset: 0x10000,
  };
}

test('preserving USB plan requires direct exact evidence and permits one app0-only non-erasing write', () => {
  const plan = planPreservingBootstrap(evidence(), release());
  assert.deepEqual({
    address: plan.address, eraseAll: plan.eraseAll, size: plan.bytes.byteLength,
    start: plan.range.start, end: plan.range.end,
  }, {
    address: 0x10000, eraseAll: false, size: IMAGE.byteLength,
    start: 0x10000, end: 0x10000 + IMAGE.byteLength,
  });
  assert.deepEqual(PRESERVING_BOOTSTRAP_RANGE, { start: 0x10000, end: 0x650000 });
  for (const changed of [
    { source: 'remembered' },
    { partitionTableSha256: '0'.repeat(64) },
    { installedAppOffset: 0x650000 },
    { buildNumber: 1197 },
    { chipName: 'ESP32' },
  ]) {
    assert.throws(() => planPreservingBootstrap({ ...evidence(), ...changed }, release()), /before writing|preserving/i);
  }
  assert.throws(() => planPreservingBootstrap(evidence(), {
    ...release(),
    ticket: { ...release().ticket, preservation: { dataPartitionsIncluded: true } },
  }), /data partitions/i);
});

test('USB inspection hashes exactly raw [0x8000,0x9000) bytes and never reads NVS', async () => {
  const reads = [];
  const loader = {
    async readFlash(address, size) { reads.push([address, size]); return TABLE; },
  };
  const inspected = await inspectPreservingBootstrapEvidence(loader, evidence());
  assert.equal(inspected.partitionTableSha256, TABLE_SHA);
  assert.deepEqual(reads, [[0x8000, 0x1000]]);
});

test('bootstrap writes app0 without erase, verifies exact SHA-256 readback, resets, and releases USB', async () => {
  const events = [];
  const loader = {
    async readFlash(address, size) {
      events.push(['read', address, size]);
      return address === 0x8000 ? TABLE : IMAGE.slice(0, size);
    },
  };
  const result = await runPreservingUsbBootstrap({
    loader, transport: {}, evidence: evidence(), release: release(),
    writeApplication: async (_loader, bytes, address, eraseAll, onProgress) => {
      events.push(['write', address, eraseAll, bytes.byteLength]); onProgress?.(1);
    },
    resetIntoApp: async () => events.push(['reset']),
    disconnect: async () => events.push(['disconnect']),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    ['read', 0x8000, 0x1000],
    ['write', 0x10000, false, IMAGE.byteLength],
    ['read', 0x10000, IMAGE.byteLength],
    ['reset'], ['disconnect'],
  ]);
});

test('interrupted bootstrap always releases USB and says preserved data remains repeatable', async () => {
  const events = [];
  await assert.rejects(() => runPreservingUsbBootstrap({
    loader: { readFlash: async () => TABLE.slice() }, transport: {}, evidence: evidence(), release: release(),
    writeApplication: async () => { throw new Error('cable removed'); },
    disconnect: async () => events.push('disconnect'),
  }), error => {
    assert.match(error.message, /data remains|repeat/i);
    assert.equal(error.recovery, 'repeat-preserving-usb-bootstrap');
    return true;
  });
  assert.deepEqual(events, ['disconnect']);
});
