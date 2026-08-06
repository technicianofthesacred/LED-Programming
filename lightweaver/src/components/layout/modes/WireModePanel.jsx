import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getCardLinkState, subscribeCardLink } from '../../../lib/cardLink.js';
import { classifyCardReadiness } from '../../../lib/cardReadiness.js';
import { useProject } from '../../../state/ProjectContext.jsx';
import { normalizePatchBoard } from '../../../lib/patchBoard.js';
import { CARD_HARDWARE_CAPABILITIES } from '../../../lib/cardRuntimeContract.js';
import { CardPushControl } from '../shared/CardPushControl.jsx';
import { WireHoverDescription } from '../shared/WireHoverDescription.jsx';
import { WiringPreflight } from '../wire/WiringPreflight.jsx';
import { WiringBenchTest } from '../wire/WiringBenchTest.jsx';
import { StripColorOrderCheck } from '../wire/StripColorOrderCheck.jsx';
import { WiringAssemblyMap } from '../wire/WiringAssemblyMap.jsx';
import { WireDiscovery } from '../wire/WireDiscovery.jsx';
import { WiringPlanSummary } from '../wire/WiringPlanSummary.jsx';
import { planAdjacentStripBoundary, planOutputPixelCountAdjustment } from '../../../lib/wiringChase.js';
import { activeBoardGpios, BOARD_CONTROL_FIELDS, planBoardGpioAssignment } from '../../../lib/gpioAssignments.js';
import { PORT_ROLE_STRIP } from '../../../lib/portRoles.js';
import { evaluateCardInstallGate, readCardAccessLevel, readCardCommissioningVerification } from '../../../lib/cardInstallGate.js';
import { STRIP_DISCOVERY_BLANK_MESSAGE, STRIP_DISCOVERY_LABEL, STRIP_DISCOVERY_ROUTE, needsStripDiscovery } from '../../../lib/cardAction.js';
import { estimatePowerBudget } from '../../../lib/controllerProfiles.js';
import { readPowerSupplySettings, withPowerSupplySettings } from '../../../lib/powerSupplySettings.js';
import '../../../styles/lw-wire.css';

