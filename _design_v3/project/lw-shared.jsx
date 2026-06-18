/* global window */
/* Shared data + icons for Light Weaver v3 screens.
   Attaches everything to window.LW so each Babel script can read it. */
(function () {
  const I = {
    search: <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>,
    play: <svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/></svg>,
    pause: <svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/></svg>,
    toStart: <svg viewBox="0 0 24 24"><path d="M6 5v14M19 5l-9 7 9 7z" fill="currentColor" stroke="currentColor" strokeLinejoin="round"/></svg>,
    loop: <svg viewBox="0 0 24 24"><path d="M4 9a6 6 0 0 1 6-6h7m0 0-3-3m3 3-3 3"/><path d="M20 15a6 6 0 0 1-6 6H7m0 0 3 3m-3-3 3-3"/></svg>,
    download: <svg viewBox="0 0 24 24"><path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>,
    doc: <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>,
    chevron: <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>,
    chevronD: <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>,
    x: <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>,
    check: <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 6"/></svg>,
    plus: <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>,
    dice: <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/><circle cx="15" cy="9" r="1.1" fill="currentColor"/><circle cx="9" cy="15" r="1.1" fill="currentColor"/></svg>,
    scissors: <svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 8l12 10M8 16 20 6"/></svg>,
    copy: <svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>,
    trash: <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>,
    target: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/></svg>,
    bolt: <svg viewBox="0 0 24 24"><path d="M13 3 5 13h6l-1 8 8-10h-6z"/></svg>,
    info: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>,
    snap: <svg viewBox="0 0 24 24"><path d="M6 3v18M18 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/></svg>,
    wand: <svg viewBox="0 0 24 24"><path d="m5 19 9-9M14 6l1.5 1.5"/></svg>,
    mirror: <svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M9 7 5 12l4 5zM15 7l4 5-4 5z"/></svg>,
    open: <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>,
    refresh: <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-1.5 5.5"/><path d="M20 5v5h-5"/></svg>,
    wrench: <svg viewBox="0 0 24 24"><path d="M14.5 6a3.5 3.5 0 0 0 4.5 4.5L21 12l-9 9-3-3 9-9 1.5-3.5A3.5 3.5 0 0 0 14.5 6z"/></svg>,
    dots: <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>,
  };

  // ── Pattern bank ─────────────────────────────────────────────────────
  // pal = palette swatches shown on each card; sp = speed tag
  const P = (id, label, cat, sp, grad, pal, desc) => ({ id, label, cat, sp, grad, pal, desc });
  const PATTERNS = [
    P('aurora', 'Aurora', 'calm', 'SLOW', 'linear-gradient(110deg,#1c5a4a,#2f8f6a,#7fcf9a,#bfe9c8)', ['#1c5a4a','#2f8f6a','#7fcf9a','#bfe9c8'], 'Slow ribbons of green-gold light drifting like northern lights.'),
    P('breathe', 'Breathe', 'calm', 'SLOW', 'linear-gradient(110deg,#0e3a33,#1f7a63,#3fae8c)', ['#0e3a33','#1f7a63','#3fae8c','#7fd0b8'], 'A single soft swell rising and falling on a calm cycle.'),
    P('calm', 'Calm', 'calm', 'SLOW', 'linear-gradient(110deg,#13403a,#246e5c,#4a9a82)', ['#13403a','#246e5c','#4a9a82','#8fc4b2'], 'Minimal, near-still wash — the quiet open of a show.'),
    P('drift', 'Drift', 'calm', 'SLOW', 'linear-gradient(110deg,#3a2f5e,#6a55a8,#9a86c8)', ['#3a2f5e','#6a55a8','#9a86c8','#c8bce0'], 'Slow movement through a muted violet field.'),
    P('bloom', 'Bloom', 'calm', 'SLOW', 'linear-gradient(110deg,#5e2247,#a8417e,#d98ab2)', ['#5e2247','#a8417e','#d98ab2','#f0c8da'], 'A warm dusty-rose build expanding from the center out.'),
    P('warm-white', 'Warm White', 'warm', 'SLOW', 'linear-gradient(110deg,#3a2a14,#8a6a3a,#e8cf9a)', ['#3a2a14','#8a6a3a','#c8a868','#e8cf9a'], 'Plain warm white — gallery house light.'),
    P('ocean', 'Ocean', 'water', 'SLOW', 'linear-gradient(110deg,#0c2f4a,#1f6a8a,#4aa8c8)', ['#0c2f4a','#1f6a8a','#4aa8c8','#8fd0e0'], 'Deep blue swells rolling across the artwork.'),
    P('ripple', 'Ripple', 'water', 'MED', 'linear-gradient(110deg,#123f4a,#2a8a8a,#6ad0c8)', ['#123f4a','#2a8a8a','#6ad0c8','#b0e8e0'], 'Concentric rings spreading from a touch point.'),
    P('wave', 'Wave', 'water', 'MED', 'linear-gradient(110deg,#1c3a6e,#3a6ac8,#8aa8e0)', ['#1c3a6e','#3a6ac8','#6a90e0','#a8c0f0'], 'Travelling sine wave sweeping out to the edges.'),
    P('plasma', 'Plasma', 'water', 'MED', 'linear-gradient(110deg,#3a1c5e,#7a3aae,#b88ad0)', ['#3a1c5e','#7a3aae','#b88ad0','#e0c8f0'], 'Organic, lava-lamp colour fields folding into each other.'),
    P('fire', 'Fire', 'warm', 'MED', 'linear-gradient(0deg,#3a0a00,#a82a00,#e85a1a,#ffcf6a)', ['#3a0a00','#a82a00','#e85a1a','#ffcf6a'], 'Rising flame with flickering embers at the tips.'),
    P('lava', 'Lava Lamp', 'warm', 'SLOW', 'linear-gradient(110deg,#4a1200,#a83218,#e86a3a)', ['#4a1200','#a83218','#e86a3a','#f0a070'], 'Slow orange and red organic blobs.'),
    P('candle', 'Candle', 'warm', 'SLOW', 'linear-gradient(110deg,#3a2208,#8a5a1a,#e8a83a)', ['#3a2208','#8a5a1a','#e8a83a','#f0cf88'], 'Gentle warm flicker, like a row of candles.'),
    P('ember', 'Ember', 'warm', 'MED', 'linear-gradient(110deg,#3a1405,#a8481a,#e89a3a)', ['#3a1405','#a8481a','#e89a3a','#f0c878'], 'Pulsing coals breathing orange and gold.'),
    P('sunset', 'Sunset', 'warm', 'SLOW', 'linear-gradient(110deg,#5e1a3a,#c84a3a,#e8a83a,#f0d28a)', ['#5e1a3a','#c84a3a','#e8a83a','#f0d28a'], 'Dusk gradient sliding from rose to amber.'),
    P('sparkle', 'Sparkle', 'spark', 'FAST', 'radial-gradient(circle at 30% 40%,#fff,transparent 18%),radial-gradient(circle at 70% 65%,#ffe9b0,transparent 22%),#241a0a', ['#241a0a','#8a7a4a','#e8d8a8','#ffffff'], 'Scattered points twinkling on a dark field.'),
    P('twinkle', 'Twinkle', 'spark', 'MED', 'radial-gradient(circle at 40% 50%,#bfe0ff,transparent 20%),radial-gradient(circle at 75% 35%,#fff,transparent 16%),#0e1a2a', ['#0e1a2a','#3a5a7a','#8ab8d9','#e8f0ff'], 'Soft, slow stars fading in and out.'),
    P('meteor', 'Meteor', 'spark', 'FAST', 'linear-gradient(120deg,#fff,#8a8ae0,#11112a)', ['#11112a','#4a4a8a','#8a8ae8','#e0e0ff'], 'Streaks with glowing tails crossing the piece.'),
    P('confetti', 'Confetti', 'spark', 'FAST', 'linear-gradient(90deg,#e8a83a,#c84a8a,#4aa882,#3a6ac8)', ['#e8a83a','#c84a8a','#4aa882','#3a6ac8'], 'Bursts of random colour popping across the LEDs.'),
    P('lightning', 'Lightning', 'spark', 'FAST', 'linear-gradient(110deg,#0a0a2a,#5a5ad9,#cfcfff,#5a5ad9)', ['#0a0a2a','#4a4ad9','#8a8aff','#e8e8ff'], 'Sharp electric arcs cracking and fading.'),
    P('chase', 'Color Chase', 'motion', 'FAST', 'linear-gradient(90deg,#3a8ac8 0 30%,#0e1a2a 30% 60%,#3a8ac8 60% 100%)', ['#0e1a2a','#2a6a9a','#3a8ac8','#8ac0e8'], 'Running dots travelling along each strip.'),
    P('scanner', 'Scanner', 'motion', 'FAST', 'linear-gradient(90deg,#0e0e0e,#d9a84a,#0e0e0e)', ['#2a1e08','#8a6a1a','#d9a84a','#f0d088'], 'A bright bar sweeping back and forth.'),
    P('warp', 'Warp Speed', 'motion', 'FAST', 'radial-gradient(circle,#fff 0%,#8a8ad9 18%,#0a0a1a 65%)', ['#0a0a1a','#4a4a8a','#8a8ad9','#e0e0ff'], 'Stars stretching into streaks toward the centre.'),
    P('pulse-ring', 'Pulse Ring', 'motion', 'MED', 'radial-gradient(circle,#8ae8c8,#2a6a5a,#0a1a16)', ['#0a1a16','#2a6a5a','#4aae8c','#8ae8c8'], 'Rings expanding outward on each beat.'),
    P('blocks', 'Color Blocks', 'motion', 'FAST', 'linear-gradient(90deg,#a8e880 0 25%,#3a6ac8 25% 50%,#e8a83a 50% 75%,#c84a8a 75% 100%)', ['#a8e880','#3a6ac8','#e8a83a','#c84a8a'], 'Solid colour zones shifting in sequence.'),
    P('rainbow', 'Rainbow', 'motion', 'FAST', 'linear-gradient(90deg,#e85a3a,#e8c83a,#4aa882,#3a8ac8,#8a4ac8)', ['#e85a3a','#e8c83a','#4aa882','#8a4ac8'], 'Full spectrum scrolling smoothly through.'),
    P('neon', 'Neon', 'electric', 'MED', 'linear-gradient(110deg,#0a2a2a,#1aa890,#6ff0d8)', ['#0a2a2a','#1aa890','#4ae0c8','#9ff0d8'], 'Saturated tube-light glow with a hard edge.'),
    P('matrix', 'Digital Rain', 'electric', 'FAST', 'linear-gradient(180deg,#001a08,#0a8a2a,#6ff06a)', ['#001a08','#0a8a2a','#3ae84a','#9ff09a'], 'Falling green code streams down the strips.'),
    P('heartbeat', 'Heartbeat', 'electric', 'MED', 'linear-gradient(90deg,#2a0a0e,#e83a4a,#2a0a0e)', ['#2a0a0e','#8a2a3a','#e83a4a','#f08a94'], 'A double-thump pulse on a steady rhythm.'),
    P('stained', 'Stained Glass', 'electric', 'MED', 'conic-gradient(from 30deg,#8a4a3a,#c84a8a,#3a8ac8,#4aa882,#8a4a3a)', ['#8a4a3a','#c84a8a','#3a8ac8','#4aa882'], 'Faceted panels of jewel-tone colour.'),
  ];

  // saved layer mixes (section blends)
  const MIXES = [
    { id: 'mix1', label: 'Strip 1 Lava Lamp', base: 'lava', cat: 'mix', sp: 'SLOW', grad: 'linear-gradient(110deg,#4a1200,#a83218,#e86a3a)', pal: ['#4a1200','#a83218','#e86a3a','#f0a070'], desc: 'Saved mix · Strip 1 running Lava Lamp.', mix: true },
    { id: 'mix2', label: 'Canopy duet', base: 'aurora', cat: 'mix', sp: 'SLOW', grad: 'linear-gradient(110deg,#1c5a4a,#2f8f6a,#a8417e)', pal: ['#1c5a4a','#2f8f6a','#a8417e','#d98ab2'], desc: 'Saved mix · spine Aurora + ring Bloom.', mix: true },
  ];

  const PATTERN_CATS = [
    { id: 'all', label: 'All' },
    { id: 'mix', label: 'Layer mixes' },
    { id: 'calm', label: 'Calm' },
    { id: 'water', label: 'Water' },
    { id: 'warm', label: 'Warm' },
    { id: 'spark', label: 'Spark' },
    { id: 'motion', label: 'Motion' },
    { id: 'electric', label: 'Electric' },
  ];

  const STRIP_TESTS = [
    { id: 'r', short: 'R', label: 'Red', col: 'oklch(0.63 0.23 25)' },
    { id: 'g', short: 'G', label: 'Green', col: 'oklch(0.74 0.19 150)' },
    { id: 'b', short: 'B', label: 'Blue', col: 'oklch(0.55 0.21 260)' },
    { id: 'w', short: 'W', label: 'White', col: 'oklch(0.96 0.005 80)' },
  ];

  // round pick-color swatches (full wheel, earthy-leaning)
  const SWATCHES = [
    'oklch(0.70 0.16 12)', 'oklch(0.72 0.16 40)', 'oklch(0.78 0.15 70)', 'oklch(0.82 0.15 95)',
    'oklch(0.78 0.14 122)', 'oklch(0.74 0.13 158)', 'oklch(0.72 0.12 200)', 'oklch(0.66 0.15 250)',
    'oklch(0.62 0.16 285)', 'oklch(0.66 0.17 320)', 'oklch(0.70 0.16 350)', 'oklch(0.94 0.01 80)',
  ];

  const GEOMETRY = [
    { id: 'none', label: 'Original' },
    { id: 'mirror', label: 'Mirror' },
    { id: 'mandala', label: 'Mandala' },
    { id: 'kaleido', label: 'Kaleido' },
  ];

  // ── Timeline (Show) data ─────────────────────────────────────────────
  const CLIP_COLOR = {
    calm: 'oklch(0.72 0.07 162)', aurora: 'oklch(0.74 0.09 190)',
    bloom: 'oklch(0.70 0.11 350)', ember: 'oklch(0.76 0.12 58)',
    wave: 'oklch(0.70 0.08 232)', drift: 'oklch(0.68 0.09 300)',
    scanner: 'oklch(0.78 0.11 78)',
  };
  const CLIPS = [
    { id: 'c1', track: 0, patternId: 'calm', start: 0, end: 95, label: 'Calm open' },
    { id: 'c2', track: 0, patternId: 'aurora', start: 90, end: 240, label: 'Aurora drift' },
    { id: 'c3', track: 0, patternId: 'bloom', start: 235, end: 360, label: 'Bloom build' },
    { id: 'c4', track: 0, patternId: 'ember', start: 355, end: 480, label: 'Ember pulse' },
    { id: 'c5', track: 0, patternId: 'wave', start: 475, end: 600, label: 'Wave out' },
    { id: 'c6', track: 1, patternId: 'drift', start: 120, end: 260, label: 'Outer drift' },
    { id: 'c7', track: 1, patternId: 'scanner', start: 260, end: 420, label: 'Outer scan' },
  ];
  const TRANSITIONS = [
    { id: 't1', clipA: 'c1', clipB: 'c2', at: 92, dur: 6, type: 'cross-fade' },
    { id: 't2', clipA: 'c2', clipB: 'c3', at: 237, dur: 5, type: 'dip-black' },
    { id: 't3', clipA: 'c3', clipB: 'c4', at: 357, dur: 5, type: 'cross-fade' },
    { id: 't4', clipA: 'c4', clipB: 'c5', at: 477, dur: 6, type: 'push' },
  ];
  const LANES = [
    { id: 'a1', label: 'Hue shift', param: 'hueShift', color: 'oklch(0.70 0.11 350)', keys: [[0, 0.1], [60, 0.2], [140, 0.5], [240, 0.75], [360, 0.4], [480, 0.9], [600, 0.1]] },
    { id: 'a2', label: 'Speed', param: 'speed', color: 'oklch(0.74 0.09 200)', keys: [[0, 0.3], [120, 0.35], [240, 0.5], [360, 0.8], [480, 0.9], [540, 0.5], [600, 0.25]] },
    { id: 'a3', label: 'Brightness', param: 'brightness', color: 'oklch(0.785 0.125 72)', keys: [[0, 0.2], [95, 0.6], [240, 0.75], [360, 0.95], [480, 0.85], [600, 0.25]] },
  ];
  const CUES = [
    { t: 0, label: 'Open' }, { t: 240, label: 'Peak A' }, { t: 360, label: 'Peak B' }, { t: 540, label: 'Out' },
  ];
  const SHOW_DURATION = 600;

  window.LW = {
    I, PATTERNS, MIXES, PATTERN_CATS, STRIP_TESTS, SWATCHES, GEOMETRY,
    CLIP_COLOR, CLIPS, TRANSITIONS, LANES, CUES, SHOW_DURATION,
    fmtTime: (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`,
  };
})();
