import { buildCardConfigHandoffUrl } from './cardPushClient.js';

export function formatBrowserProjectSaveLabel(record = {}) {
  const name = String(record.name || '').trim();
  return `${name || 'Project'} saved in browser library`;
}

export function makePlaylistPushPendingState() {
  return null;
}

export function makePlaylistPushSuccessState() {
  return null;
}

function shouldOfferHandoff(reason = '') {
  return [
    'mixed-content',
    'bridge-missing',
    'bridge-timeout',
    'bridge-post-failed',
  ].includes(reason);
}

function playlistPushErrorMessage(error = {}) {
  const reason = error?.reason || '';
  if (reason === 'mixed-content') {
    return 'The browser blocked the direct local-card write. Open the card installer to finish the save from the card page.';
  }
  if (reason === 'bridge-missing') {
    return 'Open the card page once, then try Load playlist to card again.';
  }
  if (reason === 'bridge-timeout') {
    return 'The card page did not answer. Reopen the card page, then try Load playlist to card again.';
  }
  if (reason === 'bridge-post-failed') {
    return 'Studio could not send the playlist to the card page. Reopen the card page, then try again.';
  }
  return error?.message || 'Could not load the playlist to the card.';
}

export function makePlaylistPushErrorState(error = {}, {
  host = '',
  runtimePackage = {},
  buildHandoffUrl = buildCardConfigHandoffUrl,
} = {}) {
  const reason = error?.reason || '';
  return {
    kind: 'err',
    message: playlistPushErrorMessage(error),
    handoffUrl: shouldOfferHandoff(reason) ? buildHandoffUrl(host, runtimePackage) : '',
  };
}
