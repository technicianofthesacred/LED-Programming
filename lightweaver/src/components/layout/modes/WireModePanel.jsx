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
import { WiringAssemblyMap } from '../wire/WiringAssemblyMap.jsx';

const PINS = [16, 17, 18, 21];
const outputName = index => `Output ${String.fromCharCode(65 + index)}`;
const nextRunId = (runs, prefix) => {
  const ids = new Set(runs.map(run => run.id));
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
};

export function WireModePanel({ state, connected }) {
  const {
    strips, selectStrip, selStripId, pxPerMm,
    selectedWireCut, nudgeSelectedWireCut, deleteSelectedWireCut,
  } = state;
  const {
    wiring, updateWiring, compiledWiring,
    projectId, projectName, standaloneController, confirmedCardLook,
  } = useProject();
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [connectionState, setConnectionState] = useState({ mode: 'idle', sourceId: null });
  const [advanced, setAdvanced] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const [autoOutputCount, setAutoOutputCount] = useState('auto');
  const [autoResult, setAutoResult] = useState(null);
  const [proposalIndex, setProposalIndex] = useState(0);
  const [showAssembly, setShowAssembly] = useState(false);
  const connectedCordRef = useRef(null);
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

  const wireTargetAt = (clientX, clientY) => [...document.querySelectorAll('[data-wire-in]')].find(element => {
    const rect = element.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom;
  });

  const startCordPointer = (sourceId, event) => {
    if (wiring.locked) return;
    connectedCordRef.current = null;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    setConnectionState({ mode: 'draggingCord', sourceId });
  };

  const finishCordPointer = (sourceId, event) => {
    const target = wireTargetAt(event.clientX, event.clientY);
    event.currentTarget?.releasePointerCapture?.(event.pointerId);
    if (connectedCordRef.current === sourceId) {
      suppressPortClickRef.current = sourceId;
      setConnectionState({ mode: 'idle', sourceId: null });
    } else if (target?.dataset.wireIn) {
      connectedCordRef.current = sourceId;
      suppressPortClickRef.current = sourceId;
      connectFrom(sourceId, target.dataset.wireIn);
    } else setConnectionState({ mode: 'idle', sourceId: null });
  };

  const startRowPointer = (runId, event) => {
    if (wiring.locked) return;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    const finish = pointerEvent => {
      const target = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
      const targetRowId = target?.closest?.('[data-run-id]')?.dataset.runId;
      const targetOutputId = target?.closest?.('[data-output-id]')?.dataset.outputId;
      if (!targetOutputId || targetRowId === runId) return;
      mutate(draft => {
        const targetOutput = draft.outputs.find(output => output.id === targetOutputId);
        if (!targetOutput) throw new Error('Drop onto an output lane.');
        draft.outputs.forEach(output => { output.runIds = output.runIds.filter(id => id !== runId); });
        const targetIndex = targetRowId ? targetOutput.runIds.indexOf(targetRowId) : -1;
        targetOutput.runIds.splice(targetIndex < 0 ? targetOutput.runIds.length : targetIndex, 0, runId);
      }, { changeKind: 'route' });
    };
    window.addEventListener('pointerup', finish, { once: true });
  };

  const handlePort = (id, port) => {
    if (port === 'out') {
      if (suppressPortClickRef.current === id) {
        suppressPortClickRef.current = null;
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
    const index = draft.outputs.length;
    draft.outputs.push({ id: `out${index + 1}`, name: outputName(index), pin: PINS[index], runIds: [] });
  }, { changeKind: 'output' });

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
      outputCount: autoOutputCount,
      physicalScale: Number(pxPerMm) > 0 ? { pxPerMm: Number(pxPerMm) } : null,
      capabilities: CARD_HARDWARE_CAPABILITIES,
    });
    setAutoResult(result);
    setProposalIndex(0);
    if (!result.ok) setMutationError(result.errors.map(item => item.message).join(' '));
    else setMutationError('');
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
    if (result.ok) { setAutoResult(null); setProposalIndex(0); }
  };

  const selectedRun = runsById.get(effectiveSelectedRunId);
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

  return (
    <div className="lw-wire-path is-embedded la-wire-panel" data-testid="layout-wire-panel">
      <div className="lw-wiring-toolbar">
        <strong>Physical outputs</strong>
        <button className="btn" disabled={wiring.locked || wiring.outputs.length >= 4} onClick={addOutput}>Add output</button>
        <button className="btn" aria-label="Advanced wiring settings" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>Advanced</button>
      </div>
      <p className="lw-wire-scaffold">Connect each physical run from an output’s OUT port to a run’s IN port. Cable jumps use no LED addresses.</p>
      <section className="lw-auto-wire-controls" aria-label="Auto Wire controls">
        <div>
          <strong>Auto Wire</strong>
          <span>{wiring.controllerAnchor ? `Controller at ${Math.round(wiring.controllerAnchor.x)}, ${Math.round(wiring.controllerAnchor.y)}` : 'Drag CARD on the artwork to place the controller.'}</span>
        </div>
        <label>Outputs
          <select aria-label="Auto Wire output count" value={autoOutputCount} disabled={wiring.locked} onChange={event => setAutoOutputCount(event.target.value === 'auto' ? 'auto' : Number(event.target.value))}>
            <option value="auto">Automatic</option>
            {[1, 2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <button className="btn primary" disabled={wiring.locked || !wiring.controllerAnchor} onClick={runAutoWire}>Auto Wire</button>
      </section>
      {activeProposal && (
        <section className="lw-auto-wire-preview" data-testid="auto-wire-preview">
          <div className="lw-wire-section-title"><span>Routing preview</span><strong>{activeProposal.wiring.outputs.length} output{activeProposal.wiring.outputs.length === 1 ? '' : 's'}</strong></div>
          {activeProposal.wiring.outputs.map((output, index) => (
            <div key={output.id} className="lw-auto-wire-lane" data-testid="auto-wire-lane" data-run-order={output.runIds.join(',')}>
              <strong>{outputName(index)}</strong>
              <span>{activeProposal.outputTotals[index]} px</span>
              <code>{output.runIds.join(' → ')}</code>
            </div>
          ))}
          <p>{activeProposal.jumpers.length} jumpers · {activeProposal.totalJumperLength.toFixed(1)} {activeProposal.unit === 'mm' ? 'mm' : 'relative units'} total · longest {activeProposal.worstJumperLength.toFixed(1)}</p>
          <p>{activeProposal.directionChanges.length ? `${activeProposal.directionChanges.length} physical DATA IN reversal${activeProposal.directionChanges.length === 1 ? '' : 's'}` : 'No physical DATA IN reversals'} · {activeProposal.seamChanges.length ? `${activeProposal.seamChanges.length} seam move${activeProposal.seamChanges.length === 1 ? '' : 's'}` : 'No seam moves'}</p>
          <p>Assumptions: {autoResult.assumptions.length ? autoResult.assumptions.map(item => item.message).join(' ') : 'physical scale and hardware limits are known.'}</p>
          {activeProposal.search?.warning && <p className="lw-wiring-warning">{activeProposal.search.warning}</p>}
          <div className="lw-wire-tool-row">
            {proposals.length > 1 && <button className="btn" onClick={() => setProposalIndex(index => (index + 1) % proposals.length)}>Try alternative</button>}
            <button className="btn primary" onClick={acceptAutoWire}>Accept routing</button>
            <button className="btn" onClick={() => { setAutoResult(null); setProposalIndex(0); }}>Cancel Auto Wire</button>
          </div>
        </section>
      )}
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
            onMove={moveRun}
            onRemove={removeRun}
            onReverse={reverseRun}
          />
        ))}
      </div>
      <div className="lw-wiring-additions">
        <button className="btn" disabled={wiring.locked} aria-label="Add reserved-unlit LEDs" onClick={addInactive}>+ Reserved · unlit</button>
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
        <details className="lw-wiring-range">
          <summary>Edit LED range</summary>
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
        </details>
      )}
      <WiringPreflight
        compiled={compiledWiring}
        locked={wiring.locked}
        canLock={compiledWiring.ok && wiring.verified && wiring.runs.every(run => run.verified)}
        onToggleLock={toggleLock}
        mutationError={mutationError}
      />
      <WiringBenchTest
        wiring={wiring}
        compiled={compiledWiring}
        updateWiring={updateWiring}
        priorConfirmedLook={confirmedCardLook}
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
            standaloneController={standaloneController}
            disabled={!compiledWiring.sendReady}
          >
            <button className="btn la-export-ledmap" data-testid="layout-export-ledmap" onClick={exportLedmap}>Export ledmap.json</button>
          </CardPushControl>
      </section>
    </div>
  );
}
