export const DEFAULT_CLIPS = [
  { id: 'c1', track: 0, patternId: 'calm',    start: 0,   end: 95,  label: 'Calm open' },
  { id: 'c2', track: 0, patternId: 'aurora',  start: 90,  end: 240, label: 'Aurora drift' },
  { id: 'c3', track: 0, patternId: 'bloom',   start: 235, end: 360, label: 'Bloom build' },
  { id: 'c4', track: 0, patternId: 'ember',   start: 355, end: 480, label: 'Ember pulse' },
  { id: 'c5', track: 0, patternId: 'wave',    start: 475, end: 600, label: 'Wave out' },
  { id: 'c6', track: 1, patternId: 'drift',   start: 120, end: 260, label: 'Outer drift', group: 'Outer ring' },
  { id: 'c7', track: 1, patternId: 'scanner', start: 260, end: 420, label: 'Outer scan',  group: 'Outer ring' },
];

export const DEFAULT_TRANSITIONS = [
  { id: 't1', clipA: 'c1', clipB: 'c2', start: 90,  end: 95,  type: 'crossfade', curve: 'ease-in-out' },
  { id: 't2', clipA: 'c2', clipB: 'c3', start: 235, end: 240, type: 'fade-black', curve: 'linear' },
  { id: 't3', clipA: 'c3', clipB: 'c4', start: 355, end: 360, type: 'dissolve',  curve: 'ease-in-out' },
  { id: 't4', clipA: 'c4', clipB: 'c5', start: 475, end: 480, type: 'crossfade', curve: 'ease-in-out' },
];

export const DEFAULT_CUES = [
  { t: 0,   name: 'Start',     kbd: 'Q1' },
  { t: 95,  name: 'Drop 1',    kbd: 'Q2' },
  { t: 240, name: 'Bloom',     kbd: 'Q3' },
  { t: 360, name: 'Climax',    kbd: 'Q4' },
  { t: 480, name: 'Wind down', kbd: 'Q5' },
  { t: 600, name: 'End',       kbd: 'Q6' },
];

export const DEFAULT_AUTO_LANES = [
  { id: 'a1', label: 'Hue shift',  color: '#c84a8a', param: 'hueShift',   keys: [[0,0.1],[60,0.2],[140,0.5],[240,0.75],[360,0.4],[480,0.9],[600,0.1]] },
  { id: 'a2', label: 'Speed',      color: '#5fb8d9', param: 'speed',      keys: [[0,0.3],[120,0.35],[240,0.5],[360,0.8],[480,0.9],[540,0.5],[600,0.25]] },
  { id: 'a3', label: 'Brightness', color: '#e89a3a', param: 'brightness', keys: [[0,0.2],[95,0.6],[240,0.75],[360,0.95],[480,0.85],[600,0.25]] },
];
