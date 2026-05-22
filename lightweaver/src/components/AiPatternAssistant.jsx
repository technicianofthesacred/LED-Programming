import { useMemo, useState } from 'react';
import { requestAiPatternDraft } from '../lib/aiPatternClient.js';
import { validateAiPatternDraft } from '../lib/aiPatternDraft.js';
import { getPatternById, isBuiltInPattern } from '../lib/patternRegistry.js';

function buildProjectContext(strips = [], audioBands = null) {
  const visible = (Array.isArray(strips) ? strips : []).filter(strip => !strip.hidden);
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
  audioBands,
  onAcceptDraft,
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState(null);
  const [validated, setValidated] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const sourcePattern = useMemo(
    () => sourceFromPattern(patternId, palette, params),
    [patternId, palette, params],
  );

  const sendInstruction = async (modeOverride = null) => {
    const instruction = input.trim();
    if (!instruction || !sourcePattern || pending) return;
    setPending(true);
    setError(null);
    setMessages(prev => [...prev, { role: 'user', text: instruction }]);
    try {
      const rawDraft = await requestAiPatternDraft({
        mode: modeOverride || (draft ? 'refine' : 'transform'),
        instruction,
        sourcePattern,
        draftPattern: draft,
        projectContext: buildProjectContext(strips, audioBands),
      });
      const result = validateAiPatternDraft(rawDraft, { instruction, strips, audioBands });
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
      setError({ kind: requestError.code || 'request-failed', message: requestError.message });
      setMessages(prev => [...prev, { role: 'assistant', text: requestError.message, error: true }]);
    } finally {
      setPending(false);
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
          {draft && (
            <div className="lw-ai-draft">
              <div className="lw-ai-draft-head">
                <div>
                  <div className="eyebrow">Draft pattern</div>
                  <div className="title">{draft.name}</div>
                </div>
                <span>not applied</span>
              </div>
              <p>{draft.description}</p>
              <div className="lw-ai-swatches">
                {draft.palette.map((color, index) => <span key={`${color}-${index}`} style={{ background: color }}/>)}
              </div>
              <ul>
                {draft.changeSummary.map(item => <li key={item}>{item}</li>)}
              </ul>
              <div className="lw-ai-actions">
                <button className="btn" type="button" onClick={acceptDraft}>Accept</button>
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
