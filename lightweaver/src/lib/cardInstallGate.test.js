import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_INSTALL_BLOCK_MESSAGES,
  evaluateCardInstallGate,
  readCardAccessLevel,
  readCardCommissioningVerification,
} from './cardInstallGate.js';
import { BENCH_PROJECT_ID } from './benchConfig.js';

// The three "Install on card" buttons (Layout -> Test & Install, Playlist,
// Patterns) all end at pushConfigToCard -> POST /api/config. These fact sets
// are the exact inputs each screen supplies, so the assertions below are what
// each button does.
const layoutFacts = (overrides = {}) => ({
  requiresLiveLink: false,
  wiringAffecting: true,
  wiringSendReady: true,
  commissioningVerified: true,
  ...overrides,
});
const playlistFacts = (overrides = {}) => ({
  cardAccess: 'ready',
  busy: false,
  hardwareIssue: '',
  ...overrides,
});
const patternsFacts = (overrides = {}) => ({
  cardAccess: 'ready',
  busy: false,
  hardwareIssue: '',
  ...overrides,
});

test('every call site allows the install when its own facts are all satisfied', () => {
  assert.equal(evaluateCardInstallGate(layoutFacts()).allowed, true);
  assert.equal(evaluateCardInstallGate(playlistFacts()).allowed, true);
  assert.equal(evaluateCardInstallGate(patternsFacts()).allowed, true);
});

test('a wiring-affecting install is refused without bench proof, wherever it is triggered', () => {
  // Layout -> Test & Install.
  assert.deepEqual(
    { ...evaluateCardInstallGate(layoutFacts({ commissioningVerified: false })) },
    { allowed: false, reason: 'not-commissioned', message: CARD_INSTALL_BLOCK_MESSAGES['not-commissioned'] },
  );
  assert.equal(
    evaluateCardInstallGate(layoutFacts({ wiringSendReady: false })).reason,
    'wiring-incomplete',
  );

  // Playlist's "allow layout change" escalation reaches the same destination
  // with the same power, so it must answer to the same rule.
  const playlistLayoutChange = playlistFacts({
    wiringAffecting: true,
    wiringSendReady: true,
    commissioningVerified: false,
  });
  assert.equal(evaluateCardInstallGate(playlistLayoutChange).reason, 'not-commissioned');
  assert.equal(
    evaluateCardInstallGate({ ...playlistLayoutChange, commissioningVerified: true }).allowed,
    true,
  );
});

test('installs that cannot change wiring do not carry the commissioning requirement', () => {
  // The card refuses a layout change unless the caller passes
  // allowLayoutChange, which neither of these does.
  assert.equal(evaluateCardInstallGate(playlistFacts({ commissioningVerified: false })).allowed, true);
  assert.equal(evaluateCardInstallGate(patternsFacts({ commissioningVerified: false })).allowed, true);
});

test('a hardware configuration issue outranks every other reason at every site', () => {
  for (const facts of [layoutFacts(), playlistFacts(), patternsFacts()]) {
    const result = evaluateCardInstallGate({
      ...facts,
      hardwareIssue: 'GPIO 4 is already used by an LED output',
      busy: true,
      cardAccess: 'recovery',
      commissioningVerified: false,
      wiringSendReady: false,
    });
    assert.equal(result.reason, 'hardware-issue');
    assert.equal(result.allowed, false);
  }
});

test('an in-flight install blocks a second one everywhere', () => {
  assert.equal(evaluateCardInstallGate(layoutFacts({ busy: true })).reason, 'busy');
  assert.equal(evaluateCardInstallGate(playlistFacts({ busy: true })).reason, 'busy');
  assert.equal(evaluateCardInstallGate(patternsFacts({ busy: true })).reason, 'busy');
});

test('link-state reasons are distinct, and only the Layout push may run without a live link', () => {
  for (const [access, reason] of [
    ['blank', 'blank'],
    ['project', 'project-mismatch'],
    ['recovery', 'disconnected'],
    ['', 'disconnected'],
  ]) {
    assert.equal(evaluateCardInstallGate(playlistFacts({ cardAccess: access })).reason, reason);
    assert.equal(evaluateCardInstallGate(patternsFacts({ cardAccess: access })).reason, reason);
    // pushConfigToCard runs its own discovery and can fall back to a bounded
    // installer handoff for the exact paired card, so the ambient link reading
    // disconnected must not disable the Layout button.
    assert.equal(evaluateCardInstallGate(layoutFacts({ cardAccess: access })).allowed, true);
  }
});

