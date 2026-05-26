import { useEffect, useMemo, useRef, useState } from 'react';
import {
  requestAiPatternDraft,
  requestAiProviderSettings,
  saveAiProviderSettings,
  startOpenRouterAccountConnection,
  testOpenRouterConnection,
} from '../lib/aiPatternClient.js';
import { validateAiPatternDraft } from '../lib/aiPatternDraft.js';
import { getPatternById, isBuiltInPattern } from '../lib/patternRegistry.js';

const AI_PROVIDER_STORAGE_KEY = 'lw_ai_pattern_provider';
const AI_PROVIDER_OPTIONS = [
  { id: 'openrouter', label: 'OpenRouter', detail: 'model router', keyLabel: 'OpenRouter key' },
  { id: 'openai', label: 'ChatGPT', detail: 'OpenAI', keyLabel: 'ChatGPT key' },
  { id: 'anthropic', label: 'Claude', detail: 'Anthropic', keyLabel: 'Claude key' },
];
const PRIMARY_AI_PROVIDER = 'openrouter';
const AI_MODEL_PRESET_FALLBACKS = [
  { id: 'balanced', label: 'Balanced', detail: 'Reliable default', model: 'openai/gpt-5.4-mini' },
  { id: 'best', label: 'Best', detail: 'Higher quality', model: 'openai/gpt-5.5' },
  { id: 'creative', label: 'Creative', detail: 'Claude Sonnet', model: 'anthropic/claude-sonnet-4.6' },
  { id: 'fast', label: 'Fast', detail: 'Quick drafts', model: 'google/gemini-3.5-flash' },
  { id: 'budget', label: 'Budget', detail: 'Lower-cost iterations', model: 'openai/gpt-5-mini' },
];
const AI_QUALITY_PRESET_FALLBACKS = [
  { id: 'simple', label: 'Simple', detail: 'Short editable code' },
  { id: 'balanced', label: 'Balanced', detail: 'Smooth and editable' },
  { id: 'showpiece', label: 'Showpiece', detail: 'Layered gallery-ready motion' },
];

function getProviderOption(provider) {
  return AI_PROVIDER_OPTIONS.find(option => option.id === provider) || AI_PROVIDER_OPTIONS[0];
}

function createSettingsDraft(provider, settings = {}) {
  return {
    provider: getProviderOption(provider).id,
    modelPreset: settings.modelPreset || 'balanced',
    qualityPreset: settings.qualityPreset || 'balanced',
    keys: { openai: '', anthropic: '', openrouter: '' },
  };
}

function formatUsageNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

function formatOpenRouterUsage(account = {}) {
  const remaining = formatUsageNumber(account.limitRemaining);
  const limit = formatUsageNumber(account.limit);
  const reset = account.limitReset ? ` ${account.limitReset}` : '';
  if (remaining && limit) return `Remaining ${remaining} of ${limit}${reset}`;

  const usage = formatUsageNumber(account.usage);
  if (usage) return `Used ${usage}${reset}`;
  return '';
}

function hasCompletedAiSetupConnection() {
  try {
    return new URLSearchParams(window.location.hash.slice(1)).get('aiSetup') === 'connected';
  } catch {
    return false;
  }
}

function getVisibleStrips(strips = [], hidden = {}) {
  return (Array.isArray(strips) ? strips : []).filter(strip => strip && !strip.hidden && !hidden[strip.id]);
}

function buildProjectContext(strips = [], hidden = {}, audioBands = null) {
  const visible = getVisibleStrips(strips, hidden);
  return {
    ledCount: visible.reduce((sum, strip) => sum + (strip.pixels?.length || strip.pixelCount || 0), 0),
    stripCount: visible.length,
    hasAudio: !!audioBands,
    hasMappedXY: true,
  };
}

function sourceFromPattern(patternId, palette, params) {
  const pattern = getPatternById(patternId);
  if (!pattern) return null;
  return {
    id: pattern.id,
    name: pattern.name,
    description: pattern.desc || '',
    code: pattern.code || '',
    palette: pattern.palette?.length ? pattern.palette : palette,
    params,
    isCustom: !isBuiltInPattern(pattern.id),
  };
}

