/* Light Weaver v3 — Show / Voices: one card per motif, played like an
   instrument rather than configured like a settings screen.

   THE RULE THIS FILE IS HELD TO
   Nothing opens a dialog. Nothing needs saving before it is heard. Every
   control changes the piece while the music is still playing.

   The behaviour that makes it feel like an instrument is HOLD-TO-AUDITION:
   press and hold a chip and that choice applies live; slide to another chip
   without lifting and you hear that one instead; release and whatever you are
   hearing is what you keep. It is implemented on POINTER events with an
   explicit pointer capture, because touch is the case that matters — the
   owner is standing in front of the wall with a phone. On touch, a pointer is
   captured to the element it started on and `pointerenter` never fires on the
   chip you slide onto, so the chip under the finger is found with
   document.elementFromPoint() on every move instead of with hover events.
   `touch-action: none` on the row is what stops the page scrolling under the
   drag. A plain click still commits, so keyboard and assistive tech keep
   working; committing the same value twice is a no-op. */
import React, { useCallback, useRef } from 'react';
import { voiceSentenceTokens, groundSentenceTokens } from '../lib/showVoiceSentence.js';
import { BAND_CHOICES, CHARACTER_CHOICES, bandLabel } from '../lib/showEnsembleBench.js';

// Mirrors chipStyle() in lw-show.jsx. Deliberately duplicated rather than
// imported: lw-show.jsx imports this file, and importing back would make the
// module graph circular.
const chipStyle = (on) => ({
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  border: `1px solid ${on ? 'var(--accent)' : 'var(--border-soft)'}`,
  background: on ? 'var(--accent)' : 'var(--bg-elev)',
  color: on ? 'var(--on-accent)' : 'var(--text-mid)',
});

function sentence(tokens) {
  return tokens.map((t) => t.text).join('');
}

/**
 * A row of chips with hold-to-audition. `options` is [{ value, label, extra }]
 * where `value` is stringified into the DOM and handed back verbatim.
 *   onAudition(value | null) — fires while a finger/button is down
 *   onCommit(value)          — fires on release, and on a plain click
 */
function AuditionChips({ label, value, options, onAudition, onCommit, testId }) {
  const rowRef = useRef(null);
  const heldRef = useRef(null);

  const valueAt = useCallback((clientX, clientY) => {
    if (typeof document === 'undefined' || !document.elementFromPoint) return null;
    const el = document.elementFromPoint(clientX, clientY);
    const chip = el && el.closest ? el.closest('[data-audition-value]') : null;
    if (!chip || !rowRef.current || !rowRef.current.contains(chip)) return null;
    return chip.getAttribute('data-audition-value');
  }, []);

  const onPointerDown = useCallback((event) => {
    const next = valueAt(event.clientX, event.clientY);
    if (next === null) return;
    // Capture on the ROW, not the chip, so a finger sliding across siblings
    // keeps delivering moves here instead of to whichever chip it started on.
    try { rowRef.current.setPointerCapture(event.pointerId); } catch { /* older Safari */ }
    heldRef.current = next;
    onAudition(next);
  }, [onAudition, valueAt]);

  const onPointerMove = useCallback((event) => {
    if (heldRef.current === null) return;
    const next = valueAt(event.clientX, event.clientY);
    if (next === null || next === heldRef.current) return;
    heldRef.current = next;
    onAudition(next);
  }, [onAudition, valueAt]);

  const endHold = useCallback((commit) => {
    const held = heldRef.current;
    heldRef.current = null;
    onAudition(null);
    if (commit && held !== null) onCommit(held);
  }, [onAudition, onCommit]);

  return (
    <div style={{ marginTop: 8 }}>
      {label && (
        <div className="mono" style={{ fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 5 }}>{label}</div>
      )}
      <div
        ref={rowRef}
        data-testid={testId}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endHold(true)}
        onPointerCancel={() => endHold(false)}
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            data-audition-value={opt.value}
            aria-pressed={String(value) === String(opt.value)}
            title={opt.title}
            onClick={() => onCommit(opt.value)}
            style={{
              ...chipStyle(String(value) === String(opt.value)),
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: 4,
              minWidth: opt.extra ? 56 : undefined,
            }}
          >
            <span style={{ pointerEvents: 'none' }}>{opt.label}</span>
            {opt.extra}
          </button>
        ))}
      </div>
    </div>
  );
}

