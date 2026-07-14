import assert from 'node:assert/strict';
import { createDefaultCircleLayout } from '../src/lib/defaultCircleLayout.js';
import { createDefaultPatchBoard } from '../src/lib/patchBoard.js';
import {
  buildPatternPlaylistPreview,
  buildSavedLookPlaylistPreviewTargets,
} from '../src/lib/playlistLivePreview.js';
import {
  cardActionReducer,
  cardActionStatusLabel,
  createCardActionState,
} from '../src/lib/cardAction.js';

const strips = createDefaultCircleLayout({ sectionPixelCounts: [22, 22] });
const patchBoard = createDefaultPatchBoard(strips);

const firePreview = buildPatternPlaylistPreview('fire');
assert.equal(firePreview.patternId, 'fire');
assert.equal(firePreview.syncZones, true);
assert.equal(firePreview.brightness, 1);

const targets = buildSavedLookPlaylistPreviewTargets({
  strips,
  patchBoard,
  savedLook: {
    id: 'split-look',
    label: 'Split Look',
    defaultLook: { patternId: 'plasma' },
    sectionLooks: {
      'patch-default-outer-circle': { patternId: 'sparkle', brightness: 0.6 },
    },
  },
});

const allTarget = targets.find(target => target.kind === 'all');
const outerTarget = targets.find(target => target.id === 'patch-default-outer-circle');
const innerTarget = targets.find(target => target.id === 'patch-default-inner-circle');

assert.equal(allTarget?.look.patternId, 'plasma');
assert.equal(outerTarget?.zoneId, 'patch-default-outer-circle');
assert.equal(outerTarget?.look.patternId, 'sparkle');
assert.equal(outerTarget?.look.brightness, 0.6);
assert.equal(innerTarget?.zoneId, 'patch-default-inner-circle');
assert.equal(innerTarget?.look.patternId, 'plasma');

// Playlist selection is a Studio intent immediately, while the highlighted
// physical row remains the last card-confirmed revision. Late acknowledgements
// from a superseded row cannot move the physical highlight backwards.
let physicalState = createCardActionState({ confirmedRevision: 'row-fire' });
physicalState = cardActionReducer(physicalState, { type: 'start', revision: 'row-ocean' });
assert.equal(cardActionStatusLabel(physicalState), 'Sending to Lightweaver');
assert.equal(physicalState.confirmedRevision, 'row-fire');
physicalState = cardActionReducer(physicalState, { type: 'start', revision: 'row-plasma' });
const afterLateOcean = cardActionReducer(physicalState, { type: 'confirm', revision: 'row-ocean' });
assert.strictEqual(afterLateOcean, physicalState);
physicalState = cardActionReducer(physicalState, { type: 'confirm', revision: 'row-plasma' });
assert.equal(physicalState.confirmedRevision, 'row-plasma');
assert.equal(cardActionStatusLabel(physicalState), 'Playing on Lightweaver');

console.log('playlist live preview helpers OK');
