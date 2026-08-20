import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../../state/ProjectContext.jsx';
import { buildCardRuntimePackageFromProject } from '../../lib/cardRuntimeProject.js';
import { pushConfigToCard, readCardProjectEvidence, readCardStatusEnvelope } from '../../lib/cardPushClient.js';
import {
  activateAndWaitForCardWiring,
  confirmCardWiringCandidate,
  getCardWiringStatus,
  readCardWiringCandidateEvidence,
  rollbackCardWiringCandidate,
} from '../../lib/cardWiringSafety.js';
import {
  connectCardLink,
  cancelCardWifiHandoff,
  getCardLinkState,
  getSharedCardLink,
  isCardLinkConnected,
  reportCardStatusEnvelope,
  reportDirectCardStatus,
  restoreCardWifiHandoff,
  suspendCardWifiHandoff,
} from '../../lib/cardLink.js';
import {
  adoptCommissionedCardBridgeIdentity,
  clearCardBridgeHandoff,
  getCardBridgeState,
  retargetCardBridge,
  sendCardBridgeRequest,
} from '../../lib/cardBridge.js';
import { acceptWifiHandoff } from '../../lib/cardWifiHandoff.js';
import { setupNetworkLabelForCardId, setupNetworkSsidForCardId } from '../../lib/cardIdentity.js';
import { canPushDirectlyToCard, discoverCardStatus } from '../../lib/cardConnection.js';
import { compileWiring } from '../../lib/wiringCompiler.js';
import { createWiringChaseSession } from '../../lib/wiringChase.js';
import {
  CARD_COMMISSIONING_CHANGED_EVENT,
  CARD_COMMISSIONING_STAGES,
  adaptCardRestorationReadback,
  acknowledgeCommissionedCard,
  acknowledgeCommissionedCardFromStatus,
  bindCardWiringActivationEvidence,
  beginCardLightCheckMutation,
  beginCardRestorationMutation,
  claimCardLightCheckMutation,
  claimCardRestoration,
  clearCardCommissioning,
  completeCardInstall,
  commissioningFlowMatchesProject,
  confirmCardSetupNetworkJoined,
  markCardProjectRestored,
  preflightCardCommissioningMutation,
  readCardCommissioning,
  readCardRestorationAttempt,
  recordCardRestorationResponse,
  inspectCardCommissioning,
  releaseCardRestoration,
  returnCardProjectToSetupAfterLightCheck,
  verifyCardRestorationMutation,
  verifyCardLightCheckMutation,
  resumeInstalledCardAfterInterruption,
  returnCardToSetupNetworkPath,
  stageCardProjectForPhysicalCheck,
  writeCardCommissioning,
} from '../../lib/cardCommissioningFlow.js';
import { describeSetupHotspotWait, SETUP_HOTSPOT_RESCAN_MS } from '../../lib/setupHotspotWait.js';

// The card's soft-AP address. Only reachable while this device is joined to the
// card's own setup hotspot.
const SETUP_CARD_HOST = '192.168.4.1';
// How long the opened setup tab gets to prove the card actually answered before
// Studio names the likely causes. Long enough for a phone to finish associating
// with the hotspot and for the bridge handshake to land, short enough that the
// owner is not left staring at a spinning tab.
const SETUP_CARD_REACH_TIMEOUT_MS = 20_000;
const SETUP_CARD_REACH_INTERVAL_MS = 2500;
const SETUP_CARD_REACH_REQUEST_TIMEOUT_MS = 3000;

const STAGE_LABELS = {
  'connect-card': 'Connect card',
  'install-safely': 'Install safely',
  'set-up-card': 'Set up card',
  'check-lights': 'Check lights',
};

function runtimePackageFromSnapshot(snapshot = {}, identity = {}) {
  return buildCardRuntimePackageFromProject({
    projectId: snapshot.id,
    projectName: snapshot.name,
    projectRevision: identity.revision,
    projectFingerprint: identity.fingerprint,
    productionJobId: identity.productionJobId,
    productionJobDigest: identity.productionJobDigest,
    strips: snapshot.layout?.strips || [],
    patchBoard: snapshot.layout?.patchBoard || null,
    wiring: snapshot.layout?.wiring || null,
    standaloneController: snapshot.devices?.standaloneController || {},
  });
}

function finalOutputs(outputs = []) {
  return outputs.map(output => ({
    id: String(output?.id || ''),
    pin: Number(output?.pin),
    pixels: Number(output?.pixels),
    segments: (output?.segments || []).map(segment => ({
      id: String(segment?.id || ''),
      count: Number(segment?.count),
      direction: String(segment?.direction || 'forward'),
    })),
  }));
}

export function assertCommissioningFinalWiringStatus({
  activationId,
  confirmation,
  status,
  flow,
  expectedWiring,
} = {}) {
  const fail = detail => {
    throw new Error(`Final wiring read-back did not match the confirmed Studio project: ${detail}`);
  };
  if (!activationId || confirmation?.state !== 'known-good' || confirmation?.activationId !== activationId) {
    fail('the confirm response did not belong to the active wiring transaction');
  }
  if (status?.app !== 'Lightweaver' || status?.state !== 'known-good' || status?.activationId) {
    fail('the independent GET did not return a final known-good Lightweaver status');
  }
  if (status.cardId !== flow?.expectedCard?.id
    || status.firmwareVersion !== flow?.expectedCard?.firmwareVersion
    || status.buildId !== flow?.expectedCard?.buildId) {
    fail('card or firmware identity changed');
  }
  if (status.projectRevision !== flow?.project?.revision
    || status.projectFingerprint !== flow?.project?.fingerprint) {
    fail('project revision or project fingerprint changed');
  }
  if (!expectedWiring || status.wiringRevision !== expectedWiring.wiringRevision
    || status.wiringDigest !== expectedWiring.wiringDigest) {
    fail('wiring revision or digest changed');
  }
  if (status.ledType !== expectedWiring.ledType) fail('LED protocol changed');
  if (status.colorOrder !== expectedWiring.colorOrder) fail('LED color order changed');
  if (status.maxMilliamps !== expectedWiring.maxMilliamps) fail('aggregate current limit changed');
  if (JSON.stringify(finalOutputs(status.outputs)) !== JSON.stringify(finalOutputs(expectedWiring.outputs))) {
    fail('physical outputs changed');
  }
  return true;
}

function commissioningMarkerFrame(snapshot = {}) {
  const strips = snapshot.layout?.strips || [];
  let compiled = null;
  if (snapshot.layout?.wiring) {
    try { compiled = compileWiring({ wiring: snapshot.layout.wiring, strips }); }
    catch { compiled = null; }
  }
  const fallbackCount = strips.reduce((sum, strip) => sum + Math.max(0, Number(strip.pixelCount ?? strip.pixels?.length ?? 0)), 0);
  const outputs = compiled?.ok && compiled.outputs.length
    ? compiled.outputs
    : fallbackCount > 0 ? [{ start: 0, count: fallbackCount }] : [];
  const totalPixels = compiled?.ok && compiled.totalPixels > 0 ? compiled.totalPixels : fallbackCount;
  const frame = Array.from({ length: totalPixels }, () => '001A00');
  for (const output of outputs) {
    const start = Math.max(0, Number(output.start) || 0);
    const end = Math.min(frame.length, start + Math.max(0, Number(output.count ?? output.pixels) || 0));
    if (start >= end) continue;
    if (end - start === 1) frame[start] = '1A001A';
    else {
      frame[start] = '00001A';
      frame[end - 1] = '1A0000';
    }
  }
  return frame;
}

