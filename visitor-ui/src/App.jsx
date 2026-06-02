import { useCallback, useEffect, useState } from 'react';

const BRAND = {
  artist: 'Adrian Rasmussen',
  piece: 'Piece 01',
  accent: '#e8b14a',
};

const SCENES = [
  { id: 1, name: 'Drift' },
  { id: 2, name: 'Pulse' },
  { id: 3, name: 'Embers' },
  { id: 4, name: 'Calm' },
  { id: 5, name: 'Bloom' },
];

const STATE_POLL_MS = 5000;

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

export default function App() {
  const [activePreset, setActivePreset] = useState(null);
  const [power, setPower] = useState(true);
  const [brightness, setBrightness] = useState(160);
  const [busy, setBusy] = useState(false);
  const [pressedId, setPressedId] = useState(null);
  const [error, setError] = useState('');

  const refreshState = useCallback(async () => {
    try {
      const s = await getJSON('/api/state');
      if (typeof s.on === 'boolean') setPower(s.on);
      if (typeof s.bri === 'number') setBrightness(s.bri);
      if (typeof s.ps === 'number' && s.ps > 0) setActivePreset(s.ps);
      setError('');
    } catch (e) {
      setError('Cannot reach controller');
    }
  }, []);

  useEffect(() => {
    refreshState();
    const t = setInterval(refreshState, STATE_POLL_MS);
    return () => clearInterval(t);
  }, [refreshState]);

  const choosePreset = async (id) => {
    if (busy) return;
    setBusy(true);
    setPressedId(id);
    try {
      await postJSON(`/api/preset/${id}`);
      setActivePreset(id);
      setError('');
    } catch {
      setError('Could not change scene');
    } finally {
      setBusy(false);
      setTimeout(() => setPressedId(null), 180);
    }
  };

  const togglePower = async () => {
    const next = !power;
    setPower(next);
    try {
      await postJSON('/api/power', { on: next });
      setError('');
    } catch {
      setPower(!next);
      setError('Could not toggle power');
    }
  };

  const onBrightness = (e) => {
    const v = Number(e.target.value);
    setBrightness(v);
  };

  const commitBrightness = async () => {
    try {
      await postJSON('/api/brightness', { bri: brightness });
      setError('');
    } catch {
      setError('Could not set brightness');
    }
  };

  return (
    <div className="app" style={{ '--accent': BRAND.accent }}>
      <header className="brand">
        <div className="wordmark">{BRAND.artist}</div>
        <h1 className="piece">{BRAND.piece}</h1>
      </header>

      <main className="grid" role="group" aria-label="Scenes">
        {SCENES.map((s) => {
          const active = activePreset === s.id;
          const pressed = pressedId === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className={`tile${active ? ' active' : ''}${pressed ? ' pressed' : ''}`}
              onClick={() => choosePreset(s.id)}
              disabled={busy && pressedId !== s.id}
              aria-pressed={active}
            >
              <span className="tile-name">{s.name}</span>
              <span className="tile-num">{String(s.id).padStart(2, '0')}</span>
            </button>
          );
        })}
      </main>

      <footer className="controls">
        <div className="bri">
          <label htmlFor="bri">Brightness</label>
          <input
            id="bri"
            type="range"
            min="0"
            max="255"
            value={brightness}
            onChange={onBrightness}
            onMouseUp={commitBrightness}
            onTouchEnd={commitBrightness}
          />
        </div>
        <button
          type="button"
          className={`power${power ? ' on' : ''}`}
          onClick={togglePower}
          aria-pressed={power}
        >
          {power ? 'On' : 'Off'}
        </button>
      </footer>

      <div className="status" aria-live="polite">{error}</div>
    </div>
  );
}
