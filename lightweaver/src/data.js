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
  { id: 'ring-inner',  name: 'Inner Ring',  leds: 64,  path: 'M 320 200 m -70 0 A 70 70 0 1 0 390 200 A 70 70 0 1 0 250 200' },
  { id: 'ring-middle', name: 'Middle Ring', leds: 96,  path: 'M 320 200 m -120 0 A 120 120 0 1 0 440 200 A 120 120 0 1 0 200 200' },
  { id: 'ring-outer',  name: 'Outer Ring',  leds: 128, path: 'M 320 200 m -170 0 A 170 170 0 1 0 490 200 A 170 170 0 1 0 150 200' },
];

export const GRAPH_NODES = [
  { id: 'n1', x: 24,  y: 40,  kind: 'source', title: 'Polar',
    rows: [['mode','radial'], ['center','0.5, 0.5']] },
  { id: 'n2', x: 24,  y: 160, kind: 'source', title: 'Time',
    rows: [['rate','1.0x'], ['type','beat']] },
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