/* A band chip's own little flame. Four of these side by side turn "which band
   should this motif follow?" from an abstract question into a visual one: watch
   which one dances the way you want, hold it, keep it. */
function ChipFlame({ value, on }) {
  const pct = Math.round(Math.min(1, Math.max(0, value || 0)) * 100);
  return (
    <span style={{ display: 'block', height: 4, borderRadius: 2, background: on ? 'rgba(0,0,0,.28)' : 'var(--bg-elev-2)', overflow: 'hidden', pointerEvents: 'none' }}>
      <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: on ? 'var(--on-accent)' : 'var(--accent)' }} />
    </span>
  );
}

/* The most-touched control on the screen, so it gets a 30px-tall grab strip
   instead of the 4px track the tune panel's sliders use. The track is painted
   by the wrapper; the input sits transparent on top of it. */
function FatSlider({ label, readout, value, min = 0, max = 1, step = 0.01, onChange, testId }) {
  const frac = max > min ? (value - min) / (max - min) : 0;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
        <span style={{ color: 'var(--text-mid)' }}>{label}</span>
        <span className="mono" style={{ color: 'var(--text-hi)' }}>{readout}</span>
      </div>
      <div style={{ position: 'relative', height: 30, display: 'flex', alignItems: 'center' }}>
        <span style={{ position: 'absolute', left: 0, right: 0, height: 10, borderRadius: 99, background: 'var(--bg-elev-2)', pointerEvents: 'none' }} />
        <span style={{ position: 'absolute', left: 0, width: `${Math.round(frac * 100)}%`, height: 10, borderRadius: 99, background: 'var(--accent)', pointerEvents: 'none' }} />
        <input
          className="lw"
          type="range"
          data-testid={testId}
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{ position: 'relative', width: '100%', height: 30, background: 'transparent' }}
        />
      </div>
    </div>
  );
}

