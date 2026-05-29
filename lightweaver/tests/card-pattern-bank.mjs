import assert from 'node:assert/strict';
import { DEFAULT_CARD_PATTERN_BANK } from '../src/lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';

const ids = DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id);

assert.ok(
  ids.length >= 24,
  `expected at least 24 chip-ready patterns, got ${ids.length}`,
);

for (const id of [
  'aurora',
  'plasma',
  'fire',
  'ocean',
  'sparkle',
  'meteor',
  'matrix',
  'heartbeat',
  'confetti',
  'sunset',
]) {
  assert.ok(ids.includes(id), `missing chip-ready pattern ${id}`);
}

const previewCount = DEFAULT_CARD_PATTERN_BANK.filter(pattern => pattern.preview || pattern.previewPatternId).length;
assert.equal(previewCount, DEFAULT_CARD_PATTERN_BANK.length, 'every chip pattern needs local preview metadata');

const selectedPackage = buildCardRuntimePackageFromProject({
  projectName: 'Selected Catalog',
  standaloneController: {
    defaultLook: { patternId: 'fire' },
    controls: { encoder: { patternCycleIds: ['fire', 'ocean', 'sparkle'] } },
  },
});

assert.deepEqual(
  selectedPackage.config.patterns.map(pattern => pattern.id),
  ['fire', 'ocean', 'sparkle'],
);
assert.equal(selectedPackage.config.startupPatternId, 'fire');

console.log('card-pattern-bank tests passed');
