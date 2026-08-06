import { CARD_COMMISSIONING_STAGES } from './cardCommissioningFlow.js';
import { classifyCardReadiness } from './cardReadiness.js';
import { PORT_ROLE_STRIP } from './portRoles.js';

// The guided setup journey an owner walks through to bring a new card to life.
// This is a pure model: it never stores a counter, it only reads live evidence
// from the card link, the commissioning flow, and the project, and derives which
// step the owner is already on (or how many are left to go).
export const SETUP_STEP_IDS = Object.freeze([
  'flash',
  'wifi',
  'pin',
  'colour',
  'count',
  'install',
  'layout',
  'save',
  'controls',
]);

const OPTIONAL_STEP_IDS = Object.freeze(['layout', 'save', 'controls']);
const REQUIRED_STEP_IDS = Object.freeze([
  'flash',
  'wifi',
  'pin',
  'colour',
  'count',
  'install',
]);

// The IP the card answers on while it is still serving its setup hotspot.
// A card on this address has not yet joined the owner's home network.
const SETUP_MODE_HOST = '192.168.4.1';
export const CONNECTED_CARD_LINK_STATES = Object.freeze(['connected-direct', 'connected-bridge']);

// The ordered commissioning stages the firmware-install flow walks through.
// Read from the flow itself rather than copied, so the two cannot drift apart.
const COMMISSIONING_STAGE_ORDER = CARD_COMMISSIONING_STAGES;

const STEP_TITLES = {
  flash: 'Connect to your card',
  wifi: 'Get the card on Wi-Fi',
  pin: 'Find which pin the strip is on',
  colour: 'Check the strip\'s colour order',
  count: 'Count the LEDs',
  install: 'Put the setup on the card',
  layout: 'Place the strips on your layout',
  save: 'Save the project',
  controls: 'Add knobs and buttons',
};

const STEP_DETAILS = {
  flash: 'Power the card up on your Wi-Fi and connect to it. Only a brand-new card needs the firmware installing first.',
  wifi: 'Join the card to your home network so it works away from its setup hotspot.',
  pin: 'Tell the card which output port the strip is plugged into.',
  colour: 'Set the strip colour order so every colour appears correctly.',
  count: 'Enter the number of lights on the strip.',
  install: 'Send the finished setup to the card so it runs on its own.',
  layout: 'Place the strips where they belong in your artwork.',
  save: 'Save the project so it is kept for later.',
  controls: 'Add any knobs and buttons you want visitors to use.',
};

function normalizeHost(value) {
  const raw = String(value || '').trim();
  return raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/\/+$/, '').toLowerCase();
}

function isConnectedState(state) {
  return CONNECTED_CARD_LINK_STATES.includes(state);
}

function isPastFirmwareInstall(stage) {
  const index = COMMISSIONING_STAGE_ORDER.indexOf(stage);
  return index > COMMISSIONING_STAGE_ORDER.indexOf('install-safely');
}

function isFlashed({ cardLink, commissioningFlow }) {
  if (isConnectedState(cardLink?.state)) return true;
  const stage = commissioningFlow?.stage ?? commissioningFlow?.flow?.stage;
  return isPastFirmwareInstall(stage);
}

// If Studio has heard a status back from the card at an address that is NOT the
// card's own setup hotspot, the card is already on the owner's network. Requiring
// a fully paired link here told owners to go and join a "Lightweaver setup"
// hotspot that no longer exists, for a card sitting happily on their Wi-Fi.
function isOnHomeNetwork(cardLink) {
  const host = normalizeHost(cardLink?.host);
  if (!host || host === SETUP_MODE_HOST) return false;
  if (isConnectedState(cardLink?.state)) return true;
  return Boolean(cardLink?.readiness);
}

// The strip port roles the owner has already described: entries marked as a
// strip that carry a real pin number.
function stripPortRoles(project) {
  const roles = project?.portRoles;
  if (!Array.isArray(roles)) return [];
  return roles.filter(entry => (
    entry
    && typeof entry === 'object'
    && entry.role === PORT_ROLE_STRIP
    && typeof entry.pin === 'number'
    && Number.isFinite(entry.pin)
  ));
}

function hasStripPin(project) {
  return stripPortRoles(project).length > 0;
}

// A brand-new project already carries a colour order — DEFAULT_CARD_LED ships
// 'RGB' — so treating "there is a value" as "the owner answered" silently marked
// this step done and never asked. Only an order the owner actually confirmed,
// by measuring or by saying they know their wiring, counts.
function hasColourOrder(project) {
  const led = project?.devices?.standaloneController?.led;
  if (led?.colorOrderConfirmed !== true) return false;
  const order = led?.colorOrder;
  return typeof order === 'string' && order.trim().length > 0;
}

function hasPixelCount(project) {
  return stripPortRoles(project).some(entry => (
    typeof entry.pixelCount === 'number' && entry.pixelCount > 0
  ));
}

function hasPlaybackAccess(cardLink) {
  const classified = classifyCardReadiness(cardLink?.readiness || {}, {
    expectedCard: cardLink?.expectedCard ?? cardLink?.card ?? null,
  });
  return classified.playbackAccess === 'ready';
}

function isInstalled({ cardLink, resolution }) {
  if (!(resolution?.matchesCurrentProject === true)) return false;
  return hasPlaybackAccess(cardLink);
}

export function deriveSetupJourney({
  cardLink,
  commissioningFlow,
  project,
  resolution,
} = {}) {
  const evidence = {
    flash: isFlashed({ cardLink, commissioningFlow }),
    wifi: isOnHomeNetwork(cardLink),
    pin: hasStripPin(project),
    colour: hasColourOrder(project),
    count: hasPixelCount(project),
    install: isInstalled({ cardLink, resolution }),
  };

  let currentIndex = REQUIRED_STEP_IDS.findIndex(id => !evidence[id]);
  if (currentIndex === -1) currentIndex = null;

  const steps = SETUP_STEP_IDS.map((id) => {
    let status;
    if (OPTIONAL_STEP_IDS.includes(id)) {
      status = 'optional';
    } else if (currentIndex === null) {
      status = 'done';
    } else {
      const index = REQUIRED_STEP_IDS.indexOf(id);
      if (index < currentIndex) status = 'done';
      else if (index === currentIndex) status = 'current';
      else status = 'locked';
    }
    return { id, title: STEP_TITLES[id], status, detail: STEP_DETAILS[id] };
  });

  return {
    steps,
    currentStepId: currentIndex === null ? null : REQUIRED_STEP_IDS[currentIndex],
  };
}

export function isSetupComplete(journey) {
  if (!journey || !Array.isArray(journey.steps)) return false;
  return journey.steps
    .filter(step => step.status !== 'optional')
    .every(step => step.status === 'done');
}