test('cardAccess:bench is derived from the card\'s own project report, never assumed', () => {
  const benchEvidence = { projectId: BENCH_PROJECT_ID, projectRevision: 1 };
  const ownerEvidence = { projectId: 'owner-mandala-01', projectRevision: 7 };
  assert.equal(readCardAccessLevel('ready', benchEvidence), 'bench');
  assert.equal(readCardAccessLevel('ready', null, benchEvidence), 'bench',
    'evidence can arrive on either the paired card or the readiness envelope');
  assert.equal(readCardAccessLevel('ready', ownerEvidence), 'ready');
  assert.equal(readCardAccessLevel('ready'), 'ready');
  // The mismatch warning protects somebody's artwork. The bench config is
  // Studio's own, so overwriting it is the intended exit from discovery.
  assert.equal(readCardAccessLevel('project', benchEvidence), 'bench');
  assert.equal(readCardAccessLevel('project', ownerEvidence), 'project');
  // Link-state verdicts describe reachability and pairing. No project evidence
  // can upgrade those, or a card that never proved itself would install.
  assert.equal(readCardAccessLevel('recovery', benchEvidence), 'recovery');
  assert.equal(readCardAccessLevel('blank', benchEvidence), 'blank');
});

test('a bench card installs like a ready one, because discovery exits by installing the real project', () => {
  // The card is Ready, but the project on it is Studio's own discovery bench
  // config. Overwriting that is the intended exit from discovery.
  assert.equal(evaluateCardInstallGate(playlistFacts({ cardAccess: 'bench' })).allowed, true);
  assert.equal(evaluateCardInstallGate(patternsFacts({ cardAccess: 'bench' })).allowed, true);
  assert.equal(evaluateCardInstallGate(layoutFacts({ cardAccess: 'bench', requiresLiveLink: true })).allowed, true);
  // A genuinely foreign project still gets the mismatch warning — that reason
  // exists to protect somebody else's work, which a bench config is not.
  assert.equal(evaluateCardInstallGate(playlistFacts({ cardAccess: 'project' })).reason, 'project-mismatch');
  // 'bench' widens nothing else: it is still refused without the bench proof.
  assert.equal(evaluateCardInstallGate(playlistFacts({
    cardAccess: 'bench', wiringAffecting: true, commissioningVerified: false,
  })).reason, 'not-commissioned');
});

test('the wiring proof is reported ahead of a transient link blip', () => {
  const result = evaluateCardInstallGate(playlistFacts({
    cardAccess: 'recovery',
    wiringAffecting: true,
    commissioningVerified: false,
  }));
  assert.equal(result.reason, 'not-commissioned');
});

test('every block reason carries a message', () => {
  for (const reason of Object.keys(CARD_INSTALL_BLOCK_MESSAGES)) {
    assert.ok(CARD_INSTALL_BLOCK_MESSAGES[reason].length > 0, reason);
  }
});

test('commissioning needs both a real bench check and a colour order still in use', () => {
  const wiring = {
    verified: true,
    runs: [{ id: 'run-1', verified: true }, { id: 'run-2', verified: true }],
  };
  const controller = {
    led: { colorOrder: 'GRB', colorOrderConfirmed: true, confirmedColorOrder: 'GRB' },
  };

  assert.deepEqual({ ...readCardCommissioningVerification({ wiring, standaloneController: controller }) }, {
    physicallyVerified: true,
    colorConfirmed: true,
    verified: true,
  });

  // One unverified run is enough to withdraw the physical proof.
  assert.equal(readCardCommissioningVerification({
    wiring: { ...wiring, runs: [{ id: 'run-1', verified: true }, { id: 'run-2' }] },
    standaloneController: controller,
  }).verified, false);

  // A confirmation for a colour order that is no longer the one being sent
  // proves nothing about what will light up.
  assert.equal(readCardCommissioningVerification({
    wiring,
    standaloneController: {
      led: { colorOrder: 'RGB', colorOrderConfirmed: true, confirmedColorOrder: 'GRB' },
    },
  }).colorConfirmed, false);

  // Missing state fails closed rather than reading as verified.
  assert.equal(readCardCommissioningVerification().verified, false);
  assert.equal(readCardCommissioningVerification({}).verified, false);
});
