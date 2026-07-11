// Small presentational leaf components shared across the Layout screen's
// inspector panels. Extracted verbatim from LayoutScreen.jsx (Phase 2 step 2
// of docs/layout-redesign-plan.md); behavior is unchanged, only the module
// boundary moved.
import { useState, useRef } from 'react';

// ── SVG icon helpers ───────────────────────────────────────────────────────

export const EyeIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ width: 12, height: 12, flexShrink: 0 }}>
    <path d="M1 6s2-4 5-4 5 4 5 4-2 4-5 4-5-4-5-4z"/>
    <circle cx="6" cy="6" r="1.5"/>
  </svg>
);

export const EyeOffIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ width: 12, height: 12, flexShrink: 0 }}>
    <path d="M1 1l10 10M5 2.5A5 5 0 0 1 11 6s-.5 1-1.5 2M7.5 9.5A5 5 0 0 1 1 6s2-4 5-4"/>
  </svg>
);

export const ChevronRightIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 10, height: 10, flexShrink: 0 }}>
    <path d="M4.5 3l3 3-3 3"/>
  </svg>
);

export const ChevronDownIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 10, height: 10, flexShrink: 0 }}>
    <path d="M3 4.5l3 3 3-3"/>
  </svg>
);

export const DragHandleIcon = () => (
  <svg viewBox="0 0 8 12" fill="currentColor" style={{ width: 8, height: 12, flexShrink: 0 }}>
    <circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/>
    <circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/>
    <circle cx="2" cy="10" r="1"/><circle cx="6" cy="10" r="1"/>
  </svg>
);

export const GroupIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ width: 11, height: 11, flexShrink: 0 }}>
    <rect x="1" y="1" width="4" height="4" rx="1"/>
    <rect x="7" y="1" width="4" height="4" rx="1"/>
    <rect x="1" y="7" width="4" height="4" rx="1"/>
    <rect x="7" y="7" width="4" height="4" rx="1"/>
  </svg>
);

// ── Mockup (v3) stroked icon set — warm toolbar / inspector glyphs ─────────
export const TbIcon = {
  import: <svg viewBox="0 0 24 24"><path d="M12 4v12M8 12l4 4 4-4"/><path d="M5 20h14"/></svg>,
  draw: <svg viewBox="0 0 24 24"><path d="m15 5 4 4L8 20l-5 1 1-5z"/><path d="M13 7l4 4"/></svg>,
  undo: <svg viewBox="0 0 24 24"><path d="M9 7 4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10"/></svg>,
  redo: <svg viewBox="0 0 24 24"><path d="m15 7 5 5-5 5"/><path d="M20 12H9a5 5 0 0 0 0 10"/></svg>,
  load: <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>,
  save: <svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 14h8v7H8z"/></svg>,
  bulb: <svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10c1 1 1.5 2 1.5 3h5c0-1 .5-2 1.5-3a6 6 0 0 0-4-10z"/></svg>,
  grid: <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  heat: <svg viewBox="0 0 24 24"><path d="M12 3c-2 3-4 4-4 7a4 4 0 0 0 8 0c0-3-2-4-4-7z"/></svg>,
  strip: <svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6" rx="2"/><path d="M7 9v6M11 9v6M15 9v6"/></svg>,
  check: <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 6"/></svg>,
  eye: <svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>,
  eyeOff: <svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3.6M6.6 6.6A18 18 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4-.8"/></svg>,
};

