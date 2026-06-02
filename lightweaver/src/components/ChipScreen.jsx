import { useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import {
  patchBoardToZones,
} from '../lib/cardRuntimeContract.js';
import { getCardPatternById } from '../lib/cardPatternBank.js';
import {
  deriveSectionTargets,
  normalizeSavedLooks,
  normalizeSectionVisualLook,
} from '../lib/sectionLookModel.js';
import { normalizeCardPlaylist, playlistLabels } from '../lib/cardPlaylist.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { DEFAULT_STANDALONE_OUTPUTS } from '../lib/standaloneController.js';
import { normalizePatchBoard } from '../lib/patchBoard.js';
import {
  clampHardwarePixelCount,
  clampHardwareSectionCount,
  countsFromDefaultCircleLayout,
  createDefaultCircleLayout,
  DEFAULT_CIRCLE_SECTION_LIMIT,
  DEFAULT_CIRCLE_SECTION_COUNT,
  DEFAULT_CIRCLE_TOTAL_PIXELS,
  isDefaultCircleLayout,
} from '../lib/defaultCircleLayout.js';
import {
  cardHostToUrl,
  cardLoadMethodForProtocol,
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';
import { buildCardConfigHandoffUrl, pushConfigToCard } from '../lib/cardPushClient.js';
import { pushLiveHardwareToCard } from '../lib/cardLiveControl.js';
import { downloadJsonFile } from '../lib/downloadFile.js';
import {
  createProjectLibraryRecord,
  deleteProjectLibraryRecord,
  duplicateProjectLibraryRecord,
  listProjectLibraryRecords,
  PROJECT_LIBRARY_CHANGED_EVENT,
  readActiveProjectLibraryRecordId,
  saveProjectLibraryRecord,
  writeActiveProjectLibraryRecordId,
} from '../lib/projectStorage.js';

const CARD_PAGE_FALLBACK = 'http://lightweaver.local/';

function Section({ title, meta, children, className = '' }) {
  return (
    <section className={`lw-chip-settings-section ${className}`}>
      <div className="lw-sec-header">
        <span>{title}</span>
        {meta && <span className="meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function FieldRow({ label, hint, children }) {
  return (
    <div className="lw-chip-settings-field">
      <div>
        <div className="lw-chip-settings-label">{label}</div>
        {hint && <div className="lw-chip-settings-hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="lw-tweaks-seg">
      {options.map(option => (
        <button key={option.value || option} className={value === (option.value || option) ? 'active' : ''} onClick={() => onChange(option.value || option)}>
          {option.label || option}
        </button>
      ))}
    </div>
  );
}

function Metric({ label, value, detail }) {
  return (
    <div className="lw-chip-settings-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <em>{detail}</em>}
    </div>
  );
}

function RingSummary({ sections, targets, activeLookLabel }) {
  const sectionRows = sections.slice(0, 5).map((section, index) => {
    const target = targets.find(item => item.id === section.id || item.label === section.name);
    const pattern = getCardPatternById(target?.look?.patternId);
    return {
      ...section,
      patternLabel: pattern?.label || target?.look?.patternId || activeLookLabel || 'Current look',
      ringClass: index === 0 ? 'outer' : index === 1 ? 'inner' : 'small',
    };
  });
  const outer = sectionRows[0];
  const inner = sectionRows[1];

  return (
    <div className="lw-ring-summary" data-testid="settings-ring-summary">
      <div className="lw-sec-header">
        <span>Visual setup</span>
        <span className="meta">{sections.length} sections</span>
      </div>
      <div className="lw-ring-summary-stage" aria-hidden="true">
        <span className="lw-ring-orbit outer"/>
        <span className="lw-ring-orbit inner"/>
        {sections.length > 2 && <span className="lw-ring-orbit center">{sections.length}</span>}
      </div>
      <div className="lw-ring-summary-copy">
        {outer && (
          <div>
            <strong>Outer circle</strong>
            <span>{outer.pixels} LEDs · {outer.patternLabel}</span>
          </div>
        )}
        {inner && (
          <div>
            <strong>Inner circle</strong>
            <span>{inner.pixels} LEDs · {inner.patternLabel}</span>
          </div>
        )}
        {sectionRows.slice(2).map(section => (
          <div key={section.id}>
            <strong>{section.name}</strong>
            <span>{section.pixels} LEDs · {section.patternLabel}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatSavedTime(lastSaved) {
  if (!lastSaved) return 'not saved this session';
  return `autosaved ${new Date(lastSaved).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function formatLibraryTime(updatedAt) {
  if (!updatedAt) return 'not dated';
  return new Date(updatedAt).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ChipScreen() {
  const {
    projectId,
    projectName,
    strips,
    setStrips,
    viewBox,
    setViewBox,
    svgText,
    patchBoard,
    setPatchBoard,
    standaloneController,
    setStandaloneController,
    serializeProject,
    loadProject,
    newProject,
    lastSaved,
  } = useProject();
  const importRef = useRef(null);
  const [cardHost, setCardHost] = useState(readStoredCardHost);
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [projectLibrary, setProjectLibrary] = useState(() => listProjectLibraryRecords());
  const [activeProjectRecordId, setActiveProjectRecordId] = useState(() => readActiveProjectLibraryRecordId());
  const liveHardwareSeq = useRef(0);

  const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
  const zones = useMemo(() => patchBoardToZones(board, strips), [board, strips]);
  const runtimePackage = useMemo(
    () => buildCardRuntimePackageFromProject({ projectId, projectName, strips, patchBoard: board, standaloneController }),
    [projectId, projectName, strips, board, standaloneController],
  );
  const configJson = useMemo(() => JSON.stringify(runtimePackage.config, null, 2), [runtimePackage]);
  const config = runtimePackage.config;
  const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const handoffUrl = useMemo(() => buildCardConfigHandoffUrl(cardHost, runtimePackage), [cardHost, runtimePackage]);

  const savedLooks = normalizeSavedLooks(standaloneController?.looks);
  const activeSavedLook = savedLooks.find(look => look.id === standaloneController?.activeLookId) || savedLooks[0] || null;
  const defaultLook = normalizeSectionVisualLook(standaloneController?.defaultLook);
  const playlist = normalizeCardPlaylist(standaloneController?.playlist, {
    savedLooks,
    fallbackPatternIds: [
      defaultLook.patternId,
      ...(Array.isArray(standaloneController?.controls?.encoder?.patternCycleIds)
        ? standaloneController.controls.encoder.patternCycleIds
        : []),
    ],
  });
  const playlistPreview = playlistLabels(playlist, 3).join(', ');
  const sectionTargets = useMemo(
    () => deriveSectionTargets({ strips, patchBoard: board, defaultLook }),
    [
      strips,
      board,
      defaultLook.patternId,
      defaultLook.brightness,
      defaultLook.speed,
      defaultLook.hueShift,
      defaultLook.customHue,
      defaultLook.customSaturation,
      defaultLook.customBreathe,
      defaultLook.customDrift,
    ],
  );

  const defaultLayoutActive = isDefaultCircleLayout(strips);
  const editableDefaultLayout = !svgText && (defaultLayoutActive || strips.length === 0);
  const defaultSectionCounts = defaultLayoutActive ? countsFromDefaultCircleLayout(strips) : [];
  const hardwareSectionCount = zones.length || strips.length || DEFAULT_CIRCLE_SECTION_COUNT;
  const hardwareSections = strips.length
    ? strips.map((strip, index) => ({
        id: strip.id || `section-${index + 1}`,
        name: strip.name || `Section ${index + 1}`,
        pixels: strip.pixelCount || strip.pixels?.length || 0,
      }))
    : Array.from({ length: hardwareSectionCount }, (_, index) => ({
        id: `section-${index + 1}`,
        name: index === 0 ? 'Outer circle' : index === 1 ? 'Inner circle' : `Section ${index + 1}`,
        pixels: 0,
      }));

  const controllerOutputs = (config.led.outputs.length ? config.led.outputs : DEFAULT_STANDALONE_OUTPUTS).map((output, index) => ({
    ...(DEFAULT_STANDALONE_OUTPUTS[index] || {}),
    ...output,
  }));

  const applyDefaultHardwareLayout = ({
    totalPixels = null,
    sectionCount = null,
    sectionPixelCounts = null,
  } = {}) => {
    if (!editableDefaultLayout) return;
    const currentTotal = defaultSectionCounts.reduce((sum, count) => sum + count, 0) || config.led.pixels || DEFAULT_CIRCLE_TOTAL_PIXELS;
    const nextTotal = clampHardwarePixelCount(totalPixels ?? currentTotal, currentTotal);
    const nextSectionCount = clampHardwareSectionCount(
      sectionCount ?? sectionPixelCounts?.length ?? defaultSectionCounts.length ?? DEFAULT_CIRCLE_SECTION_COUNT,
      DEFAULT_CIRCLE_SECTION_COUNT,
    );
    const nextStrips = createDefaultCircleLayout({
      totalPixels: nextTotal,
      sectionCount: nextSectionCount,
      sectionPixelCounts,
      viewBox: viewBox || '0 0 640 400',
    });
    setViewBox(viewBox || '0 0 640 400');
    setStrips(nextStrips);
    setPatchBoard(normalizePatchBoard(null, nextStrips));
    setStandaloneController(prev => {
      const current = prev || {};
      const outputs = DEFAULT_STANDALONE_OUTPUTS.map((base, index) => {
        const previous = current.outputs?.[index] || {};
        return {
          ...base,
          ...previous,
          id: index === 0 ? 'out1' : base.id,
          name: index === 0 ? 'Output 1' : base.name,
          pixels: index === 0 ? nextTotal : 0,
        };
      });
      return { ...current, outputs };
    });
  };

  const updateDefaultSectionPixels = (index, value) => {
    const fallbackCount = Math.max(1, Math.floor((config.led.pixels || DEFAULT_CIRCLE_TOTAL_PIXELS) / Math.max(1, hardwareSectionCount)));
    const counts = defaultSectionCounts.length
      ? [...defaultSectionCounts]
      : Array.from({ length: hardwareSectionCount }, () => fallbackCount);
    counts[index] = clampHardwarePixelCount(value, counts[index] || 1);
    applyDefaultHardwareLayout({ sectionPixelCounts: counts });
  };

  const updateController = (patch) => {
    setStandaloneController(prev => {
      const current = prev || {};
      return {
        ...current,
        ...patch,
        led: patch.led ? { ...(current.led || {}), ...patch.led } : current.led,
        controls: patch.controls
          ? {
              ...(current.controls || {}),
              ...patch.controls,
              encoder: patch.controls.encoder
                ? { ...(current.controls?.encoder || {}), ...patch.controls.encoder }
                : current.controls?.encoder,
            }
          : current.controls,
      };
    });
  };

  const updateOutput = (index, patch) => {
    setStandaloneController(prev => {
      const current = prev || {};
      const outputs = DEFAULT_STANDALONE_OUTPUTS.map((output, i) => ({
        ...output,
        ...(controllerOutputs[i] || {}),
        ...((current.outputs || [])[i] || {}),
      }));
      outputs[index] = { ...(outputs[index] || DEFAULT_STANDALONE_OUTPUTS[index]), ...patch };
      return { ...current, outputs };
    });
  };

  const routeAsSingleOutput = () => {
    setStandaloneController(prev => {
      const current = prev || {};
      const totalPixels = config.led.pixels || hardwareSections.reduce((sum, section) => sum + section.pixels, 0) || DEFAULT_CIRCLE_TOTAL_PIXELS;
      const previous = current.outputs?.[0] || {};
      const outputs = DEFAULT_STANDALONE_OUTPUTS.map((base, index) => ({
        ...base,
        ...((current.outputs || [])[index] || {}),
        name: index === 0 ? (previous.name || 'Main chain') : base.name,
        pixels: index === 0 ? totalPixels : 0,
      }));
      return { ...current, outputs };
    });
  };

  const routeBySections = () => {
    setStandaloneController(prev => {
      const current = prev || {};
      const nextOutputs = DEFAULT_STANDALONE_OUTPUTS.map((base, index) => {
        const section = hardwareSections[index];
        const previous = current.outputs?.[index] || {};
        return {
          ...base,
          ...previous,
          name: section?.name || previous.name || base.name,
          pixels: section ? section.pixels : 0,
        };
      });
      return { ...current, outputs: nextOutputs };
    });
  };

  const persistHost = (value) => {
    setCardHost(value);
    writeStoredCardHost(value);
  };

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(configJson);
      setStatusKind('ok');
      setStatus('Card settings copied. Paste them into the card page on the same WiFi.');
    } catch {
      setStatusKind('err');
      setStatus('Clipboard was blocked. Use Download card settings instead.');
    }
  };

  const saveProjectFile = async () => {
    const data = serializeProject();
    const ok = await downloadJsonFile(`${safeProjectName || 'lightweaver'}-studio-project.lwproj.json`, data);
    setStatusKind(ok ? 'ok' : 'err');
    setStatus(ok ? 'Project file download started.' : 'Could not start the project file download.');
  };

  const importProjectFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!loadProject(data)) {
          setStatusKind('err');
          setStatus('That project file does not look like a Lightweaver Studio project.');
          return;
        }
        writeActiveProjectLibraryRecordId('');
        setActiveProjectRecordId('');
        setStatusKind('ok');
        setStatus('Project opened in Studio.');
      } catch {
        setStatusKind('err');
        setStatus('Could not read that project file.');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const refreshProjectLibrary = () => {
    setProjectLibrary(listProjectLibraryRecords());
    setActiveProjectRecordId(readActiveProjectLibraryRecordId());
  };

  const saveProjectToLibrary = () => {
    try {
      const record = saveProjectLibraryRecord(createProjectLibraryRecord(serializeProject()));
      writeActiveProjectLibraryRecordId(record.id);
      setActiveProjectRecordId(record.id);
      refreshProjectLibrary();
      setStatusKind('ok');
      setStatus(`Saved ${record.name} in this browser.`);
    } catch (error) {
      setStatusKind('err');
      setStatus(error.message || 'Could not save this Studio project.');
    }
  };

  const updateProjectInLibrary = () => {
    if (!activeProjectRecordId) {
      saveProjectToLibrary();
      return;
    }
    try {
      const record = saveProjectLibraryRecord(createProjectLibraryRecord(serializeProject(), {
        id: activeProjectRecordId,
      }));
      writeActiveProjectLibraryRecordId(record.id);
      refreshProjectLibrary();
      setStatusKind('ok');
      setStatus(`Updated ${record.name} in this browser.`);
    } catch (error) {
      setStatusKind('err');
      setStatus(error.message || 'Could not update this Studio project.');
    }
  };

  const openProjectFromLibrary = (record) => {
    if (!record) return;
    if (!window.confirm(`Open ${record.name}? The current Studio workspace will be replaced.`)) return;
    if (!loadProject(record.project)) {
      setStatusKind('err');
      setStatus('That saved project could not be opened.');
      return;
    }
    writeActiveProjectLibraryRecordId(record.id);
    setActiveProjectRecordId(record.id);
    setStatusKind('ok');
    setStatus(`Opened ${record.name}.`);
  };

  const duplicateProjectInLibrary = (record) => {
    if (!record) return;
    const copy = duplicateProjectLibraryRecord(record.id);
    if (!copy) {
      setStatusKind('err');
      setStatus('That saved project could not be duplicated.');
      return;
    }
    refreshProjectLibrary();
    setStatusKind('ok');
    setStatus(`Duplicated ${record.name}.`);
  };

  const deleteProjectFromLibrary = (record) => {
    if (!record) return;
    if (!window.confirm(`Delete ${record.name} from this browser?`)) return;
    deleteProjectLibraryRecord(record.id);
    if (activeProjectRecordId === record.id) {
      writeActiveProjectLibraryRecordId('');
      setActiveProjectRecordId('');
    }
    refreshProjectLibrary();
    setStatusKind('ok');
    setStatus(`Deleted ${record.name} from this browser.`);
  };

  const startNewProject = () => {
    if (!window.confirm('Discard this Studio project and start over?')) return;
    writeActiveProjectLibraryRecordId('');
    setActiveProjectRecordId('');
    newProject();
  };

  useEffect(() => {
    const onLibraryChange = () => refreshProjectLibrary();
    window.addEventListener?.(PROJECT_LIBRARY_CHANGED_EVENT, onLibraryChange);
    return () => window.removeEventListener?.(PROJECT_LIBRARY_CHANGED_EVENT, onLibraryChange);
  }, []);

  const loadMethod = cardLoadMethodForProtocol(typeof window !== 'undefined' ? window.location.protocol : 'https:');
  const directPushAvailable = loadMethod.directPush;

  const updateColorOrder = (value) => {
    const colorOrder = String(value || '').toUpperCase();
    updateController({ led: { colorOrder } });

    if (!directPushAvailable) {
      setStatusKind('');
      setStatus('Color order changed in Studio. Open the local Studio to preview this live on the card.');
      return;
    }

    const seq = ++liveHardwareSeq.current;
    setStatusKind('');
    setStatus(`Previewing ${colorOrder} color order on ${cardHostToUrl(cardHost)}...`);
    pushLiveHardwareToCard({ colorOrder }, { host: cardHost, timeoutMs: 2000 })
      .then(response => {
        if (seq !== liveHardwareSeq.current) return;
        setStatusKind('ok');
        setStatus(`Color order is live on the card: ${response.colorOrder || colorOrder}. Save to card to keep it after restart.`);
      })
      .catch(() => {
        if (seq !== liveHardwareSeq.current) return;
        setStatusKind('err');
        setStatus(`Color order changed in Studio, but ${cardHostToUrl(cardHost)} did not answer.`);
      });
  };

  const pushDirect = async () => {
    setStatusKind('');
    setStatus(`Sending to ${cardHostToUrl(cardHost)}...`);
    try {
      const response = await pushConfigToCard(runtimePackage, {
        host: cardHost,
        timeoutMs: 6000,
        reboot: 'if-needed',
        allowLayoutChange: true,
      });
      setStatusKind('ok');
      setStatus(response.rebooting
        ? 'Saved on card. Rebooting now so the LED output layout takes effect.'
        : 'Saved on card.');
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.reason === 'project-mismatch'
        ? error.message
        : 'Could not reach the card. Copy or download the card settings and paste them on the card page.');
    }
  };

  return (
    <div className="lw-chip-settings-screen">
      <div className="lw-chip-settings-shell">
        <header className="lw-chip-settings-hero">
          <div>
            <div className="lw-chip-settings-kicker">Settings</div>
            <h1>Card settings</h1>
            <p>
              Hardware setup, startup looks, project files, and the saved card package.
            </p>
          </div>
        </header>

        <section className="lw-chip-save-panel">
          <div className="lw-chip-save-copy">
            <span>{directPushAvailable ? 'local card write available' : 'copy or download mode'}</span>
            <h2>Card connection</h2>
            <p>
              Write this setup to the card, or keep a backup settings file.
            </p>
          </div>
          <div className="lw-chip-save-controls">
            <label>
              <span>Card address</span>
              <input
                className="lw-search-input"
                value={cardHost}
                onChange={event => persistHost(event.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="lightweaver.local"
              />
            </label>
            <div className="lw-chip-save-buttons">
              {directPushAvailable && <button className="btn btn-primary" onClick={pushDirect}>Save to card</button>}
              {!directPushAvailable && (
                <a className="btn btn-primary" href={handoffUrl} target="_blank" rel="noopener noreferrer">
                  Open card installer
                </a>
              )}
              <button className="btn" onClick={async () => {
                const ok = await downloadJsonFile(`${safeProjectName || 'lightweaver'}-card-settings.json`, configJson);
                setStatusKind(ok ? 'ok' : 'err');
                setStatus(ok ? 'Card settings download started.' : 'Could not start the card settings download.');
              }}>Download backup</button>
              <details className="lw-card-tools-menu">
                <summary className="btn btn-ghost">More</summary>
                <div>
                  <button className="btn btn-ghost" onClick={copyConfig}>Copy settings</button>
                  <button className="btn btn-ghost" onClick={() => window.open(cardHostToUrl(cardHost) || CARD_PAGE_FALLBACK, '_blank')}>Open card page</button>
                  <button className="btn btn-ghost" onClick={() => { window.location.hash = '#screen=flash'; }}>Flash chip</button>
                  <button className="btn btn-ghost" onClick={() => { window.location.hash = '#screen=installer'; }}>Installer guide</button>
                </div>
              </details>
            </div>
          </div>
        </section>

        {status && (
          <div className={`lw-chip-settings-status ${statusKind ? `is-${statusKind}` : ''}`}>
            {status}
          </div>
        )}

        <div className="lw-chip-settings-grid">
          <div className="lw-chip-settings-stack">
            <Section title="Card setup" meta={`${config.led.pixels} pixels · ${hardwareSections.length || hardwareSectionCount} sections`} className="is-hardware">
              <div className="lw-card-setup-grid">
                <div className="lw-card-setup-controls">
                  <FieldRow
                    label="Total LEDs"
                    hint={editableDefaultLayout ? 'used by the default circles' : 'from the imported layout'}
                  >
                    <input
                      className="lw-search-input lw-chip-settings-number"
                      type="number"
                      min="1"
                      max="2048"
                      value={config.led.pixels}
                      disabled={!editableDefaultLayout}
                      onChange={event => applyDefaultHardwareLayout({ totalPixels: event.target.value })}
                    />
                  </FieldRow>
                  <FieldRow
                    label="Sections"
                    hint={editableDefaultLayout ? 'zones on the chip' : 'from strips and patches'}
                  >
                    <input
                      className="lw-search-input lw-chip-settings-number"
                      type="number"
                      min="1"
                      max={DEFAULT_CIRCLE_SECTION_LIMIT}
                      value={hardwareSections.length || hardwareSectionCount}
                      disabled={!editableDefaultLayout}
                      onChange={event => applyDefaultHardwareLayout({ sectionCount: event.target.value })}
                    />
                  </FieldRow>
                  <FieldRow label="Section LEDs" hint={editableDefaultLayout ? 'inner and outer counts' : 'read from layout'}>
                    <div className="lw-chip-section-counts">
                      {hardwareSections.map((section, index) => (
                        <label key={section.id} className="lw-chip-section-count">
                          <span>{section.name}</span>
                          <input
                            className="lw-search-input"
                            type="number"
                            min="1"
                            max="2048"
                            value={section.pixels}
                            disabled={!editableDefaultLayout}
                            onChange={event => updateDefaultSectionPixels(index, event.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                  </FieldRow>
                  <FieldRow label="Color order" hint="must match the strip">
                    <Segmented
                      value={config.led.colorOrder}
                      onChange={updateColorOrder}
                      options={['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR']}
                    />
                  </FieldRow>
                  <FieldRow label="Brightness limit" hint="firmware maximum">
                    <div className="lw-chip-settings-slider">
                      <input type="range" min="0.05" max="1" step="0.01" value={config.led.brightnessLimit}
                             onChange={event => updateController({ led: { brightnessLimit: +event.target.value } })}/>
                      <span>{Math.round(config.led.brightnessLimit * 100)}%</span>
                    </div>
                  </FieldRow>
                  <FieldRow label="Outputs" hint="GPIO and pixel count">
                    <div className="lw-chip-output-editor">
                      <div className="lw-chip-output-toolbar">
                        <div data-testid="output-routing-summary">
                          <strong>{controllerOutputs.length} {controllerOutputs.length === 1 ? 'output' : 'outputs'}</strong>
                          <span>{config.led.outputs.reduce((sum, output) => sum + output.pixels, 0)} LEDs routed</span>
                        </div>
                        <div>
                          <button className="btn btn-ghost" type="button" onClick={routeAsSingleOutput}>Single output</button>
                          <button className="btn btn-ghost" type="button" onClick={routeBySections}>Split by sections</button>
                        </div>
                      </div>
                      <div className="lw-chip-output-list">
                      {controllerOutputs.map((output, index) => (
                        <div key={output.id || index} className="lw-chip-output-row">
                          <div className="lw-chip-output-row-head">
                            <strong>{output.name || `Output ${index + 1}`}</strong>
                            <span>GPIO {output.pin ?? 0}</span>
                            <em>{output.pixels || 0} LEDs</em>
                          </div>
                          <input
                            className="lw-search-input"
                            value={output.name || `Output ${index + 1}`}
                            onChange={event => updateOutput(index, { name: event.target.value })}
                            aria-label={`Output ${index + 1} name`}
                          />
                          <label>
                            <span>GPIO</span>
                            <input className="lw-search-input" type="number" min="0" max="48" value={output.pin ?? 0} onChange={event => updateOutput(index, { pin: +event.target.value })} />
                          </label>
                          <label>
                            <span>LEDs</span>
                            <input className="lw-search-input" type="number" min="0" max="2048" value={output.pixels || 0} onChange={event => updateOutput(index, { pixels: +event.target.value })} />
                          </label>
                        </div>
                      ))}
                      </div>
                    </div>
                  </FieldRow>
                </div>
                <RingSummary
                  sections={hardwareSections}
                  targets={sectionTargets}
                  activeLookLabel={activeSavedLook?.label || 'Current look'}
                />
              </div>
            </Section>

            <div className="lw-chip-lower-grid">
              <Section title="What the card will run" meta={activeSavedLook?.label || 'current setup'}>
                <div className="lw-chip-run-summary">
                  <Metric
                    label="Startup look"
                    value={activeSavedLook?.label || 'Current look'}
                    detail={`${savedLooks.length} saved combos`}
                  />
                  <Metric
                    label="Playlist"
                    value={`${playlist.length} looks`}
                    detail={playlistPreview}
                  />
                </div>
                {sectionTargets.length <= 1 ? (
                  <div className="lw-chip-settings-note">
                    No separate sections are defined yet. The card will use the saved look across all LEDs.
                  </div>
                ) : (
                  <div className="lw-chip-section-list">
                    {sectionTargets.slice(1, 9).map(target => {
                      const pattern = getCardPatternById(target.look.patternId);
                      return (
                        <div key={target.id} className="lw-chip-section-row">
                          <div>
                            <strong>{target.label}</strong>
                            <span>{target.pixelCount} LEDs</span>
                          </div>
                          <span>{pattern?.label || target.look.patternId}</span>
                          <code>{Math.round(target.look.brightness * 100)}%</code>
                          <code>{target.look.speed.toFixed(2)}x</code>
                        </div>
                      );
                    })}
                  </div>
                )}
                <FieldRow label="Change setup" hint="patterns and zones">
                  <div className="lw-chip-settings-inline-actions">
                    <button className="btn btn-ghost" onClick={() => { window.location.hash = '#screen=patterns'; }}>Edit patterns</button>
                    <button className="btn btn-ghost" onClick={() => { window.location.hash = '#screen=playlist'; }}>Edit playlist</button>
                    <button className="btn btn-ghost" onClick={() => { window.location.hash = '#screen=layout'; }}>Edit layout</button>
                  </div>
                </FieldRow>
              </Section>

              <div className="lw-chip-project-package">
                <Section title="Studio project" meta={formatSavedTime(lastSaved)}>
                  <FieldRow label="Browser library" hint="editable Studio projects">
                    <div className="lw-chip-settings-inline-actions">
                      <button className="btn btn-primary" onClick={saveProjectToLibrary}>Save current</button>
                      <button className="btn btn-ghost" onClick={updateProjectInLibrary} disabled={!activeProjectRecordId}>
                        Update opened
                      </button>
                    </div>
                  </FieldRow>
                  <div className="lw-project-library-list">
                    {projectLibrary.length ? projectLibrary.map(record => (
                      <div
                        key={record.id}
                        className={`lw-project-library-row ${record.id === activeProjectRecordId ? 'is-active' : ''}`}
                      >
                        <div className="lw-project-library-main">
                          <strong>{record.name}</strong>
                          <span>{formatLibraryTime(record.updatedAt)} · project v{record.projectVersion}</span>
                        </div>
                        <div className="lw-project-library-actions">
                          <button className="btn btn-ghost" onClick={() => openProjectFromLibrary(record)}>Open</button>
                          <button className="btn btn-ghost" onClick={() => duplicateProjectInLibrary(record)}>Duplicate</button>
                          <button className="btn btn-ghost" onClick={() => deleteProjectFromLibrary(record)}>Delete</button>
                        </div>
                      </div>
                    )) : (
                      <div className="lw-project-library-empty">
                        No saved Studio projects in this browser yet.
                      </div>
                    )}
                  </div>
                  <FieldRow label="File backup" hint="portable .lwproj.json">
                    <div className="lw-chip-settings-inline-actions">
                      <button className="btn btn-ghost" onClick={saveProjectFile}>Download</button>
                      <button className="btn btn-ghost" onClick={() => importRef.current?.click()}>Open</button>
                      <button className="btn btn-ghost" onClick={startNewProject}>New</button>
                      <input ref={importRef} type="file" accept=".json,.lwproj.json,.lw.json" className="lw-hidden-file-input" onChange={importProjectFile}/>
                    </div>
                  </FieldRow>
                </Section>

                <Section title="Card package" meta="saved on chip" className="is-package">
                  <div className="lw-card-load-summary">
                    <span>Piece</span><strong>{config.piece.name}</strong>
                    <span>Look</span><strong>{activeSavedLook?.label || 'Current saved look'}</strong>
                    <span>Pixels</span><strong>{config.led.pixels}</strong>
                    <span>Outputs</span><strong>{config.led.outputs.length}</strong>
                    <span>Sections</span><strong>{config.zones.length || 1}</strong>
                  </div>
                </Section>
              </div>
            </div>

            <div className="lw-chip-settings-advanced">
              <button className="btn btn-ghost" onClick={() => setAdvancedOpen(open => !open)}>
                Advanced
              </button>
              {advancedOpen && (
                <Section title="Designer config" meta={`${(configJson.length / 1024).toFixed(1)} KB`}>
                  <textarea
                    readOnly
                    value={configJson}
                    className="lw-chip-settings-json"
                  />
                </Section>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