export function AiPatternAssistant({
  patternId,
  palette,
  params,
  strips,
  hidden,
  audioBands,
  onAcceptDraft,
}) {
  const requestIdRef = useRef(0);
  const connectedOnLoad = hasCompletedAiSetupConnection();
  const [open, setOpen] = useState(connectedOnLoad);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState(null);
  const [validated, setValidated] = useState(null);
  const [provider, setProvider] = useState(() => {
    try {
      const saved = localStorage.getItem(AI_PROVIDER_STORAGE_KEY);
      return saved === PRIMARY_AI_PROVIDER ? saved : PRIMARY_AI_PROVIDER;
    } catch {
      return PRIMARY_AI_PROVIDER;
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(connectedOnLoad);
  const [settings, setSettings] = useState(null);
  const [settingsDraft, setSettingsDraft] = useState(() => createSettingsDraft(PRIMARY_AI_PROVIDER));
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsError, setSettingsError] = useState(null);
  const [settingsSaved, setSettingsSaved] = useState(connectedOnLoad ? 'Connected OpenRouter account.' : '');
  const [connectionPending, setConnectionPending] = useState(false);
  const [connectionResult, setConnectionResult] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const sourcePattern = useMemo(
    () => sourceFromPattern(patternId, palette, params),
    [patternId, palette, params],
  );

  const visibleStrips = useMemo(() => getVisibleStrips(strips, hidden), [strips, hidden]);

  useEffect(() => {
    requestIdRef.current += 1;
    setMessages([]);
    setInput('');
    setDraft(null);
    setValidated(null);
    setPending(false);
    setError(null);
  }, [sourcePattern?.id]);

  useEffect(() => {
    try {
      localStorage.setItem(AI_PROVIDER_STORAGE_KEY, provider);
    } catch {}
  }, [provider]);

  const loadProviderSettings = async () => {
    setSettingsPending(true);
    setSettingsError(null);
    try {
      const data = await requestAiProviderSettings();
      const nextProvider = PRIMARY_AI_PROVIDER;
      setSettings(data);
      setProvider(nextProvider);
      setSettingsDraft(createSettingsDraft(nextProvider, data));
      return data;
    } catch (settingsLoadError) {
      setSettingsError(settingsLoadError.message);
      return null;
    } finally {
      setSettingsPending(false);
    }
  };

  useEffect(() => {
    if (open && !settings) {
      loadProviderSettings();
    }
  }, [open, settings]);

  const openSettingsPanel = () => {
    setSettingsOpen(value => !value);
    setSettingsSaved('');
    if (!settings) loadProviderSettings();
  };

  const updateSettingsKey = (id, value) => {
    setSettingsDraft(current => ({
      ...current,
      keys: { ...current.keys, [id]: value },
    }));
  };

  const updateSettingsChoice = (key, value) => {
    setSettingsDraft(current => ({
      ...current,
      [key]: value,
    }));
  };

  const saveSettings = async (event) => {
    event.preventDefault();
    setSettingsPending(true);
    setSettingsError(null);
    setSettingsSaved('');
    try {
      const saved = await saveAiProviderSettings({ ...settingsDraft, provider: PRIMARY_AI_PROVIDER });
      const nextProvider = getProviderOption(saved?.provider).id;
      setSettings(saved);
      setProvider(nextProvider);
      setSettingsDraft(createSettingsDraft(nextProvider, saved));
      setSettingsSaved(`Saved. ${getProviderOption(nextProvider).label} is active.`);
      setConnectionResult(null);
    } catch (settingsSaveError) {
      setSettingsError(settingsSaveError.message);
    } finally {
      setSettingsPending(false);
    }
  };

  const connectOpenRouterAccount = async () => {
    setSettingsPending(true);
    setSettingsError(null);
    setSettingsSaved('');
    setConnectionResult(null);
    try {
      const returnTo = `${window.location.origin}${window.location.pathname}#screen=pattern`;
      const data = await startOpenRouterAccountConnection({ returnTo });
      if (data?.authorizationUrl) {
        window.location.assign(data.authorizationUrl);
        return;
      }
      throw new Error('OpenRouter did not return a sign-in URL.');
    } catch (connectionError) {
      setSettingsError(connectionError.message);
      setSettingsPending(false);
    }
  };

  const testConnection = async () => {
    setConnectionPending(true);
    setSettingsError(null);
    setSettingsSaved('');
    setConnectionResult(null);
    try {
      const result = await testOpenRouterConnection();
      setConnectionResult(result);
    } catch (connectionError) {
      setSettingsError(connectionError.message);
    } finally {
      setConnectionPending(false);
    }
  };

  const sendInstruction = async (modeOverride = null) => {
    const instruction = input.trim();
    if (!instruction || !sourcePattern || pending) return;
    const requestId = requestIdRef.current;
    setPending(true);
    setError(null);
    setMessages(prev => [...prev, { role: 'user', text: instruction }]);
    try {
      const rawDraft = await requestAiPatternDraft({
        provider: PRIMARY_AI_PROVIDER,
        qualityPreset: settingsDraft.qualityPreset || settings?.qualityPreset || 'balanced',
        mode: modeOverride || (draft ? 'refine' : 'transform'),
        instruction,
        sourcePattern,
        draftPattern: draft,
        projectContext: buildProjectContext(strips, hidden, audioBands),
      });
      if (requestIdRef.current !== requestId) return;
      const result = validateAiPatternDraft(rawDraft, { instruction, strips: visibleStrips, audioBands });
      if (requestIdRef.current !== requestId) return;
      if (!result.ok) {
        setError(result.error);
        setMessages(prev => [...prev, { role: 'assistant', text: result.error.message, error: true }]);
        return;
      }
      setDraft(result.draft);
      setValidated(result);
      setMessages(prev => [...prev, { role: 'assistant', text: result.draft.changeSummary.join(' ') }]);
      setInput('');
    } catch (requestError) {
      if (requestIdRef.current !== requestId) return;
      setError({ kind: requestError.code || 'request-failed', message: requestError.message });
      setMessages(prev => [...prev, { role: 'assistant', text: requestError.message, error: true }]);
    } finally {
      if (requestIdRef.current === requestId) setPending(false);
    }
  };

  const acceptDraft = () => {
    if (!validated?.draft || !sourcePattern || !onAcceptDraft) return;
    const accepted = onAcceptDraft(validated.draft, sourcePattern, validated.params || []);
    if (accepted) {
      setMessages(prev => [...prev, { role: 'assistant', text: `Accepted ${accepted.name}.` }]);
      setDraft(null);
      setValidated(null);
      setError(null);
    }
  };
  const addPromptText = (text) => {
    setInput(current => {
      const trimmed = current.trim();
      return trimmed ? `${trimmed}. ${text}` : text;
    });
  };
  const providerOption = getProviderOption(provider);
  const providerStatus = settings?.providers?.find(item => item.id === provider);
  const modelPresets = settings?.modelPresets?.length ? settings.modelPresets : AI_MODEL_PRESET_FALLBACKS;
  const qualityPresets = settings?.qualityPresets?.length ? settings.qualityPresets : AI_QUALITY_PRESET_FALLBACKS;
  const selectedModelPreset = modelPresets.find(preset => preset.id === settingsDraft.modelPreset) || modelPresets[0];
  const selectedQualityPreset = qualityPresets.find(preset => preset.id === settingsDraft.qualityPreset) || qualityPresets[1] || qualityPresets[0];
  const connectionUsage = formatOpenRouterUsage(connectionResult?.account);

  return (
    <section className={`lw-ai-assistant ${open ? 'open' : ''}`}>
      <button
        className="lw-ai-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span>AI Pattern</span>
        <strong>{open ? 'Close' : 'Open'}</strong>
      </button>
      {open && (
        <div className="lw-ai-body">
          <div className="lw-ai-context">
            Transforming <strong>{sourcePattern?.name || patternId}</strong>
          </div>
          <div className="lw-ai-provider">
            <div>
              <span>AI provider</span>
              <strong>{providerOption.label}</strong>
              <em>{providerStatus?.configured ? 'key saved' : 'needs key'}</em>
            </div>
            <button className="btn btn-ghost" type="button" onClick={openSettingsPanel}>
              AI setup
            </button>
          </div>
          {settingsOpen && (
            <form className="lw-ai-settings" onSubmit={saveSettings}>
              <div className="lw-ai-settings-head">
                <h3>AI provider setup</h3>
                <button className="btn btn-ghost" type="button" onClick={() => setSettingsOpen(false)}>
                  Close
                </button>
              </div>
              <div className="lw-ai-account-connect">
                <div>
                  <strong>Use OpenRouter</strong>
                  <span>Connect your OpenRouter account. Lightweaver will use OpenRouter for AI pattern generation.</span>
                  <em>ChatGPT and Claude account login are not available directly here.</em>
                </div>
                <button
                  className="btn"
                  type="button"
                  onClick={connectOpenRouterAccount}
                  disabled={settingsPending}
                >
                  Connect OpenRouter account
                </button>
              </div>
              <div className="lw-ai-setup-status">
                <div>
                  <strong>{providerStatus?.configured ? 'Connected key saved' : 'Not connected yet'}</strong>
                  <span>{settings?.cost?.note || 'Uses your OpenRouter account credits.'}</span>
                </div>
                <div>
                  <strong>OAuth callback</strong>
                  <code>{settings?.oauth?.callbackUrl || 'Loading callback URL'}</code>
                  <span>{settings?.oauth?.deploymentMessage || 'Checking callback status.'}</span>
                </div>
              </div>
              <div className="lw-ai-setup-grid">
                <label className="lw-ai-select-row">
                  <span>
                    <strong>Model</strong>
                    <em>{selectedModelPreset?.detail}</em>
                  </span>
                  <select
                    aria-label="AI model preset"
                    value={settingsDraft.modelPreset}
                    onChange={event => updateSettingsChoice('modelPreset', event.target.value)}
                    disabled={settingsPending}
                  >
                    {modelPresets.map(preset => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  <code>{selectedModelPreset?.model}</code>
                </label>
                <label className="lw-ai-select-row">
                  <span>
                    <strong>Pattern quality</strong>
                    <em>{selectedQualityPreset?.detail}</em>
                  </span>
                  <select
                    aria-label="Pattern quality"
                    value={settingsDraft.qualityPreset}
                    onChange={event => updateSettingsChoice('qualityPreset', event.target.value)}
                    disabled={settingsPending}
                  >
                    {qualityPresets.map(preset => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="lw-ai-settings-actions">
                <button className="btn" type="submit" disabled={settingsPending}>
                  {settingsPending ? 'Saving' : 'Save setup'}
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={testConnection}
                  disabled={connectionPending}
                >
                  {connectionPending ? 'Testing' : 'Test connection'}
                </button>
              </div>
              {connectionResult && (
                <div className="lw-ai-connection-result">
                  <strong>{connectionResult.message || 'OpenRouter connection works.'}</strong>
                  {connectionUsage && <span>{connectionUsage}</span>}
                  {connectionResult.account?.label && <em>{connectionResult.account.label}</em>}
                </div>
              )}
              <details className="lw-ai-manual-settings">
                <summary>Advanced: paste OpenRouter key</summary>
                <div className="lw-ai-key-list">
                  {AI_PROVIDER_OPTIONS.filter(option => option.id === PRIMARY_AI_PROVIDER).map(option => {
                    const status = settings?.providers?.find(item => item.id === option.id);
                    return (
                      <label className="lw-ai-key-row" key={option.id}>
                        <span>
                          <strong>{option.keyLabel}</strong>
                          <em>{status?.configured ? 'Saved on this computer. Paste a new key to replace it.' : 'Optional fallback if account connection is unavailable.'}</em>
                        </span>
                        <input
                          aria-label={option.keyLabel}
                          type="password"
                          autoComplete="off"
                          value={settingsDraft.keys[option.id] || ''}
                          onChange={event => updateSettingsKey(option.id, event.target.value)}
                          placeholder={status?.configured ? 'saved, leave blank to keep' : 'paste OpenRouter key'}
                          disabled={settingsPending}
                        />
                      </label>
                    );
                  })}
                </div>
                <div className="lw-ai-settings-actions">
                  <button className="btn" type="submit" disabled={settingsPending}>
                    {settingsPending ? 'Saving' : 'Save AI settings'}
                  </button>
                </div>
              </details>
              {settingsError && <div className="lw-ai-settings-error">{settingsError}</div>}
              {settingsSaved && <div className="lw-ai-settings-saved">{settingsSaved}</div>}
            </form>
          )}
          <div className="lw-ai-workflow">
            <strong>Draft first, accept later</strong>
            <span>Generate creates a preview draft. Your live pattern changes only when you accept it.</span>
          </div>
          <div className="lw-ai-messages" aria-live="polite">
            {messages.length === 0 && (
              <div className="lw-ai-empty">Describe a new direction, or say things like slower, smoother, warmer, or more sparkly.</div>
            )}
            {messages.map((message, index) => (
              <div key={index} className={`lw-ai-message ${message.role} ${message.error ? 'error' : ''}`}>
                {message.text}
              </div>
            ))}
          </div>
          <div className="lw-ai-prompt-chips" aria-label="Quick AI edits">
            {[
              ['Slower', 'Make this slower and smoother'],
              ['Smoother', 'Make the motion smoother with softer transitions'],
              ['Warmer', 'Make the colors warmer, with amber and soft white'],
              ['Less busy', 'Make it less chaotic and easier on the eyes'],
            ].map(([label, prompt]) => (
              <button key={label} type="button" className="btn btn-ghost" onClick={() => addPromptText(prompt)}>
                {label}
              </button>
            ))}
          </div>
          <div className="lw-ai-target-row" aria-label="AI edit target">
            {[
              ['Only color', 'Change only color and palette. Do not change motion.'],
              ['Only motion', 'Change only motion speed and smoothness. Do not change colors.'],
              ['Only shape', 'Change only the pattern shape and spatial structure.'],
            ].map(([label, prompt]) => (
              <button key={label} type="button" className="btn btn-ghost" onClick={() => addPromptText(prompt)}>
                {label}
              </button>
            ))}
          </div>
          {draft && (
            <div className="lw-ai-draft">
              <div className="lw-ai-draft-head">
                <div>
                  <div className="eyebrow">Draft pattern</div>
                  <div className="title">{draft.name}</div>
                </div>
                <span>Preview only</span>
              </div>
              <p>{draft.description}</p>
              <div className="lw-ai-draft-note">
                Accept creates a custom pattern and switches the preview to it.
              </div>
              <div className="lw-ai-swatches">
                {draft.palette.map((color, index) => <span key={`${color}-${index}`} style={{ background: color }}/>)}
              </div>
              <ul>
                {draft.changeSummary.map(item => <li key={item}>{item}</li>)}
              </ul>
              <div className="lw-ai-actions">
                <button className="btn" type="button" onClick={acceptDraft}>Accept and use pattern</button>
                <button className="btn btn-ghost" type="button" onClick={() => setInput('make this draft simpler and safer')}>Simplify</button>
              </div>
            </div>
          )}
          {error && (
            <div className="lw-ai-error">
              <strong>{error.kind}</strong>
              <span>{error.message}</span>
            </div>
          )}
          <div className="lw-ai-input-row">
            <textarea
              value={input}
              onChange={event => setInput(event.target.value)}
              aria-label="AI pattern instruction"
              placeholder="Make this slower and smoother..."
              rows={3}
            />
            <button className="btn" type="button" disabled={pending || !input.trim()} onClick={() => sendInstruction()}>
              {pending ? 'Thinking' : draft ? 'Refine' : 'Generate'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
