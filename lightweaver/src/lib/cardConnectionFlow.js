export const CARD_CONNECTION_ACTION_IDS = Object.freeze([
  'connected',
  'reconnect-known-card',
  'choose-card-condition',
  'open-setup-network',
  'open-card-page',
  'retry-card-page',
  'web-serial-install',
  'supported-browser-handoff',
  'supported-device-handoff',
  'connector-fallback',
]);

const ACTION_COPY = Object.freeze({
  connected: Object.freeze({
    title: 'Lightweaver connected',
    explanation: 'Studio has verified your card and is ready to control it.',
    primaryLabel: 'Done',
  }),
  'reconnect-known-card': Object.freeze({
    title: 'Reconnect your Lightweaver',
    explanation: 'Studio knows which card to look for and can reconnect it.',
    primaryLabel: 'Reconnect',
  }),
  'choose-card-condition': Object.freeze({
    title: 'Tell us about your card',
    explanation: 'Choose whether this card is already running Lightweaver or still needs installation.',
    primaryLabel: 'Choose card condition',
  }),
  'open-setup-network': Object.freeze({
    title: 'Finish card setup',
    explanation: 'Join the Lightweaver setup network, finish Wi-Fi setup, then return to Studio.',
    primaryLabel: 'Open setup',
  }),
  'open-card-page': Object.freeze({
    title: 'Open your Lightweaver card',
    explanation: 'Open the card page so Studio can find and verify your Lightweaver.',
    primaryLabel: 'Open card page',
  }),
  'retry-card-page': Object.freeze({
    title: 'Try the card page again',
    explanation: 'Keep the card page open, then try the connection again.',
    primaryLabel: 'Try again',
  }),
  'web-serial-install': Object.freeze({
    title: 'Install Lightweaver',
    explanation: 'This device can prepare a blank card for Lightweaver.',
    primaryLabel: 'Start installation',
  }),
  'supported-browser-handoff': Object.freeze({
    title: 'Continue in a supported browser',
    explanation: 'Open Studio in Chrome or Edge on this computer to install Lightweaver.',
    primaryLabel: 'Show browser steps',
  }),
  'supported-device-handoff': Object.freeze({
    title: 'Continue on a supported computer',
    explanation: 'Use a Mac, Windows, or Linux computer with Chrome or Edge to continue.',
    primaryLabel: 'Show computer steps',
  }),
  'connector-fallback': Object.freeze({
    title: 'Use advanced recovery',
    explanation: 'This card needs the recovery connector and the advanced recovery steps.',
    primaryLabel: 'Open recovery options',
  }),
});

const RETRY_REASONS = new Set(['popup-blocked', 'no-answer', 'card-page-closed']);
const INSTALL_RECOVERY_REASONS = new Set(['identity-missing', 'firmware-too-old']);
const MOBILE_PLATFORMS = new Set(['android', 'ios', 'unknown']);
const DESKTOP_PLATFORMS = new Set(['macos', 'windows', 'linux']);

function action(id, additions = {}) {
  const copy = ACTION_COPY[id];
  if (!copy || !CARD_CONNECTION_ACTION_IDS.includes(id)) {
    throw new RangeError(`Unknown card connection action: ${String(id)}`);
  }
  return { id, ...copy, ...additions };
}

function hasCardIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value.id ?? value.cardId;
  if (typeof candidate !== 'string') return false;
  const id = candidate.trim();
  return id.length > 0 && id.length <= 64;
}

function cardLabel(value, fallback) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  if (typeof value.name === 'string') {
    const name = value.name.trim().slice(0, 128);
    if (name) return name;
  }
  if (hasCardIdentity(value)) return (value.id ?? value.cardId).trim();
  return fallback;
}

function hasKnownCard(input, link) {
  return [
    input.expectedCard,
    input.rememberedCard,
    input.discoveredCard,
    input.detectedCard,
    input.card,
    input.discovery?.card,
    link.expectedCard,
    link.card,
  ].some(hasCardIdentity);
}

