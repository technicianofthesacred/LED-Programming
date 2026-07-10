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
assert.deepEqual(
  makePlaylistPushErrorState(layoutMismatch, {
    host: 'lightweaver.local',
    buildHandoffUrl: handoffBuilder,
  }),
  {
    kind: 'err',
    message: 'Stopped before saving: output layout changed.',
    handoffUrl: '',
  },
);

console.log('studio-action-status tests passed');
