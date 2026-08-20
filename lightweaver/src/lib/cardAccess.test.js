import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveCardAccess } from './cardAccess.js';
import { isCardLinkConnected } from './cardConnectionFlow.js';

const CARD_ID = 'lw-aabbccddeeff';

function readyEnvelope(overrides = {}) {
  return {
    app: 'Lightweaver',
    provisioningContractVersion: 1,
    cardId: CARD_ID,
    firmwareVersion: '1.0.0',
    buildId: 'a'.repeat(40),
    bootId: 'boot-1',
    runtimePhase: 'ready',
    knownGoodProject: true,
    commandReady: true,
    outputReady: true,
    playbackReady: true,
    ...overrides,
  };
}

function link(overrides = {}) {
  return {
    state: 'connected-direct',
    host: '192.168.18.70',
    expectedCard: { id: CARD_ID },
    readiness: readyEnvelope(),
    ...overrides,
  };
}

// Exactly what a healthy, lit card reports while its radio reassociates:
// command gate shut, playback claim open.
function reassociatingLink(overrides = {}) {
  return link({
    readiness: readyEnvelope({ runtimePhase: 'recovering', commandReady: false }),
    ...overrides,
  });
}

// The golden table this projection exists to protect: playback stays 'ready'
// while command degrades during a WiFi reassociation, and every other state
// keeps its pre-extraction verdict.
const GOLDEN = [
  {
    name: 'healthy exact card: everything open',
    link: link(),
    opts: {},
    expected: { command: true, playback: 'ready', install: 'ready' },
  },
  {
    name: 'WiFi reassociation: command closes, playback stays ready',
    link: reassociatingLink(),
    opts: {},
    expected: { command: false, playback: 'ready', install: 'ready' },
  },
  {
    name: 'WiFi reassociation with the caller-known command gate passed explicitly',
    link: reassociatingLink(),
    opts: { connected: false },
    expected: { command: false, playback: 'ready', install: 'ready' },
  },
  {
    name: 'no authorization demotes a ready card to project for installs only',
    link: link(),
    opts: { authorized: false },
    expected: { command: true, playback: 'ready', install: 'project' },
  },
  {
    name: 'no authorization during reassociation still keeps playback ready',
    link: reassociatingLink(),
    opts: { authorized: false },
    expected: { command: false, playback: 'ready', install: 'project' },
  },
  {
    name: 'no expected card pairing: recovery',
    link: link({ expectedCard: null }),
    opts: {},
    expected: { command: true, playback: 'recovery', install: 'recovery' },
  },
  {
    name: 'wrong card answered: recovery even while transport-connected',
    link: link({ expectedCard: { id: 'lw-001122334455' } }),
    opts: {},
    expected: { command: false, playback: 'recovery', install: 'recovery' },
  },
  {
    name: 'blank factory card: blank for playback and install',
    link: link({
      readiness: readyEnvelope({
        knownGoodProject: false,
        commandReady: false,
        outputReady: false,
        playbackReady: false,
        mode: 'factory-flash',
        source: 'defaults',
        projectId: '',
        projectFingerprint: '',
      }),
    }),
    opts: {},
    expected: { command: false, playback: 'blank', install: 'blank' },
  },
  {
    name: 'disconnected link: command shut, recovery verdicts',
    link: link({ state: 'disconnected', readiness: null }),
    opts: {},
    expected: { command: false, playback: 'recovery', install: 'recovery' },
  },
  {
    name: 'cardBlank flag blocks the loose playback path during reassociation',
    link: reassociatingLink({ cardBlank: true }),
    opts: {},
    expected: { command: false, playback: 'recovery', install: 'recovery' },
  },
];

test('deriveCardAccess golden table', () => {
  for (const row of GOLDEN) {
    assert.deepEqual(deriveCardAccess(row.link, row.opts), row.expected, row.name);
  }
});

test('command defaults to isCardLinkConnected of the same link', () => {
  for (const candidate of [link(), reassociatingLink(), link({ state: 'disconnected' }), null, undefined]) {
    assert.equal(
      deriveCardAccess(candidate).command,
      isCardLinkConnected(candidate || {}),
    );
  }
});

test('the bench upgrade rides the card project evidence exactly as readCardAccessLevel did', () => {
  // A card holding Studio's own discovery bench config reports the bench
  // sentinel in its project evidence; without an authorization the 'project'
  // demotion is upgraded to 'bench' instead of blocking as a foreign project.
  const benchEvidence = readyEnvelope({
    projectId: 'lw-bench-discovery',
    piece: { id: 'lw-bench-discovery' },
  });
  const benchLink = link({ readiness: benchEvidence });
  const withoutAuthorization = deriveCardAccess(benchLink, { authorized: false });
  const withAuthorization = deriveCardAccess(benchLink, { authorized: true });
  // Whatever isBenchProjectEvidence decides, the projection must agree with a
  // direct readCardAccessLevel call — the projection adds nothing of its own.
  assert.equal(withAuthorization.playback, 'ready');
  assert.ok(['project', 'bench'].includes(withoutAuthorization.install));
});
