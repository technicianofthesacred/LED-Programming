import { useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../../../state/ProjectContext.jsx';
import { download, toWLEDLedmap } from '../../../lib/export.js';
import { normalizePatchBoard } from '../../../lib/patchBoard.js';
import { proposeAutoWiring } from '../../../lib/autoWire.js';
import { CARD_HARDWARE_CAPABILITIES } from '../../../lib/cardRuntimeContract.js';
import { CardPushControl } from '../shared/CardPushControl.jsx';
import { WiringOutputLane } from '../wire/WiringOutputLane.jsx';
import { WiringPreflight } from '../wire/WiringPreflight.jsx';
import { WiringBenchTest } from '../wire/WiringBenchTest.jsx';
import { StripColorOrderCheck } from '../wire/StripColorOrderCheck.jsx';
import { WiringAssemblyMap } from '../wire/WiringAssemblyMap.jsx';
import { WireDiscovery } from '../wire/WireDiscovery.jsx';
import { planAdjacentStripBoundary, planOutputPixelCountAdjustment, planStripPixelCountAdjustment } from '../../../lib/wiringChase.js';
import { activeBoardGpios, BOARD_CONTROL_FIELDS, planBoardGpioAssignment } from '../../../lib/gpioAssignments.js';
import { parsedVb } from '../../../lib/layoutGeometry.js';
import { normalizeUsbLedColorOrder } from '../../../lib/usbLedColorOrder.js';
import { estimatePowerBudget } from '../../../lib/controllerProfiles.js';
import { readPowerSupplySettings } from '../../../lib/powerSupplySettings.js';
import { StatTile, StatTileRow } from '../../ui/StatTile.jsx';
import { StepRail } from '../../ui/StepRail.jsx';
import { UiCard } from '../../ui/UiCard.jsx';
import { WiringMiniDiagram } from '../wire/WiringMiniDiagram.jsx';
import '../../../styles/lw-wire.css';

const PINS = [16, 17, 18, 21];
const outputName = index => `Output ${String.fromCharCode(65 + index)}`;
const nextRunId = (runs, prefix) => {
  const ids = new Set(runs.map(run => run.id));
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
};

function previewRunName(run, stripsById) {
  if (!run) return 'Unknown strip';
  if (run.type === 'cable') return 'Cable jump';
  if (run.type === 'inactive') return 'Skipped pixels';
  return stripsById.get(run.source?.stripId)?.name || 'Unnamed strip';
}

function changeSummary(proposal) {
  const directionCount = proposal.directionChanges.length;
  const connectorCount = proposal.seamChanges.length;
  if (!directionCount && !connectorCount) return 'Keeps the current strip directions and connector positions.';
  const changes = [];
  if (directionCount) changes.push(`${directionCount} strip direction${directionCount === 1 ? '' : 's'}`);
  if (connectorCount) changes.push(`${connectorCount} connector position${connectorCount === 1 ? '' : 's'}`);
  return `Changes ${changes.join(' and ')}.`;
}

const RAIL_STEPS = [
  { id: 1, label: 'Wires' },
  { id: 2, label: 'Match' },
  { id: 3, label: 'Route' },
  { id: 4, label: 'Check' },
  { id: 5, label: 'Install' },
];
const RAIL_STATE = { complete: 'done', current: 'current', blocked: 'todo', optional: 'optional' };
const STEP_TITLES = {
  1: 'How many wires leave the card?',
  2: 'Match wires to strips',
  3: 'Let Lightweaver route the wires for you',
  4: 'Light them up and check',
  5: 'Lock it in',
};
const STEP_DESCRIPTIONS = {
  1: 'Count the signal wires running from the card to the LED strips. Most pieces use one.',
  2: 'Put each strip on the wire that feeds it, in the order the data flows.',
  3: 'Optional. Preview a suggested route before checking the real LEDs — nothing changes until you apply it.',
  4: 'A short guided check on the real LEDs. The card lights them up and you confirm what you see.',
  5: 'Review the wiring, lock it, then install it on the card.',
};
const WIRE_CHOICE_CAPTIONS = {
  1: 'One continuous run',
  2: 'Two shorter runs',
  3: 'Three shorter runs',
  4: 'Four shorter runs',
};

function WireCountGlyph({ count }) {
  const wireYs = { 1: [16], 2: [11, 21], 3: [8, 16, 24], 4: [6, 13, 19, 26] }[count] || [16];
  return (
    <svg className="lww-choice-glyph" width="64" height="32" viewBox="0 0 64 32" aria-hidden="true">
      <rect x="2" y="9" width="18" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {wireYs.map(y => (
        <path key={y} d={`M20 16 C 34 16 40 ${y} 60 ${y}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ))}
    </svg>
  );
}

export function WireModePanel({ state, connected, cardHost }) {
  const {
    strips, selectStrip, selStripId, pxPerMm, viewBox,
    selectedWireCut, nudgeSelectedWireCut, deleteSelectedWireCut, setStripCounts,
  } = state;
  const {
    wiring, updateWiring, compiledWiring, patchBoard, setPatchBoard,
    projectId, projectName, standaloneController, setStandaloneController, confirmedCardLook,
  } = useProject();
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [connectionState, setConnectionState] = useState({ mode: 'idle', sourceId: null });
  const [advanced, setAdvanced] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const [autoResult, setAutoResult] = useState(null);
  const [proposalIndex, setProposalIndex] = useState(0);
  const [routeDetailsOpen, setRouteDetailsOpen] = useState(false);
  const [showAssembly, setShowAssembly] = useState(false);
  const [rowDrag, setRowDrag] = useState(null);
  const [outputDrag, setOutputDrag] = useState(null);
  const [pinError, setPinError] = useState('');
  const [selectedStep, setSelectedStep] = useState(null);
  // True while the guided LED check has a question on screen — the color quiz
  // hides then so step 4 keeps one question per screen (redesign change 9).
  const [benchCheckActive, setBenchCheckActive] = useState(false);
  const autoExpandedStepRef = useRef(null);
  const connectedCordRef = useRef(null);
  const cordPointerRef = useRef(null);
  const suppressPortClickRef = useRef(null);
  const stripsById = useMemo(() => new Map(strips.map(strip => [strip.id, strip])), [strips]);
  const runsById = useMemo(() => new Map(wiring.runs.map(run => [run.id, run])), [wiring.runs]);
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
  const selectedFromCanvas = wiring.runs.find(item => item.type === 'strip' && item.source.stripId === selStripId)?.id;
  const effectiveSelectedRunId = selectedFromCanvas || selectedRunId;
  useEffect(() => {
    const run = wiring.runs.find(item => item.type === 'strip' && item.source.stripId === selStripId);
    if (run) setSelectedRunId(run.id);
  }, [selStripId, wiring.runs]);
  useEffect(() => {
    if (wiring.locked) return;
    const stripIds = new Set(strips.map(strip => strip.id));
    const stale = wiring.runs.some(run => run.type === 'strip' && !stripIds.has(run.source.stripId));
    const covered = new Set(wiring.runs.filter(run => run.type === 'strip' && stripIds.has(run.source.stripId)).map(run => run.source.stripId));
    const missing = strips.filter(strip => !covered.has(strip.id));
    if (!stale && !missing.length) return;
    updateWiring(draft => {
      const staleIds = new Set(draft.runs.filter(run => run.type === 'strip' && !stripIds.has(run.source.stripId)).map(run => run.id));
      draft.runs = draft.runs.filter(run => !staleIds.has(run.id));
      draft.outputs.forEach(output => { output.runIds = output.runIds.filter(id => !staleIds.has(id)); });
      for (const strip of missing) {
        const id = nextRunId(draft.runs, `run-${strip.id}`);
        draft.runs.push({
          id, type: 'strip', source: { stripId: strip.id, from: 0, to: Math.max(0, strip.pixelCount - 1) },
          directionPolicy: 'flexible', physicalDirection: 'source-forward', seamLed: null, verified: false,
        });
        draft.outputs[0].runIds.push(id);
      }
    }, { changeKind: 'geometry' });
  }, [strips, updateWiring, wiring]);

  const mutate = (callback, options = {}) => {
    const result = updateWiring(callback, options);
    if (!result.ok) setMutationError(result.errors?.[0]?.message || 'Wiring change rejected.');
    else setMutationError('');
    return result;
  };

  const selectRun = run => {
    setSelectedRunId(run.id);
    if (run.type === 'strip') selectStrip(run.source.stripId);
  };

  const moveRun = (outputId, runId, delta) => mutate(draft => {
    const output = draft.outputs.find(item => item.id === outputId);
    const index = output?.runIds.indexOf(runId) ?? -1;
    if (!output || index < 0) return;
    const next = Math.max(0, Math.min(output.runIds.length - 1, index + delta));
    output.runIds.splice(index, 1);
    output.runIds.splice(next, 0, runId);
  }, { changeKind: 'route' });

  const moveOutput = (outputId, delta) => mutate(draft => {
    const index = draft.outputs.findIndex(output => output.id === outputId);
    if (index < 0) return;
    const next = Math.max(0, Math.min(draft.outputs.length - 1, index + delta));
    const [output] = draft.outputs.splice(index, 1);
    draft.outputs.splice(next, 0, output);
  }, { changeKind: 'output' });

  const startOutputPointer = (outputId, event) => {
    if (wiring.locked) return;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    setOutputDrag({ outputId, targetOutputId: null, placement: null });
    const locate = pointerEvent => {
      const lane = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest?.('[data-output-id]');
      const rect = lane?.getBoundingClientRect?.();
      return {
        targetOutputId: lane?.dataset.outputId,
        placement: rect && pointerEvent.clientY > rect.top + rect.height / 2 ? 'after' : 'before',
      };
    };
    const move = pointerEvent => setOutputDrag({ outputId, ...locate(pointerEvent) });
    const finish = pointerEvent => {
      window.removeEventListener('pointermove', move);
      const { targetOutputId, placement } = locate(pointerEvent);
      setOutputDrag(null);
      if (!targetOutputId || targetOutputId === outputId) return;
      mutate(draft => {
        const from = draft.outputs.findIndex(output => output.id === outputId);
        if (from < 0) return;
        const [output] = draft.outputs.splice(from, 1);
        const target = draft.outputs.findIndex(item => item.id === targetOutputId);
        draft.outputs.splice(target < 0 ? draft.outputs.length : target + (placement === 'after' ? 1 : 0), 0, output);
      }, { changeKind: 'output' });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  };

  const connectFrom = (sourceId, targetId) => {
    if (!sourceId || sourceId === targetId) {
      setMutationError(sourceId === targetId ? 'A run cannot connect to itself.' : 'Choose an OUT port first.');
      setConnectionState({ mode: 'idle', sourceId: null });
      return;
    }
    mutate(draft => {
      const targetRun = draft.runs.find(item => item.id === targetId);
      if (!targetRun) throw new Error('The target run no longer exists.');
      const targetOutput = sourceId.startsWith('output:')
        ? draft.outputs.find(item => item.id === sourceId.slice(7))
        : draft.outputs.find(item => item.runIds.includes(sourceId));
      if (!targetOutput) throw new Error('Choose an output or run OUT port first.');
      const sourceRun = sourceId.startsWith('output:') ? null : draft.runs.find(item => item.id === sourceId);
      if (sourceRun?.type === 'cable') throw new Error('Connect from a physical run endpoint, not a cable jump.');
      const orphanCableIds = [];
      draft.outputs.forEach(output => {
        const targetIndex = output.runIds.indexOf(targetId);
        const previousId = targetIndex > 0 ? output.runIds[targetIndex - 1] : null;
        if (previousId && draft.runs.find(run => run.id === previousId)?.type === 'cable') orphanCableIds.push(previousId);
        output.runIds = output.runIds.filter(id => id !== targetId && !orphanCableIds.includes(id));
      });
      if (orphanCableIds.length) draft.runs = draft.runs.filter(run => !orphanCableIds.includes(run.id));
      const sourceIndex = sourceId.startsWith('output:') ? -1 : targetOutput.runIds.indexOf(sourceId);
      if (sourceRun && sourceIndex < 0) throw new Error('The source endpoint no longer exists.');
      if (sourceRun) {
        const cableId = nextRunId(draft.runs, 'cable');
        draft.runs.push({ id: cableId, type: 'cable', verified: false });
        targetOutput.runIds.splice(sourceIndex + 1, 0, cableId, targetId);
      } else {
        targetOutput.runIds.splice(0, 0, targetId);
      }
    }, { changeKind: 'route' });
    setConnectionState({ mode: 'idle', sourceId: null });
  };
  const connect = targetId => connectFrom(connectionState.sourceId, targetId);

  const wireTargetAt = (clientX, clientY) => [...document.querySelectorAll('[data-wire-in]')]
    .map(element => {
      const rect = element.getBoundingClientRect();
      const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
      const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
      const distance = Math.hypot(dx, dy);
      return { element, distance };
    })
    .filter(item => item.distance <= 28)
    .sort((a, b) => a.distance - b.distance)[0]?.element || null;

  const startCordPointer = (sourceId, event) => {
    if (wiring.locked) return;
    connectedCordRef.current = null;
    const sourceElement = event.currentTarget;
    sourceElement?.setPointerCapture?.(event.pointerId);
    setConnectionState({ mode: 'draggingCord', sourceId });
    const finish = pointerEvent => finishCordPointer(sourceId, pointerEvent);
    const move = pointerEvent => {
      const gesture = cordPointerRef.current;
      if (!gesture || gesture.pointerId !== pointerEvent.pointerId) return;
      if (Math.hypot(pointerEvent.clientX - gesture.startX, pointerEvent.clientY - gesture.startY) > 4) {
        gesture.dragged = true;
      }
      const hoveredTarget = wireTargetAt(pointerEvent.clientX, pointerEvent.clientY);
      if (hoveredTarget?.dataset.wireIn) gesture.targetId = hoveredTarget.dataset.wireIn;
    };
    cordPointerRef.current = {
      sourceId, pointerId: event.pointerId, sourceElement, finish, move,
      startX: event.clientX, startY: event.clientY, dragged: false, targetId: null,
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  };

  const finishCordPointer = (sourceId, event) => {
    const gesture = cordPointerRef.current;
    if (!gesture || gesture.sourceId !== sourceId || gesture.pointerId !== event.pointerId) return;
    cordPointerRef.current = null;
    window.removeEventListener('pointermove', gesture.move);
    window.removeEventListener('pointerup', gesture.finish);
    if (gesture.sourceElement?.hasPointerCapture?.(event.pointerId)) {
      gesture.sourceElement.releasePointerCapture(event.pointerId);
    }
    // Chromium suppresses hit-testing outside the captured element while the
    // pointer is captured. Release first, then resolve the real IN port.
    const targetId = gesture.targetId || wireTargetAt(event.clientX, event.clientY)?.dataset.wireIn;
    if (gesture.dragged) suppressPortClickRef.current = sourceId;
    if (connectedCordRef.current === sourceId) {
      suppressPortClickRef.current = sourceId;
      setConnectionState({ mode: 'idle', sourceId: null });
    } else if (targetId) {
      connectedCordRef.current = sourceId;
      suppressPortClickRef.current = sourceId;
      connectFrom(sourceId, targetId);
    } else setConnectionState({ mode: 'idle', sourceId: null });
  };

  const startRowPointer = (runId, event) => {
    if (wiring.locked) return;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    const locateTarget = pointerEvent => {
      const target = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
      const targetRow = target?.closest?.('[data-run-id]');
      const targetRowId = targetRow?.dataset.runId;
      const targetOutputId = target?.closest?.('[data-output-id]')?.dataset.outputId;
      const rect = targetRow?.getBoundingClientRect?.();
      const placement = rect && pointerEvent.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
      return { targetRowId, targetOutputId, placement };
    };
    setRowDrag({ runId, targetOutputId: null, targetRunId: null, placement: null });
    const move = pointerEvent => {
      const { targetRowId, targetOutputId, placement } = locateTarget(pointerEvent);
      setRowDrag({ runId, targetOutputId: targetOutputId || null, targetRunId: targetRowId || null, placement });
    };
    const finish = pointerEvent => {
      window.removeEventListener('pointermove', move);
      const { targetRowId, targetOutputId, placement } = locateTarget(pointerEvent);
      setRowDrag(null);
      if (!targetOutputId || targetRowId === runId) return;
      mutate(draft => {
        const targetOutput = draft.outputs.find(output => output.id === targetOutputId);
        if (!targetOutput) throw new Error('Drop onto an output lane.');
        draft.outputs.forEach(output => { output.runIds = output.runIds.filter(id => id !== runId); });
        const targetIndex = targetRowId ? targetOutput.runIds.indexOf(targetRowId) : -1;
        const insertAt = targetIndex < 0 ? targetOutput.runIds.length : targetIndex + (placement === 'after' ? 1 : 0);
        targetOutput.runIds.splice(insertAt, 0, runId);
      }, { changeKind: 'route' });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  };

  const handlePort = (id, port) => {
    if (port === 'out') {
      if (suppressPortClickRef.current === id || connectedCordRef.current === id) {
        suppressPortClickRef.current = null;
        connectedCordRef.current = null;
        return;
      }
      setConnectionState(current => current.sourceId === id
        ? { mode: 'idle', sourceId: null }
        : { mode: 'sourcePortSelected', sourceId: id });
    } else connect(id);
  };
  const enterCordTarget = targetId => {
    if (connectionState.mode === 'draggingCord' && connectionState.sourceId && !connectedCordRef.current) {
      connectedCordRef.current = connectionState.sourceId;
      connectFrom(connectionState.sourceId, targetId);
    }
  };

  const addInactive = () => mutate(draft => {
    const id = nextRunId(draft.runs, 'reserved');
    draft.runs.push({ id, type: 'inactive', count: 1, verified: false });
    draft.outputs[0].runIds.push(id);
  }, { changeKind: 'route' });

  const removeRun = (outputId, runId) => mutate(draft => {
    const output = draft.outputs.find(item => item.id === outputId);
    if (output) output.runIds = output.runIds.filter(id => id !== runId);
    draft.runs = draft.runs.filter(run => run.id !== runId);
  }, { changeKind: 'route' });

  const reverseRun = runId => mutate(draft => {
    const run = draft.runs.find(item => item.id === runId);
    if (!run || run.type !== 'strip') return;
    if (run.directionPolicy === 'fixed') throw new Error('This run has a fixed physical direction.');
    run.physicalDirection = run.physicalDirection === 'source-reverse' ? 'source-forward' : 'source-reverse';
  }, { changeKind: 'direction', runIds: [runId] });

  const addOutput = () => mutate(draft => {
    if (draft.outputs.length >= 4) throw new Error('The card supports at most four outputs.');
    const ids = new Set(draft.outputs.map(output => output.id));
    let number = 1;
    while (ids.has(`out${number}`)) number += 1;
    const used = new Set(activeBoardGpios(draft.outputs, standaloneController?.controls).map(item => item.pin));
    const pin = CARD_HARDWARE_CAPABILITIES.supportedOutputPins.find(candidate => !used.has(candidate));
    if (pin == null) throw new Error('No unused LED output GPIO is available.');
    draft.outputs.push({ id: `out${number}`, name: `Output ${number}`, pin, runIds: [] });
  }, { changeKind: 'output' });

  const removeOutput = outputId => mutate(draft => {
    const output = draft.outputs.find(item => item.id === outputId);
    if (!output) return;
    if (output.runIds.length) throw new Error('Remove all runs before removing this output.');
    if (draft.outputs.length <= 1) throw new Error('At least one output is required.');
    draft.outputs = draft.outputs.filter(item => item.id !== outputId);
  }, { changeKind: 'output' });

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

  const toggleLock = () => {
    if (wiring.locked) {
      mutate(draft => { draft.locked = false; draft.verified = false; draft.runs.forEach(run => { run.verified = false; }); }, { changeKind: null });
      return;
    }
    if (!compiledWiring.ok || !wiring.verified || wiring.runs.some(run => !run.verified)) {
      setMutationError('Bench verification is required for every run before wiring can be locked.');
      return;
    }
    mutate(draft => { draft.locked = true; }, { changeKind: null });
  };

  const exportLedmap = () => {
    download(toWLEDLedmap(compiledWiring.pixels), 'ledmap.json', 'application/json');
  };

  const availableOutputs = PINS.map((pin, index) => ({ id: `out${index + 1}`, name: outputName(index), pin }));
  const runAutoWire = () => {
    const result = proposeAutoWiring({
      wiring,
      strips,
      controllerAnchor: wiring.controllerAnchor,
      availableOutputs,
      outputCount: wiring.outputs.length,
      physicalScale: Number(pxPerMm) > 0 ? { pxPerMm: Number(pxPerMm) } : null,
      capabilities: CARD_HARDWARE_CAPABILITIES,
    });
    setAutoResult(result);
    setProposalIndex(0);
    setRouteDetailsOpen(false);
    if (!result.ok) setMutationError(result.errors.map(item => item.message).join(' '));
    else setMutationError('');
  };
  const placeCard = () => {
    const box = parsedVb(viewBox);
    mutate(draft => { draft.controllerAnchor = { x: box.x + box.w / 2, y: box.y + box.h / 2 }; }, { changeKind: 'controller-anchor' });
  };
  const proposals = autoResult?.ok ? [autoResult.proposal, ...autoResult.alternatives] : [];
  const activeProposal = proposals[proposalIndex] || null;
  const acceptAutoWire = () => {
    if (!activeProposal) return;
    const accepted = activeProposal.wiring;
    const result = mutate(draft => {
      draft.controllerAnchor = accepted.controllerAnchor;
      draft.outputs = accepted.outputs;
      draft.runs = accepted.runs;
      draft.verified = false;
      draft.locked = false;
    }, { changeKind: 'route' });
    if (result.ok) { setAutoResult(null); setProposalIndex(0); setRouteDetailsOpen(false); }
  };

  const selectedRun = runsById.get(effectiveSelectedRunId);
  const installController = useMemo(() => ({
    ...standaloneController,
    outputs: compiledWiring.outputs.map(output => ({ id: output.id, name: output.name, pin: output.pin, pixels: output.count })),
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

  const adjustRunCount = (runId, delta) => {
    let update;
    try {
      update = planStripPixelCountAdjustment(
        wiring,
        Object.fromEntries(strips.map(strip => [strip.id, strip.pixelCount])),
        { runId, delta },
      );
    } catch (error) {
      setMutationError(error.message);
      return { ok: false, error: error.message };
    }
    return applyStripCountUpdates([update]);
  };

  const changeDataWireCount = value => {
    const count = Math.max(1, Math.min(4, Math.trunc(Number(value) || 1)));
    const result = mutate(draft => {
      if (count === draft.outputs.length) return;
      if (count < draft.outputs.length) {
        const removed = draft.outputs.splice(count);
        const destination = draft.outputs[count - 1];
        destination.runIds.push(...removed.flatMap(output => output.runIds));
      } else {
        const ids = new Set(draft.outputs.map(output => output.id));
        const usedPins = new Set(draft.outputs.map(output => output.pin));
        while (draft.outputs.length < count) {
          let number = draft.outputs.length + 1;
          while (ids.has(`out${number}`)) number += 1;
          const pin = CARD_HARDWARE_CAPABILITIES.supportedOutputPins.find(candidate => !usedPins.has(candidate));
          if (pin == null) throw new Error('No unused LED output GPIO is available.');
          const id = `out${number}`;
          draft.outputs.push({ id, name: outputName(draft.outputs.length), pin, runIds: [] });
          ids.add(id);
          usedPins.add(pin);
        }
      }
    }, { changeKind: 'output' });
    if (result.ok) {
      setPatchBoard(current => ({
        ...current,
        dataWireCount: count,
        dataWireCountNeedsReview: false,
      }));
    }
  };

  const dataWireCountConfirmed = !patchBoard?.dataWireCountNeedsReview;
  const mappingReady = compiledWiring.ok;
  const physicallyVerified = Boolean(wiring.verified && wiring.runs.every(run => run.verified));
  const stripRunCount = wiring.runs.filter(run => run.type === 'strip').length;
  const colorOrder = normalizeUsbLedColorOrder(standaloneController?.led?.colorOrder || 'RGB');
  const colorConfirmed = Boolean(
    standaloneController?.led?.colorOrderConfirmed
    && normalizeUsbLedColorOrder(standaloneController?.led?.confirmedColorOrder || '') === colorOrder
  );
  const commissioningVerified = physicallyVerified && colorConfirmed;
  const stepStates = {
    1: dataWireCountConfirmed ? 'complete' : 'current',
    2: !dataWireCountConfirmed ? 'blocked' : mappingReady ? 'complete' : 'current',
    3: mappingReady ? 'optional' : 'blocked',
    4: !mappingReady ? 'blocked' : commissioningVerified ? 'complete' : 'current',
    5: commissioningVerified ? 'current' : 'blocked',
  };
  useEffect(() => {
    // Same auto-advance semantics as the old accordion auto-expand: the view
    // follows the flow's active step unless the user manually jumped elsewhere.
    const activeStep = !dataWireCountConfirmed ? 1 : !mappingReady ? 2 : !commissioningVerified ? 4 : 5;
    const priorAutomaticStep = autoExpandedStepRef.current;
    autoExpandedStepRef.current = activeStep;
    setSelectedStep(current => (current == null || current === priorAutomaticStep ? activeStep : current));
  }, [dataWireCountConfirmed, mappingReady, commissioningVerified]);
  const currentStep = selectedStep ?? (!dataWireCountConfirmed ? 1 : !mappingReady ? 2 : !commissioningVerified ? 4 : 5);
  const railSteps = RAIL_STEPS.map(step => ({ ...step, state: RAIL_STATE[stepStates[step.id]] || 'todo' }));
  // Same worst-case basis as the Size & Power "Max draw" tile (full white,
  // user-set supply settings) so the two panels never disagree about amps.
  const powerSettings = readPowerSupplySettings(standaloneController);
  const powerEstimate = useMemo(() => estimatePowerBudget({
    led: { length: compiledWiring.totalPixels, maxBrightness: 255 },
    power: powerSettings,
  }), [compiledWiring.totalPixels, powerSettings.psuAmps, powerSettings.milliampsPerPixel]);
  const installBlocker = !dataWireCountConfirmed
    ? { step: 1, text: 'Confirm how many wires leave the card.', action: 'Go to wires' }
    : !mappingReady
      ? { step: 2, text: 'Finish matching wires to strips.', action: 'Go to matching' }
      : !physicallyVerified
        ? { step: 4, text: 'Run the LED check on the real strips.', action: 'Run it now' }
        : !colorConfirmed
          ? { step: 4, text: 'Confirm the colors you see on the real LEDs.', action: 'Check colors' }
          : null;

  return (
    <div className="lw-wire-path is-embedded la-wire-panel" data-testid="layout-wire-panel">
      <section className="lww-intro" aria-label="Wire setup guide">
        <strong>Wire the physical LEDs</strong>
        <p>Match each run to its real data wire, then prove it on the LEDs.</p>
      </section>
      <div className="lww-summary">
        <StatTileRow>
          <StatTile label="Data wires" value={wiring.outputs.length} />
          <StatTile label="Strips" value={stripRunCount} />
          <StatTile label="Pixels" value={compiledWiring.totalPixels} />
          <StatTile label="Max draw" value={powerEstimate.maxAmps.toFixed(1)} unit="A"
                    tone={powerEstimate.status === 'over' ? 'danger' : undefined} />
        </StatTileRow>
        <WiringMiniDiagram wiring={wiring} stripsById={stripsById} />
        <StepRail steps={railSteps} activeId={currentStep} onSelect={setSelectedStep} />
      </div>
      <section
        className="lww-step-region"
        data-testid="commissioning-step"
        data-step-state={stepStates[currentStep]}
        role="region"
        aria-label={STEP_TITLES[currentStep]}
      >
      <UiCard title={STEP_TITLES[currentStep]} description={STEP_DESCRIPTIONS[currentStep]}>
      {currentStep === 1 && <>
        {patchBoard?.dataWireCountNeedsReview && (
          <p className="lww-review-note">This older project needs confirmation. Tap the correct number, even if it is already selected.</p>
        )}
        <div className="lww-choices" role="group" aria-label="How many wires leave the card?">
          {[1, 2, 3, 4].map(count => (
            <button
              key={count}
              type="button"
              className={`lww-choice${wiring.outputs.length === count ? ' is-selected' : ''}`}
              aria-pressed={wiring.outputs.length === count}
              disabled={wiring.locked}
              onClick={() => changeDataWireCount(count)}
            >
              <WireCountGlyph count={count} />
              <span className="lww-choice-title">{count === 1 ? '1 wire' : `${count} wires`}</span>
              <span className="lww-choice-cap">{WIRE_CHOICE_CAPTIONS[count]}</span>
            </button>
          ))}
        </div>
      </>}
      {currentStep === 2 && <>
      <div className="lw-wiring-toolbar">
        <strong>
          {wiring.outputs.length === 1 ? '1 wire' : `${wiring.outputs.length} wires`} feeding{' '}
          {stripRunCount} strip{stripRunCount === 1 ? '' : 's'}
        </strong>
        <WireDiscovery outputs={wiring.outputs} cardHost={cardHost} disabled={wiring.locked} onPinConfirmed={changeOutputPin}/>
        <button className="btn btn-ghost lw-expert-toggle" aria-label="Advanced wiring settings" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>{advanced ? 'Hide advanced settings' : 'Advanced settings'}</button>
      </div>
      <div className="lw-wiring-lanes">
        {wiring.outputs.map((output, outputIndex) => (
          <WiringOutputLane
            key={output.id}
            output={{ ...output, name: outputName(outputIndex) }}
            runs={output.runIds.map(id => runsById.get(id)).filter(Boolean)}
            compiledRuns={compiledWiring.runs}
            stripsById={stripsById}
            selectedRunId={effectiveSelectedRunId}
            connectionState={connectionState}
            advanced={advanced}
            locked={wiring.locked}
            onSelectRun={selectRun}
            onPort={handlePort}
            onCordPointerDown={startCordPointer}
            onCordPointerUp={finishCordPointer}
            onCordTargetEnter={enterCordTarget}
            onRowPointerDown={startRowPointer}
            draggingRunId={rowDrag?.runId}
            dropTargetRunId={rowDrag?.targetRunId}
            dropTarget={rowDrag?.targetOutputId === output.id}
            dropPlacement={rowDrag?.placement}
            onMove={moveRun}
            onRemove={removeRun}
            onReverse={reverseRun}
            onAdjustCount={adjustRunCount}
            supportedPins={CARD_HARDWARE_CAPABILITIES.supportedOutputPins}
            unavailablePins={unavailablePinsFor(`output:${output.id}`)}
            onPinChange={pin => changeOutputPin(output.id, pin)}
            onOutputPointerDown={startOutputPointer}
            onMoveOutput={delta => moveOutput(output.id, delta)}
            onRemoveOutput={() => removeOutput(output.id)}
            outputDragging={outputDrag?.outputId === output.id}
            outputDropPlacement={outputDrag?.targetOutputId === output.id && outputDrag?.outputId !== output.id ? outputDrag.placement : null}
          />
        ))}
      </div>
      <details className="lww-expert">
        <summary>Board pins and expert mapping</summary>
        <div className="lww-expert-body">
        <div className="lw-pin-group">
          <strong>LED outputs</strong>
          {wiring.outputs.map((output, index) => <label key={output.id}>{outputName(index)}
            <select aria-label={`${outputName(index)} board pin`} value={output.pin} disabled={wiring.locked} onChange={event => changeOutputPin(output.id, Number(event.target.value))}>
              {CARD_HARDWARE_CAPABILITIES.supportedOutputPins.map(pin => <option key={pin} value={pin} disabled={pin !== output.pin && unavailablePinsFor(`output:${output.id}`).includes(pin)}>GPIO {pin}</option>)}
            </select>
          </label>)}
        </div>
        <div className="lw-pin-group">
          <strong>Physical controls</strong>
          {BOARD_CONTROL_FIELDS.map(field => <label key={field.key}>{field.label}
            <select aria-label={`${field.label} pin`} value={controlPinValue(field)} disabled={wiring.locked} onChange={event => changeControlPin(field.key, Number(event.target.value))}>
              {field.allowOff && <option value={-1}>Off</option>}
              {Array.from({ length: 49 }, (_, pin) => <option key={pin} value={pin} disabled={pin !== controlPinValue(field) && unavailablePinsFor(`control:${field.key}`).includes(pin)}>GPIO {pin}</option>)}
            </select>
          </label>)}
        </div>
        <div className="lw-pin-input-note"><strong>Inputs</strong><span>Current card firmware has no direct microphone input. Analog or I2S input requires a supported hardware profile; I2S uses multiple pins.</span></div>
        {pinError && <p className="lw-wiring-error">{pinError}</p>}
        <p className="lww-expert-note">Use these only for intentional gaps, splits, or custom source ranges.</p>
        <div className="lw-wiring-additions">
          <button className="btn" disabled={wiring.locked} aria-label="Add skipped pixels" onClick={addInactive}>Add skipped pixels</button>
          <span>Skipped pixels stay dark but keep their addresses.</span>
        </div>
        {derivedCut && (
          <section className="lw-wire-selected-detail">
            <div className="lw-wire-section-title"><span>Selected split</span><strong>LED {derivedCut.cutLed}</strong></div>
            <div className="lw-wire-tool-row">
              <button className="btn" disabled={wiring.locked} aria-label="Move split earlier" onClick={() => nudgeSelectedWireCut(-1, derivedCut)}>−</button>
              <button className="btn" disabled={wiring.locked} aria-label="Move split later" onClick={() => nudgeSelectedWireCut(1, derivedCut)}>+</button>
              <button className="btn" disabled={wiring.locked} aria-label="Merge split runs" onClick={() => deleteSelectedWireCut(derivedCut)}>Merge</button>
              <button className="btn lw-btn-danger" disabled={wiring.locked} aria-label="Delete split" onClick={() => deleteSelectedWireCut(derivedCut)}>Delete</button>
            </div>
          </section>
        )}
        {selectedRun?.type === 'strip' && (
          <div className="lw-wiring-range">
          <strong>Source range</strong>
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
          {(stripsById.get(selectedRun.source.stripId)?.closed || stripsById.get(selectedRun.source.stripId)?.isClosed || selectedRun.seamLed != null) && (
            <label>Connector seam LED
              <input type="number" min={selectedRun.source.from} max={selectedRun.source.to} disabled={wiring.locked || selectedRun.verified || selectedRun.directionPolicy === 'fixed'} value={selectedRun.seamLed ?? selectedRun.source.from} onChange={event => mutate(draft => {
                const run = draft.runs.find(item => item.id === selectedRun.id);
                if (!run || run.verified || run.directionPolicy === 'fixed') throw new Error('Verified or fixed connector seams cannot move.');
                run.seamLed = Math.max(run.source.from, Math.min(run.source.to, Math.trunc(Number(event.target.value))));
              }, { changeKind: 'seam', runIds: [selectedRun.id] })}/>
            </label>
          )}
          </div>
        )}
        </div>
      </details>
      </>}
      {currentStep === 3 && <>
        <p className="lww-auto-note">Uses your {wiring.outputs.length} data wire{wiring.outputs.length === 1 ? '' : 's'}. Applying a route later clears the physical check.</p>
        <button className="btn primary lww-cta" title={wiring.controllerAnchor ? 'Preview a physical routing proposal' : 'Place the card at the artwork center, then drag it where it belongs'} disabled={wiring.locked} onClick={wiring.controllerAnchor ? runAutoWire : placeCard}>{wiring.controllerAnchor ? 'Preview a route' : 'Place the card'}</button>
        {activeProposal && (
          <section className="lw-auto-wire-preview" data-testid="auto-wire-preview" data-proposal-index={proposalIndex}>
            <div className="lw-auto-wire-preview-heading">
              <strong>Proposed route</strong>
              <span>{activeProposal.wiring.outputs.length} output{activeProposal.wiring.outputs.length === 1 ? '' : 's'} · {activeProposal.outputTotals.reduce((sum, count) => sum + count, 0)} pixels</span>
            </div>
            {activeProposal.wiring.outputs.map((output, index) => (
              <div key={output.id} className="lw-auto-wire-lane" data-testid="auto-wire-lane" data-run-order={output.runIds.join(',')}>
                <div className="lw-auto-wire-lane-heading">
                  <strong>{outputName(index)}</strong>
                  <span>{activeProposal.outputTotals[index]} pixels</span>
                </div>
                <div className="lw-auto-wire-order" aria-label={`${outputName(index)} strip order`}>
                  {output.runIds.map((runId, runIndex) => {
                    const run = activeProposal.wiring.runs.find(item => item.id === runId);
                    return <span key={runId}>{runIndex > 0 && <i aria-hidden="true">→</i>}{previewRunName(run, stripsById)}</span>;
                  })}
                </div>
              </div>
            ))}
            <p className="lw-auto-wire-summary">{changeSummary(activeProposal)}</p>
            <div className="lw-auto-wire-details">
              <button className="lw-auto-wire-details-toggle" aria-expanded={routeDetailsOpen} onClick={() => setRouteDetailsOpen(open => !open)}>Route details</button>
              {routeDetailsOpen && <div className="lw-auto-wire-diagnostics">
                <p><strong>Cable length</strong><span>{activeProposal.jumpers.length} connection{activeProposal.jumpers.length === 1 ? '' : 's'} · {activeProposal.totalJumperLength.toFixed(1)} {activeProposal.unit === 'mm' ? 'mm' : 'relative units'} total · longest {activeProposal.worstJumperLength.toFixed(1)}</span></p>
                <p><strong>Direction changes</strong><span>{activeProposal.directionChanges.length ? `${activeProposal.directionChanges.length} strip${activeProposal.directionChanges.length === 1 ? '' : 's'} change direction` : 'None'}</span></p>
                <p><strong>Connector changes</strong><span>{activeProposal.seamChanges.length ? `${activeProposal.seamChanges.length} connector${activeProposal.seamChanges.length === 1 ? '' : 's'} move` : 'None'}</span></p>
                <p><strong>Estimate notes</strong><span>{autoResult.assumptions.length ? autoResult.assumptions.map(item => item.message).join(' ') : 'Physical scale and card limits are known.'}</span></p>
                {activeProposal.search?.warning && <p><strong>Route search</strong><span>Route search reached its limit. A shorter route may still be possible.</span></p>}
              </div>}
            </div>
            <div className="lw-auto-wire-actions">
              <button className="btn btn-ghost lw-auto-wire-close" onClick={() => { setAutoResult(null); setProposalIndex(0); setRouteDetailsOpen(false); }}>Cancel</button>
              {proposals.length > 1 && <button className="btn" onClick={() => { setProposalIndex(index => (index + 1) % proposals.length); setRouteDetailsOpen(false); }}>Try another</button>}
              <button className="btn primary" onClick={acceptAutoWire}>Apply route</button>
            </div>
          </section>
        )}
      </>}
      {currentStep === 4 && <>
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
        onActivityChange={setBenchCheckActive}
        onDefer={() => setSelectedStep(5)}
      />
      {!benchCheckActive && (
        <StripColorOrderCheck
          cardHost={cardHost}
          controller={standaloneController}
          setController={setStandaloneController}
        />
      )}
      </>}
      {currentStep === 5 && <>
      {installBlocker ? (
        <UiCard
          tone="warning"
          title="One thing left before install"
          description={installBlocker.text}
          footer={<button className="btn lww-cta" onClick={() => setSelectedStep(installBlocker.step)}>{installBlocker.action}</button>}
        />
      ) : (
        <p className={`lww-install-ready${compiledWiring.sendReady ? ' is-ready' : ''}`} role="status">
          {compiledWiring.sendReady
            ? 'Everything checks out. Install it on the card.'
            : 'Everything is verified. Lock the wiring below, then install it on the card.'}
        </p>
      )}
      <WiringPreflight
        compiled={compiledWiring}
        locked={wiring.locked}
        canLock={compiledWiring.ok && commissioningVerified}
        onToggleLock={toggleLock}
        mutationError={mutationError}
      />
      {compiledWiring.sendReady && <button className="btn lw-open-assembly" onClick={() => setShowAssembly(value => !value)}>{showAssembly ? 'Hide assembly map' : 'Open assembly map'}</button>}
      {showAssembly && compiledWiring.sendReady && <WiringAssemblyMap wiring={wiring} compiled={compiledWiring} strips={strips} physicalScale={Number(pxPerMm) > 0 ? { pxPerMm: Number(pxPerMm) } : null} onClose={() => setShowAssembly(false)}/>}
      <section className="lw-wire-finish">
          <CardPushControl
            connected={connected}
            board={cardTransportBoard}
            strips={strips}
            projectId={projectId}
            projectName={projectName}
            standaloneController={installController}
            disabled={!compiledWiring.sendReady || !commissioningVerified}
          >
            <button className="btn btn-ghost la-export-ledmap" data-testid="layout-export-ledmap" title="Secondary export for a separate WLED setup — does not change the Lightweaver card" onClick={exportLedmap}>Download WLED map</button>
          </CardPushControl>
      </section>
      </>}
      </UiCard>
      </section>
    </div>
  );
}
