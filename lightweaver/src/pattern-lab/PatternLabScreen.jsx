import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadJsonFile } from '../lib/downloadFile.js';
import { PATTERN_LAB_EVOLUTION_CHARACTERS } from '../lib/patternLabEvolution.js';
import { recipeFromPattern } from '../lib/patternLabPatternAdapter.js';
import { normalizePatternLabRecipe } from '../lib/patternLabRecipe.js';
import { readPatternLabDraftState, savePatternLabDraft } from '../lib/patternLabStorage.js';
import { isBuiltInPattern, listBuiltInPatterns } from '../lib/patternRegistry.js';
import { useProject } from '../state/ProjectContext.jsx';
import PatternLabControls from './PatternLabControls.jsx';
import PatternLabEvolution from './PatternLabEvolution.jsx';
import PatternLabLayers from './PatternLabLayers.jsx';
import PatternLabPreview from './PatternLabPreview.jsx';
import PatternLabVariants from './PatternLabVariants.jsx';
import './pattern-lab.css';

const WORKFLOW = [
  ['01', 'Choose', 'Begin with a built-in pattern.'],
  ['02', 'Sculpt', 'Shape it with five creative controls.'],
  ['03', 'Evolve', 'Build a five-to-fifteen-minute journey.'],
  ['04', 'Save', 'Keep a private, repeatable variation.'],
];
const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_IMPORT_NODES = 2000;
const MAX_IMPORT_DEPTH = 12;

function cloneRecipe(recipe) {
  return JSON.parse(JSON.stringify(recipe));
}

function withEvolutionDisabled(recipe) {
  return normalizePatternLabRecipe({
    ...cloneRecipe(recipe),
    evolution: { ...recipe.evolution, enabled: false },
  });
}

function sourceFromRecipe(recipe) {
  const source = recipeFromPattern(recipe.base.patternId, { palette: recipe.palette });
  return withEvolutionDisabled({ ...source, id: recipe.id, name: recipe.name });
}

