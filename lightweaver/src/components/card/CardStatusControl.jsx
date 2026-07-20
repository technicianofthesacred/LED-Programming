import React from 'react';
import { isCardLinkConnected } from '../../lib/cardLink.js';

const ATTENTION_REASONS = new Set([
  'firmware-too-old',
  'identity-missing',
  'popup-blocked',
  'wrong-card',
  'wrong-firmware-version',
  'wrong-firmware-build',
]);

export function cardConnectionStatus(link = {}) {
  if (link.state === 'revalidating' && link.reason === 'card-restarted') return 'Card restarted — verifying';
  if (link.state === 'reconnecting' || link.state === 'reconnecting-bridge') return 'Card stopped responding';
  if (link.reason === 'wrong-card') return 'Wrong card';
  if (link.activity === 'recovering') return 'Recovering';
  if (link.activity === 'failed' || ATTENTION_REASONS.has(link.reason)) return 'Needs attention';
  if (link.activity === 'pending' || link.state === 'connecting') return 'Connecting';
  // A paired, reachable card that is still on factory defaults is genuinely
  // linked (writes will pass the identity guard) but has no project installed —
  // so it is not green "Connected", it is "Needs project".
  const verifiedTransport = Boolean(
    link.card?.id
    && (link.state === 'connected-bridge' || link.state === 'connected-direct')
  );
  if (verifiedTransport && link.cardBlank === true) return 'Needs project';
  if (isCardLinkConnected(link)) return 'Connected';
  if (verifiedTransport || link.state === 'revalidating') return 'Checking card';
  // A card answered but this origin has never paired it — actionable, not green.
  if (link.reason === 'found-unpaired') return 'Found — pair';
  return 'Not connected';
}

function connectedSummary(card = {}) {
  return [
    card.pixelCount > 0 ? `${card.pixelCount} pixels` : '',
    card.gpioSummary,
    card.firmwareVersion ? `firmware ${card.firmwareVersion}` : '',
    card.buildId ? `build ${card.buildId}` : '',
  ].filter(Boolean).join(' · ');
}

export function CardStatusControl({ link, onOpen, open = false }) {
  const status = cardConnectionStatus(link);
  const connected = status === 'Connected';
  const summary = connected ? connectedSummary(link.card) : '';
  const accessibleName = connected
    ? `${link.card?.name || 'Lightweaver'} · Connected`
    : `Connect Lightweaver · ${status}`;

  return (
    <>
      <button
        type="button"
        className={`card-status-control is-${status.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`}
        onClick={onOpen}
        aria-label={accessibleName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="card-connection-center"
        data-testid="card-link-status"
      >
        <span className="card-status-dot" aria-hidden="true" />
        <span className="card-status-copy">
          <span className="card-status-name">{connected ? (link.card?.name || 'Lightweaver') : 'Lightweaver'}</span>
          <span className="card-status-state">{status}</span>
        </span>
        {summary && <span className="card-status-summary">{summary}</span>}
      </button>
      <span className="card-status-announcement" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </span>
    </>
  );
}