export function CardCommissioningSteps({ stage = 'connect-card' }) {
  const activeIndex = Math.max(0, CARD_COMMISSIONING_STAGES.indexOf(stage));
  return (
    <ol className="card-commissioning-steps" aria-label="Card setup progress">
      {CARD_COMMISSIONING_STAGES.map((id, index) => (
        <li key={id} className={index < activeIndex ? 'complete' : index === activeIndex ? 'active' : ''} aria-current={index === activeIndex ? 'step' : undefined}>
          <span aria-hidden="true">{index < activeIndex ? '✓' : index + 1}</span>
          {STAGE_LABELS[id]}
        </li>
      ))}
    </ol>
  );
}

// A once-a-second clock, running only while something on screen is actually
// counting. The setup-hotspot wait is the only such thing, and it has to tick:
// a countdown rendered once at mount is a number the owner watches not change,
// which is worse than no countdown at all. `until` stops the interval once the
// last phase boundary is behind us, so a panel left open on this step does not
// re-render forever to say the same sentence.
function useSecondTick(active, until = Infinity) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const start = Date.now();
    setNow(start);
    if (start >= until) return undefined;
    const timer = window.setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (tick >= until) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active, until]);
  return now;
}

function identityMessage(reason, expected = {}, actual = {}) {
  if (reason === 'wrong-card') return `Studio expected ${expected.id}, but ${actual.id || 'another card'} answered. Reconnect the installed card.`;
  if (reason === 'wrong-firmware-version') return `Studio expected firmware ${expected.firmwareVersion}, but the card reports ${actual.firmwareVersion || 'no version'}.`;
  if (reason === 'wrong-firmware-build') return 'The card firmware build does not match the build verified during installation.';
  return 'Reconnect the installed card so Studio can verify its identity and firmware.';
}

