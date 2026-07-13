import { useEffect, useMemo, useState } from 'react';
import { useProject } from '../../../state/ProjectContext.jsx';
import { download } from '../../../lib/export.js';
import { normalizePatchBoard } from '../../../lib/patchBoard.js';
import { CardPushControl } from '../shared/CardPushControl.jsx';
import { WiringOutputLane } from '../wire/WiringOutputLane.jsx';
import { WiringPreflight } from '../wire/WiringPreflight.jsx';

const PINS = [16, 17, 18, 21];

export function WireModePanel({ state, connected }) {
  const { strips, selectStrip, selStripId } = state;
  const {
    wiring, updateWiring, compiledWiring,
    projectId, projectName, standaloneController,
  } = useProject();
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [connectionState, setConnectionState] = useState({ mode: 'idle', sourceId: null });
  const [advanced, setAdvanced] = useState(false);
  const [mutationError, setMutationError] = useState('');
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
    if (!sourceId || sourceId === targetId) { setConnectionState({ mode: 'idle', sourceId: null }); return; }
    mutate(draft => {
      const targetOutput = sourceId.startsWith('output:')
        ? draft.outputs.find(item => item.id === sourceId.slice(7))
        : draft.outputs.find(item => item.runIds.includes(sourceId));
      if (!targetOutput) throw new Error('Choose an output or run OUT port first.');
      draft.outputs.forEach(output => { output.runIds = output.runIds.filter(id => id !== targetId); });
      const sourceIndex = sourceId.startsWith('output:') ? -1 : targetOutput.runIds.indexOf(sourceId);
      targetOutput.runIds.splice(sourceIndex + 1, 0, targetId);
    }, { changeKind: 'route' });
    setConnectionState({ mode: 'idle', sourceId: null });
  };
  const connect = targetId => connectFrom(connectionState.sourceId, targetId);

  const startCordPointer = (sourceId, event) => {
    if (wiring.locked) return;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    setConnectionState({ mode: 'draggingCord', sourceId });
    const finish = pointerEvent => {
      window.removeEventListener('pointerup', finish);
      const target = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest?.('[data-wire-in]');
      if (target?.dataset.wireIn) connectFrom(sourceId, target.dataset.wireIn);
      else setConnectionState({ mode: 'idle', sourceId: null });
    };
    window.addEventListener('pointerup', finish, { once: true });
  };

  const handlePort = (id, port) => {
    if (port === 'out') {
      setConnectionState(current => current.sourceId === id
        ? { mode: 'idle', sourceId: null }
        : { mode: 'sourcePortSelected', sourceId: id });
    } else connect(id);
  };

  const addInactive = () => mutate(draft => {
    const id = `reserved-${Date.now()}`;
    draft.runs.push({ id, type: 'inactive', count: 1, verified: false });
    draft.outputs[0].runIds.push(id);
  }, { changeKind: 'route' });

  const addCable = () => mutate(draft => {
    const id = `cable-${Date.now()}`;
    draft.runs.push({ id, type: 'cable', verified: false });
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
    draft.outputs.push({ id: `out${index + 1}`, name: `Output ${index + 1}`, pin: PINS[index], runIds: [] });
  }, { changeKind: 'output' });

  const toggleLock = () => {
    if (wiring.locked) {
      mutate(draft => { draft.locked = false; draft.verified = false; draft.runs.forEach(run => { run.verified = false; }); }, { changeKind: null });
      return;
    }
    if (!compiledWiring.ok) { setMutationError('Resolve compiler errors before locking wiring.'); return; }
    mutate(draft => { draft.locked = true; draft.verified = true; draft.runs.forEach(run => { run.verified = true; }); }, { changeKind: null });
  };

  const exportLedmap = () => {
    const map = compiledWiring.pixels.map(pixel => pixel.inactive ? [-1, -1] : [pixel.x, pixel.y]);
    download(JSON.stringify({ n: map.length, map }, null, 2), 'ledmap.json', 'application/json');
  };

  const selectedRun = runsById.get(effectiveSelectedRunId);
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
      <div className="lw-wiring-lanes">
        {wiring.outputs.map(output => (
          <WiringOutputLane
            key={output.id}
            output={output}
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
            onMove={moveRun}
            onRemove={removeRun}
            onReverse={reverseRun}
          />
        ))}
      </div>
      <div className="lw-wiring-additions">
        <button className="btn" disabled={wiring.locked} aria-label="Add reserved-unlit LEDs" onClick={addInactive}>+ Reserved · unlit</button>
        <button className="btn" disabled={wiring.locked} aria-label="Add cable jump" onClick={addCable}>+ Cable jump</button>
      </div>
      {selectedRun?.type === 'strip' && (
        <details className="lw-wiring-range">
          <summary>Edit LED range</summary>
          <label>Start LED <input type="number" min="0" disabled={wiring.locked} value={selectedRun.source.from} onChange={event => updateSelectedRange('from', event.target.value)}/></label>
          <label>End LED <input type="number" min="0" disabled={wiring.locked} value={selectedRun.source.to} onChange={event => updateSelectedRange('to', event.target.value)}/></label>
          <label>Direction
            <select disabled={wiring.locked} value={selectedRun.directionPolicy} onChange={event => mutate(draft => {
              const run = draft.runs.find(item => item.id === selectedRun.id);
              if (run?.type === 'strip') run.directionPolicy = event.target.value;
            }, { changeKind: 'direction', runIds: [selectedRun.id] })}>
              <option value="flexible">Flexible</option>
              <option value="fixed">Fixed by strip</option>
            </select>
          </label>
        </details>
      )}
      <WiringPreflight compiled={compiledWiring} locked={wiring.locked} onToggleLock={toggleLock} mutationError={mutationError}/>
      <section className="lw-wire-finish">
        <fieldset disabled={!compiledWiring.ok} className="lw-send-gate">
          <CardPushControl
            connected={connected}
            board={cardTransportBoard}
            strips={strips}
            projectId={projectId}
            projectName={projectName}
            standaloneController={standaloneController}
          >
            <button className="btn la-export-ledmap" data-testid="layout-export-ledmap" onClick={exportLedmap}>Export ledmap.json</button>
          </CardPushControl>
        </fieldset>
        <div className="lw-wire-recovery" aria-label="Local card recovery actions">
          <button className="btn" onClick={() => navigator.clipboard?.writeText(JSON.stringify({ wiring, compiled: compiledWiring }, null, 2))}>Copy payload</button>
          <button className="btn" onClick={() => { window.location.hash = 'screen=installer'; }}>Open installer</button>
          <button className="btn" onClick={() => document.querySelector('[data-testid="layout-send-to-card"]')?.click()}>Retry</button>
        </div>
      </section>
    </div>
  );
}
