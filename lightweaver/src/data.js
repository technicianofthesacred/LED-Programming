import { PATTERNS as LIB_PATTERNS } from './lib/patterns-library.js';
import { parseParamsFromCode } from './lib/patternParams.js';

export const PATTERNS = LIB_PATTERNS;

export const DEFAULT_PARAMS = Object.fromEntries(
  LIB_PATTERNS.map(pattern => [pattern.id, parseParamsFromCode(pattern.code)])
);

export const PATTERN_CODE = Object.fromEntries(
  LIB_PATTERNS.map(p => [p.id, p.code])
);

export const PALETTE_DEFAULT = ['#ff6b6b', '#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#ff9f1c'];

export const DEMO_STRIPS = [
  { id: 's1', name: 'Ceiling Loop',   leds: 120, path: 'M 100 80 Q 200 40 320 80 T 540 80' },
  { id: 's2', name: 'Left Spiral',    leds: 96,  path: 'M 90 180 C 90 260 180 260 180 180 C 180 140 140 140 140 180 Q 140 220 160 220' },
  { id: 's3', name: 'Right Spiral',   leds: 96,  path: 'M 460 180 C 460 260 550 260 550 180 C 550 140 510 140 510 180 Q 510 220 530 220' },
  { id: 's4', name: 'Base Bar',       leds: 144, path: 'M 100 320 L 540 320' },
  { id: 's5', name: 'Diamond Top',    leds: 64,  path: 'M 320 120 L 360 160 L 320 200 L 280 160 Z' },
];

export const GRAPH_NODES = [
  { id: 'n1', x: 24,  y: 40,  kind: 'source', title: 'Polar',
    rows: [['mode','radial'], ['center','0.5, 0.5']] },
  { id: 'n2', x: 24,  y: 160, kind: 'source', title: 'Time',
    rows: [['rate','1.0×'], ['type','beat']] },
  { id: 'n3', x: 24,  y: 280, kind: 'source', title: 'Noise FBM',
    rows: [['scale','6.0'], ['oct','4']] },
  { id: 'n4', x: 240, y: 60,  kind: 'mod', title: 'Wave',
    rows: [['freq','8.0'], ['shape','sine']] },
  { id: 'n5', x: 240, y: 220, kind: 'mod', title: 'Smoothstep',
    rows: [['min','0.2'], ['max','0.8']] },
  { id: 'n6', x: 440, y: 140, kind: 'color', title: 'HSV Map',
    rows: [['hue','0.58 + t'], ['sat','0.9']] },
  { id: 'n7', x: 640, y: 160, kind: 'output', title: 'Pixel Out',
    rows: [['blend','replace'], ['gamma','2.2']] },
];

export const GRAPH_EDGES = [
  ['n1','n4'], ['n2','n4'], ['n3','n5'],
  ['n4','n6'], ['n5','n6'], ['n6','n7'],
];