function deriveSeed(seed, index) {
  let value = ((Number(seed) >>> 0) + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function validateImportDocument(value) {
  const errors = [];
  const add = (path, message) => {
    if (errors.length < 4) errors.push(`${path}: ${message}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    add('$', 'must be a recipe object');
    return errors;
  }
  if (Number(value.version) !== 1) add('$.version', 'must be 1');
  if (typeof value.id !== 'string' || !value.id.trim()) add('$.id', 'must be a non-empty string');
  if (!isBuiltInPattern(value.base?.patternId)) add('$.base.patternId', 'must name a built-in Lightweaver pattern');
  if (!PATTERN_LAB_EVOLUTION_CHARACTERS.includes(value.evolution?.character)) {
    add('$.evolution.character', 'must be one of the six supported characters');
  }
  if (!Array.isArray(value.layers) || value.layers.length > 3) add('$.layers', 'must contain at most 3 layers');
  if (Array.isArray(value.targets) && value.targets.length > 64) add('$.targets', 'must contain at most 64 targets');
  if (Array.isArray(value.requirements) && value.requirements.length > 64) add('$.requirements', 'must contain at most 64 entries');
  if (Array.isArray(value.provenance) && value.provenance.length > 64) add('$.provenance', 'must contain at most 64 entries');
  if (value.base?.params && Object.keys(value.base.params).length > 64) add('$.base.params', 'must contain at most 64 parameters');
  if (!Array.isArray(value.palette) || value.palette.length < 2 || value.palette.length > 8) add('$.palette', 'must contain 2 to 8 colors');
  if (!Number.isFinite(Number(value.evolution?.durationSeconds))
    || Number(value.evolution.durationSeconds) < 300
    || Number(value.evolution.durationSeconds) > 900) {
    add('$.evolution.durationSeconds', 'must be between 300 and 900');
  }
  if (!Number.isFinite(Number(value.evolution?.change))
    || Number(value.evolution.change) < 0
    || Number(value.evolution.change) > 1) {
    add('$.evolution.change', 'must be between 0 and 1');
  }

  let nodes = 0;
  const stack = [[value, 0]];
  while (stack.length && errors.length < 4) {
    const [current, depth] = stack.pop();
    nodes += 1;
    if (nodes > MAX_IMPORT_NODES) {
      add('$', `must contain at most ${MAX_IMPORT_NODES} values`);
      break;
    }
    if (depth > MAX_IMPORT_DEPTH) {
      add('$', `must not exceed ${MAX_IMPORT_DEPTH} levels`);
      break;
    }
    if (current && typeof current === 'object') {
      for (const nested of Object.values(current)) stack.push([nested, depth + 1]);
    } else if (typeof current === 'string' && current.length > 20000) {
      add('$', 'contains a string that is too long');
      break;
    }
  }
  return errors;
}

function useMobileDrawer() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 640px)');
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return mobile;
}

function safeFilename(name) {
  const slug = String(name || 'pattern-lab-recipe')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'pattern-lab-recipe'}.lwrecipe.json`;
}

function SculpturePlaceholder() {
  return (
    <svg className="plab-sculpture" viewBox="0 0 640 420" aria-hidden="true" focusable="false">
      <circle className="plab-orbit" cx="320" cy="210" r="164" />
      <circle className="plab-orbit plab-orbit-inner" cx="320" cy="210" r="92" />
      <path className="plab-line" d="M320 45C353 115 443 123 480 210C413 230 397 322 320 375C287 305 197 297 160 210C227 190 243 98 320 45Z" />
      <path className="plab-line plab-line-secondary" d="M160 210C231 246 238 337 320 375C356 304 447 297 480 210C409 174 402 83 320 45C284 116 193 123 160 210Z" />
      <circle className="plab-node" cx="320" cy="45" r="5" />
      <circle className="plab-node" cx="480" cy="210" r="5" />
      <circle className="plab-node" cx="320" cy="375" r="5" />
      <circle className="plab-node" cx="160" cy="210" r="5" />
    </svg>
  );
}

export default function PatternLabScreen() {
  const project = useProject();
  const patterns = useMemo(() => listBuiltInPatterns(), []);
  const importRef = useRef(null);
  const drawerRef = useRef(null);
  const drawerTriggerRef = useRef(null);
  const drawerCloseRef = useRef(null);
  const [sourceRecipe, setSourceRecipe] = useState(null);
  const [draft, setDraft] = useState(null);
  const [comparison, setComparison] = useState('draft');
  const [previewTime, setPreviewTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [drafts, setDrafts] = useState([]);
  const [draftState, setDraftState] = useState('loading');
  const [message, setMessage] = useState('');
  const [importErrors, setImportErrors] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [variationRound, setVariationRound] = useState(0);
  const [seedLocked, setSeedLocked] = useState(false);
  const mobileDrawer = useMobileDrawer();
  const previewRecipe = comparison === 'source' ? sourceRecipe : draft;
  const previewDuration = draft?.evolution?.durationSeconds ?? 600;

  useEffect(() => {
    const state = readPatternLabDraftState();
    setDrafts(state.drafts);
    setDraftState(state.status === 'empty' || state.status === 'restored' ? 'ready' : state.status);
  }, []);

  useEffect(() => {
    if (!playing || !previewRecipe) return undefined;
    let frame = 0;
    let lastCommit = performance.now();
    const advance = now => {
      if (now - lastCommit >= 30) {
        const elapsed = Math.min((now - lastCommit) / 1000, 0.1);
        setPreviewTime(current => (current + elapsed) % previewDuration);
        lastCommit = now;
      }
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [playing, previewDuration, Boolean(previewRecipe)]);

  useEffect(() => {
    if (!mobileDrawer || !drawerOpen) return undefined;
    drawerCloseRef.current?.focus();
    const closeOnEscape = event => {
      if (event.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [drawerOpen, mobileDrawer]);

  const geometry = useMemo(() => ({
    strips: project.strips.map(strip => {
      const { patternId: _patternId, compiledFn: _compiledFn, patternFn: _patternFn, ...geometryStrip } = strip;
      return { ...geometryStrip, patternId: null };
    }),
    viewBox: project.viewBox,
    svgText: project.svgText,
    hidden: project.hidden,
    bpm: project.bpm,
    gammaEnabled: project.gammaEnabled,
    gammaValue: project.gammaValue,
    symSettings: project.symSettings,
    audioBands: project.audioBands,
    motionSmoothing: project.motionSmoothing,
  }), [
    project.strips,
    project.viewBox,
    project.svgText,
    project.hidden,
    project.bpm,
    project.gammaEnabled,
    project.gammaValue,
    project.symSettings,
    project.audioBands,
    project.motionSmoothing,
  ]);

  const variantSeeds = useMemo(
    () => Array.from({ length: 4 }, (_, index) => deriveSeed(sourceRecipe?.seed ?? 1, index + variationRound * 4)),
    [sourceRecipe?.seed, variationRound],
  );

  function choosePattern(patternId) {
    if (!patternId) {
      setSourceRecipe(null);
      setDraft(null);
      return;
    }
    const source = withEvolutionDisabled(recipeFromPattern(patternId, { palette: project.palette }));
    setSourceRecipe(source);
    setDraft(cloneRecipe(source));
    setComparison('draft');
    setPreviewTime(0);
    setPlaying(false);
    setMessage('');
    setImportErrors([]);
    setVariationRound(0);
    setSeedLocked(false);
  }

  function changeMacro(name, value) {
    setDraft(current => current ? { ...current, macros: { ...current.macros, [name]: value } } : current);
    setComparison('draft');
    setMessage('');
  }

  function changeEvolution(name, value) {
    setDraft(current => current ? { ...current, evolution: { ...current.evolution, [name]: value } } : current);
    if (name === 'durationSeconds') setPreviewTime(current => Math.min(current, value));
    setComparison('draft');
    setMessage('');
  }

  function chooseSeed(seed) {
    setDraft(current => current ? { ...cloneRecipe(current), seed } : current);
    setComparison('draft');
    setMessage('');
  }

  function createNewVariations() {
    if (!seedLocked) setVariationRound(round => round + 1);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    requestAnimationFrame(() => drawerTriggerRef.current?.focus());
  }

  function trapDrawerFocus(event) {
    if (!mobileDrawer || !drawerOpen || event.key !== 'Tab') return;
    const focusable = [...drawerRef.current.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [href], [tabindex]:not([tabindex="-1"])',
    )].filter(element => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function changeLayers(layers) {
    setDraft(current => current ? { ...current, layers: cloneRecipe(layers) } : current);
    setComparison('draft');
    setMessage('');
  }

  function addLayer() {
    setDraft(current => {
      if (!current || current.layers.length >= 3) return current;
      const index = current.layers.length + 1;
      return {
        ...current,
        layers: [...current.layers, {
          id: `layer-${current.id}-${index}`,
          name: `Layer ${index}`,
          blendMode: 'normal',
          opacity: 0.65,
        }],
      };
    });
    setComparison('draft');
  }

  function openDraft(saved) {
    const normalized = normalizePatternLabRecipe(saved);
    setSourceRecipe(sourceFromRecipe(normalized));
    setDraft(cloneRecipe(normalized));
    setComparison('draft');
    setPreviewTime(0);
    setPlaying(false);
    setMessage(`Opened ${normalized.name}`);
    setImportErrors([]);
    setVariationRound(0);
    setSeedLocked(false);
  }

  function saveDraft() {
    if (!draft) return;
    try {
      const saved = savePatternLabDraft(normalizePatternLabRecipe(draft));
      setDraft(saved);
      const state = readPatternLabDraftState();
      setDrafts(state.drafts);
      setDraftState(state.status === 'empty' || state.status === 'restored' ? 'ready' : state.status);
      setMessage(`Saved privately — ${saved.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save this private draft.');
    }
  }

  async function exportRecipe() {
    if (!draft) return;
    const canonical = normalizePatternLabRecipe(draft);
    await downloadJsonFile(safeFilename(canonical.name), canonical, { preferPicker: false });
  }

  async function importRecipe(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) {
        setImportErrors([`file: must be smaller than ${Math.round(MAX_IMPORT_BYTES / 1024)} KB`]);
        setMessage('');
        return;
      }
      const temporary = JSON.parse(await file.text());
      const validationErrors = validateImportDocument(temporary);
      if (validationErrors.length) {
        setImportErrors(validationErrors);
        setMessage('');
        return;
      }
      const normalized = normalizePatternLabRecipe(temporary);
      const source = sourceFromRecipe(normalized);
      setSourceRecipe(source);
      setDraft(cloneRecipe(normalized));
      setComparison('draft');
      setPreviewTime(0);
      setImportErrors([]);
      setMessage(`Imported ${normalized.name}. Save when you want to keep it privately.`);
      setVariationRound(0);
      setSeedLocked(false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The file is not a valid Pattern Lab recipe.';
      setImportErrors([detail].slice(0, 4));
      setMessage('');
    }
  }

  return (
    <main className="screen plab-screen" data-testid="pattern-lab-screen">
      <div className="plab-scroll">
        <header className="plab-header">
          <div>
            <span className="plab-kicker">Separate creative workspace</span>
            <h1>Pattern Lab</h1>
            <p>Turn familiar looks into detailed five-to-fifteen-minute light journeys. Nothing here changes your project or connected card.</p>
          </div>
          <div className="plab-isolation" role="status">
            <span className="plab-isolation-mark" aria-hidden="true" />
            <span><strong>Private workspace</strong>Your active project and connected lights stay unchanged.</span>
          </div>
        </header>

        <ol className="plab-workflow" aria-label="Pattern Lab workflow">
          {WORKFLOW.map(([number, title, description], index) => (
            <li key={title} className={index === 0 ? 'current' : ''} aria-current={index === 0 ? 'step' : undefined}>
              <span className="plab-step-number">{number}</span>
              <span><strong>{title}</strong><small>{description}</small></span>
            </li>
          ))}
        </ol>

        <section className="plab-workspace" aria-label="Pattern authoring workspace">
          <div className="plab-preview">
            <div className="plab-preview-bar">
              <span>{previewRecipe ? <strong data-testid="pattern-lab-draft-name">{previewRecipe.name}</strong> : 'Artwork preview'}</span>
              <div className="plab-preview-meta">
                <span>{previewRecipe ? 'Mapped to current artwork' : 'No source selected'}</span>
                <button type="button" className="plab-play" disabled={!previewRecipe} aria-pressed={playing} onClick={() => setPlaying(value => !value)}>{playing ? 'Pause' : 'Play'}</button>
                <button
                  ref={drawerTriggerRef}
                  type="button"
                  className="plab-drawer-trigger"
                  aria-label="Pattern controls"
                  aria-expanded={drawerOpen}
                  aria-controls="plab-controls-drawer"
                  onClick={() => setDrawerOpen(open => !open)}
                >Controls</button>
              </div>
            </div>
            <div className="plab-stage">
              {previewRecipe ? (
                <PatternLabPreview recipe={previewRecipe} previewTime={previewTime} playing={playing} geometry={geometry} />
              ) : (
                <>
                  <SculpturePlaceholder />
                  <div className="plab-empty">
                    <span className="plab-empty-rule" aria-hidden="true" />
                    <h2>Begin with a pattern</h2>
                    <p>Choose a built-in look in the inspector. Pattern Lab makes a private copy you can stretch into a longer, less repetitive experience.</p>
                    <button type="button" className="btn primary" onClick={() => {
                      if (mobileDrawer) setDrawerOpen(true);
                      requestAnimationFrame(() => document.getElementById('plab-base-pattern')?.focus());
                    }}>Choose pattern</button>
                  </div>
                </>
              )}
            </div>
          </div>

          {mobileDrawer && drawerOpen && (
            <button className="plab-drawer-backdrop" type="button" aria-label="Dismiss pattern controls" onClick={closeDrawer} />
          )}
          <aside
            ref={drawerRef}
            id="plab-controls-drawer"
            className={`plab-controls${drawerOpen ? ' drawer-open' : ''}`}
            aria-label="Pattern Lab controls"
            role={mobileDrawer ? 'dialog' : undefined}
            aria-modal={mobileDrawer && drawerOpen ? 'true' : undefined}
            aria-hidden={mobileDrawer && !drawerOpen ? 'true' : undefined}
            inert={mobileDrawer && !drawerOpen ? '' : undefined}
            onKeyDown={trapDrawerFocus}
          >
            <div className="plab-control-heading">
              <span>Pattern inspector</span>
              <span>{draft ? 'Private draft' : 'Choose below'}</span>
              <button
                ref={drawerCloseRef}
                type="button"
                className="plab-drawer-close"
                aria-label="Close pattern controls"
                onClick={closeDrawer}
              >Close</button>
            </div>
            <div id="plab-pattern-select">
              <PatternLabControls
                patterns={patterns}
                recipe={draft}
                selectedPatternId={draft?.base?.patternId || ''}
                onPatternChange={choosePattern}
                onMacroChange={changeMacro}
              />
            </div>
            <PatternLabEvolution
              recipe={draft}
              previewTime={previewTime}
              onEvolutionChange={changeEvolution}
              onPreviewTime={setPreviewTime}
            />
            <PatternLabVariants
              recipe={draft}
              sourceSeed={sourceRecipe?.seed}
              variantSeeds={variantSeeds}
              geometry={geometry}
              previewTime={previewTime}
              comparison={comparison}
              seedLocked={seedLocked}
              onComparison={setComparison}
              onSelectSeed={chooseSeed}
              onSeedLock={setSeedLocked}
              onNewVariations={createNewVariations}
            />
            {draft && (
              <div className="plab-layer-inspector">
                <PatternLabLayers
                  layers={draft.layers}
                  onAddLayer={addLayer}
                  onLayersChange={changeLayers}
                />
              </div>
            )}

            <section className="plab-private-library" aria-labelledby="plab-private-heading">
              <div className="plab-library-heading">
                <div><span className="plab-section-index">Saved</span><h2 id="plab-private-heading">Private drafts</h2></div>
                <span>{drafts.length}</span>
              </div>
              {draftState === 'loading' && <p>Loading private drafts…</p>}
              {draftState === 'unavailable' && <p role="alert">Private draft storage is unavailable in this browser.</p>}
              {draftState === 'unrecoverable' && <p role="alert">Private drafts could not be recovered. Existing data was left untouched.</p>}
              {draftState === 'ready' && drafts.length === 0 && <p>No saved drafts yet. Your first save stays only in this browser.</p>}
              {drafts.length > 0 && (
                <ul>
                  {drafts.map(saved => (
                    <li key={saved.id}>
                      <button type="button" onClick={() => openDraft(saved)} aria-label={`Open ${saved.name}`}>
                        <strong>{saved.name}</strong>
                        <small>{Math.round(saved.evolution.durationSeconds / 60)} min · {saved.evolution.character.replaceAll('-', ' ')}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {importErrors.length > 0 && (
              <div className="plab-import-errors" role="alert">
                <strong>Could not import recipe</strong>
                <ul>{importErrors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul>
              </div>
            )}
            {message && <p className="plab-save-status" data-testid="pattern-lab-save-status" aria-live="polite">{message}</p>}

            <div className="plab-actions">
              <button type="button" className="btn primary" disabled={!draft} onClick={saveDraft}>Save private draft</button>
              <button type="button" className="btn" disabled={!draft} onClick={exportRecipe}>Export recipe</button>
              <button type="button" className="btn" onClick={() => importRef.current?.click()}>Import recipe</button>
              <input ref={importRef} className="plab-file-input" aria-label="Import recipe" type="file" accept=".lwrecipe.json,application/json" onChange={importRecipe} />
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