export function CardCommissioningPanel({
  result = null,
  link = {},
  onReconnect,
  onComplete,
  openSetupCard = connectCardLink,
  pushProject = pushConfigToCard,
  readProjectEvidence = readCardProjectEvidence,
  readCandidateEvidence = readCardWiringCandidateEvidence,
}) {
  const { projectLifecycle, serializeProject, markProjectInstalled } = useProject();
  const projectAuthorityRef = useRef(null);
  projectAuthorityRef.current = {
    generation: projectLifecycle.generation,
    revision: projectLifecycle.editedRevision,
    restored: projectLifecycle.restored,
    serializeProject,
  };
  const markCommissioningProjectInstalled = (sourceFlow, installation, requestedGeneration) => {
    const current = projectAuthorityRef.current;
    if (current.generation !== requestedGeneration || !commissioningFlowMatchesProject(sourceFlow, {
      project: current.serializeProject(),
      revision: current.revision,
      generation: current.generation,
      restored: current.restored,
    })) return false;
    markProjectInstalled({
      ...installation,
      revision: current.revision,
      generation: requestedGeneration,
    });
    return true;
  };
  const [initialState] = useState(() => inspectCardCommissioning());
  const [flow, setFlow] = useState(initialState.flow);
  const [restoreState, setRestoreState] = useState('idle');
  const [detection, setDetection] = useState({ state: 'idle' });
  const [lightCheckState, setLightCheckState] = useState('idle');
  const [lightCheckNotice, setLightCheckNotice] = useState('');
  const [bridgeHandoffStatus, setBridgeHandoffStatus] = useState(null);
  const [setupReach, setSetupReach] = useState({ state: 'idle' });
  const markerSessionRef = useRef(null);
  const markerTimeoutRef = useRef(null);
  const acknowledgementPersistenceRef = useRef('');
  const activeFlowIdRef = useRef(initialState.flow?.flowId || '');
  const handoffFlowIdRef = useRef('');
  const [failure, setFailure] = useState(initialState.error === 'corrupt'
    ? 'Saved card setup data is corrupt. Nothing was changed; restart the exact setup.'
    : initialState.error === 'invalid-lease'
      ? 'A saved card restore claim was invalid or stale and has been cleared. Verify the same card, then retry.'
    : '');
  const hasAuthoritativePendingWiring = Boolean(
    flow?.project?.pendingWiring
    && flow.project.wiringEvidenceState !== 'legacy-inconclusive',
  );

  // `updatedAt` is stamped by completeCardInstall / returnCardToSetupNetworkPath
  // at the moment the card was left broadcasting its setup hotspot, and nothing
  // rewrites it while `setup-required` holds — so it is the honest start of the
  // owner's wait for that network to show up in their Wi-Fi list. Tick only
  // during that state; every other screen here is event-driven.
  const awaitingSetupHotspot = flow?.stage === 'set-up-card' && flow?.networkState === 'setup-required';
  // Past the last boundary the wording is fixed, so there is nothing left to
  // count and the clock can stop.
  const hotspotWaitEndsAt = Number(flow?.updatedAt) > 0
    ? Number(flow.updatedAt) + SETUP_HOTSPOT_RESCAN_MS + 1000
    : 0;
  const hotspotNow = useSecondTick(awaitingSetupHotspot, hotspotWaitEndsAt);

  useEffect(() => {
    const sync = () => {
      const state = inspectCardCommissioning();
      setFlow(state.flow);
      if (state.error === 'corrupt') setFailure('Saved card setup data is corrupt. Nothing was changed; restart the exact setup.');
      if (state.error === 'invalid-lease') setFailure('A saved card restore claim was invalid or stale and has been cleared. Verify the same card, then retry.');
    };
    window.addEventListener('storage', sync);
    window.addEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    };
  }, []);

  useEffect(() => () => {
    if (markerTimeoutRef.current != null) window.clearTimeout(markerTimeoutRef.current);
    markerTimeoutRef.current = null;
    const session = markerSessionRef.current;
    markerSessionRef.current = null;
    if (session) void session.stop().catch(() => {});
  }, []);

  useEffect(() => {
    const flowId = flow?.flowId || '';
    const previousFlowId = handoffFlowIdRef.current;
    if (previousFlowId && previousFlowId !== flowId) {
      cancelCardWifiHandoff(previousFlowId);
      clearCardBridgeHandoff(previousFlowId);
    }
    handoffFlowIdRef.current = flowId;
    activeFlowIdRef.current = flowId;
    acknowledgementPersistenceRef.current = '';
    if (flowId && flow?.stage === 'set-up-card') restoreCardWifiHandoff(flowId);
    return () => {
      if (flowId) suspendCardWifiHandoff(flowId);
      if (activeFlowIdRef.current === flowId) activeFlowIdRef.current = '';
      acknowledgementPersistenceRef.current = '';
    };
  }, [flow?.flowId, flow?.stage]);

  useEffect(() => {
    setBridgeHandoffStatus(previous => (
      previous?.flowId && previous.flowId !== flow?.flowId ? null : previous
    ));
  }, [flow?.flowId]);

  // Opening the setup tab used to be fire-and-forget: the only failure Studio
  // could report was a blocked popup. If the tab opened but the card never
  // answered — wrong network joined, hotspot already gone — the owner just
  // watched an untitled tab spin while Studio said nothing. This bounded watch
  // proves reachability over whichever channel this page is actually allowed to
  // use, then names the likely causes. It never touches the opened tab.
  useEffect(() => {
    if (setupReach.state !== 'checking') return undefined;
    if (setupReach.flowId !== flow?.flowId) {
      setSetupReach({ state: 'idle' });
      return undefined;
    }
    let active = true;
    let timer = null;
    const budget = Number(window.__LW_SETUP_REACH_TIMEOUT_MS_FOR_TEST__) > 0
      ? Number(window.__LW_SETUP_REACH_TIMEOUT_MS_FOR_TEST__)
      : SETUP_CARD_REACH_TIMEOUT_MS;
    const deadline = setupReach.startedAt + budget;
    const watchedHost = setupReach.host || SETUP_CARD_HOST;
    const probe = async () => {
      if (!active) return;
      let reached = false;
      try {
        // readCardStatusEnvelope picks the only channel this page is allowed to
        // use: a direct GET on http/file pages, and the opened bridge tab's
        // postMessage handshake on HTTPS, where fetching http://192.168.4.1
        // would be blocked as mixed content.
        const status = await readCardStatusEnvelope({
          host: watchedHost,
          timeoutMs: Math.min(SETUP_CARD_REACH_REQUEST_TIMEOUT_MS, budget),
        });
        reached = Boolean(status);
      } catch { reached = false; }
      if (!active) return;
      if (reached) { setSetupReach({ state: 'reached' }); return; }
      if (Date.now() >= deadline) { setSetupReach({ state: 'unreachable' }); return; }
      timer = window.setTimeout(probe, Math.min(SETUP_CARD_REACH_INTERVAL_MS, budget));
    };
    void probe();
    return () => { active = false; if (timer != null) window.clearTimeout(timer); };
  }, [flow?.flowId, setupReach]);

  // Any independent proof the card answered settles the watch, so the parallel
  // handoff poll or a card that has already moved to the gallery network never
  // leaves a stale "could not reach" alert on screen.
  useEffect(() => {
    if (setupReach.state === 'idle' || setupReach.state === 'reached') return;
    if (bridgeHandoffStatus?.status
      || flow?.cardAcknowledgedAt
      || ['found', 'return-to-gallery'].includes(detection.state)) {
      setSetupReach({ state: 'reached' });
    }
  }, [bridgeHandoffStatus, detection.state, flow?.cardAcknowledgedAt, setupReach.state]);

  useEffect(() => {
    if (result?.status !== 'awaiting-card-acknowledgement') return;
    void (async () => { try {
      let current = readCardCommissioning({ flowId: result.flowId });
      if (!current) throw new Error('This Bridge result has no matching saved setup in this browser profile. It was not applied; restart that exact setup.');
      if (current.source !== 'native-bridge') throw new Error('This Bridge result belongs to a different card setup attempt. Return to the setup that started it.');
      if (current.stage === 'install-safely') {
        current = completeCardInstall(current, result);
        await writeCardCommissioning(current);
      }
      setFlow(current);
      setFailure('');
    } catch (error) {
      setFailure(error?.message || 'Studio could not resume this card setup result.');
    } })();
  }, [result]);

  const cardAcknowledgement = useMemo(() => {
    if (!flow || flow.stage !== 'set-up-card') return null;
    const setupNetworkReset = ['setup-required', 'setup-joined'].includes(flow.networkState);
    const acknowledgedAt = Date.parse(link?.acknowledgedAt || '');
    const freshAfterSetupJoin = flow.networkState === 'setup-joined'
      && Number.isFinite(acknowledgedAt)
      && acknowledgedAt >= flow.updatedAt;
    const exactStationAuthority = link?.handoffStationVerified === true
      && link?.handoffFlowId === flow.flowId;
    if ((!isCardLinkConnected(link) && !exactStationAuthority)
      || (setupNetworkReset && !freshAfterSetupJoin)) return null;
    return acknowledgeCommissionedCardFromStatus(flow, link?.readiness || {});
  }, [flow, link]);

  const interruptedInstallEvidence = useMemo(() => {
    const verifiedBlankCard = (link?.state === 'connected-bridge' || link?.state === 'connected-direct')
      && link?.cardBlank === true
      && Boolean(link?.validatedBootId);
    if (!flow || flow.stage !== 'install-safely' || flow.source !== 'web-serial' || !link?.card?.id
      || (!isCardLinkConnected(link) && !verifiedBlankCard)) return null;
    return resumeInstalledCardAfterInterruption(flow, link.card);
  }, [flow, link]);

  const restorePreflight = useMemo(() => {
    if (!flow?.cardAcknowledgedAt) return { ok: false, reason: 'checking-card' };
    const initialConfigAuthority = link?.handoffStationVerified === true
      && link?.handoffFlowId === flow.flowId
      && link?.cardBlank === true;
    if (!isCardLinkConnected(link) && !initialConfigAuthority) return { ok: false, reason: 'checking-card' };
    return preflightCardCommissioningMutation(flow, link.readiness, {
      allowInitialConfig: initialConfigAuthority,
    });
  }, [flow, link]);

  const lightCheckPreflight = useMemo(() => {
    if (flow?.stage !== 'check-lights' || !flow.cardAcknowledgedAt) return { ok: false, reason: 'checking-card' };
    if (!isCardLinkConnected(link) || !link.validatedBootId) return { ok: false, reason: 'checking-card' };
    return preflightCardCommissioningMutation(flow, link.readiness);
  }, [flow, link]);

  useEffect(() => {
    if (!interruptedInstallEvidence?.ok) return;
    void (async () => { try {
      await writeCardCommissioning(interruptedInstallEvidence.flow);
      setFlow(interruptedInstallEvidence.flow);
    } catch (error) { setFailure(`Card setup could not be saved: ${error?.message || String(error)}`); } })();
  }, [interruptedInstallEvidence]);

  useEffect(() => {
    if (!cardAcknowledgement?.ok || flow?.cardAcknowledgedAt) return;
    const acknowledgementFlowId = flow?.flowId || '';
    const persistenceKey = `${acknowledgementFlowId}:${cardAcknowledgement.flow?.updatedAt || ''}`;
    if (!acknowledgementFlowId || acknowledgementPersistenceRef.current === persistenceKey) return;
    acknowledgementPersistenceRef.current = persistenceKey;
    void (async () => { try {
      await writeCardCommissioning(cardAcknowledgement.flow);
      if (activeFlowIdRef.current === acknowledgementFlowId) setFlow(cardAcknowledgement.flow);
    } catch (error) {
      if (activeFlowIdRef.current === acknowledgementFlowId) {
        setFailure(`Card setup could not be saved: ${error?.message || String(error)}`);
      }
    } finally {
      if (acknowledgementPersistenceRef.current === persistenceKey) acknowledgementPersistenceRef.current = '';
    } })();
  }, [cardAcknowledgement, flow?.cardAcknowledgedAt, flow?.flowId]);

  useEffect(() => {
    if (
      !flow
      || flow.stage !== 'set-up-card'
      || flow.cardAcknowledgedAt
      || flow.networkState !== 'setup-joined'
      || canPushDirectlyToCard()
      || detection.state === 'return-to-gallery'
    ) return undefined;
    let active = true;
    let timer = null;
    const poll = async () => {
      try {
        const status = await sendCardBridgeRequest('status', { cache: 'no-store', nonce: Date.now() }, {
          host: '192.168.4.1', timeoutMs: 3000, retryOnTimeout: false,
        });
        if (active) {
          setBridgeHandoffStatus({ flowId: flow.flowId, status });
          timer = window.setTimeout(poll, 2500);
        }
      } catch {
        if (active) timer = window.setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => { active = false; if (timer != null) window.clearTimeout(timer); };
  }, [detection.state, flow]);

  // HTTPS cannot fetch the card's HTTP status directly. The tracked AP card
  // page supplies the complete status envelope over postMessage; exact
  // handoff-ready evidence retargets that same WindowProxy to the correlated
  // station address and leaves the setup flow in one explicit network-switch
  // state until final station truth arrives.
  useEffect(() => {
    if (
      !flow
      || flow.stage !== 'set-up-card'
      || flow.cardAcknowledgedAt
      || !(link?.readiness || bridgeHandoffStatus?.status)
    ) return;
    const bridge = getCardBridgeState();
    const existing = bridge.handoffCorrelation;
    const expectedCard = flow.expectedCard;
    if (bridgeHandoffStatus && bridgeHandoffStatus.flowId !== flow.flowId) return;
    // Once this exact flow has attempted its one acknowledgement, mounting a
    // different Studio section must not replay the AP -> station navigation.
    // Recovery from that point is status-only (and a real reload goes through
    // restoreCardWifiHandoff above); the explicit retry button remains the
    // user's bounded way to navigate the retained WindowProxy again.
    if (existing
      && bridge.handoffFlowId === flow.flowId
      && (link?.handoffAckAttempted || link?.handoffStationVerified)) {
      setDetection(previous => (
        previous.state === 'return-to-gallery'
          ? previous
          : { state: 'return-to-gallery', correlation: existing, retryable: true }
      ));
      return;
    }
    const status = bridgeHandoffStatus?.status || link.readiness;
    let correlation = existing;
    if (!correlation) {
      correlation = acceptWifiHandoff({
        status,
        expectedCard,
        expectedBootId: status.bootId,
        lastGeneration: 0,
      });
    }
    if (!correlation
      || correlation.expectedCardId !== expectedCard?.id
      || correlation.expectedFirmwareVersion !== expectedCard?.firmwareVersion
      || correlation.expectedBuildId !== expectedCard?.buildId) return;
    const retargeted = retargetCardBridge(correlation.host, correlation, { flowId: flow.flowId });
    const lifecycle = getCardBridgeState().lifecycle;
    getSharedCardLink().dispatch({
      type: 'wifi-handoff-retargeted', host: correlation.host,
      correlation, flowId: flow.flowId, bridgeLifecycle: lifecycle,
    });
    setFailure(retargeted.ok ? '' : 'The card page could not move to the verified gallery-network address. Return to gallery WiFi, then retry this same card page.');
    setDetection({
      state: 'return-to-gallery', correlation,
      retryable: retargeted.retryable !== false,
    });
  }, [bridgeHandoffStatus, flow, link?.readiness]);

  // Reality-driven auto-advance: while the wizard is waiting for the card to
  // rejoin home WiFi (stage 'set-up-card', not yet acknowledged), poll the LAN
  // for the EXPECTED card by identity. Once it answers /api/status in station
  // transport, advance the same verified acknowledge transition the manual
  // button uses — no click required. Only runs on http/file pages that can
  // actually reach the card; on HTTPS the bridge/link path stays the only route.
  const expectedCardId = flow?.stage === 'set-up-card' ? flow.expectedCard?.id : '';
  const pollHost = link?.host;
  useEffect(() => {
    if (!expectedCardId || flow?.cardAcknowledgedAt) {
      setDetection(prev => (prev.state === 'idle' ? prev : { state: 'idle' }));
      return undefined;
    }
    if (!canPushDirectlyToCard()) return undefined;
    let active = true;
    let timer = null;
    const flowId = flow.flowId;
    setDetection(prev => (prev.state === 'found' ? prev : { state: 'searching' }));
    const poll = async () => {
      if (!active) return;
      let result = null;
      try {
        result = await discoverCardStatus({
          preferredHost: pollHost,
          expectedCard: { id: expectedCardId },
          timeoutMs: 1500,
          persist: true,
        });
      } catch { result = null; }
      if (!active) return;
      if (result?.connected) {
        // The poll proved THIS host reachable for the expected card (discoverCardStatus
        // gated on the expected id). Feed it into the shared card link so restore(),
        // which targets link.host, reaches the host the poll actually used rather than
        // a stale remembered address — the same connected-link guarantee the manual
        // acknowledge path gives restore. allowAdopt is safe because the reached card
        // was already identity-matched (id gate above + strict id+fw+build in
        // acknowledgeCommissionedCardFromStatus below); reportDirectCardStatus also
        // persists that identity + stored host so the passive useCardStatus feed
        // converges on it, and its own comparison gate still refuses to overwrite a
        // different persisted pairing. Only done on the acknowledge paths (where
        // restore can follow), never on an identity/firmware-rejected poll.
        const propagateProvenHost = () => reportDirectCardStatus({
          connected: true, host: result.host, status: result.status, allowAdopt: true,
        });
        // Re-read authority so we acknowledge against the freshest generation
        // (another tab or the setup-joined click may have advanced it).
        const current = readCardCommissioning({ flowId }) || flow;
        if (current?.cardAcknowledgedAt) { propagateProvenHost(); if (active) setDetection({ state: 'found' }); return; }
        const ack = acknowledgeCommissionedCardFromStatus(current, result.status);
        if (ack.ok) {
          try {
            await writeCardCommissioning(ack.flow);
            propagateProvenHost();
            if (active) { setFlow(ack.flow); setDetection({ state: 'found' }); }
            return;
          } catch { /* stale generation — listener re-syncs; retry below */ }
        }
      }
      if (active) timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => { active = false; if (timer != null) window.clearTimeout(timer); };
  }, [expectedCardId, flow?.cardAcknowledgedAt, flow?.flowId, pollHost]);

  if (!flow && lightCheckState === 'complete') return (
    <div className="card-commissioning" aria-live="polite">
      <CardCommissioningSteps stage="check-lights" />
      <h3>Light check complete</h3>
      <p>The exact temporary wiring was confirmed on the card and is now its working setup.</p>
      {onComplete && <button type="button" className="btn primary" onClick={onComplete}>Done</button>}
    </div>
  );
  if (!flow) return <div className="card-commissioning" aria-live="polite"><CardCommissioningSteps stage="connect-card" />{failure && <p className="card-connection-failure" role="alert">{failure}</p>}</div>;

  // Restore is deliberately NOT routed through cardProjectAdoption: adoption
  // is a card→Studio read (rebuild the open project from the card's own
  // readback), while this restore is a Studio→card WRITE with its own durable
  // claim registry — the opposite direction, sharing nothing worth deduping.
  const restore = async () => {
    const requestedGeneration = projectLifecycle.generation;
    if (restoreState === 'working' || !flow.cardAcknowledgedAt) return;
    if (!restorePreflight.ok) {
      setFailure('Checking card. Reconnect the exact installed card before restoring the saved project.');
      return;
    }
    setRestoreState('working');
    setFailure('');
    let lease = null;
    try {
      const freshStatus = await readCardStatusEnvelope({
        host: link.host,
        transport: link.transport,
        timeoutMs: 3000,
      });
      if (link.validatedBootId && freshStatus?.bootId !== link.validatedBootId) {
        throw new Error('Card restarted — verifying. Wait for Studio to finish checking it before restoring the project.');
      }
      const initialConfigAuthority = link?.handoffStationVerified === true
        && link?.handoffFlowId === flow.flowId
        && link?.cardBlank === true;
      const freshPreflight = preflightCardCommissioningMutation(flow, freshStatus, {
        allowInitialConfig: initialConfigAuthority,
      });
      if (!freshPreflight.ok) {
        throw new Error(freshPreflight.reason === 'wrong-card'
          ? 'Wrong card. Reconnect the exact installed card before restoring the project.'
          : freshPreflight.reason === 'wrong-firmware-version' || freshPreflight.reason === 'wrong-firmware-build'
            ? 'The connected card firmware does not match the verified installation. Update or reconnect the expected card.'
            : 'Checking card. The card is not command-ready, so Studio refused to restore the project.');
      }
      const selectedReadback = typeof window.__LW_READ_COMMISSIONING_EVIDENCE_FOR_TEST__ === 'function'
        ? window.__LW_READ_COMMISSIONING_EVIDENCE_FOR_TEST__
        : readProjectEvidence;
      const priorAttempt = readCardRestorationAttempt(flow);
      if (priorAttempt) {
        try {
          const responseReadback = await selectedReadback({ host: link.host, endpoint: '/api/firmware-info', expectedCardId: flow.expectedCard.id });
          const evidence = adaptCardRestorationReadback({ method: 'GET', endpoint: '/api/firmware-info', response: responseReadback });
          const next = markCardProjectRestored(flow, evidence);
          adoptCommissionedCardBridgeIdentity(flow.flowId);
          await writeCardCommissioning(next);
          markCommissioningProjectInstalled(flow, {
            cardId: flow.expectedCard.id,
            projectRevision: flow.project.revision,
            projectFingerprint: flow.project.fingerprint,
          }, requestedGeneration);
          setFlow(next);
          setRestoreState('complete');
          return;
        } catch {}
        if (priorAttempt.activationId) {
          try {
            const candidate = await readCandidateEvidence(priorAttempt.activationId, { host: link.host, timeoutMs: 8000 });
            const next = stageCardProjectForPhysicalCheck(flow, bindCardWiringActivationEvidence(candidate, candidate));
            adoptCommissionedCardBridgeIdentity(flow.flowId);
            await writeCardCommissioning(next);
            setFlow(next);
            setRestoreState('complete');
            return;
          } catch {}
        }
        throw new Error('A previous restore may already have reached this card, but exact independent evidence is inconclusive. Inspect or recover this setup; Studio will not send the project again automatically.');
      }
      const claim = await claimCardRestoration(flow);
      if (!claim.ok) throw new Error(claim.reason === 'restore-in-progress' ? 'This exact project restore is already running in another tab. Wait for it to finish or retry after the recovery window.' : claim.reason === 'recovery-required' ? 'A previous restore requires inspection and will not be sent again automatically.' : 'The saved setup is unavailable. Nothing was sent.');
      lease = claim.lease;
      const runtimePackage = runtimePackageFromSnapshot(flow.project.snapshot, flow.project);
      const selectedPush = typeof window.__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__ === 'function'
        ? window.__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__
        : pushProject;
      const mutation = await beginCardRestorationMutation(flow, lease);
      if (!mutation.ok || !verifyCardRestorationMutation(flow, lease.id, mutation.fencingToken)) {
        throw new Error('The durable project restore claim was lost before the card mutation. Nothing was sent.');
      }
      const response = await selectedPush(runtimePackage, {
        host: link.host,
        timeoutMs: 8000,
        reboot: 'if-needed',
        allowProjectChange: true,
        allowLayoutChange: true,
        commissioningFlowId: flow.flowId,
        cardEvidence: freshStatus,
      });
      await recordCardRestorationResponse(flow, lease.id, mutation.fencingToken, response);
      const refreshedStatus = await readCardStatusEnvelope({
        host: link.host, transport: link.transport, timeoutMs: 3000,
      }).catch(() => null);
      if (refreshedStatus) {
        reportCardStatusEnvelope({ host: link.host, transport: link.transport, status: refreshedStatus });
      }
      if (response?.state === 'staged') {
        const candidateReadback = await readCandidateEvidence(response.activationId, { host: link.host, timeoutMs: 8000 });
        const activationEvidence = bindCardWiringActivationEvidence(response, candidateReadback);
        const next = stageCardProjectForPhysicalCheck(flow, activationEvidence);
        adoptCommissionedCardBridgeIdentity(flow.flowId);
        await writeCardCommissioning(next);
        setFlow(next);
        setRestoreState('complete');
        return;
      }
      if (typeof selectedReadback !== 'function') {
        throw new Error('The project was sent, but this firmware does not yet provide independent restoration read-back. Studio has not marked it restored.');
      }
      const responseReadback = await selectedReadback({
        host: link.host,
        endpoint: '/api/firmware-info',
        expectedCardId: flow.expectedCard.id,
      });
      const evidence = adaptCardRestorationReadback({
        method: 'GET', endpoint: '/api/firmware-info', response: responseReadback,
      });
      const next = markCardProjectRestored(flow, evidence);
      adoptCommissionedCardBridgeIdentity(flow.flowId);
      await writeCardCommissioning(next);
      markCommissioningProjectInstalled(flow, {
        cardId: flow.expectedCard.id,
        projectRevision: flow.project.revision,
        projectFingerprint: flow.project.fingerprint,
      }, requestedGeneration);
      setFlow(next);
      setRestoreState('complete');
    } catch (error) {
      setFailure(error?.message || 'Studio could not restore the saved project. Reconnect the same card and try again.');
      setRestoreState('idle');
    } finally {
      if (lease) await releaseCardRestoration(flow.flowId, lease.id).catch(() => false);
    }
  };

  const reconnecting = link?.state === 'connecting' || link?.state === 'reconnecting-bridge';
  const currentCard = link?.card || link?.discoveredCard || {};
  const displayedIdentityCheck = flow.stage === 'set-up-card' && currentCard?.id
    ? acknowledgeCommissionedCard(flow, currentCard)
    : null;
  const identityFailure = flow.stage === 'set-up-card' && !flow.cardAcknowledgedAt && displayedIdentityCheck && !displayedIdentityCheck.ok
    ? identityMessage(displayedIdentityCheck.reason, flow.expectedCard, currentCard)
    : '';

  const confirmSetupNetwork = async () => {
    setFailure('');
    try {
      const next = confirmCardSetupNetworkJoined(flow);
      await writeCardCommissioning(next);
      setFlow(next);
    } catch (error) {
      setFailure(error?.message || 'Studio could not save the Wi-Fi handoff. Try again before leaving this network.');
    }
  };

  // The firmware builds its hotspot name from the same eFuse MAC as the card id
  // Studio recorded at install, so this is the card's REAL network name, not a
  // placeholder. When the id does not have the firmware's shape (older saved
  // flow, fixture data) the copy describes the network instead of naming one.
  const setupSsid = setupNetworkSsidForCardId(flow.expectedCard?.id);
  const setupNetworkLabel = setupNetworkLabelForCardId(flow.expectedCard?.id);
  // "Join the setup network" is an instruction the owner cannot obey for the
  // first half-minute of its life: the card is broadcasting, but this device
  // has not rescanned yet. Say which of those three things is true right now.
  const hotspotWait = describeSetupHotspotWait({
    startedAt: flow.updatedAt,
    now: hotspotNow,
    label: setupNetworkLabel,
  });

  // What the USB serial port said the card did after the flash. `station-detected`
  // means the card's saved Wi-Fi survived the install: it went straight onto the
  // LAN and never raised a setup hotspot, so the 192.168.4.1 instructions would
  // point at an address that can never answer.
  const stationDetected = flow.stage === 'set-up-card'
    && flow.networkState === 'station-detected'
    && Boolean(flow.stationHost);
  // Detection was attempted and could not settle the question. Studio shows both
  // routes rather than guessing which one the owner is looking at.
  const postFlashInconclusive = flow.stage === 'set-up-card'
    && flow.postFlashDetection === 'inconclusive'
    && ['setup-required', 'setup-joined'].includes(flow.networkState);

  const reconnectHost = link?.handoffCorrelation?.host
    || (stationDetected && !flow.cardAcknowledgedAt ? flow.stationHost : '')
    || link?.host || 'lightweaver.local';
  const reconnectInstalledCard = () => onReconnect?.(reconnectHost);
  const openCardPageAt = host => {
    setFailure('');
    const opened = openSetupCard(host);
    if (!opened) {
      setSetupReach({ state: 'idle' });
      setFailure('The browser blocked the tracked card page. Allow popups, then try opening the card page again.');
      return;
    }
    setSetupReach({ state: 'checking', flowId: flow.flowId, startedAt: Date.now(), host });
  };
  const openSetupNetworkCard = () => openCardPageAt(SETUP_CARD_HOST);
  const openStationCard = () => openCardPageAt(flow.stationHost);
  const useSetupNetworkPathInstead = async () => {
    setFailure('');
    setSetupReach({ state: 'idle' });
    try {
      const next = returnCardToSetupNetworkPath(flow);
      await writeCardCommissioning(next);
      setFlow(next);
    } catch (error) {
      setFailure(error?.message || 'Studio could not switch back to the setup-hotspot instructions.');
    }
  };
  const retryStationRetarget = () => {
    const correlation = detection.correlation || getCardBridgeState().handoffCorrelation;
    if (!correlation) {
      setFailure('The verified Wi-Fi handoff is no longer available. Reconnect the exact card before retrying.');
      return;
    }
    const result = retargetCardBridge(correlation.host, correlation, { flowId: flow.flowId });
    const lifecycle = getCardBridgeState().lifecycle;
    getSharedCardLink().dispatch({
      type: 'wifi-handoff-retargeted', host: correlation.host,
      correlation, flowId: flow.flowId, bridgeLifecycle: lifecycle,
    });
    setFailure(result.ok ? '' : 'The verified card page is still unreachable. Return to gallery WiFi and retry this same card page.');
  };

  const acquireFreshLightCheckMutation = async () => {
    const observed = getCardLinkState();
    if (!isCardLinkConnected(observed) || !observed.validatedBootId) {
      throw new Error('Checking card. Reconnect and revalidate the exact installed card before changing the light test.');
    }
    const generation = observed.operationGeneration || 0;
    const bootId = observed.validatedBootId;
    const status = await readCardStatusEnvelope({
      host: observed.host, transport: observed.transport, timeoutMs: 3000,
    });
    const current = getCardLinkState();
    if (!isCardLinkConnected(current)
      || current.host !== observed.host
      || (current.operationGeneration || 0) !== generation
      || current.validatedBootId !== bootId
      || status?.bootId !== bootId) {
      throw new Error('Card restarted or stopped answering. Wait for two stable checks before changing the light test.');
    }
    const preflight = preflightCardCommissioningMutation(flow, status);
    if (!preflight.ok) {
      throw new Error('Checking card. The exact installed card and firmware must be command-ready before changing the light test.');
    }
    const claim = await claimCardLightCheckMutation(flow);
    if (!claim.ok) throw new Error('Another Studio tab is changing this light check. Wait for it to finish, then try again.');
    try {
      const mutation = await beginCardLightCheckMutation(flow, claim.lease);
      const assertAuthority = () => {
        const latest = getCardLinkState();
        if (!mutation.ok
          || !verifyCardLightCheckMutation(flow, claim.lease.id, mutation.fencingToken)
          || !isCardLinkConnected(latest)
          || latest.host !== observed.host
          || latest.validatedBootId !== bootId
          || (latest.operationGeneration || 0) !== generation) {
          throw new Error('Card readiness changed before the light-check command. Nothing was changed.');
        }
      };
      assertAuthority();
      return { lease: claim.lease, host: observed.host, assertAuthority };
    } catch (error) {
      await releaseCardRestoration(flow.flowId, claim.lease.id).catch(() => false);
      throw error;
    }
  };

  const startLightCheck = async () => {
    const activationId = flow.project.pendingActivationId;
    if (lightCheckState !== 'idle') return;
    setFailure('');
    setLightCheckNotice('');
    setLightCheckState('starting');
    let mutationAuthority = null;
    try {
      mutationAuthority = await acquireFreshLightCheckMutation();
      if (!activationId) {
        const frame = commissioningMarkerFrame(flow.project.snapshot);
        if (!frame.length) throw new Error('The saved project has no LED outputs to test.');
        const startMarkers = window.__LW_START_COMMISSIONING_MARKERS_FOR_TEST__;
        let session;
        if (typeof startMarkers === 'function') {
          mutationAuthority.assertAuthority();
          session = await startMarkers(frame, { host: mutationAuthority.host });
        } else {
          session = createWiringChaseSession({ host: mutationAuthority.host });
        }
        markerSessionRef.current = session;
        if (typeof startMarkers !== 'function') {
          mutationAuthority.assertAuthority();
          await session.show(frame);
        }
        markerTimeoutRef.current = window.setTimeout(() => {
          const active = markerSessionRef.current;
          markerSessionRef.current = null;
          markerTimeoutRef.current = null;
          void active?.stop?.().catch(() => {});
          setLightCheckState('idle');
          setLightCheckNotice('The 30-second marker test ended and the working look is restored.');
        }, 30_000);
        setLightCheckState('testing');
        return;
      }
      const activate = typeof window.__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__ === 'function'
        ? window.__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__
        : activateAndWaitForCardWiring;
      mutationAuthority.assertAuthority();
      const status = await activate(activationId, { host: mutationAuthority.host, timeoutMs: 18000 });
      if (status?.state !== 'testing' || status?.activationId !== activationId) {
        throw new Error('The card did not start the exact temporary wiring test.');
      }
      setLightCheckState('testing');
    } catch (error) {
      const session = markerSessionRef.current;
      markerSessionRef.current = null;
      if (session) await session.stop().catch(() => {});
      setFailure(error?.message || 'The bounded light test did not start. The previous working setup remains protected.');
      setLightCheckState('idle');
    } finally {
      if (mutationAuthority?.lease) {
        await releaseCardRestoration(flow.flowId, mutationAuthority.lease.id).catch(() => false);
      }
    }
  };

  const finishLightCheck = async visible => {
    const requestedGeneration = projectLifecycle.generation;
    const activationId = flow.project.pendingActivationId;
    if (lightCheckState !== 'testing') return;
    if (visible && activationId && !hasAuthoritativePendingWiring) {
      setFailure('This older setup lacks exact wiring evidence. Restore the working setup, then send and test the project again.');
      return;
    }
    setFailure('');
    setLightCheckNotice('');
    setLightCheckState(visible ? 'confirming' : 'restoring');
    let mutationAuthority = null;
    try {
      mutationAuthority = await acquireFreshLightCheckMutation();
      if (!activationId) {
        if (markerTimeoutRef.current != null) window.clearTimeout(markerTimeoutRef.current);
        markerTimeoutRef.current = null;
        const session = markerSessionRef.current;
        markerSessionRef.current = null;
        mutationAuthority.assertAuthority();
        await session?.stop?.();
        if (visible) {
          await clearCardCommissioning({ flowId: flow.flowId });
          setLightCheckState('complete');
        } else {
          setLightCheckState('idle');
          setLightCheckNotice('The bounded marker test stopped and the working look is restored.');
        }
        return;
      }
      if (visible) {
        const confirm = typeof window.__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__ === 'function'
          ? window.__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__
          : confirmCardWiringCandidate;
        mutationAuthority.assertAuthority();
        const status = await confirm(activationId, { host: mutationAuthority.host });
        const readFinalStatus = typeof window.__LW_READ_FINAL_COMMISSIONING_WIRING_FOR_TEST__ === 'function'
          ? window.__LW_READ_FINAL_COMMISSIONING_WIRING_FOR_TEST__
          : getCardWiringStatus;
        const finalStatus = await readFinalStatus({
          host: mutationAuthority.host,
          transport: link.transport,
          timeoutMs: 3000,
        });
        assertCommissioningFinalWiringStatus({
          activationId,
          confirmation: status,
          status: finalStatus,
          flow,
          expectedWiring: flow.project.pendingWiring,
        });
        markCommissioningProjectInstalled(flow, {
          cardId: finalStatus.cardId,
          projectRevision: finalStatus.projectRevision,
          projectFingerprint: finalStatus.projectFingerprint,
        }, requestedGeneration);
        await clearCardCommissioning({ flowId: flow.flowId });
        setLightCheckState('complete');
      } else {
        const rollback = typeof window.__LW_ROLLBACK_COMMISSIONING_WIRING_FOR_TEST__ === 'function'
          ? window.__LW_ROLLBACK_COMMISSIONING_WIRING_FOR_TEST__
          : rollbackCardWiringCandidate;
        mutationAuthority.assertAuthority();
        const status = await rollback(activationId, { host: mutationAuthority.host });
        if (status?.state !== 'known-good' || (status?.activationId && status.activationId !== activationId)) {
          throw new Error('The card did not restore the previous working wiring.');
        }
        const next = returnCardProjectToSetupAfterLightCheck(flow);
        await writeCardCommissioning(next);
        setFlow(next);
        setLightCheckState('idle');
      }
    } catch (error) {
      setFailure(error?.message || 'The card could not finish the wiring check. It will restore the previous setup when the test window ends.');
      setLightCheckState('testing');
    } finally {
      if (mutationAuthority?.lease) {
        await releaseCardRestoration(flow.flowId, mutationAuthority.lease.id).catch(() => false);
      }
    }
  };

  return (
    <div className="card-commissioning" data-stage={flow.stage} aria-live="polite">
      <CardCommissioningSteps stage={flow.stage} />
      {flow.stage === 'install-safely' && (
        <>
          <h3>Install safely</h3>
          <p>{flow.source === 'web-serial'
            ? 'The browser was interrupted before it recorded the result. Reconnect the card; Studio will inspect the exact card and firmware build before deciding what to do. It will not flash again automatically.'
            : 'Lightweaver is verifying the official firmware and keeping your saved Studio project available for restoration.'}</p>
          {flow.source === 'web-serial' && <button type="button" className="btn primary" onClick={reconnectInstalledCard}>Reconnect and inspect card</button>}
          {interruptedInstallEvidence && !interruptedInstallEvidence.ok && link?.card?.id && <p className="card-connection-failure" role="alert">{identityMessage(interruptedInstallEvidence.reason, flow.installTarget, link.card)} Nothing was changed.</p>}
        </>
      )}
      {flow.stage === 'set-up-card' && (
        <>
          <h3>Set up card</h3>
          {!flow.cardAcknowledgedAt && detection.state === 'return-to-gallery' && (
            <div className="card-commissioning-network">
              <p role="status"><strong>Wi-Fi saved on the exact card.</strong> Return this device to gallery WiFi. Studio is reusing the same card page and will continue after it verifies this exact card on the gallery network.</p>
              {detection.retryable && <button type="button" className="btn" onClick={retryStationRetarget}>Retry verified card page</button>}
            </div>
          )}
          {!flow.cardAcknowledgedAt && detection.state === 'found' && (
            <div className="card-commissioning-network">
              <p aria-live="polite"><strong>Card is back on your network — continuing…</strong></p>
            </div>
          )}
          {!flow.cardAcknowledgedAt && !['found', 'return-to-gallery'].includes(detection.state) && stationDetected && (
            <div className="card-commissioning-network" data-post-flash="station">
              <p><strong>No hotspot to join — the card kept its Wi-Fi.</strong> Studio watched this card boot over USB and saw it join your network at <strong>{flow.stationHost}</strong>. It never started a {setupNetworkLabel}, so there is nothing to join and the 192.168.4.1 setup address will never answer.</p>
              <button type="button" className="btn primary" onClick={openStationCard}>Open the card at {flow.stationHost}</button>
              {setupReach.state === 'checking' && <p role="status">Checking whether the card answers at {flow.stationHost}…</p>}
              {setupReach.state === 'unreachable' && (
                <p className="card-connection-failure" role="alert">
                  {`The card page opened, but nothing answered at ${flow.stationHost}. Its address may have changed since the install. Check that this device is on the same Wi-Fi, then use “Reconnect installed card” below.`}
                </p>
              )}
              <p role="status">{detection.state === 'searching' ? `Verifying ${flow.expectedCard.id} on your network…` : 'Studio continues automatically once this exact card answers.'}</p>
              <button type="button" className="btn" onClick={useSetupNetworkPathInstead}>{setupSsid ? `No — the card is showing ${setupSsid}` : 'No — the card is showing its setup hotspot'}</button>
            </div>
          )}
          {!flow.cardAcknowledgedAt && !['found', 'return-to-gallery'].includes(detection.state) && postFlashInconclusive && (
            <div className="card-commissioning-network" data-post-flash="inconclusive">
              <p role="status"><strong>Studio could not confirm how this card came back up.</strong> If the install kept the Wi-Fi it was already using, the card is on your network right now and never started {setupNetworkLabel} — the setup address would spin forever. Follow whichever of these you can actually see.</p>
              <button type="button" className="btn" onClick={reconnectInstalledCard} disabled={reconnecting}>{reconnecting ? 'Reconnecting…' : 'The card is already on my Wi-Fi'}</button>
            </div>
          )}
          {!flow.cardAcknowledgedAt && !['found', 'return-to-gallery'].includes(detection.state) && flow.networkState === 'setup-required' && (
            <div className="card-commissioning-network" data-hotspot-wait={hotspotWait.phase}>
              <p>The clean installation reset Wi-Fi, so the card is now broadcasting <strong>{setupNetworkLabel}</strong> for you to join. The setup address only works while that network is joined.</p>
              {/*
                The wait itself, stated. Without it the owner opens Wi-Fi
                settings, does not see the network, and concludes something is
                broken — when all that has happened is that their phone has not
                rescanned yet. This counts down instead of asserting.
              */}
              <p className="card-commissioning-hotspot-wait" role="status" data-testid="setup-hotspot-wait">
                <strong>{hotspotWait.headline}</strong> {hotspotWait.detail}
              </p>
              <button type="button" className="btn primary" onClick={confirmSetupNetwork}>{setupSsid ? `I’ve joined ${setupSsid}` : 'I’ve joined the setup network'}</button>
              {hotspotWait.phase === 'overdue' && (
                <button type="button" className="btn" onClick={reconnectInstalledCard} disabled={reconnecting} data-testid="setup-hotspot-no-network">
                  {reconnecting ? 'Reconnecting…' : 'There is no such network — look for the card on my Wi-Fi'}
                </button>
              )}
              {detection.state === 'searching' && <p role="status">Looking for {flow.expectedCard.id} on your network…</p>}
            </div>
          )}
          {!flow.cardAcknowledgedAt && !['found', 'return-to-gallery'].includes(detection.state) && flow.networkState === 'setup-joined' && (
            <div className="card-commissioning-network">
              <p><strong>{setupSsid ? `${setupSsid} joined.` : 'Setup network joined.'}</strong> If the card is still on its setup network, open it at 192.168.4.1, choose its permanent Wi-Fi, and return here. Once it rejoins your network Studio continues automatically. This progress stays saved while networks change.</p>
              <button type="button" className="btn" onClick={openSetupNetworkCard}>Open 192.168.4.1 Wi-Fi setup</button>
              {setupReach.state === 'checking' && <p role="status">Checking whether the card answers at 192.168.4.1…</p>}
              {setupReach.state === 'unreachable' && (
                <p className="card-connection-failure" role="alert">
                  {`The setup page opened, but the card never answered at 192.168.4.1, so that tab will keep loading forever. Usually this device is not on ${setupNetworkLabel}, it silently switched back to a different network, or the card already rejoined your home Wi-Fi and its setup hotspot is gone. Check this device’s Wi-Fi and open Wi-Fi setup again — or if the card is already back on your network, use “Reconnect installed card” below.`}
                </p>
              )}
              <p role="status">{detection.state === 'searching' ? `Waiting for the card to rejoin your network — looking for ${flow.expectedCard.id}…` : 'Waiting for the card to rejoin your network…'}</p>
            </div>
          )}
          {!flow.cardAcknowledgedAt ? (
            <>
              <p>{identityFailure || 'Studio continues automatically once the exact card, firmware version, and firmware build answer on your network. You can also reconnect the installed card manually.'}</p>
              <button type="button" className="btn" onClick={reconnectInstalledCard} disabled={reconnecting}>{reconnecting ? 'Reconnecting…' : 'Reconnect installed card'}</button>
            </>
          ) : (
            <>
              <p>The exact installed card and firmware build are verified. Restore the saved Studio revision that contains its GPIO outputs, LED map, zones, patterns, playlist, and controls.</p>
              {!restorePreflight.ok && <p role="status">Checking card. Restore stays locked until the exact installed card and firmware are command-ready.</p>}
              <button type="button" className="btn primary" onClick={restore} disabled={restoreState === 'working' || !restorePreflight.ok}>{restoreState === 'working' ? 'Restoring saved project…' : 'Restore saved project'}</button>
            </>
          )}
        </>
      )}
      {flow.stage === 'check-lights' && (
        <>
          <h3>Check lights</h3>
          {!lightCheckPreflight.ok && <p role="status">Checking card. Light-check controls stay locked until the exact card is stable and command-ready.</p>}
          <p>{flow.project.pendingActivationId
            ? 'The saved Studio project revision is staged on this exact card. The bounded physical light check will test its GPIO wiring before making it permanent.'
            : 'The saved Studio project revision is installed on this exact card. Continue to the bounded physical light check.'}</p>
          {flow.project.pendingActivationId ? (
            <div className="card-commissioning-network">
              {lightCheckState === 'testing' ? (
                <>
                  <p>Check every connected output. Do you see a <strong>blue first pixel and red final pixel</strong>, with the expected LEDs between them?</p>
                  {!hasAuthoritativePendingWiring && (
                    <p role="alert">This older setup lacks exact wiring evidence, so Studio cannot make it permanent. Restore the working setup, then send and test the project again.</p>
                  )}
                  <div className="card-connection-actions">
                    <button type="button" className="btn primary" disabled={!lightCheckPreflight.ok || !hasAuthoritativePendingWiring} onClick={() => finishLightCheck(true)}>Yes, every output is correct</button>
                    <button type="button" className="btn" disabled={!lightCheckPreflight.ok} onClick={() => finishLightCheck(false)}>No, restore working setup</button>
                  </div>
                </>
              ) : (
                <>
                  <p>The test lasts at most 90 seconds. Until you confirm the real LEDs, the card keeps the previous working wiring ready to restore automatically.</p>
                  <button type="button" className="btn primary" disabled={lightCheckState !== 'idle' || !lightCheckPreflight.ok} onClick={startLightCheck}>{lightCheckState === 'starting' ? 'Starting bounded light test…' : 'Start 90-second light test'}</button>
                </>
              )}
            </div>
          ) : (
            <div className="card-commissioning-network">
              {lightCheckState === 'testing' ? (
                <>
                  <p>Check every connected output. Do you see a <strong>blue first pixel and red final pixel</strong>, with green LEDs between them?</p>
                  <div className="card-connection-actions">
                    <button type="button" className="btn primary" disabled={!lightCheckPreflight.ok} onClick={() => finishLightCheck(true)}>Yes, every output is correct</button>
                    <button type="button" className="btn" disabled={!lightCheckPreflight.ok} onClick={() => finishLightCheck(false)}>No, restore working look</button>
                  </div>
                </>
              ) : (
                <>
                  <p>This marker frame runs for at most 30 seconds, then releases the card back to its normal working look automatically.</p>
                  <button type="button" className="btn primary" disabled={lightCheckState !== 'idle' || !lightCheckPreflight.ok} onClick={startLightCheck}>{lightCheckState === 'starting' ? 'Starting bounded marker test…' : 'Start bounded marker test'}</button>
                </>
              )}
              {lightCheckNotice && <p role="status">{lightCheckNotice}</p>}
            </div>
          )}
        </>
      )}
      {failure && <p className="card-connection-failure" role="alert">{failure}</p>}
    </div>
  );
}

export { runtimePackageFromSnapshot };
