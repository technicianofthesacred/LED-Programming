import { useCallback, useEffect, useRef, useState } from 'react';

// The active art piece (pulled from the studio).
const PIECE = 'Willow Canopy';

// Operator door back to the studio (public Lightweaver UI).
const STUDIO_URL = 'https://led.mandalacodes.com';

const SCENES = [
  { id: 1, name: 'Drift', pal: ['#3a2f5e', '#6a55a8', '#9a86c8', '#c8bce0'] },
  { id: 2, name: 'Pulse', pal: ['#0a1a16', '#2a6a5a', '#4aae8c', '#8ae8c8'] },
  { id: 3, name: 'Embers', pal: ['#3a1405', '#a8481a', '#e89a3a', '#f0c878'] },
  { id: 4, name: 'Calm', pal: ['#13403a', '#246e5c', '#4a9a82', '#8fc4b2'] },
  { id: 5, name: 'Bloom', pal: ['#5e2247', '#a8417e', '#d98ab2', '#f0c8da'] },
  { id: 6, name: 'Aurora', pal: ['#1c5a4a', '#2f8f6a', '#7fcf9a', '#bfe9c8'] },
  { id: 7, name: 'Lava Lamp', pal: ['#2a0805', '#7a1c12', '#d8501e', '#f0a040'] },
  { id: 8, name: 'Tidepool', pal: ['#04201f', '#0c5046', '#1f8a8a', '#5fd0d8'] },
  { id: 9, name: 'Solstice', pal: ['#3a1a00', '#9a5400', '#e09020', '#f8d878'] },
  { id: 10, name: 'Nocturne', pal: ['#0a0a24', '#1e2a6a', '#4458b0', '#8aa0e0'] },
  { id: 11, name: 'Rosewood', pal: ['#2a0a14', '#7a2440', '#c05878', '#e8a0b8'] },
  { id: 12, name: 'Moss', pal: ['#0c1c08', '#34521c', '#6e9440', '#b4d080'] },
];

const BEADS = 7;
const STATE_POLL_MS = 5000;
const DEFAULT_STATUS = 'lightweaver.local · connected';

function rgb(h) {
  h = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// Interpolate a palette into N LED bead colors.
function ledColors(pal, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = (i / (n - 1)) * (pal.length - 1);
    const s = Math.floor(p);
    const t = p - s;
    const a = rgb(pal[s]);
    const b = rgb(pal[Math.min(s + 1, pal.length - 1)]);
    out.push('rgb(' + a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',') + ')');
  }
  return out;
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function PowerIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 3v9" />
      <path d="M6.6 6.6a8 8 0 1 0 10.8 0" />
    </svg>
  );
}

function BrightnessIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.2 5.2l1.8 1.8M17 17l1.8 1.8M18.8 5.2 17 7M7 17l-1.8 1.8" />
    </svg>
  );
}

function SpeedIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M5 12h9" />
      <path d="M5 7h13" />
      <path d="M5 17h6" />
      <path d="m17 14 4 3-4 3" />
    </svg>
  );
}

function CycleIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 9a6 6 0 0 1 6-6h7m0 0-3-3m3 3-3 3" />
      <path d="M20 15a6 6 0 0 1-6 6H7m0 0 3 3m-3-3 3-3" />
    </svg>
  );
}

function HueIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export default function App() {
  const [active, setActive] = useState(3);
  const [power, setPower] = useState(true);
  const [brightness, setBrightness] = useState(160);
  const [speed, setSpeed] = useState(100); // 5..300, /100 = multiplier (local-only for now)
  const [hue, setHue] = useState(0); // 0..360 color-shift across the spectrum (local-only for now)
  const [autoCycle, setAutoCycle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ text: DEFAULT_STATUS, err: false });
  const flashTimer = useRef(null);

  // Transient status line: errors auto-revert to the connected line; non-errors stick.
  const flash = useCallback((text, err = false) => {
    setStatus({ text, err });
    clearTimeout(flashTimer.current);
    if (err) {
      flashTimer.current = setTimeout(() => setStatus({ text: DEFAULT_STATUS, err: false }), 2200);
    }
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const s = await getJSON('/api/state');
      if (typeof s.on === 'boolean') setPower(s.on);
      if (typeof s.bri === 'number') setBrightness(s.bri);
      if (typeof s.ps === 'number' && s.ps > 0) setActive(s.ps);
      setStatus((cur) => (cur.err ? { text: DEFAULT_STATUS, err: false } : cur));
    } catch {
      flash('Cannot reach controller', true);
    }
  }, [flash]);

  useEffect(() => {
    refreshState();
    const t = setInterval(refreshState, STATE_POLL_MS);
    return () => {
      clearInterval(t);
      clearTimeout(flashTimer.current);
    };
  }, [refreshState]);

  const choose = async (id) => {
    if (busy) return;
    const prev = active;
    setActive(id);
    setBusy(true);
    const scene = SCENES.find((x) => x.id === id);
    try {
      await postJSON(`/api/preset/${id}`);
      flash('Scene set · ' + scene.name);
    } catch {
      setActive(prev);
      flash('Could not change scene', true);
    } finally {
      setBusy(false);
    }
  };

  const togglePower = async () => {
    const next = !power;
    setPower(next);
    try {
      await postJSON('/api/power', { on: next });
      flash(next ? 'Lights on' : 'Lights off');
    } catch {
      setPower(!next);
      flash('Could not toggle power', true);
    }
  };

  const commitBrightness = async () => {
    try {
      await postJSON('/api/brightness', { bri: brightness });
      flash('Brightness · ' + Math.round((brightness / 255) * 100) + '%');
    } catch {
      flash('Could not set brightness', true);
    }
  };

  const commitSpeed = () => {
    // Local-only for now: no /api/speed route on the bridge yet (WLED sx mapping TBD).
    // When the route lands: await postJSON('/api/speed', { sx: speed });
    flash('Speed · ' + (speed / 100).toFixed(1) + '×');
  };

  const commitHue = () => {
    // Color shift across the spectrum. Local-only for now: no /api/hue route yet
    // (maps to a WLED palette/hue rotation). When it lands: await postJSON('/api/hue', { hue });
    flash('Color shift · ' + hue + '°');
  };

  const toggleAutoCycle = () => {
    // Local-only: auto-cycle maps to a WLED playlist not yet defined.
    setAutoCycle((v) => {
      flash(!v ? 'Auto-cycle on' : 'Auto-cycle off');
      return !v;
    });
  };

  const briPct = Math.round((brightness / 255) * 100);
  const speedPct = Math.round(((speed - 5) / 295) * 100);
  const huePct = Math.round((hue / 360) * 100);

  return (
    <div className={`kiosk${power ? '' : ' off'}`}>
      <div className="topbar">
        <div className="tb-actions">
          <button
            type="button"
            className={`power${power ? ' on' : ''}`}
            onClick={togglePower}
            aria-pressed={power}
            aria-label="Power"
          >
            <PowerIcon />
          </button>
          <button
            type="button"
            className={`toggle${autoCycle ? ' on' : ''}`}
            onClick={toggleAutoCycle}
            aria-pressed={autoCycle}
          >
            <CycleIcon />
            Auto-cycle
          </button>
        </div>
        <a className="studio-btn" href={STUDIO_URL} title="Open the design studio">
          Operator Studio <span className="ar">↗</span>
        </a>
      </div>

      <header>
        <h1>{PIECE}</h1>
      </header>

      <main className="scenes" role="group" aria-label="Scenes">
        {SCENES.map((s) => {
          const isActive = active === s.id;
          const beads = ledColors(s.pal, BEADS);
          return (
            <button
              key={s.id}
              type="button"
              className={`scene${isActive ? ' active' : ''}`}
              onClick={() => choose(s.id)}
              disabled={busy && !isActive}
              aria-pressed={isActive}
            >
              <div className="scene-led">
                <div className="ledrow">
                  {beads.map((c, i) => (
                    <span
                      key={i}
                      className="led wave"
                      style={{ background: c, boxShadow: `0 0 9px ${c}, 0 0 20px ${c}`, animationDelay: `${i * 0.11}s` }}
                    />
                  ))}
                </div>
              </div>
              <div className="scene-veil" />
              <div className="scene-meta">
                <span className="nm">{s.name}</span>
                <span className="num">{String(s.id).padStart(2, '0')}</span>
              </div>
            </button>
          );
        })}
      </main>

      <footer>
        <div className="bri">
          <span className="ico"><BrightnessIcon /></span>
          <input
            type="range"
            min="0"
            max="255"
            value={brightness}
            aria-label="Brightness"
            style={{ '--p': `${briPct}%` }}
            onChange={(e) => setBrightness(Number(e.target.value))}
            onMouseUp={commitBrightness}
            onTouchEnd={commitBrightness}
          />
          <span className="val">{briPct}%</span>
        </div>

        <div className="bri">
          <span className="ico"><SpeedIcon /></span>
          <input
            type="range"
            min="5"
            max="300"
            value={speed}
            aria-label="Speed"
            style={{ '--p': `${speedPct}%` }}
            onChange={(e) => setSpeed(Number(e.target.value))}
            onMouseUp={commitSpeed}
            onTouchEnd={commitSpeed}
          />
          <span className="val">{(speed / 100).toFixed(1)}×</span>
        </div>

        <div className="bri hue">
          <span className="ico"><HueIcon /></span>
          <input
            type="range"
            min="0"
            max="360"
            value={hue}
            aria-label="Color shift"
            style={{ '--p': `${huePct}%` }}
            onChange={(e) => setHue(Number(e.target.value))}
            onMouseUp={commitHue}
            onTouchEnd={commitHue}
          />
          <span className="val">{hue}°</span>
        </div>
      </footer>

      <div className={`status${status.err ? ' err' : ''}`} aria-live="polite">
        <span className="dot" />
        <span>{status.text}</span>
      </div>
    </div>
  );
}
