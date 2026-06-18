import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultStandaloneController } from './projectModel.js';
import {
  deriveLegacyPatternCycleIds,
  normalizeCardPlaylist,
  playlistContainsCombo,
  playlistContainsPattern,
} from './cardPlaylist.js';

test('defaultStandaloneController migrates old knob cycle order into a card playlist', () => {
  const controller = defaultStandaloneController({
    defaultLook: { patternId: 'fire' },
    controls: { encoder: { patternCycleIds: ['ocean', 'aurora', 'ocean'] } },
  });

  assert.deepEqual(controller.playlist.map(item => item.type), ['pattern', 'pattern', 'pattern']);
  assert.deepEqual(controller.playlist.map(item => item.patternId), ['fire', 'ocean', 'aurora']);
  assert.equal(controller.playlist[0].id, 'fire');
  assert.equal(playlistContainsPattern(controller.playlist, 'fire'), true);
  assert.equal(playlistContainsPattern(controller.playlist, 'sparkle'), false);
  assert.deepEqual(deriveLegacyPatternCycleIds(controller.playlist), ['fire', 'ocean', 'aurora']);
});

test('normalizeCardPlaylist preserves pattern and combo playlist items in card order', () => {
  const savedLooks = [{
    id: 'split-glow',
    label: 'Split glow',
    defaultLook: { patternId: 'aurora' },
    sectionLooks: {
      outer: { patternId: 'fire' },
      inner: { patternId: 'ocean' },
    },
  }];

  const playlist = normalizeCardPlaylist([
    { type: 'pattern', patternId: 'plasma' },
    { type: 'combo', lookId: 'split-glow' },
    { type: 'combo', lookId: 'missing' },
    { type: 'pattern', patternId: 'missing' },
  ], { savedLooks });

  assert.deepEqual(playlist.map(item => item.id), ['plasma', 'combo-split-glow']);
  assert.deepEqual(playlist.map(item => item.label), ['Plasma', 'Split glow']);
  assert.equal(playlist[1].type, 'combo');
  assert.equal(playlist[1].lookId, 'split-glow');
  assert.equal(playlistContainsCombo(playlist, 'split-glow'), true);
  assert.equal(playlistContainsCombo(playlist, 'missing'), false);
  assert.deepEqual(deriveLegacyPatternCycleIds(playlist), ['plasma']);
});
