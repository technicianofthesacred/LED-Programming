import React from 'react';
import { isCardLinkConnected } from '../../lib/cardLink.js';

const ATTENTION_REASONS = new Set([
  'firmware-too-old',
  'identity-missing',
  'popup-blocked',
  'wrong-card',
]);

export function cardConnectionStatus(link = {}) {
  if (link.activity === 'recovering' || link.state === 'reconnecting-bridge') return 'Recovering';
  if (link.activity === 'failed' || ATTENTION_REASONS.has(link.reason)) return 'Needs attention';
  if (link.activity === 'pending' || link.state === 'connecting') return 'Connecting';
  if (isCardLinkConnected(link)) return 'Connected';
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
    <button
      type="button"
      className={`card-status-control is-${status.toLowerCase().replace(/\s+/g, '-')}`}
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
  );
}
