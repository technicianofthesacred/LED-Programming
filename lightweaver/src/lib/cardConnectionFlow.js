export const CARD_CONNECTION_ACTION_IDS = Object.freeze([
  'ready-browser-usb',
  'escape-insecure-card-frame',
  'ready-local-card',
  'needs-card-update',
  'launch-native-bridge',
  'install-native-bridge',
  'handoff-supported-device',
  'wrong-card',
  'recoverable-failure',
  'needs-safe-recovery',
]);

const ACTION_COPY = Object.freeze({
  'ready-browser-usb': Object.freeze({
    legacyId: 'web-serial-install',
    title: 'Connect the card by USB',
    explanation: 'Plug the Lightweaver card into this computer with a data cable, then choose the card.',
    primaryLabel: 'Choose USB card',
  }),
  'escape-insecure-card-frame': Object.freeze({
    legacyId: 'supported-browser-handoff',
    title: 'Open secure installer',
    explanation: 'Studio is inside the local card page, where USB installation is blocked. Open the secure installer in its own tab.',
    primaryLabel: 'Open secure installer',
  }),
  'ready-local-card': Object.freeze({
    legacyId: 'connected',
    title: 'Lightweaver card ready',
    explanation: 'Studio verified the connected card and can control it now.',
    primaryLabel: 'Continue',
  }),
  'needs-card-update': Object.freeze({
    legacyId: 'web-serial-install',
    title: 'Update this Lightweaver card',
    explanation: 'Keep the card plugged into this computer and install the current Lightweaver software.',
    primaryLabel: 'Update card',
  }),
  'launch-native-bridge': Object.freeze({
    legacyId: 'supported-browser-handoff',
    title: 'Continue in secure Lightweaver Studio',
    explanation: 'The Lightweaver USB helper is not available yet. Use secure Studio in a browser with USB support, or continue on another supported computer.',
    primaryLabel: 'Show supported options',
  }),
  'install-native-bridge': Object.freeze({
    legacyId: 'connector-fallback',
    title: 'Continue in secure Lightweaver Studio',
    explanation: 'The Lightweaver USB helper is not available yet. Use secure Studio in a browser with USB support, or continue on another supported computer.',
    primaryLabel: 'Show supported options',
  }),
  'handoff-supported-device': Object.freeze({
    legacyId: 'supported-device-handoff',
    title: 'Continue on a computer',
    explanation: 'Plug the card into a Mac, Windows, or Linux computer and open Lightweaver Studio there.',
    primaryLabel: 'Show computer steps',
  }),
  'wrong-card': Object.freeze({
    legacyId: 'reconnect-known-card',
    title: 'Connect the expected card',
    explanation: 'Studio found a different Lightweaver card. Unplug it and connect the expected card.',
    primaryLabel: 'Check again',
  }),
  'recoverable-failure': Object.freeze({
    legacyId: 'retry-card-page',
    title: 'Check the card and try again',
    explanation: 'Keep the card powered, check that its page is open, then try the connection again.',
    primaryLabel: 'Try again',
  }),
  'needs-safe-recovery': Object.freeze({
    legacyId: 'connector-fallback',
    title: 'Recover the card safely',
    explanation: 'Leave the card powered and connected. Follow the recovery steps before writing to it again.',
    primaryLabel: 'Start safe recovery',
  }),
});

const UPDATE_REASONS = new Set(['identity-missing', 'firmware-too-old']);
const TRANSIENT_REASONS = new Set([
  'popup-blocked',
  'no-answer',
  'card-page-closed',
  'card-stopped-answering',
  'card-unreachable',
  'bridge-missing',
  'never-connected',
  'recovery-timeout',
]);
const UNCERTAIN_REASONS = new Set([
  'preview-unconfirmed',
  'recovery-unconfirmed',
  'write-status-unknown',
  'recovery-status-unknown',
]);
const MOBILE_PLATFORMS = new Set(['android', 'ios']);
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

function isMobile(capabilities) {
  return capabilities.isMobile === true || MOBILE_PLATFORMS.has(capabilities.platform);
}

function requiresInstaller(intent, reason) {
  return intent === 'blank-card' || intent === 'deep-recovery' || UPDATE_REASONS.has(reason);
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

function installationRoute(capabilities) {
  if (capabilities.mustEscapeToSecureInstaller === true) {
    return action('escape-insecure-card-frame');
  }
  if (capabilities.canWebSerialInstall === true) return action('ready-browser-usb');
  if (isMobile(capabilities) || capabilities.platform === 'unknown') {
    return action('handoff-supported-device');
  }
  if (DESKTOP_PLATFORMS.has(capabilities.platform)) return action('launch-native-bridge');
  return action('handoff-supported-device');
}

export function nextCardConnectionAction(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return action('recoverable-failure');
  }

  const link = input.link && typeof input.link === 'object' ? input.link : {};
  const capabilities = input.capabilities && typeof input.capabilities === 'object'
    ? input.capabilities
    : {};
  const reason = link.reason;

  if (
    (link.state === 'connected-bridge' || link.state === 'connected-direct')
    && hasCardIdentity(link.card)
  ) {
    return action('ready-local-card');
  }

  if (UNCERTAIN_REASONS.has(reason)) return action('needs-safe-recovery');

  if (reason === 'wrong-card') {
    const expected = cardLabel(input.expectedCard || link.expectedCard, 'the expected card');
    const detected = cardLabel(
      input.detectedCard || input.discoveredCard || input.card || link.card,
      'a different card',
    );
    return action('wrong-card', {
      explanation: `Studio expected ${expected}, but found ${detected}. Unplug it and connect the expected card.`,
      secondaryAction: {
        id: 'adopt-discovered-card',
        label: 'Use this card instead',
      },
    });
  }

  if (reason === 'native-bridge-missing') return action('install-native-bridge');

  if (UPDATE_REASONS.has(reason)) {
    if (capabilities.mustEscapeToSecureInstaller === true) {
      return action('escape-insecure-card-frame');
    }
    return action('needs-card-update');
  }

  if (requiresInstaller(input.intent, reason)) return installationRoute(capabilities);

  if (input.intent === 'working-card' && hasSetupEvidence(input, link)) {
    return action('recoverable-failure', {
      route: 'setup-network',
      title: 'Finish card setup',
      explanation: 'Join the Lightweaver setup network, finish Wi-Fi setup, then return to Studio.',
      primaryLabel: 'Continue',
    });
  }

  if (TRANSIENT_REASONS.has(reason)) return action('recoverable-failure');

  if (link.state === 'connecting' || link.state === 'reconnecting' || link.state === 'reconnecting-bridge') {
    return action('recoverable-failure', {
      title: 'Connecting to the Lightweaver card',
      explanation: 'Keep the card powered and leave its page open while Studio checks it.',
      primaryLabel: 'Connecting…',
      busy: true,
      pending: true,
      primaryDisabled: true,
    });
  }

  return action('recoverable-failure');
}