function isSetupMode(value) {
  return value === true || value === 'setup' || value === 'ap' || value === 'access-point';
}

function hasSetupEvidence(input, link) {
  const setupNetwork = input.setupNetwork;
  const networkEvidence = setupNetwork === true || (
    setupNetwork && typeof setupNetwork === 'object' && (
      setupNetwork.available === true
      || setupNetwork.found === true
      || /^Lightweaver-/i.test(String(setupNetwork.ssid || ''))
    )
  );

  return networkEvidence
    || isSetupMode(input.setupMode)
    || isSetupMode(input.mode)
    || isSetupMode(input.accessPoint)
    || isSetupMode(input.discovery?.mode)
    || isSetupMode(input.discoveredCard?.mode)
    || isSetupMode(link.card?.mode);
}

function unsupportedInstallHandoff(capabilities) {
  if (capabilities.handoffKind === 'supported-browser-handoff') {
    return 'supported-browser-handoff';
  }
  if (capabilities.handoffKind === 'supported-device-handoff') {
    return 'supported-device-handoff';
  }
  if (capabilities.isMobile === true || MOBILE_PLATFORMS.has(capabilities.platform)) {
    return 'supported-device-handoff';
  }
  if (DESKTOP_PLATFORMS.has(capabilities.platform)) {
    return 'supported-browser-handoff';
  }
  return 'supported-device-handoff';
}

function installRecoveryAction(capabilities) {
  if (capabilities.canWebSerialInstall === true) return action('web-serial-install');
  return action(unsupportedInstallHandoff(capabilities));
}

export function nextCardConnectionAction(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return action('choose-card-condition');
  }

  const link = input.link && typeof input.link === 'object' ? input.link : {};
  const capabilities = input.capabilities && typeof input.capabilities === 'object'
    ? input.capabilities
    : {};

  if (
    (link.state === 'connected-bridge' || link.state === 'connected-direct')
    && hasCardIdentity(link.card)
  ) {
    return action('connected');
  }

  if (link.state === 'connecting' || link.state === 'reconnecting' || link.state === 'reconnecting-bridge') {
    return action('reconnect-known-card', {
      explanation: 'Studio is reconnecting to your Lightweaver now.',
      primaryLabel: 'Connecting…',
      busy: true,
      pending: true,
      primaryDisabled: true,
    });
  }

  if (link.reason === 'wrong-card') {
    const expected = cardLabel(input.expectedCard || link.expectedCard, 'your expected card');
    const detected = cardLabel(input.detectedCard || input.discoveredCard || input.card || link.card, 'a different card');
    return action('reconnect-known-card', {
      explanation: `Studio expected ${expected}, but found ${detected}. Reconnect the expected card or explicitly choose the detected card.`,
      primaryLabel: 'Reconnect expected card',
      secondaryAction: {
        id: 'adopt-discovered-card',
        label: 'Use this card instead',
      },
    });
  }
  if (INSTALL_RECOVERY_REASONS.has(link.reason)) return installRecoveryAction(capabilities);
  if (RETRY_REASONS.has(link.reason)) return action('retry-card-page');

  if (input.intent === 'working-card') {
    if (hasKnownCard(input, link)) return action('reconnect-known-card');
    if (hasSetupEvidence(input, link)) return action('open-setup-network');
    return action('open-card-page');
  }

  if (input.intent === 'blank-card') {
    if (capabilities.canWebSerialInstall === true) return action('web-serial-install');
    return action(unsupportedInstallHandoff(capabilities));
  }

  if (input.intent === 'deep-recovery') {
    if (capabilities.canWebSerialInstall === true) return action('web-serial-install');
    const mobile = capabilities.isMobile === true
      || MOBILE_PLATFORMS.has(capabilities.platform)
      || capabilities.handoffKind === 'supported-device-handoff';
    return action(mobile ? 'supported-device-handoff' : 'connector-fallback');
  }

  return action('choose-card-condition');
}
