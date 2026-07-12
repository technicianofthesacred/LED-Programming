import assert from 'node:assert/strict';
import {
  formatBrowserProjectSaveLabel,
  makePlaylistPushErrorState,
  makePlaylistPushPendingState,
  makePlaylistPushSuccessState,
} from '../src/lib/studioActionStatus.js';
import {
  formatBrowserProjectSaveLabel as formatBrowserProjectSaveLabelV3,
  makePlaylistPushErrorState as makePlaylistPushErrorStateV3,
  makePlaylistPushSuccessState as makePlaylistPushSuccessStateV3,
} from '../src-v3/lib/studioActionStatus.js';

assert.equal(
  formatBrowserProjectSaveLabel({ name: 'Shanghai Mandala' }),
  'Shanghai Mandala saved in browser library',
);
assert.equal(formatBrowserProjectSaveLabel({}), 'Project saved in browser library');
assert.equal(
  formatBrowserProjectSaveLabelV3({ name: 'Shanghai Mandala' }),
  'Shanghai Mandala saved in browser library',
);

assert.equal(makePlaylistPushPendingState(), null);
assert.equal(makePlaylistPushSuccessState(), null);
assert.equal(makePlaylistPushSuccessState({ rebooting: true }), null);
assert.equal(makePlaylistPushSuccessStateV3().message, 'Playlist saved to the card.');

const handoffBuilder = (host) => `http://${host}/#lwconfig=abc&reboot=1`;
const bridgeTimeout = new Error('Timed out waiting for the card bridge.');
bridgeTimeout.reason = 'bridge-timeout';
assert.deepEqual(
  makePlaylistPushErrorState(bridgeTimeout, {
    host: 'lightweaver.local',
    buildHandoffUrl: handoffBuilder,
  }),
  {
    kind: 'err',
    message: 'The card page did not answer. Reopen the card page, then try Load playlist to card again.',
    handoffUrl: 'http://lightweaver.local/#lwconfig=abc&reboot=1',
    action: null,
  },
);
assert.deepEqual(
  makePlaylistPushErrorStateV3(bridgeTimeout, {
    host: 'lightweaver.local',
    buildHandoffUrl: handoffBuilder,
  }),
  {
    kind: 'err',
    message: 'The card page did not answer. Reopen the card page, then try Load playlist to card again.',
    handoffUrl: 'http://lightweaver.local/#lwconfig=abc&reboot=1',
  },
);

const layoutMismatch = new Error('Stopped before saving: output layout changed.');
layoutMismatch.reason = 'layout-mismatch';
layoutMismatch.layout = { current: '44 LEDs / 1 output', target: '94 LEDs / 3 outputs' };
const layoutState = makePlaylistPushErrorState(layoutMismatch, {
  host: 'lightweaver.local',
  buildHandoffUrl: handoffBuilder,
});
assert.equal(layoutState.kind, 'err');
assert.equal(layoutState.message, 'Stopped before saving: output layout changed.');
assert.equal(layoutState.handoffUrl, '');
// Layout mismatch offers an in-place reconcile that re-pushes with the wiring
// override, so the user never has to detour to Settings just to load a playlist.
assert.equal(layoutState.action.kind, 'allow-layout-change');
assert.equal(layoutState.action.label, 'Set card to 94 LEDs / 3 outputs & load');
assert.ok(layoutState.action.hint);

const projectMismatch = new Error('Stopped before saving: paired with another piece.');
projectMismatch.reason = 'project-mismatch';
projectMismatch.pieces = { current: 'Shanghai Mandala', target: 'Lotus Gate' };
const projectState = makePlaylistPushErrorState(projectMismatch, { host: 'lightweaver.local' });
assert.equal(projectState.action.kind, 'allow-project-change');
assert.equal(projectState.action.label, 'Recommission card for Lotus Gate & load');

console.log('studio-action-status tests passed');