// ── Compass — directed/omni emit angle dial (mockup .la-compass) ──────────
export function EmitCompass({ angle, setAngle, omni }) {
  const cx = 34, cy = 34, r = 26;
  const a = (angle - 90) * Math.PI / 180;
  const nx = cx + Math.cos(a) * r, ny = cy + Math.sin(a) * r;
  return (
    <div className="la-compass-wrap">
      <svg className="la-compass" viewBox="0 0 68 68" style={{ opacity: omni ? 0.4 : 1 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth="1"/>
        <circle cx={cx} cy={cy} r="2.5" fill="var(--accent)"/>
        {[0, 90, 180, 270].map(d => {
          const t = (d - 90) * Math.PI / 180;
          return <line key={d} x1={cx + Math.cos(t) * (r - 4)} y1={cy + Math.sin(t) * (r - 4)}
                       x2={cx + Math.cos(t) * r} y2={cy + Math.sin(t) * r}
                       stroke="var(--text-faint)" strokeWidth="1"/>;
        })}
        {omni
          ? <circle cx={cx} cy={cy} r={r - 7} fill="var(--accent-soft)" stroke="var(--accent-line)" strokeDasharray="2 3"/>
          : <><line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/><circle cx={nx} cy={ny} r="3.5" fill="var(--accent)"/></>}
      </svg>
      <div className="la-compass-ctrl">
        <span className="la-offset-lab">Offset</span>
        <input className="lw" type="range" min="-180" max="180" step="1" value={angle} disabled={omni}
               onChange={e => setAngle(parseInt(e.target.value, 10))}/>
        <span className="la-offset-v">{angle}°</span>
      </div>
    </div>
  );
}

export function InlineRename({ value, onCommit, className, style }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(value);
  const inputRef              = useRef(null);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== value) onCommit(t);
  };

  if (!editing) {
    return (
      <span className={className} style={style}
            title="Double-click to rename"
            onDoubleClick={e => { e.stopPropagation(); setDraft(value); setEditing(true); setTimeout(() => inputRef.current?.select(), 20); }}>
        {value}
      </span>
    );
  }
  return (
    <input ref={inputRef} value={draft} autoFocus
           onChange={e => setDraft(e.target.value)}
           onBlur={commit}
           onKeyDown={e => {
             if (e.key === 'Enter') { e.preventDefault(); commit(); }
             if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
           }}
           onClick={e => e.stopPropagation()}
           style={{ ...style, background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 3,
                    padding: '0 5px', color: 'var(--text)', fontSize: 'inherit', fontFamily: 'inherit', outline: 'none', minWidth: 0 }}/>
  );
}

// ── Light visualization sub-components ────────────────────────────────────

export function LightCone({ uid, cx, cy, angle, color, reach = 90, intensity = 0.5 }) {
  const gid = `lcg-${uid}`;
  const a = (angle - 90) * Math.PI / 180;
  const spread = 34 * Math.PI / 180;
  const fx = cx + Math.cos(a) * reach * 0.42;
  const fy = cy + Math.sin(a) * reach * 0.42;
  const left = { x: cx + Math.cos(a - spread) * reach, y: cy + Math.sin(a - spread) * reach };
  const right = { x: cx + Math.cos(a + spread) * reach, y: cy + Math.sin(a + spread) * reach };
  const far = { x: cx + Math.cos(a) * reach * 1.08, y: cy + Math.sin(a) * reach * 1.08 };
  return (
    <>
      <defs>
        <radialGradient id={gid} cx={fx} cy={fy} r={reach} gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor={color} stopOpacity={0.95 * intensity}/>
          <stop offset="48%"  stopColor={color} stopOpacity={0.28 * intensity}/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </radialGradient>
      </defs>
      <path
        data-light-cone={uid}
        d={`M ${cx} ${cy} L ${left.x} ${left.y} Q ${far.x} ${far.y} ${right.x} ${right.y} Z`}
        fill={`url(#${gid})`}
        opacity={0.9}
        style={{ mixBlendMode: 'screen' }}
      />
    </>
  );
}

export function OmniHalo({ uid, cx, cy, color, reach = 90, intensity = 0.5 }) {
  const gid = `ohg-${uid}`;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx={cx} cy={cy} r={reach} gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor={color} stopOpacity={0.8 * intensity}/>
          <stop offset="60%"  stopColor={color} stopOpacity={0.2 * intensity}/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={reach} fill={`url(#${gid})`} style={{ mixBlendMode: 'screen' }}/>
    </>
  );
}
