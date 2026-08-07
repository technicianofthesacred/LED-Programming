import React, { useEffect, useMemo, useRef, useState } from 'react';
import './lw-setup.css';
import { CONNECTED_CARD_LINK_STATES, deriveSetupJourney, SETUP_STEP_IDS } from '../lib/setupJourney.js';
import { CARD_COMMISSIONING_CHANGED_EVENT, inspectCardCommissioning } from '../lib/cardCommissioningFlow.js';
import { isCardLinkConnected } from '../lib/cardLink.js';
import { readCardProjectEvidence, readCardStatusEnvelope } from '../lib/cardPushClient.js';
import { resolveCardProject, describeResolvedCardProject } from '../lib/cardProjectResolver.js';
import { isBenchProjectEvidence } from '../lib/benchConfig.js';
import { CARD_HARDWARE_CONTRACT } from '../lib/cardHardwareContract.js';
import { COLOR_ORDERS } from '../lib/usbLedColorOrder.js';
import { projectSkeletonFromCardStatus } from '../lib/discoveryCommit.js';
import { prepareCardDeployment } from '../lib/cardDeployment.js';
import { getCardHostname, CardPushError } from '../lib/cardPushClient.js';
import { deploySetupToCard } from '../lib/cardSetupDeploy.js';
import { sweepKnownSubnetsForCard } from '../lib/cardConnection.js';
import { sampleStripPixels } from '../lib/layoutGeometry.js';
import { buildBenchConfig } from '../lib/benchConfig.js';
import { installBenchConfig } from '../lib/benchInstall.js';
import { buildDecadeMarkerFrame } from '../lib/stripDiscovery.js';
import { COLOUR_PROBE_BLOCKS, buildColourProbeFrame, colourOrderFromSeenOrder } from '../lib/colourReorder.js';
import { createCardFrameStream } from '../lib/cardFrameStream.js';
import { useProject } from '../state/ProjectContext.jsx';
import { PORT_ROLE_STRIP, PORT_ROLE_UNUSED } from '../lib/portRoles.js';

const SKIP_KEY = 'lw_setup_skip_v1';
// How much strip to provision while counting. Long enough that almost any
// real strip lights end to end, so the owner counts the whole thing rather
// than counting where the card ran out of room.
const COUNTING_CEILING = 600;

// The "Any time" rows are shortcuts to somewhere real. They used to render as
// plain text with no button at all, which read as an instruction the screen was
// refusing to carry out. Every one of them now does the thing it names.
const OPTIONAL_ACTIONS = {
  layout: { label: 'Open Layout', hash: '#screen=layout' },
  save: { label: 'Save the project', save: true },
  controls: { label: 'Open Wire mode', hash: '#screen=layout&mode=wire' },
};