const nextRunId = (runs, prefix) => {
  const ids = new Set(runs.map(run => run.id));
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
};
const parsePositive = (raw, fallback) => {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export function WireModePanel({ state, connected, cardHost }) {
  const {
    strips, selStripId, pxPerMm,
    selectedWireCut, nudgeSelectedWireCut, deleteSelectedWireCut, setStripCounts,
    wireOverlayMode, setWireOverlayMode,
    setDrawMode, setGhostPt, setMode,
  } = state;
  const {
    wiring, updateWiring, compiledWiring, patchBoard,
    projectId, projectName, standaloneController, setStandaloneController, confirmedCardLook, portRoles,
  } = useProject();
  const [mutationError, setMutationError] = useState('');
  const [showAssembly, setShowAssembly] = useState(false);
  const [pinError, setPinError] = useState('');
  const [selectedCustomRunId, setSelectedCustomRunId] = useState('');
  const [psuAmpsDraft, setPsuAmpsDraft] = useState(() => String(readPowerSupplySettings(standaloneController).psuAmps));
  const [milliampsDraft, setMilliampsDraft] = useState(() => String(readPowerSupplySettings(standaloneController).milliampsPerPixel));
  // True while the guided LED check owns the primary flow area — the bench
  // wizard runs first, then the color quiz presents itself as the next question.
  const [checkFlowOpen, setCheckFlowOpen] = useState(false);
  const stripsById = useMemo(() => new Map(strips.map(strip => [strip.id, strip])), [strips]);
  const runsById = useMemo(() => new Map(wiring.runs.map(run => [run.id, run])), [wiring.runs]);
  // Strips the guided setup learned about from the real card: one entry per
  // measured strip, carrying its true GPIO and light count.
  const discoveredStripEntries = useMemo(() => (Array.isArray(portRoles) ? portRoles : [])
    .filter(entry => entry
      && entry.role === PORT_ROLE_STRIP
      && Number.isInteger(entry.pin)
      && Number.isInteger(entry.pixelCount)
      && entry.pixelCount > 0), [portRoles]);
  // Pair each output with a discovered strip so an owner who ran the guided
  // card setup sees the real strip next to the drawing's plan. A discovered
  // strip already on this output's GPIO wins; otherwise the first unmatched
  // measured strip is the truth this output should be pointing at.
  const discoveredByOutput = useMemo(() => {
    const used = new Set();
    const byOutput = new Map();
    for (const output of wiring.outputs || []) {
      let entry = discoveredStripEntries.find(item => item.pin === output.pin && !used.has(item.pin));
      if (!entry) entry = discoveredStripEntries.find(item => !used.has(item.pin));
      if (entry) { byOutput.set(output.id, entry); used.add(entry.pin); }
    }
    return byOutput;
  }, [wiring.outputs, discoveredStripEntries]);
  // CardPushControl still accepts the legacy transport shape. Build that shape
  // from canonical wiring at the boundary; patchBoard is never read or mutated.
  const cardTransportBoard = useMemo(() => normalizePatchBoard({
    physicalLocked: wiring.locked,
    patches: wiring.runs.filter(run => run.type !== 'cable').map(run => run.type === 'inactive'
      ? { id: run.id, name: 'Reserved · unlit', source: { type: 'off', ledCount: run.count }, output: { mode: 'off' } }
      : {
          id: run.id,
          name: stripsById.get(run.source.stripId)?.name || run.id,
          source: {
            type: 'strip', stripId: run.source.stripId,
            startLed: run.physicalDirection === 'source-reverse' ? run.source.to : run.source.from,
            endLed: run.physicalDirection === 'source-reverse' ? run.source.from : run.source.to,
          },
          output: { mode: 'normal' },
        }),
    chains: wiring.outputs.map(output => ({ id: output.id, name: output.name || output.id, rowIds: output.runIds.filter(id => runsById.get(id)?.type !== 'cable') })),
  }, strips), [wiring, strips, stripsById, runsById]);
  const mutate = (callback, options = {}) => {
    const result = updateWiring(callback, options);
    if (!result.ok) setMutationError(result.errors?.[0]?.message || 'Wiring change rejected.');
    else setMutationError('');
    return result;
  };

  const addInactive = () => mutate(draft => {
    const id = nextRunId(draft.runs, 'reserved');
    draft.runs.push({ id, type: 'inactive', count: 1, verified: false });
    draft.outputs[0].runIds.push(id);
  }, { changeKind: 'route' });

  const changeOutputPin = (outputId, pin) => {
    const plan = planBoardGpioAssignment({
      outputs: wiring.outputs,
      controls: standaloneController?.controls,
      target: { kind: 'output', id: outputId }, pin,
      supportedOutputPins: CARD_HARDWARE_CAPABILITIES.supportedOutputPins,
    });
    if (!plan.ok) { setPinError(plan.error); return plan; }
    setPinError('');
    return mutate(draft => {
      const output = draft.outputs.find(item => item.id === outputId);
      const planned = plan.outputs.find(item => item.id === outputId);
      if (output && planned) output.pin = planned.pin;
    }, { changeKind: 'gpio' });
  };

  const changeControlPin = (key, pin) => {
    const plan = planBoardGpioAssignment({
      outputs: wiring.outputs,
      controls: standaloneController?.controls,
      target: { kind: 'control', key }, pin,
      supportedOutputPins: CARD_HARDWARE_CAPABILITIES.supportedOutputPins,
    });
    if (!plan.ok) { setPinError(plan.error); return; }
    const result = setStandaloneController(previous => ({ ...previous, controls: plan.controls }));
    if (result?.ok === false) setPinError(result.errors?.[0]?.message || 'Pin change rejected.');
    else setPinError('');
  };

  const unlockWiring = () => mutate(draft => {
    draft.locked = false;
    draft.verified = false;
    draft.runs.forEach(run => { run.verified = false; });
  }, { changeKind: null });

  // Canvas overlay tool for the specialist split workflow.
  const toggleSplitTool = () => {
    setDrawMode(false);
    setGhostPt(null);
    setWireOverlayMode(mode => mode === 'chop' ? 'idle' : 'chop');
  };

  const selectedStripRuns = useMemo(
    () => wiring.runs.filter(run => run.type === 'strip' && run.source.stripId === selStripId),
    [wiring.runs, selStripId],
  );
  const selectedRun = selectedStripRuns.find(run => run.id === selectedCustomRunId) || selectedStripRuns[0];
  useEffect(() => {
    setSelectedCustomRunId(current => selectedStripRuns.some(run => run.id === current) ? current : selectedStripRuns[0]?.id || '');
  }, [selectedStripRuns]);
  const selectedRunPlacement = useMemo(() => {
    if (!selectedRun) return null;
    const output = wiring.outputs.find(item => item.runIds.includes(selectedRun.id));
    const index = output?.runIds.indexOf(selectedRun.id) ?? -1;
    if (!output || index < 0) return null;
    const followingRun = output.runIds
      .slice(index + 1)
      .map(id => runsById.get(id))
      .find(run => run && run.type !== 'cable');
    const hasImmediateCable = runsById.get(output.runIds[index + 1])?.type === 'cable';
    return { output, canAddCable: Boolean(followingRun && !hasImmediateCable) };
  }, [selectedRun, wiring.outputs, runsById]);
  const runName = run => run?.type === 'strip'
    ? (stripsById.get(run.source.stripId)?.name || run.source.stripId)
    : run?.type === 'inactive' ? 'Reserved LEDs' : run?.id || 'Unknown run';
  const cableJumps = useMemo(() => wiring.outputs.flatMap(output => output.runIds.flatMap((runId, index) => {
    const run = runsById.get(runId);
    if (run?.type !== 'cable') return [];
    const previousRun = output.runIds.slice(0, index).reverse().map(id => runsById.get(id)).find(item => item && item.type !== 'cable');
    const followingRun = output.runIds.slice(index + 1).map(id => runsById.get(id)).find(item => item && item.type !== 'cable');
    return [{ run, previousRun, followingRun }];
  })), [wiring.outputs, runsById]);
  const addCableJump = () => {
    if (!selectedRunPlacement?.canAddCable) return;
    mutate(draft => {
      const output = draft.outputs.find(item => item.id === selectedRunPlacement.output.id);
      const outputIndex = output?.runIds.indexOf(selectedRun.id) ?? -1;
      if (!output || outputIndex < 0) throw new Error('Select a strip that is followed by another physical run.');
      const followingRun = output.runIds.slice(outputIndex + 1)
        .map(id => draft.runs.find(run => run.id === id))
        .find(run => run && run.type !== 'cable');
      if (!followingRun || draft.runs.find(run => run.id === output.runIds[outputIndex + 1])?.type === 'cable') {
        throw new Error('This strip does not have an available following run.');
      }
      const id = nextRunId(draft.runs, 'cable-jump');
      const cable = { id, type: 'cable', verified: false };
      const runIndex = draft.runs.findIndex(run => run.id === selectedRun.id);
      draft.runs.splice(runIndex + 1, 0, cable);
      output.runIds.splice(outputIndex + 1, 0, id);
    }, { changeKind: 'route' });
  };
  const removeCableJump = runId => mutate(draft => {
    draft.runs = draft.runs.filter(run => run.id !== runId);
    draft.outputs.forEach(output => { output.runIds = output.runIds.filter(id => id !== runId); });
  }, { changeKind: 'route' });
  const installController = useMemo(() => ({
    ...standaloneController,
    outputs: compiledWiring.outputs.map(output => ({
      id: output.id,
      name: output.name,
      pin: output.pin,
      pixels: output.count,
      direction: output.direction,
      segments: output.segments,
    })),
  }), [standaloneController, compiledWiring.outputs]);
  const boardAssignments = activeBoardGpios(wiring.outputs, standaloneController?.controls);
  const unavailablePinsFor = owner => boardAssignments.filter(item => item.owner !== owner).map(item => item.pin);
  const controlPinValue = field => field.path.reduce((value, part) => value?.[part], standaloneController?.controls) ?? -1;
  const derivedCut = selectedWireCut || (() => {
    const cuts = wiring.runs
      .filter(run => run.type === 'strip')
      .map(run => ({ stripId: run.source.stripId, cutLed: run.source.to }))
      .filter(cut => stripsById.get(cut.stripId) && cut.cutLed < stripsById.get(cut.stripId).pixelCount - 1)
      .sort((a, b) => a.cutLed - b.cutLed);
    return cuts[0] || null;
  })();
  const splitStripIds = useMemo(() => {
    const seen = new Set();
    const split = new Set();
    wiring.runs.forEach(run => {
      if (run.type !== 'strip') return;
      if (seen.has(run.source.stripId)) split.add(run.source.stripId);
      else seen.add(run.source.stripId);
    });
    return split;
  }, [wiring.runs]);
  const updateSelectedRange = (field, value) => mutate(draft => {
    const run = draft.runs.find(item => item.id === selectedRun?.id);
    if (run?.type === 'strip') run.source[field] = Math.max(0, Math.trunc(Number(value) || 0));
  }, { changeKind: 'seam', runIds: selectedRun ? [selectedRun.id] : [] });

  const adjustableRunIds = useMemo(() => wiring.outputs.flatMap(output => output.runIds.filter((runId, index) => {
    const run = runsById.get(runId);
    if (run?.type !== 'strip') return false;
    return runsById.get(output.runIds[index + 1])?.type === 'strip' || runsById.get(output.runIds[index - 1])?.type === 'strip';
  })), [wiring.outputs, runsById]);
  const adjustableOutputIds = useMemo(() => wiring.outputs
    .filter(output => output.runIds.some(runId => runsById.get(runId)?.type === 'strip'))
    .map(output => output.id), [wiring.outputs, runsById]);

  const applyStripCountUpdates = updates => {
    const validationStrips = strips.map(strip => {
      const update = updates.find(item => item.stripId === strip.id);
      return update ? { ...strip, pixelCount: update.count } : strip;
    });
    const result = mutate(draft => {
      for (const update of updates) {
        const run = draft.runs.find(item => item.id === update.runId);
        if (!run || run.type !== 'strip') continue;
        run.source.from = 0;
        run.source.to = update.count - 1;
        if (run.seamLed != null && run.seamLed > run.source.to) run.seamLed = run.source.to;
      }
    }, { changeKind: 'seam', runIds: updates.map(item => item.runId), strips: validationStrips });
    if (!result.ok) return result;
    setStripCounts(updates.map(item => ({ id: item.stripId, count: item.count })), { recordHistory: false });
    return result;
  };

  const adjustRunBoundary = (runId, delta) => {
    const output = wiring.outputs.find(item => item.runIds.includes(runId));
    if (!output) return { ok: false, error: 'Run is not assigned to an output.' };
    let updates;
    try {
      updates = planAdjacentStripBoundary(
        wiring,
        Object.fromEntries(strips.map(strip => [strip.id, strip.pixelCount])),
        { outputId: output.id, runId, delta },
      );
    } catch (error) {
      setMutationError(error.message);
      return { ok: false, error: error.message };
    }
    return applyStripCountUpdates(updates);
  };

  const adjustOutputCount = (outputId, delta) => {
    let update;
    try {
      update = planOutputPixelCountAdjustment(
        wiring,
        Object.fromEntries(strips.map(strip => [strip.id, strip.pixelCount])),
        { outputId, delta },
      );
    } catch (error) {
      setMutationError(error.message);
      return { ok: false, error: error.message };
    }
    return applyStripCountUpdates([update]);
  };

  const stripIds = new Set(strips.map(strip => strip.id));
  const mappedStripIds = new Set(wiring.runs.filter(run => run.type === 'strip' && stripIds.has(run.source.stripId)).map(run => run.source.stripId));
  const mappingCoversEveryStrip = mappedStripIds.size === stripIds.size
    && !wiring.runs.some(run => run.type === 'strip' && !stripIds.has(run.source.stripId));
  const mappingReady = compiledWiring.ok && mappingCoversEveryStrip;
  // Shared with the Playlist install gate so the two screens can never
  // disagree about what counts as a commissioned card (src/lib/cardInstallGate.js).
  const commissioning = readCardCommissioningVerification({ wiring, standaloneController });
  const physicallyVerified = commissioning.physicallyVerified;
  const physicalStripCount = mappedStripIds.size;
  const commissioningVerified = commissioning.verified;
  // What the card itself reports it is holding. LayoutScreen passes only
  // `connected`/`cardHost`, so the readiness evidence is read from the shared
  // card link here rather than threaded through a file this panel does not own.
  const cardLink = useSyncExternalStore(subscribeCardLink, getCardLinkState, getCardLinkState);
  const cardReadinessState = cardLink.readiness
    ? classifyCardReadiness(cardLink.readiness, { expectedCard: cardLink.expectedCard }).state
    : (cardLink.cardBlank === true ? 'blank' : '');
  const cardAccess = readCardAccessLevel(
    cardReadinessState === 'blank' ? 'blank' : 'ready',
    cardLink.card,
    cardLink.readiness,
  );
  // This push always sends allowLayoutChange, so it is the wiring-affecting
  // case the gate exists for. It deliberately does not require a live ambient
  // link: pushConfigToCard runs its own discovery and can fall back to the
  // bounded installer handoff for the exact paired card. cardAccess is still
  // stated at its single source, so this screen cannot drift from the ones that
  // do check the link.
  const installGate = evaluateCardInstallGate({
    cardAccess,
    wiringAffecting: true,
    wiringSendReady: compiledWiring.sendReady,
    commissioningVerified,
    requiresLiveLink: false,
  });
  useEffect(() => {
    // Verification auto-locks the wiring. Safe from looping: changeKind null
    // plus an unchanged wiring fingerprint (locked is excluded from it) means
    // locking never invalidates the verification it depends on.
    if (!commissioningVerified || !compiledWiring.ok || wiring.locked) return;
    updateWiring(draft => { draft.locked = true; }, { changeKind: null });
  }, [commissioningVerified, compiledWiring.ok, wiring.locked, updateWiring]);
  // Same worst-case basis as the Size & Power "Max draw" tile (full white,
  // user-set supply settings) so the two panels never disagree about amps.
  const powerSettings = readPowerSupplySettings(standaloneController);
  const powerEstimate = useMemo(() => estimatePowerBudget({
    led: { length: compiledWiring.totalPixels, maxBrightness: 255 },
    power: powerSettings,
  }), [compiledWiring.totalPixels, powerSettings.psuAmps, powerSettings.milliampsPerPixel]);
  // Project hydration can land after mount (autosave/import load): follow the
  // stored settings unless the draft already parses to the same value, so
  // mid-typing edits are never clobbered.
  useEffect(() => {
    setPsuAmpsDraft(current => parsePositive(current, null) === powerSettings.psuAmps ? current : String(powerSettings.psuAmps));
    setMilliampsDraft(current => parsePositive(current, null) === powerSettings.milliampsPerPixel ? current : String(powerSettings.milliampsPerPixel));
  }, [powerSettings.psuAmps, powerSettings.milliampsPerPixel]);
  const psuAmps = parsePositive(psuAmpsDraft, powerSettings.psuAmps);
  const milliampsPerPixel = parsePositive(milliampsDraft, powerSettings.milliampsPerPixel);
  const persistPowerSettings = next => setStandaloneController(previous => withPowerSupplySettings(previous, {
    psuAmps,
    milliampsPerPixel,
    ...next,
  }));
  const stripWord = physicalStripCount === 1 ? 'strip' : 'strips';
  // The LED check below lights real LEDs, which means 'frame' messages, which
  // the bridge refuses while the card reports playbackReady=false. A card with
  // no project always reports exactly that — so offering the check here is
  // offering a button that cannot work, and the install it gates cannot be
  // reached any other way. Send those cards to discovery instead.
  //
  // A bench card is NOT sent there. It is Ready, it lights LEDs, and the whole
  // point of the bench config is to be replaced: this branch owns the install
  // CTA, so routing a bench card back to discovery would close the only exit
  // discovery has and loop the owner between the two screens forever.
  const cardNeedsStripDiscovery = needsStripDiscovery({ readinessState: cardReadinessState });
  const openStripDiscovery = () => { window.location.hash = STRIP_DISCOVERY_ROUTE; };
  const editInWire = () => {
    setDrawMode(false);
    setGhostPt(null);
    setMode('draw');
  };

  return (
    <WireHoverDescription className="lw-wire-path is-embedded la-wire-panel" data-testid="layout-wire-panel">
      <div className="panel-head lww-plan-head">
        <span className="ttl">Test &amp; Install</span>
        <span className="meta">{physicalStripCount} {stripWord} · {compiledWiring.totalPixels} LEDs · from Wire</span>
      </div>
      <WiringPlanSummary wiring={wiring} strips={strips}/>
      {discoveredByOutput.size > 0 && (
        <section className="wire-discovered-list" aria-label="What the setup found on the card">
          {wiring.outputs.map(output => {
            const discovered = discoveredByOutput.get(output.id);
            if (!discovered) return null;
            const drawingCount = compiledWiring.ok
              ? (compiledWiring.outputs.find(item => item.id === output.id)?.count ?? 0)
              : 0;
            const disagrees = output.pin !== discovered.pin || drawingCount !== discovered.pixelCount;
            return (
              <div key={output.id} className="wire-discovered-output">
                <span className="wire-discovered-chip" data-testid={`wire-discovered-${discovered.pin}`}>
                  Found on your card: GPIO {discovered.pin} · {discovered.pixelCount} light{discovered.pixelCount === 1 ? '' : 's'}
                </span>
                {disagrees && (
                  <>
                    <p className="wire-discovered-mismatch" data-testid={`wire-mismatch-${discovered.pin}`}>
                      Your drawing says {drawingCount} lights on GPIO {output.pin}, but your strip has {discovered.pixelCount} lights on GPIO {discovered.pin}.
                    </p>
                    <button
                      type="button"
                      className="btn wire-discovered-adopt"
                      data-testid={`wire-adopt-${discovered.pin}`}
                      title="Point this output at the GPIO the guided setup found on the real card."
                      data-tooltip="Point this output at the GPIO the guided setup found on the real card."
                      onClick={() => changeOutputPin(output.id, discovered.pin)}
                    >Use what was found</button>
                  </>
                )}
              </div>
            );
          })}
        </section>
      )}
      {powerEstimate.status === 'over' && (
        <p className="lww-power-warning" role="alert">
          Needs {powerEstimate.maxAmps.toFixed(1)} A at full white — your supply is {powerSettings.psuAmps} A.
        </p>
      )}

      <section className="lww-flow" data-testid="commissioning-step">
        {cardNeedsStripDiscovery ? (
          <>
            <h3 className="lww-flow-title">Find this card&rsquo;s strips first</h3>
            <p className="lww-flow-message" data-testid="wire-blank-card-message">{STRIP_DISCOVERY_BLANK_MESSAGE}</p>
            <button
              type="button"
              className="btn primary lww-cta"
              data-testid="wire-find-strips"
              title="Open strip discovery, which sets the card up once and then counts each strip with its own LEDs."
              data-tooltip="Open strip discovery, which sets the card up once and then counts each strip with its own LEDs."
              onClick={openStripDiscovery}
            >{STRIP_DISCOVERY_LABEL}</button>
          </>
        ) : patchBoard?.dataWireCountNeedsReview || !mappingReady ? (
          <>
            <h3 className="lww-flow-title">Finish the setup in Wire</h3>
            <p className="lww-flow-message">
              {patchBoard?.dataWireCountNeedsReview
                ? 'This older project needs each strip’s GPIO confirmed before the physical check.'
                : 'Every strip needs a GPIO and a place in the first-to-last wiring order.'}
            </p>
            <WiringPreflight compiled={compiledWiring} mutationError={mutationError} />
            <button type="button" className="btn primary lww-cta" title="Open the Wire workspace to assign GPIOs and arrange the physical LED order." data-tooltip="Open the Wire workspace to assign GPIOs and arrange the physical LED order." onClick={editInWire}>Edit in Wire</button>
          </>
        ) : !commissioningVerified ? (
          wiring.locked ? (
            // Loaded state only — auto-lock never fires before full verification.
            <p className="lww-flow-message">The wiring is locked but not fully checked — use “Unlock to edit” under Advanced, then run the check.</p>
          ) : checkFlowOpen && !physicallyVerified ? (
            <WiringBenchTest
              wiring={wiring}
              compiled={compiledWiring}
              updateWiring={updateWiring}
              priorConfirmedLook={confirmedCardLook}
              cardHost={cardHost}
              strips={strips}
              adjustableRunIds={adjustableRunIds}
              onAdjustBoundary={adjustRunBoundary}
              adjustableOutputIds={adjustableOutputIds}
              onAdjustOutput={adjustOutputCount}
              onDefer={() => setCheckFlowOpen(false)}
            />
          ) : checkFlowOpen ? (
            <>
              <StripColorOrderCheck
                autoStart
                cardHost={cardHost}
                controller={standaloneController}
                setController={setStandaloneController}
              />
              <button type="button" className="btn btn-ghost" title="Leave the color check for now; the LED color order remains unconfirmed." data-tooltip="Leave the color check for now; the LED color order remains unconfirmed." onClick={() => setCheckFlowOpen(false)}>Do this later</button>
            </>
          ) : (
            <>
              {!connected && (
                <p className="lw-card-banner is-inline">
                  This check lights the real LEDs — use <b>Connect Lightweaver</b> in the footer first.
                </p>
              )}
              <button type="button" className="btn primary lww-cta" data-testid="start-led-check" title="Begin or resume the guided check that lights the real LEDs to verify each run." data-tooltip="Begin or resume the guided check that lights the real LEDs to verify each run." onClick={() => setCheckFlowOpen(true)}>
                {physicallyVerified ? 'Finish the LED check' : 'Start LED check'}
              </button>
            </>
          )
        ) : (
          <>
            <p className="lww-install-ready" role="status">Checked ✓ — install it on the card.</p>
            <section className="lw-wire-finish">
              <CardPushControl
                connected={connected}
                board={cardTransportBoard}
                strips={strips}
                projectId={projectId}
                projectName={projectName}
                standaloneController={installController}
                disabled={!installGate.allowed}
              />
            </section>
          </>
        )}
      </section>

      <details className="lww-advanced-tools" data-testid="advanced-installation-tools">
        <summary>Advanced installation tools</summary>
        <div className="lww-advanced-tools-body">
          {wiring.locked && (
            <div className="lww-unlock">
              <span>Wiring locked after the check — unlocking clears the verification.</span>
              <button type="button" className="btn" data-testid="unlock-wiring" title="Reopen wiring edits and clear the completed verification before changing connections." data-tooltip="Reopen wiring edits and clear the completed verification before changing connections." onClick={unlockWiring}>Unlock to edit</button>
            </div>
          )}
          <WireDiscovery outputs={wiring.outputs} cardHost={cardHost} disabled={wiring.locked} onPinConfirmed={changeOutputPin}/>
          {compiledWiring.sendReady && <button className="btn lw-open-assembly" title="Show or hide the assembly map used to build the verified LED wiring." data-tooltip="Show or hide the assembly map used to build the verified LED wiring." onClick={() => setShowAssembly(value => !value)}>{showAssembly ? 'Hide assembly map' : 'Open assembly map'}</button>}
          {showAssembly && compiledWiring.sendReady && <WiringAssemblyMap wiring={wiring} compiled={compiledWiring} strips={strips} physicalScale={Number(pxPerMm) > 0 ? { pxPerMm: Number(pxPerMm) } : null} onClose={() => setShowAssembly(false)}/>}
          {mutationError && <p className="lw-wiring-error" role="alert">{mutationError}</p>}
          <details className="lww-custom-mapping">
            <summary>Custom mapping</summary>
            <div className="lww-specialist-actions">
              <button className="btn" disabled={wiring.locked} aria-pressed={wireOverlayMode === 'chop'} title="Turn on the canvas tool for dividing the selected LED strip at a physical cut point." data-tooltip="Turn on the canvas tool for dividing the selected LED strip at a physical cut point." onClick={toggleSplitTool}>Split a strip mid-wire</button>
              <button
                className="btn"
                disabled={wiring.locked || !selectedRunPlacement?.canAddCable}
                title={selectedRunPlacement?.canAddCable ? 'Insert an unlit cable section after the selected strip without consuming LED addresses.' : 'Select a strip that has another physical run after it.'}
                data-tooltip={selectedRunPlacement?.canAddCable ? 'Insert an unlit cable section after the selected strip without consuming LED addresses.' : 'Select a strip that has another physical run after it.'}
                onClick={addCableJump}
              >Add a cable jump</button>
            </div>
            {cableJumps.length > 0 && (
              <div className="lww-cable-jumps" aria-label="Cable jumps">
                {cableJumps.map(({ run, previousRun, followingRun }) => (
                  <div className="lww-cable-jump-row" data-testid="cable-jump-row" key={run.id}>
                    <span><strong>Cable jump</strong><small>{runName(previousRun)} → {runName(followingRun)}</small></span>
                    <button type="button" className="btn btn-ghost" disabled={wiring.locked} aria-label="Remove cable jump" title="Remove this cable section so the neighboring physical runs connect directly in the plan." data-tooltip="Remove this cable section so the neighboring physical runs connect directly in the plan." onClick={() => removeCableJump(run.id)}>Remove</button>
                  </div>
                ))}
              </div>
            )}
            <div className="lw-wiring-additions">
              <button className="btn" disabled={wiring.locked} aria-label="Add skipped LEDs" title="Reserve an unlit LED position in the output order for LEDs that are intentionally skipped." data-tooltip="Reserve an unlit LED position in the output order for LEDs that are intentionally skipped." onClick={addInactive}>Add skipped LEDs</button>
            </div>
            {derivedCut && (
              <section className="lw-wire-selected-detail">
                <div className="lw-wire-section-title"><span>Selected split</span><strong>LED {derivedCut.cutLed}</strong></div>
                <div className="lw-wire-tool-row">
                  <button className="btn" disabled={wiring.locked} aria-label="Move split earlier" title="Move this split one LED toward the start of the strip." data-tooltip="Move this split one LED toward the start of the strip." onClick={() => nudgeSelectedWireCut(-1, derivedCut)}>−</button>
                  <button className="btn" disabled={wiring.locked} aria-label="Move split later" title="Move this split one LED toward the end of the strip." data-tooltip="Move this split one LED toward the end of the strip." onClick={() => nudgeSelectedWireCut(1, derivedCut)}>+</button>
                  <button className="btn" disabled={wiring.locked} aria-label="Merge split runs" title="Rejoin the split sections into one continuous LED run." data-tooltip="Rejoin the split sections into one continuous LED run." onClick={() => deleteSelectedWireCut(derivedCut)}>Merge</button>
                  <button className="btn lw-btn-danger" disabled={wiring.locked} aria-label="Delete split" title="Remove this split and merge its LED sections back together." data-tooltip="Remove this split and merge its LED sections back together." onClick={() => deleteSelectedWireCut(derivedCut)}>Delete</button>
                </div>
              </section>
            )}
            {selectedRun?.type === 'strip' && splitStripIds.has(selectedRun.source.stripId) && (
              <div className="lw-wiring-range">
              <strong>Custom source range</strong>
              <label>Physical run
                <select aria-label="Physical run" value={selectedRun.id} onChange={event => setSelectedCustomRunId(event.target.value)}>
                  {selectedStripRuns.map(run => <option key={run.id} value={run.id}>LEDs {run.source.from}–{run.source.to}</option>)}
                </select>
              </label>
              <label>Start LED <input type="number" min="0" disabled={wiring.locked} value={selectedRun.source.from} onChange={event => updateSelectedRange('from', event.target.value)}/></label>
              <label>End LED <input type="number" min="0" disabled={wiring.locked} value={selectedRun.source.to} onChange={event => updateSelectedRange('to', event.target.value)}/></label>
              <label>Direction policy
                <select disabled={wiring.locked} value={selectedRun.directionPolicy} onChange={event => mutate(draft => {
                  const run = draft.runs.find(item => item.id === selectedRun.id);
                  if (run?.type === 'strip') run.directionPolicy = event.target.value;
                }, { changeKind: 'direction', runIds: [selectedRun.id] })}>
                  <option value="flexible">Flexible</option>
                  <option value="fixed">Fixed</option>
                </select>
              </label>
              <label>Physical DATA IN
                <select disabled={wiring.locked || selectedRun.directionPolicy === 'fixed'} value={selectedRun.physicalDirection} onChange={event => mutate(draft => {
                  const run = draft.runs.find(item => item.id === selectedRun.id);
                  if (run?.type === 'strip') run.physicalDirection = event.target.value;
                }, { changeKind: 'direction', runIds: [selectedRun.id] })}>
                  <option value="source-forward">Start LED</option>
                  <option value="source-reverse">End LED</option>
                </select>
              </label>
              <label>Connector seam LED
                <input type="number" min={selectedRun.source.from} max={selectedRun.source.to}
                       disabled={wiring.locked || selectedRun.verified || selectedRun.directionPolicy === 'fixed'}
                       value={selectedRun.seamLed ?? selectedRun.source.from}
                       onChange={event => mutate(draft => {
                         const run = draft.runs.find(item => item.id === selectedRun.id);
                         if (!run || run.verified || run.directionPolicy === 'fixed') throw new Error('Verified or fixed connector seams cannot move.');
                         run.seamLed = Math.max(run.source.from, Math.min(run.source.to, Math.trunc(Number(event.target.value))));
                       }, { changeKind: 'seam', runIds: [selectedRun.id] })}/>
              </label>
              </div>
            )}
          </details>
          <details className="lww-card-hardware" data-testid="wire-power-section">
            <summary>Card hardware</summary>
            <div className="lw-pin-group">
              <strong>Physical controls</strong>
              {BOARD_CONTROL_FIELDS.map(field => <label key={field.key}>{field.label}
                <select aria-label={`${field.label} pin`} value={controlPinValue(field)} disabled={wiring.locked} onChange={event => changeControlPin(field.key, Number(event.target.value))}>
                  {field.allowOff && <option value={-1}>Off</option>}
                  {Array.from({ length: 49 }, (_, pin) => <option key={pin} value={pin} disabled={pin !== controlPinValue(field) && unavailablePinsFor(`control:${field.key}`).includes(pin)}>GPIO {pin}</option>)}
                </select>
              </label>)}
            </div>
            <div className="lww-power-fields">
              <label>Power supply amps
                <input type="number" min="0.5" step="0.5" inputMode="decimal"
                       value={psuAmpsDraft} aria-label="Power supply amps"
                       onFocus={event => event.target.select()}
                       onChange={event => {
                         setPsuAmpsDraft(event.target.value);
                         const value = Number.parseFloat(event.target.value);
                         if (Number.isFinite(value) && value > 0) persistPowerSettings({ psuAmps: value });
                       }}
                       onBlur={() => setPsuAmpsDraft(String(psuAmps))}/>
              </label>
              <label>Milliamps per LED
                <input type="number" min="1" step="1" inputMode="numeric"
                       value={milliampsDraft} aria-label="Milliamps per LED"
                       onFocus={event => event.target.select()}
                       onChange={event => {
                         setMilliampsDraft(event.target.value);
                         const value = Number.parseFloat(event.target.value);
                         if (Number.isFinite(value) && value > 0) persistPowerSettings({ milliampsPerPixel: value });
                       }}
                       onBlur={() => setMilliampsDraft(String(milliampsPerPixel))}/>
              </label>
            </div>
            <p className={`lww-power-headroom${powerEstimate.status === 'over' ? ' is-over' : ''}`}>
              {powerEstimate.status === 'over'
                ? `Over by ${Math.abs(powerEstimate.headroomAmps).toFixed(1)} A`
                : `Headroom ${powerEstimate.headroomAmps.toFixed(1)} A`}
            </p>
            {pinError && <p className="lw-wiring-error">{pinError}</p>}
          </details>
        </div>
      </details>
    </WireHoverDescription>
  );
}