function VoiceCard({ voice, levels, expanded, soloed, dimmed, onExpand, onSolo, onCommit, onAudition }) {
  const summary = sentence(voiceSentenceTokens({
    areaId: voice.areaId,
    areaName: voice.name,
    character: voice.character,
    band: voice.band,
    bandLabel: bandLabel(voice.band),
    depth: voice.depth,
    resolved: !voice.unresolved,
    field: voice.fold > 1 ? { fold: voice.fold } : null,
    spread: voice.spread,
    direction: voice.direction,
  }));

  return (
    <div
      data-testid={`show-voice-${voice.id}`}
      style={{
        border: `1px solid ${soloed ? 'var(--accent)' : 'var(--border-hair)'}`,
        borderRadius: 'var(--r-md)',
        background: 'var(--bg-elev)',
        padding: '10px 12px',
        marginBottom: 8,
        opacity: dimmed ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          data-testid={`show-voice-expand-${voice.id}`}
          onClick={() => onExpand(expanded ? null : voice.id)}
          aria-expanded={expanded}
          style={{ flex: 1, minWidth: 0, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer' }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-hi)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{voice.name}</span>
            {voice.fold > 1 && (
              <span className="mono" style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 99, border: '1px solid var(--border-soft)', color: 'var(--text-faint)' }}>×{voice.fold}</span>
            )}
          </span>
          <span style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-lo)' }}>{summary}</span>
        </button>
        <button
          type="button"
          data-testid={`show-voice-solo-${voice.id}`}
          onClick={() => onSolo(soloed ? null : voice.id)}
          aria-pressed={soloed}
          title="Hear this motif against the rest of the piece, dimmed — never alone."
          style={{ ...chipStyle(soloed), fontSize: 11, padding: '5px 10px' }}
        >
          Solo
        </button>
      </div>

      {expanded && (
        <div data-testid={`show-voice-panel-${voice.id}`}>
          <AuditionChips
            label="Character"
            testId={`show-voice-character-${voice.id}`}
            value={voice.character}
            options={CHARACTER_CHOICES.map((c) => ({ value: c.key, label: c.label, title: `This motif ${c.verb}` }))}
            onAudition={(v) => onAudition(v === null ? null : { character: v })}
            onCommit={(v) => onCommit({ character: v })}
          />
          <AuditionChips
            label="Listens to"
            testId={`show-voice-band-${voice.id}`}
            value={voice.band}
            options={BAND_CHOICES.map((b) => ({
              value: b.key,
              label: b.label,
              title: `Follow the ${b.label}`,
              extra: <ChipFlame value={levels?.[b.meter]} on={voice.band === b.key} />,
            }))}
            onAudition={(v) => onAudition(v === null ? null : { band: v })}
            onCommit={(v) => onCommit({ band: v })}
          />
          <FatSlider
            label="Depth"
            testId={`show-voice-depth-${voice.id}`}
            readout={`${Math.round(voice.depth * 100)}%`}
            value={voice.depth}
            onChange={(v) => onCommit({ depth: v })}
          />
          {voice.fold > 1 && (
            <>
              <FatSlider
                label="Spread"
                testId={`show-voice-spread-${voice.id}`}
                readout={voice.spread === 0 ? 'as one body' : `${Math.round(voice.spread * 100)}%`}
                value={voice.spread}
                onChange={(v) => onCommit({ spread: v })}
              />
              <AuditionChips
                label="Direction"
                testId={`show-voice-direction-${voice.id}`}
                value={voice.direction}
                options={[
                  { value: '1', label: 'clockwise' },
                  { value: '-1', label: 'counter-clockwise' },
                ]}
                onAudition={(v) => onAudition(v === null ? null : { direction: Number(v) })}
                onCommit={(v) => onCommit({ direction: Number(v) })}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function GroundCard({ ground, expanded, dimmed, onExpand, onGround }) {
  const level = Number.isFinite(ground?.level) ? ground.level : 0.12;
  const summary = sentence(groundSentenceTokens({ depth: level }));
  return (
    <div
      data-testid="show-voice-ground"
      style={{
        border: '1px solid var(--border-hair)',
        borderRadius: 'var(--r-md)',
        background: 'var(--bg-elev)',
        padding: '10px 12px',
        opacity: dimmed ? 0.55 : 1,
      }}
    >
      <button
        type="button"
        data-testid="show-voice-expand-ground"
        onClick={() => onExpand(expanded ? null : 'ground')}
        aria-expanded={expanded}
        style={{ width: '100%', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer' }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-hi)' }}>Ground</span>
        <span style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-lo)' }}>{summary}</span>
      </button>
      {expanded && (
        <FatSlider
          label="Coals"
          testId="show-voice-ground-level"
          readout={`${Math.round(level * 100)}%`}
          value={level}
          min={0}
          max={0.4}
          onChange={(v) => onGround({ level: v })}
        />
      )}
    </div>
  );
}

/**
 * ShowVoices — the whole voice list. Every prop is a plain value or a
 * callback; this component owns no composition state, so a chip press lands
 * in the engine on the same tick it lands in React.
 */
export function ShowVoices({
  voices = [],
  ground = null,
  levels = null,
  soloVoiceId = null,
  expandedId = null,
  onExpand,
  onSolo,
  onCommit,
  onAudition,
  onGround,
  onRebuild,
}) {
  return (
    <div data-testid="show-voices">
      <div className="sec-h">
        <span className="t">Voices</span>
        <span className="line" />
        {onRebuild && (
          <button type="button" className="btn" style={{ fontSize: 11 }} data-testid="show-voices-rebuild" onClick={onRebuild} title="Start again from your layout's own named parts">
            Start over
          </button>
        )}
      </div>
      {voices.length === 0 && (
        <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-faint)', marginBottom: 10 }}>
          Nothing in this layout is voiced yet. Draw some strips (or group them
          by name on the Layout screen), then press Start over.
        </div>
      )}
      {voices.map((voice) => (
        <VoiceCard
          key={voice.id}
          voice={voice}
          levels={levels}
          expanded={expandedId === voice.id}
          soloed={soloVoiceId === voice.id}
          dimmed={Boolean(soloVoiceId) && soloVoiceId !== voice.id}
          onExpand={onExpand}
          onSolo={onSolo}
          onCommit={(patch) => onCommit(voice.id, patch)}
          onAudition={(patch) => onAudition(patch === null ? null : { voiceId: voice.id, patch })}
        />
      ))}
      <GroundCard
        ground={ground}
        expanded={expandedId === 'ground'}
        dimmed={Boolean(soloVoiceId)}
        onExpand={onExpand}
        onGround={onGround}
      />
      <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-faint)', marginTop: 10 }}>
        Hold a chip to hear it, slide to another to compare, let go to keep it.
        Everything saves itself.
      </div>
    </div>
  );
}

export default ShowVoices;