export function SetupScreen({
  connected,
  cardHost,
  onOpenConnectionCenter,
  cardLink,
  currentProject = {},
  activeCloudProjects = [],
  browserProjects = [],
  replaceProject,
  onSaveProject,
}) {
  const {
    setProjectId,
    setPortRoles,
    setStandaloneController,
    serializeProject,
    updateWiring,
    setStrips,
    starterPending: starterLayoutPending,
  } = useProject();
  const [install, setInstall] = useState({ busy: false, message: '', failed: false, done: false });
  const [commissioningFlow, setCommissioningFlow] = useState(() => inspectCardCommissioning().flow);
  const ready = cardLink ? isCardLinkConnected(cardLink) : connected;
  // isCardLinkConnected is false for a card that answers but holds no project.
  // The install step exists to GIVE a blank card its project, so gating it on
  // that flag is a deadlock: no project because no install, no install because
  // no project. Reachability is the honest test here.
  const reachable = ready || CONNECTED_CARD_LINK_STATES.includes(cardLink?.state);
  const [cardState, setCardState] = useState({ evidence: null, status: null, read: false });
  const [resolution, setResolution] = useState({ kind: 'unknown' });
  const importRef = useRef(null);
  const [counting, setCounting] = useState({ busy: false, lit: false, message: '' });
  // One draft per question, each seeded from the answer already on record, so
  // reopening a finished step shows what that step currently says instead of a
  // blank form that silently overwrites it.
  const [pinDraft, setPinDraft] = useState('');
  const [orderDraft, setOrderDraft] = useState('');
  const [countDraft, setCountDraft] = useState('');
  const countingStreamRef = useRef(null);
  // Which finished step the owner has reopened to change. Empty means none, and
  // the only expanded row is the one they still have to do.
  const [openStepId, setOpenStepId] = useState('');
  const [finding, setFinding] = useState({ busy: false, message: '' });
  const [colourProbe, setColourProbe] = useState({ busy: false, lit: false, message: '' });
  const [seenOrder, setSeenOrder] = useState(() => COLOUR_PROBE_BLOCKS.map(block => block.id));
  const resolveInputsRef = useRef({ currentProject, activeCloudProjects, browserProjects });
  resolveInputsRef.current = { currentProject, activeCloudProjects, browserProjects };

  useEffect(() => {
    const sync = () => setCommissioningFlow(inspectCardCommissioning().flow);
    window.addEventListener('storage', sync);
    window.addEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    };
  }, []);

  // Read the card's evidence once it is connected, then classify it: bench
  // scaffolding, a match for the open or a saved project, or nothing at all.
  useEffect(() => {
    if (!ready) {
      setCardState({ evidence: null, status: null, read: false });
      setResolution({ kind: 'unknown' });
      return undefined;
    }
    let cancelled = false;
    (async () => {
      let evidence = null;
      let status = null;
      try {
        const readHost = cardLink?.host || cardHost || '';
        const readTransport = cardLink?.transport;
        // Settled, not all: these are two independent questions of the card, and
        // Promise.all threw away a perfectly good status read whenever the
        // project read failed. That status is what lets a card which is already
        // driving a strip hand its wiring back — losing it sent the owner
        // through questions the card had already answered.
        const [readEvidence, readStatus] = await Promise.allSettled([
          readCardProjectEvidence({ host: readHost, transport: readTransport }),
          readCardStatusEnvelope({ host: readHost, transport: readTransport }),
        ]);
        evidence = readEvidence.status === 'fulfilled' ? readEvidence.value : null;
        status = readStatus.status === 'fulfilled' ? readStatus.value : null;
      } catch {
        evidence = null;
        status = null;
      }
      if (cancelled) return;
      setCardState({ evidence, status, read: true });
      // The card is the source of truth for what is physically wired to it. If it
      // is already driving a strip and this browser's project does not know about
      // it, adopt what the card knows rather than marching the owner back through
      // questions the card can already answer. This is the "my chip is already
      // programmed" case: it should pick up where the card is, not start over.
      adoptWiringFromCard(status);
      if (!evidence) {
        setResolution({ kind: 'none' });
        return;
      }
      if (isBenchProjectEvidence(evidence)) {
        setResolution({ kind: 'bench' });
        return;
      }
      const inputs = resolveInputsRef.current;
      const resolved = resolveCardProject({
        evidence,
        currentProject: inputs.currentProject,
        productionJobs: [],
        cloudProjects: Array.isArray(inputs.activeCloudProjects) ? inputs.activeCloudProjects : [],
        browserProjects: Array.isArray(inputs.browserProjects) ? inputs.browserProjects : [],
      });
      if (resolved.status === 'match') {
        setResolution(resolved.source === 'current'
          ? { kind: 'matches-current', resolved }
          : { kind: 'saved-match', resolved });
        return;
      }
      setResolution({ kind: 'none' });
    })();
    return () => { cancelled = true; };
    // Depend on STABLE values only. currentProject / activeCloudProjects /
    // browserProjects are rebuilt on every render, so listing them here re-ran
    // this effect forever: read card -> setState -> render -> new object ->
    // read card. That loop pinned the main thread and made every button on this
    // screen look dead. The live values are read through a ref instead.
  }, [ready, cardLink?.host, cardLink?.transport, cardHost, currentProject?.id, currentProject?.projectRevision]);

  const matchesCurrent = resolution.kind === 'matches-current';
  const journey = useMemo(() => deriveSetupJourney({
    cardLink,
    commissioningFlow,
    project: currentProject,
    resolution: matchesCurrent ? { matchesCurrentProject: true, playbackAccess: 'ready' } : null,
  }), [cardLink, commissioningFlow, currentProject, matchesCurrent]);

  const requiredSteps = journey.steps.filter(step => step.status !== 'optional');
  const optionalSteps = journey.steps.filter(step => step.status === 'optional');

  // Take pin, light count and colour order straight off a card that is already
  // running them. Only fills gaps — an answer the owner has given is never
  // overwritten.
  const adoptedRef = useRef(false);
  const adoptWiringFromCard = (status) => {
    if (adoptedRef.current) return;
    const outputs = Array.isArray(status?.outputs) ? status.outputs : [];
    const wired = outputs.filter(output => Number(output?.pixels) > 0 && Number.isFinite(Number(output?.pin)));
    if (!wired.length) return;
    const known = Array.isArray(currentProject?.portRoles) ? currentProject.portRoles : [];
    const alreadyDescribed = known.some(entry => entry?.role === PORT_ROLE_STRIP && Number(entry.pixelCount) > 0);
    if (alreadyDescribed) { adoptedRef.current = true; return; }
    adoptedRef.current = true;
    // Take on the card's project identity as well as its wiring. Without this the
    // browser stays on some other piece, every pattern press is silently refused
    // as "that card belongs to something else", and the owner is asked to
    // reconcile two things the app could simply have agreed on. The card knows
    // which piece it is running; this is the app catching up to it.
    const cardProjectId = String(status?.projectId || '').trim();
    if (cardProjectId && typeof setProjectId === 'function') setProjectId(cardProjectId);
    const roles = known.length ? known.map(entry => {
      const match = wired.find(output => Number(output.pin) === Number(entry.pin));
      return match ? { ...entry, role: PORT_ROLE_STRIP, pixelCount: Number(match.pixels) } : entry;
    }) : wired.map(output => ({ pin: Number(output.pin), role: PORT_ROLE_STRIP, pixelCount: Number(output.pixels), controlKind: '' }));
    applyWiring(roles, status?.outputColor?.colorOrder || '');
  };

  const go = hash => { window.location.hash = hash; };

  // Look for the card rather than telling the owner their card must be new.
  // Home routers move addresses on a lease, so every remembered address can be
  // stale at once; this searches the networks the card has answered on before.
  const findMyCard = async () => {
    setFinding({ busy: true, message: 'Looking for your card on your network…' });
    try {
      const found = await sweepKnownSubnetsForCard({
        onProgress: message => setFinding({ busy: true, message }),
      });
      if (found) {
        setFinding({ busy: false, message: `Found it at ${found.host}. Connecting…` });
        onOpenConnectionCenter?.();
        return;
      }
      setFinding({
        busy: false,
        message: 'No card answered on your network. Check it is powered on and on the same Wi-Fi as this computer.',
      });
    } catch {
      setFinding({ busy: false, message: 'Could not search your network from here. Connect by hand instead.' });
    }
  };

  const journeyProject = { portRoles: Array.isArray(currentProject?.portRoles) ? currentProject.portRoles : [] };

  // What the project already says. Each editor below shows this until the owner
  // types over it, so opening a finished step reads as "here is your answer",
  // never as an empty form that will quietly erase it on the next click.
  const stripRole = journeyProject.portRoles.find(entry => entry.role === PORT_ROLE_STRIP);
  const savedPin = Number.isFinite(Number(stripRole?.pin)) ? Number(stripRole.pin) : null;
  const savedCount = Number(stripRole?.pixelCount) > 0 ? Number(stripRole.pixelCount) : null;
  const savedOrder = currentProject?.devices?.standaloneController?.led?.colorOrder || '';
  const pinValue = pinDraft !== '' ? pinDraft : String(savedPin ?? CARD_HARDWARE_CONTRACT.outputPins[0] ?? 18);
  const orderValue = orderDraft !== '' ? orderDraft : savedOrder;
  const countValue = countDraft !== '' ? countDraft : (savedCount ? String(savedCount) : '');

  // Send the owner's real setup to the card. Deliberately NOT the provisional
  // bench document Find-my-strips writes: that one is a temporary test the card
  // is meant to forget, and leaving it behind is what strands a card mid-setup.
  const deployConfig = (runtimePackage, host, onProgress, options = {}) => {
    countingStreamRef.current?.stop?.();
    countingStreamRef.current = null;
    return deploySetupToCard(runtimePackage, host, { onProgress, ...options });
  };

  // Build the card document for a given set of ports, ignoring the drawing.
  // Used when the drawing cannot be trusted yet — counting the strip, and
  // adopting what a card already knows.
  const packageForPortRoles = (roles) => {
    const saved = serializeProject();
    return prepareCardDeployment({
      projectId: saved.id,
      projectName: saved.name,
      // Without a revision the card is written with no project fingerprint, and
      // then nothing can tell it is running the project the owner has open.
      projectRevision: Number.isSafeInteger(saved.projectRevision) ? saved.projectRevision : 0,
      standaloneController: {
        ...(saved.devices?.standaloneController || {}),
        outputs: outputsFromPortRoles(roles),
      },
    }, { cardId: cardLink?.card?.id || '' });
  };

  const runInstall = async (takeOver = false) => {
    setInstall({ busy: true, message: 'Sending your setup to the card…', failed: false, done: false });
    try {
      // prepareCardDeployment takes the FLAT card-facing shape, not the nested
      // saved-project shape. Handing it the nested one silently produces the
      // built-in placeholder wiring (GPIO 16, 44 lights) instead of the owner's,
      // which is how a card ends up driving a port nothing is plugged into.
      const saved = serializeProject();
      const prepared = prepareCardDeployment({
        projectId: saved.id,
        projectName: saved.name,
        // Undefined here means prepareCardDeployment skips the fingerprint, and a
        // card with no fingerprint can never be matched to the open project.
        projectRevision: Number.isSafeInteger(saved.projectRevision) ? saved.projectRevision : 0,
        projectFingerprint: saved.projectFingerprint,
        strips: saved.layout?.strips || [],
        patchBoard: saved.layout?.patchBoard || null,
        wiring: saved.layout?.wiring || null,
        standaloneController: saved.devices?.standaloneController || {},
      }, { cardId: cardLink?.card?.id || '' });
      // The card is built from the drawing, so a drawing that disagrees with the
      // real strip sends the wrong wiring and the lights land in the wrong place.
      // Say so plainly instead of shipping a silent mismatch.
      const discovered = journeyProject.portRoles.filter(entry => entry.role === PORT_ROLE_STRIP && entry.pixelCount > 0);
      const discoveredPixels = discovered.reduce((sum, entry) => sum + entry.pixelCount, 0);
      const sendingPixels = (prepared.config?.led?.outputs || []).reduce((sum, output) => sum + (Number(output.pixels) || 0), 0);
      const sendingPins = (prepared.config?.led?.outputs || []).map(output => output.pin).join(', ');
      const discoveredPins = discovered.map(entry => entry.pin).join(', ');
      if (discoveredPixels && sendingPixels && (sendingPixels !== discoveredPixels || sendingPins !== discoveredPins)) {
        setInstall({
          busy: false,
          failed: true,
          done: false,
          needsRedraw: { pixels: discoveredPixels, pins: discoveredPins },
          message: `Your drawing says ${sendingPixels} lights on GPIO ${sendingPins}, but your strip has ${discoveredPixels} lights on GPIO ${discoveredPins}.`,
        });
        return;
      }
      const host = cardLink?.host || cardHost || getCardHostname();
      await deployConfig(prepared.runtimePackage, host,
        message => setInstall({ busy: true, message, failed: false, done: false }),
        { allowProjectChange: takeOver });
      setInstall({
        busy: false,
        failed: false,
        done: true,
        message: 'Your setup is on the card. It will play these lights on its own now, even with this page closed.',
      });
    } catch (error) {
      const detail = error instanceof CardPushError ? error.message : (error?.message || 'the card did not answer');
      if (error?.code === 'project-mismatch' && !takeOver) {
        setInstall({
          busy: false,
          failed: true,
          done: false,
          needsTakeOver: true,
          message: 'This card is currently set up for a different piece. Sending this setup will replace what is on it.',
        });
        return;
      }
      setInstall({ busy: false, failed: true, done: false, message: `The card did not take the setup: ${detail}` });
    }
  };

  const skipSetup = () => {
    try { window.localStorage.setItem(SKIP_KEY, '1'); } catch { /* storage may be unavailable */ }
    go('#screen=layout');
  };

  // Point the wiring plan at the port the strip is really on. Without this the
  // card is built from the drawing's old GPIO and the discovered answer never
  // reaches it — the strip stays dark while every screen claims success.
  const retargetWiringToPin = (pin) => {
    if (!Number.isFinite(pin) || typeof updateWiring !== 'function') return;
    updateWiring(draft => {
      if (!Array.isArray(draft.outputs) || draft.outputs.length !== 1) return;
      if (draft.outputs[0].pin === pin) return;
      draft.outputs[0].pin = pin;
    }, { changeKind: 'gpio' });
  };

  // The card is built from the drawing, so the drawing has to carry the real
  // number of lights or the card is sent a length that does not exist. Only the
  // untouched placeholder line is resized — never artwork the owner has drawn.
  const resizePlaceholderStrip = (count) => {
    if (!Number.isFinite(count) || count <= 0 || typeof setStrips !== 'function') return;
    // Safe to reshape while there is nothing to protect: the untouched starter
    // layout, or a project with no imported artwork. Once real artwork exists the
    // drawing is the owner's and is never touched here.
    const hasArtwork = Boolean(currentProject?.layout?.svgText);
    if (!starterLayoutPending && hasArtwork) return;
    setStrips(prev => {
      const list = Array.isArray(prev) ? prev : [];
      if (!list.length) return list;
      const total = list.reduce((sum, strip) => sum + (Number(strip.pixelCount) || 0), 0);
      if (total === count) return list;
      // Every shape is KEPT and scaled to share the real total. Deleting a shape
      // instead would leave the wiring plan and the zones pointing at something
      // that no longer exists, and the card refuses the whole project over it.
      const shares = list.map(strip => Math.max(1, Math.round(((Number(strip.pixelCount) || 1) / (total || list.length)) * count)));
      let drift = count - shares.reduce((sum, share) => sum + share, 0);
      for (let index = 0; drift !== 0 && index < shares.length; index += 1) {
        const step = drift > 0 ? 1 : -1;
        if (shares[index] + step >= 1) { shares[index] += step; drift -= step; }
      }
      return list.map((strip, index) => (strip.pixelCount === shares[index] ? strip : {
        ...strip,
        pixelCount: shares[index],
        pixels: sampleStripPixels(strip.pathData, shares[index], strip.reversed, strip.x || 0, strip.y || 0),
      }));
    });
  };

  // A project that has never had its wiring set falls back to a hard-coded
  // placeholder — GPIO 16 with 44 lights — and that placeholder is what gets
  // sent to the card. Write the real ports here so the card is built from the
  // strip the owner actually has.
  const outputsFromPortRoles = (portRoles) => (portRoles || [])
    .filter(entry => entry?.role === PORT_ROLE_STRIP && entry.pixelCount > 0)
    .slice(0, CARD_HARDWARE_CONTRACT.maxOutputs)
    .map((entry, index) => ({
      id: `out${index + 1}`,
      name: `Output ${index + 1}`,
      pin: Number(entry.pin),
      pixels: Number(entry.pixelCount),
    }));

  const applyWiring = (portRoles, colorOrder) => {
    const outputs = outputsFromPortRoles(portRoles);
    setStandaloneController(prev => ({
      ...prev,
      ...(outputs.length ? { outputs } : {}),
      led: {
        ...(prev?.led || {}),
        ...(colorOrder ? { colorOrder, colorOrderConfirmed: true } : {}),
        ...(outputs.length ? { outputs, pixels: outputs.reduce((sum, output) => sum + output.pixels, 0) } : {}),
      },
    }));
    if (Array.isArray(portRoles) && portRoles.length) {
      setPortRoles(portRoles);
      const strip = portRoles.find(entry => entry?.role === PORT_ROLE_STRIP && entry.pixelCount > 0);
      if (strip) {
        retargetWiringToPin(Number(strip.pin));
        resizePlaceholderStrip(Number(strip.pixelCount));
      }
    }
  };

  // Paint the ruler. The card only lights pixels it has been configured for, so
  // a generous temporary length goes on first — otherwise a 41-light strip on a
  // card set to 30 shows 30 and the owner counts 30, which is how a wrong answer
  // gets recorded as a confident one.
  const showCountingRuler = async (pin) => {
    setCounting({ busy: true, lit: false, message: 'Making room on the card so the whole strip can light…' });
    const host = cardLink?.host || cardHost || getCardHostname();
    try {
      const generous = [{ pin, role: PORT_ROLE_STRIP, pixelCount: COUNTING_CEILING, controlKind: '' }];
      await deployConfig(packageForPortRoles(generous).runtimePackage, host,
        message => setCounting({ busy: true, lit: false, message }),
        { allowProjectChange: true });
      const layout = [{ pin, start: 0, count: COUNTING_CEILING }];
      const frame = buildDecadeMarkerFrame({ benchLayout: layout, counts: { [pin]: COUNTING_CEILING } });
      countingStreamRef.current?.stop?.();
      countingStreamRef.current = createCardFrameStream({ host });
      countingStreamRef.current.start();
      countingStreamRef.current.push(frame);
      setCounting({ busy: false, lit: true, message: 'The strip is lit. Count it, then type the number.' });
    } catch (error) {
      setCounting({ busy: false, lit: false, message: `Could not light the strip: ${error?.message || 'the card did not answer'}` });
    }
  };

  // Which port the strip is plugged into. Moving it carries the measured length
  // across: the old shortcut form zeroed every other strip port, so re-answering
  // the port question silently threw away the count and the colour order with it.
  const applyPin = () => {
    const pin = Number(pinValue);
    if (!Number.isFinite(pin)) return;
    setOpenStepId('');
    const carried = savedCount || 0;
    const roles = journeyProject.portRoles.map((entry) => {
      if (Number(entry.pin) === pin) {
        const kept = Number(entry.pixelCount) > 0 ? Number(entry.pixelCount) : carried;
        return { ...entry, role: PORT_ROLE_STRIP, pixelCount: kept };
      }
      return entry.role === PORT_ROLE_STRIP ? { ...entry, role: PORT_ROLE_UNUSED, pixelCount: 0 } : entry;
    });
    applyWiring(roles, '');
    setPinDraft('');
  };

  const applyOrder = () => {
    const order = String(orderValue || '').trim();
    if (!order) {
      setColourProbe(prev => ({ ...prev, message: 'Pick the order you see on the strip, or light it to compare.' }));
      return;
    }
    setOpenStepId('');
    countingStreamRef.current?.stop?.();
    countingStreamRef.current = null;
    setColourProbe({ busy: false, lit: false, message: `Colour order set to ${order}.` });
    applyWiring(journeyProject.portRoles, order);
    setOrderDraft('');
  };

  const applyCount = () => {
    const count = Math.max(0, Math.round(Number(countValue) || 0));
    // Zero lights is not an answer, and accepting it left the step looking
    // finished while the card was sent a strip with nothing on it.
    if (count <= 0) {
      setCounting(prev => ({ ...prev, message: 'Type how many lights are on the strip — a number above zero.' }));
      return;
    }
    setOpenStepId('');
    countingStreamRef.current?.stop?.();
    countingStreamRef.current = null;
    setCounting({ busy: false, lit: false, message: `Recorded ${count} lights.` });
    const roles = journeyProject.portRoles.map(entry => (
      entry?.role === PORT_ROLE_STRIP ? { ...entry, pixelCount: count } : entry
    ));
    // Deliberately no colour order here. applyWiring treats any order it is
    // handed as one the owner confirmed, so passing the project's own default
    // marked the colour step done without ever having asked the question.
    applyWiring(roles, '');
    setCountDraft('');
  };

  const startFromCard = () => {
    const skeleton = projectSkeletonFromCardStatus(cardState.status || cardLink?.readiness || {});
    applyWiring(skeleton.portRoles, skeleton.colorOrder);
  };

  const loadResolvedProject = async () => {
    if (!resolution?.resolved?.project) return;
    try {
      await replaceProject?.(resolution.resolved.project, { confirmDiscard: () => true });
    } catch { /* keep the current project on failure */ }
  };

  const onImportFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(String(ev.target.result));
        await replaceProject?.(data);
      } catch { /* an invalid file leaves the current project untouched */ }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  // The controls for one step. Rendered whenever the row is open — whether that
  // is because it is the step to do next, or because the owner pressed Change on
  // a finished one. Gating this on "current" meant Change opened an empty box on
  // four of the six steps, which is what made the row look like decoration.
  const renderStepBody = (step) => {
    if (step.id === 'flash') {
      // A card sitting on the network that Studio has simply not been paired with
      // is NOT an unflashed card. Leading with "Install the firmware" tells the
      // owner to erase a working card when all they needed was to connect to it.
      return (
        <div className="lw-setup-detail">
          <button
            type="button"
            className="btn primary"
            data-testid="setup-connect-card"
            disabled={finding.busy}
            onClick={findMyCard}
          >
            {finding.busy ? 'Looking for your card…' : 'Find my card'}
          </button>
          {finding.message && <p className="lw-setup-note" data-testid="setup-find-status">{finding.message}</p>}
          <button type="button" className="link-btn" data-testid="setup-connect-manual" onClick={() => onOpenConnectionCenter?.()}>
            Connect by hand instead
          </button>
          <p className="lw-setup-note">
            Already have a card powered on and on your Wi-Fi? Connect to it — there is nothing to install.
          </p>
          <button type="button" className="link-btn" data-testid="setup-step-flash-install" onClick={() => go('#screen=card&section=install')}>
            My card is brand new — install the firmware
          </button>
        </div>
      );
    }
    if (step.id === 'wifi') {
      // Most owners get here with the card already on their Wi-Fi. Lead with that.
      // The hotspot walk is only for a card that has never been given a network,
      // so it sits behind a disclosure rather than being the instruction.
      return (
        <div className="lw-setup-detail">
          <button
            type="button"
            className="btn primary"
            data-testid="setup-wifi-connect"
            onClick={() => onOpenConnectionCenter?.()}
          >
            My card is already on Wi-Fi — connect to it
          </button>
          <details className="lw-setup-aside">
            <summary>My card has never been on Wi-Fi</summary>
            <p>
              A card with no network of its own makes one, called <strong>Lightweaver-XXXX</strong>.
              Join that on this device, open <strong>192.168.4.1</strong>, and give it your home
              Wi-Fi. When it reconnects, this screen carries on by itself.
            </p>
          </details>
        </div>
      );
    }
    if (step.id === 'install') {
      // Everything the card needs is already in the project by this point: the
      // port the strip is on, how many lights are on it, and the colour order.
      // prepareCardDeployment turns that into the exact document the card
      // stores; pushConfigToCard is the same transport Wire mode's Send uses,
      // so there is one install path in the app, not two.
      const strips = journeyProject.portRoles.filter(entry => entry.role === PORT_ROLE_STRIP && entry.pixelCount > 0);
      const installable = reachable && strips.length > 0 && !install.busy;
      return (
        <div className="lw-setup-detail">
          <button
            type="button"
            className="btn primary"
            disabled={!installable}
            data-testid="setup-step-install-action"
            onClick={runInstall}
          >
            {install.busy ? 'Sending to the card…' : 'Put this setup on the card'}
          </button>
          {install.message && (
            <p className={install.failed ? 'lw-setup-note lw-setup-note-bad' : 'lw-setup-note'} data-testid="setup-install-status">
              {install.message}
            </p>
          )}
          {!install.message && !reachable && <p className="lw-setup-note">Connect your card first.</p>}
          {!install.message && reachable && strips.length === 0 && (
            <p className="lw-setup-note">Finish finding your strips first.</p>
          )}
          {install.needsRedraw && (
            <button
              type="button"
              className="btn"
              data-testid="setup-install-match-drawing"
              onClick={() => {
                resizePlaceholderStrip(install.needsRedraw.pixels);
                setInstall({ busy: false, message: '', failed: false, done: false });
              }}
            >
              Set my drawing to {install.needsRedraw.pixels} lights
            </button>
          )}
          {install.needsTakeOver && (
            <button type="button" className="btn" data-testid="setup-install-takeover" onClick={() => runInstall(true)}>
              Use this card for this piece
            </button>
          )}
          {install.done && (
            <button type="button" className="btn" data-testid="setup-install-open-patterns" onClick={() => go('#screen=pattern')}>
              Open Patterns
            </button>
          )}
        </div>
      );
    }
    if (step.id === 'pin') return renderPin();
    if (step.id === 'colour') return renderColour();
    if (step.id === 'count') return renderCounting();
    return null;
  };

  // Which of the four ports the strip is plugged into. This used to live inside a
  // collapsed "I already know how my strip is wired" panel that also re-asked the
  // colour order and the light count on every one of the three steps.
  const renderPin = () => (
    <div className="lw-setup-detail" data-testid="setup-pin">
      <label className="lw-setup-field">
        <span>Output port</span>
        <select
          className="lw-select"
          data-testid="setup-pin-value"
          value={pinValue}
          onChange={event => setPinDraft(event.target.value)}
        >
          {CARD_HARDWARE_CONTRACT.outputPins.map(pin => (
            <option key={pin} value={String(pin)}>GPIO {pin}</option>
          ))}
        </select>
      </label>
      <button type="button" className="btn primary" data-testid="setup-pin-apply" onClick={applyPin}>
        Use this port
      </button>
      <button type="button" className="link-btn" data-testid="setup-pin-discover" onClick={() => go('#screen=discovery')}>
        I do not know — light each port in turn
      </button>
    </div>
  );

  // Counting the strip. The owner cannot count 41 identical lights by eye, so
  // the strip is painted as a ruler: every 10th green, every 50th blue, every
  // 100th red, everything else warm. Count the greens, then the warm ones after
  // the last green. This is the one place the flow asks the owner to walk to
  // the piece, so it has to work in a single look — no run to walk, no rerun.
  // Adrian's design: show the three colours the card is sending and let the owner
  // drag them into the order they actually see. One look, no colour naming, no
  // rotating through six options, and it cannot be answered ambiguously.
  const showColourProbe = async () => {
    setColourProbe({ busy: true, lit: false, message: 'Painting three colours on your strip…' });
    const host = cardLink?.host || cardHost || getCardHostname();
    const strip = journeyProject.portRoles.find(entry => entry.role === PORT_ROLE_STRIP);
    const pin = Number(strip?.pin);
    const lights = Number(strip?.pixelCount) > 0 ? Number(strip.pixelCount) : COUNTING_CEILING;
    try {
      const roles = [{ pin, role: PORT_ROLE_STRIP, pixelCount: lights, controlKind: '' }];
      await deployConfig(packageForPortRoles(roles).runtimePackage, host,
        message => setColourProbe({ busy: true, lit: false, message }),
        { allowProjectChange: true });
      countingStreamRef.current?.stop?.();
      countingStreamRef.current = createCardFrameStream({ host });
      countingStreamRef.current.start();
      countingStreamRef.current.push(buildColourProbeFrame(lights));
      setColourProbe({ busy: false, lit: true, message: 'Put the three colours in the order you see them on the strip.' });
    } catch (error) {
      setColourProbe({ busy: false, lit: false, message: `Could not paint the strip: ${error?.message || 'the card did not answer'}` });
    }
  };

  const moveSeen = (from, to) => {
    if (to < 0 || to >= seenOrder.length) return;
    setSeenOrder(prev => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const applySeenOrder = () => {
    setOpenStepId('');
    // The card is what painted the strip, so the card's own reported order is the
    // baseline the owner's answer is relative to. The project's value may be a guess.
    const declared = cardState.status?.outputColor?.colorOrder
      || currentProject?.devices?.standaloneController?.led?.colorOrder
      || 'GRB';
    const resolved = colourOrderFromSeenOrder(seenOrder, declared);
    if (!resolved) {
      setColourProbe(prev => ({ ...prev, message: 'Each colour needs to appear once. Try again.' }));
      return;
    }
    countingStreamRef.current?.stop?.();
    countingStreamRef.current = null;
    setColourProbe({ busy: false, lit: false, message: `Colour order set to ${resolved}.` });
    applyWiring(journeyProject.portRoles, resolved);
    setOrderDraft('');
  };

  const renderColour = () => (
    <div className="lw-setup-detail" data-testid="setup-colour">
      <p className="lw-setup-note">
        {colourProbe.message || 'Your strip will show three blocks of colour. Put them in the order you actually see.'}
      </p>
      <label className="lw-setup-field">
        <span>Colour order</span>
        <select
          className="lw-select"
          data-testid="setup-colour-value"
          value={orderValue}
          onChange={event => setOrderDraft(event.target.value)}
        >
          <option value="">Not set yet</option>
          {COLOR_ORDERS.map(order => (
            <option key={order} value={order}>{order}</option>
          ))}
        </select>
      </label>
      <button type="button" className="btn primary" data-testid="setup-colour-set" onClick={applyOrder}>
        Use this order
      </button>
      <button
        type="button"
        className="btn"
        data-testid="setup-colour-show"
        disabled={!reachable || colourProbe.busy}
        onClick={showColourProbe}
      >
        {colourProbe.busy ? 'Painting the strip…' : 'I do not know — show me three colours on the strip'}
      </button>
      {colourProbe.lit && (
        <>
          <ol className="lw-setup-chips" data-testid="setup-colour-chips">
            {seenOrder.map((id, index) => (
              <li
                key={id}
                className={`lw-setup-chip is-${id}`}
                data-testid={`setup-colour-chip-${id}`}
                draggable
                onDragStart={event => event.dataTransfer.setData('text/plain', String(index))}
                onDragOver={event => event.preventDefault()}
                onDrop={event => {
                  event.preventDefault();
                  moveSeen(Number(event.dataTransfer.getData('text/plain')), index);
                }}
              >
                <button type="button" className="link-btn" aria-label={`Move ${id} earlier`} data-testid={`setup-colour-${id}-earlier`} onClick={() => moveSeen(index, index - 1)}>‹</button>
                <span className="lw-setup-chip-label">{id}</span>
                <button type="button" className="link-btn" aria-label={`Move ${id} later`} data-testid={`setup-colour-${id}-later`} onClick={() => moveSeen(index, index + 1)}>›</button>
              </li>
            ))}
          </ol>
          <button type="button" className="btn primary" data-testid="setup-colour-apply" onClick={applySeenOrder}>
            That is what I see
          </button>
        </>
      )}
    </div>
  );

  // The count field is always here. It used to appear only after the ruler had
  // been lit, so an owner who already knew their strip had 41 lights had no way
  // to say so without running a hardware probe first.
  const renderCounting = () => {
    const pin = savedPin;
    return (
      <div className="lw-setup-detail" data-testid="setup-counting">
        <label className="lw-setup-field">
          <span>Number of lights</span>
          <input
            type="number"
            min="1"
            className="lw-input"
            data-testid="setup-count-value"
            value={countValue}
            onChange={event => setCountDraft(event.target.value)}
          />
        </label>
        <button type="button" className="btn primary" data-testid="setup-count-apply" onClick={applyCount}>
          Use this count
        </button>
        <p className="lw-setup-note">
          {counting.message || 'Do not know the number? Light the strip as a ruler and count what you see.'}
        </p>
        <button
          type="button"
          className="btn"
          data-testid="setup-count-show"
          disabled={!reachable || !Number.isFinite(Number(pin)) || counting.busy}
          onClick={() => showCountingRuler(Number(pin))}
        >
          {counting.busy ? 'Lighting the strip…' : 'Light the counting colours'}
        </button>
        {counting.lit && (
          <p className="lw-setup-note" data-testid="setup-count-ruler-lit">
            Every 10th light is green, every 50th blue, every 100th red. Count the greens,
            then the warm ones after the last green, and add them up.
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="screen card-workspace-screen">
      <div className="card-workspace">
        <div className="card-workspace-body lw-setup-body">
          <header className="card-workspace-header">
            <span className="card-workspace-kicker">Get started</span>
            <h1>Set up your Lightweaver</h1>
            <p className="lw-setup-intro">This takes you from unboxing to patterns playing on your strip. Each step tells you exactly what to do next.</p>
          </header>

          <div className="card-status-area" data-testid="setup-card-status" aria-live="polite">
            {resolution.kind === 'bench' && (
              <section className="card-support-panel lw-setup-banner">
                <h2>This card is running the temporary setup</h2>
                <p>The card you connected is holding a temporary Find-my-strips test, not one of your saved projects. Follow the steps below, or install one of your projects to replace it.</p>
              </section>
            )}
            {resolution.kind === 'matches-current' && (
              <section className="card-support-panel lw-setup-banner">
                <h2>This card is running the project you have open</h2>
                <p>The card matches the project open right now. Your wiring is in place, so you can jump straight to your patterns.</p>
                <button type="button" className="btn primary" data-testid="setup-open-patterns" onClick={() => go('#screen=pattern')}>Open Patterns</button>
              </section>
            )}
            {resolution.kind === 'saved-match' && (
              <section className="card-support-panel lw-setup-banner">
                <h2>A saved project matches this card</h2>
                <p>This card is running a project that is saved in Studio. Load it to continue from where you left off.</p>
                <button type="button" className="btn primary" data-testid="setup-load-matched" onClick={() => void loadResolvedProject()}>
                  {resolution.resolved ? `Load this card's project — ${describeResolvedCardProject(resolution.resolved)}` : 'Load this card project'}
                </button>
              </section>
            )}
            {resolution.kind === 'none' && cardState.read && !matchesCurrent && (
              <section className="card-support-panel lw-setup-banner">
                <h2>There is no matching project here</h2>
                <div className="card-overview-actions">
                  <button type="button" className="btn" data-testid="setup-import-project" onClick={() => importRef.current?.click()}>
                    Import a project file
                  </button>
                  <button type="button" className="btn" data-testid="setup-sign-in" onClick={() => go('#screen=card&section=preferences')}>
                    Sign in to the online library
                  </button>
                  <button type="button" className="btn" data-testid="setup-start-from-card" onClick={startFromCard}>
                    Start from what the card knows
                  </button>
                </div>
                <p className="lw-setup-note">The card has saved its wiring. The original project file was not found here — this rebuilds the wiring, not the drawing.</p>
              </section>
            )}
          </div>

          <section className="lw-setup-steps" aria-label="Set up steps">
            <p className="lw-setup-progress" data-testid="setup-progress">
              {(() => {
                const total = requiredSteps.length;
                const done = requiredSteps.filter(step => step.status === 'done').length;
                return done === total
                  ? 'All set up. Change any step below whenever you like.'
                  : `Step ${done + 1} of ${total}`;
              })()}
            </p>
            <ol className="lw-setup-ladder">
              {requiredSteps.map((step, index) => {
                // A step is open when it is the one to do next, or when the owner
                // has reopened it to change an answer. Everything else collapses to
                // a single line, so the screen always has exactly one thing on it.
                const open = step.status === 'current' || openStepId === step.id;
                const canReopen = step.status === 'done';
                return (
                  <li
                    key={step.id}
                    className={`card-support-panel lw-setup-step is-${step.status}${open ? ' is-open' : ''}`}
                    data-status={step.status}
                    data-open={open ? 'true' : 'false'}
                    data-testid={`setup-step-${step.id}`}
                    aria-current={step.status === 'current' ? 'step' : undefined}
                  >
                    <div className="lw-setup-step-head">
                      <span className="lw-setup-marker" aria-hidden="true">
                        {step.status === 'done' ? '✓' : index + 1}
                      </span>
                      <div className="lw-setup-step-text">
                        <strong>{step.title}</strong>
                        <p>{step.detail}</p>
                      </div>
                      {canReopen && (
                        <button
                          type="button"
                          className="link-btn lw-setup-redo"
                          data-testid={`setup-step-${step.id}-change`}
                          onClick={() => setOpenStepId(openStepId === step.id ? '' : step.id)}
                        >
                          {openStepId === step.id ? 'Close' : 'Change'}
                        </button>
                      )}
                    </div>
                    {open && renderStepBody(step)}
                  </li>
                );
              })}
            </ol>

            {optionalSteps.length > 0 && (
              <div className="lw-setup-optional">
                <h2>Any time</h2>
                {optionalSteps.map((step) => {
                  const action = OPTIONAL_ACTIONS[step.id];
                  return (
                    <div key={step.id} className={`card-support-panel lw-setup-step is-${step.status}`} data-status={step.status} data-testid={`setup-step-${step.id}`}>
                      <div className="lw-setup-step-head">
                        <div className="lw-setup-step-text">
                          <strong>{step.title}</strong>
                          <p>{step.detail}</p>
                        </div>
                        {action && (
                          <button
                            type="button"
                            className="btn lw-setup-optional-action"
                            data-testid={`setup-step-${step.id}-action`}
                            onClick={() => (action.save ? onSaveProject?.() : go(action.hash))}
                          >
                            {action.label}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <p className="lw-setup-skip">
            <button type="button" className="link-btn" data-testid="setup-skip" onClick={skipSetup}>
              Skip — take me to Layout
            </button>
          </p>

          <input
            ref={importRef}
            className="lw-setup-import"
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            data-testid="setup-import-input"
            onChange={onImportFile}
          />
        </div>
      </div>
    </div>
  );
}