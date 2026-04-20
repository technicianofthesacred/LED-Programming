import { useState, useEffect } from 'react';

const DEFAULTS = { theme: 'studio', density: 'comfy', font: 'sans', panelWidth: 'normal' };

export function useTweaks() {
  const [tweaks, setTweaks] = useState(DEFAULTS);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onMsg = (e) => {
      if (!e.data) return;
      if (e.data.type === '__activate_edit_mode')   setVisible(true);
      if (e.data.type === '__deactivate_edit_mode') setVisible(false);
    };
    window.addEventListener('message', onMsg);
    try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch {}
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('theme-lab',  tweaks.theme === 'lab');
    document.body.classList.toggle('theme-neon', tweaks.theme === 'neon');
    document.body.classList.toggle('font-mono',  tweaks.font === 'mono');
    document.documentElement.style.setProperty('--density',
      tweaks.density === 'compact' ? '0.82' :
      tweaks.density === 'cozy'    ? '1' : '1.15');
  }, [tweaks]);

  const set = (k, v) => {
    setTweaks(prev => ({ ...prev, [k]: v }));
    try { window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [k]: v } }, '*'); } catch {}
  };

  return { tweaks, visible, set };
}

export function TweaksPanel({ tweaks, visible, set }) {
  if (!visible) return null;
  const Seg = ({ k, opts }) => (
    <div className="lw-tweaks-seg">
      {opts.map(([v, l]) => (
        <button key={v} className={tweaks[k] === v ? 'active' : ''} onClick={() => set(k, v)}>{l}</button>
      ))}
    </div>
  );
  return (
    <div className="lw-tweaks">
      <div className="lw-tweaks-header">
        <h3>Tweaks</h3>
        <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-4)' }}>live</span>
      </div>
      <div className="lw-tweaks-row">
        <label>Direction</label>
        <Seg k="theme" opts={[['studio','Studio Dark'],['lab','Lab Light'],['neon','Neon Console']]}/>
      </div>
      <div className="lw-tweaks-row">
        <label>Density</label>
        <Seg k="density" opts={[['compact','Compact'],['cozy','Cozy'],['comfy','Comfy']]}/>
      </div>
      <div className="lw-tweaks-row">
        <label>UI Font</label>
        <Seg k="font" opts={[['sans','Sans'],['mono','Mono']]}/>
      </div>
      <div className="lw-tweaks-row">
        <label>Panel width</label>
        <Seg k="panelWidth" opts={[['normal','Normal'],['wide','Wide']]}/>
      </div>
      <div style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-4)', lineHeight: 1.4, marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        Three directions, one IA. All tweaks persist on refresh.
      </div>
    </div>
  );
}
