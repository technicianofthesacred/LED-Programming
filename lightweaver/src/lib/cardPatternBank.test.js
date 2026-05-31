import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_PATTERN_BANK,
  getCardPatternFingerprint,
} from './cardPatternBank.js';

test('builds a useful preview fingerprint for a named chip pattern', () => {
  const fingerprint = getCardPatternFingerprint('lava');

  assert.equal(fingerprint.id, 'lava');
  assert.equal(fingerprint.motionLabel, 'Organic blobs');
  assert.equal(fingerprint.tempoLabel, 'Slow');
  assert.equal(fingerprint.intensityLabel, 'Warm');
  assert.equal(fingerprint.cssClass, 'motion-organic');
  assert.deepEqual(fingerprint.palette.slice(0, 3), ['#290604', '#b51606', '#ff7a1a']);
  assert.ok(fingerprint.tags.includes('blob'));
});

test('every chip pattern has preview metadata for cards and inspectors', () => {
  for (const pattern of CARD_PATTERN_BANK) {
    const fingerprint = getCardPatternFingerprint(pattern.id);

    assert.equal(fingerprint.id, pattern.id);
    assert.ok(fingerprint.motionLabel.length > 2, `${pattern.id} motion label`);
    assert.ok(fingerprint.tempoLabel.length > 2, `${pattern.id} tempo label`);
    assert.ok(fingerprint.intensityLabel.length > 2, `${pattern.id} intensity label`);
    assert.ok(fingerprint.cssClass.startsWith('motion-'), `${pattern.id} css class`);
    assert.ok(fingerprint.palette.length >= 3, `${pattern.id} palette`);
    assert.ok(fingerprint.tags.length >= 2, `${pattern.id} tags`);
  }
});
