/**
 * patterns-library.js — built-in pattern definitions
 *
 * Isolated from main.js so edits hot-swap instantly without a page reload.
 * Custom patterns created in the UI are stored in state, not here.
 */

export const PATTERNS = [
  {
    id: 'rainbow', name: 'Rainbow Flow',
    desc: 'Smooth rainbow cycling across all LEDs',
    preview: 'linear-gradient(90deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)',
    code: `// Classic animated rainbow across all LEDs\nreturn hsv(fract(index / 60 + time), 1, 1);`,
  },
  {
    id: 'plasma', name: 'Plasma Wave',
    desc: 'Overlapping colour waves based on LED position',
    preview: 'linear-gradient(135deg,#7400b8,#5390d9,#06d6a0,#9bf6ff,#7400b8)',
    code:
`// Overlapping sine waves on x/y position
const h = sin(x * 6 + time * 3.14) * 0.5
        + sin(y * 5 - time * 2.1) * 0.5;
return hsv(fract(h * 0.5 + 0.5), 0.9, 1);`,
  },
  {
    id: 'fire', name: 'Fire',
    desc: 'Warm noise-based flames rising upward',
    preview: 'linear-gradient(0deg,#330000,#cc2200,#ff6600,#ffcc00,#ffffff)',
    code:
`// @param scale float 3.0 1.0 10.0
// @param rise  float 1.5 0.2 4.0
// Noise-based warm glow moving upward
const n = noise(x * params.scale, y * 4 - time * params.rise);
const v = clamp(n * 1.5, 0, 1);
return hsv(lerp(0.0, 0.1, n), 1, v);`,
  },
  {
    id: 'chase', name: 'Color Chase',
    desc: 'A single bright dot racing along the strip',
    preview: 'linear-gradient(90deg,#050510 0%,#050510 35%,#4cc9f0 50%,#ffffff 51%,#4cc9f0 65%,#050510 100%)',
    code:
`// @param dotSize float 0.025 0.005 0.15
// Single colour dot chasing along all strips
const pos  = fract(time * 0.8);
const d0   = abs(index / pixelCount - pos);
const dist = min(d0, 1 - d0);
const v    = max(0, 1 - dist / params.dotSize);
return hsv(0.55, 1, v);`,
  },
  {
    id: 'sparkle', name: 'Sparkle',
    desc: 'Random bright flashes across the LEDs',
    preview: 'radial-gradient(circle at 20% 50%,#fff 0%,transparent 8%),radial-gradient(circle at 60% 30%,#fff 0%,transparent 6%),radial-gradient(circle at 80% 70%,#fff 0%,transparent 10%),#080820',
    code:
`// @param density float 0.96 0.7 0.999
// Random white sparkles
const seed = randomF(index + floor(t * 20) * 997);
const v = seed > params.density ? 1 : 0;
return { r: v*255, g: v*255, b: v*255 };`,
  },
  {
    id: 'breathe', name: 'Breathe',
    desc: 'Slow pulsing glow — great for ambient scenes',
    preview: 'radial-gradient(ellipse,#06d6a0 0%,#036644 50%,#010e09 100%)',
    code:
`// @param hue float 0.45 0.0 1.0
// @param rate float 0.5 0.1 2.0
// Smooth sine breathe
const v = pow((sin(t * params.rate * TAU) * 0.5 + 0.5), 2);
return hsv(params.hue, 0.9, v);`,
  },
  {
    id: 'gradient', name: 'Gradient',
    desc: 'Static colour gradient from palette start to end',
    preview: 'linear-gradient(90deg,#ef476f,#ffd166,#06d6a0,#118ab2)',
    code:
`// Static gradient using the palette
const pct = index / pixelCount;
const seg = pct * 3;
const i2 = floor(seg);
const f = fract(seg);
const a = palette[i2 % palette.length];
const b2 = palette[(i2+1) % palette.length];
return { r: lerp(a.r,b2.r,f)*255, g: lerp(a.g,b2.g,f)*255, b: lerp(a.b,b2.b,f)*255 };`,
  },
  {
    id: 'twinkle', name: 'Twinkle',
    desc: 'Soft random stars slowly fading in and out',
    preview: 'radial-gradient(circle at 15% 80%,#aaddff 0%,transparent 5%),radial-gradient(circle at 55% 20%,#ffeedd 0%,transparent 4%),radial-gradient(circle at 85% 60%,#ccffee 0%,transparent 6%),#040412',
    code:
`// Soft slow twinkle
const phase = randomF(index * 3.7) * TAU;
const speed = 0.3 + randomF(index * 1.3) * 0.7;
const v = pow(sin(t * speed + phase) * 0.5 + 0.5, 3);
const h = randomF(index * 7.1) * 0.15 + 0.55;
return hsv(h, 0.3, v);`,
  },
  {
    id: 'debug-xy', name: 'XY Position Map',
    desc: 'Developer tool: x maps to hue, y to brightness',
    preview: 'linear-gradient(135deg,#ff0000,#00ff00,#0000ff)',
    code: `// x → hue, y → brightness — check ledmap layout\nreturn hsv(x, 1, 0.5 + y * 0.5);`,
  },
  {
    id: 'meteor', name: 'Meteor Shower',
    desc: 'Bright comets racing along each strip with a glowing tail',
    preview: 'linear-gradient(90deg,#000010,#000030 40%,#8888ff 80%,#ffffff 100%)',
    code:
`// @param speed   float 1.0 0.2 4.0
// @param tailLen float 0.12 0.02 0.4
const pos = fract(time * params.speed);
const d = fract(stripProgress - pos + 1);
const tail = d < params.tailLen ? pow(1 - d / params.tailLen, 2) : 0;
return hsv(0.62, 0.6, tail);`,
  },
  {
    id: 'aurora', name: 'Aurora',
    desc: 'Slow curtains of northern lights drifting across the sky',
    preview: 'linear-gradient(90deg,#003311,#00cc66,#00ffaa,#6600aa,#003311)',
    code:
`// @param speed float 0.15 0.02 0.6
const drift   = fbm(x * 2 + t * params.speed, y * 1.5, 3);
const curtain = fbm(x * 3 - t * params.speed * 0.7, drift * 2, 4);
const h = mix(0.35, 0.82, curtain);
return hsv(h, 0.85, pow(curtain, 1.2));`,
  },
  {
    id: 'scanner', name: 'Scanner',
    desc: 'Single beam sweeping back and forth like a CYLON eye',
    preview: 'linear-gradient(90deg,#050505 0%,#ff2000 40%,#ffffff 50%,#ff2000 60%,#050505 100%)',
    code:
`// @param width float 0.08 0.01 0.3
// @param hue   float 0.0  0.0  1.0
const pos  = sin(t * 1.5) * 0.5 + 0.5;
const dist = abs(stripProgress - pos);
const v    = max(0, 1 - dist / params.width);
return hsv(params.hue, 1, pow(v, 1.5));`,
  },
  {
    id: 'ripple', name: 'Ripple',
    desc: 'Concentric rings expanding outward from artwork center',
    preview: 'radial-gradient(circle,#ffffff 0%,#00ccff 20%,#0033aa 50%,#000022 80%)',
    code:
`// @param speed float 1.5 0.3 5.0
// @param freq  float 8.0 2.0 20.0
const { r } = polar(x, y);
const ring  = sin(r * params.freq * TAU - t * params.speed * TAU) * 0.5 + 0.5;
const fade  = 1 - clamp(r * 1.8, 0, 1);
return hsv(0.58, 0.9, ring * fade);`,
  },
  {
    id: 'lava', name: 'Lava Lamp',
    desc: 'Slow organic blobs rising and merging in warm colors',
    preview: 'radial-gradient(ellipse at 30% 70%,#ff4400 0%,#cc0000 30%,#220000 100%)',
    code:
`// @param speed float 0.2 0.05 1.0
const blob = fbm(x * 2 + sin(t * params.speed * 0.3) * 0.5,
                 y * 2 - t * params.speed + cos(t * params.speed * 0.2) * 0.3, 5);
const h    = mix(0.0, 0.12, blob);
const v    = pow(clamp(blob * 1.8 - 0.3, 0, 1), 0.7);
return hsv(h, 1, v);`,
  },
  {
    id: 'ocean', name: 'Ocean Wave',
    desc: 'Rolling blue-teal waves with white-foam highlights',
    preview: 'linear-gradient(180deg,#ffffff 0%,#7aecff 20%,#0077b6 60%,#03045e 100%)',
    code:
`// @param speed float 0.5 0.1 2.0
const w1 = sin(x * 8 - t * params.speed * 2) * 0.5 + 0.5;
const w2 = sin(x * 5 + y * 3 - t * params.speed * 1.3) * 0.5 + 0.5;
const h  = mix(w1, w2, 0.5);
const foam = pow(h, 8);
return hsv(mix(0.55, 0.62, h), mix(0.9, 0.1, foam), mix(0.4, 1.0, h));`,
  },
  {
    id: 'candle', name: 'Candle',
    desc: 'Warm gentle flicker of a single candle flame',
    preview: 'radial-gradient(ellipse at 50% 80%,#ffffff 0%,#ffee88 10%,#ff7700 40%,#220000 100%)',
    code:
`// @param flicker float 3.0 0.5 8.0
const n1 = noise(index * 0.3 + t * params.flicker);
const n2 = noise(index * 0.7 - t * params.flicker * 0.6 + 10);
const f  = clamp((n1 + n2) * 0.7, 0, 1);
return hsv(mix(0.02, 0.1, f), 1, pow(f, 0.5));`,
  },
  {
    id: 'lightning', name: 'Lightning',
    desc: 'Frozen-frame electric arcs that randomly re-strike',
    preview: 'linear-gradient(90deg,#050515,#7070ff,#ffffff,#7070ff,#050515)',
    code:
`// @param rate float 6.0 1.0 20.0
const frame  = floor(t * params.rate);
const strike = randomF(frame * 999) > 0.85;
const rnd    = randomF(frame * 1337 + index * 7);
const v      = strike ? (rnd > 0.6 ? 1 : rnd * 0.3) : 0;
return hsv(0.65, 0.5, v);`,
  },
  {
    id: 'neon', name: 'Neon Sign',
    desc: 'Flickering colored neon-tube sections',
    preview: 'linear-gradient(90deg,#ff00aa,#ff00aa 33%,#00ffcc 33%,#00ffcc 66%,#ffff00 66%)',
    code:
`// @param rate float 3.0 0.5 10.0
const seg     = floor(stripProgress * 6);
const flicker = randomF(floor(t * params.rate) * 13 + seg * 7);
const v       = flicker > 0.08 ? 1 : 0.05;
const h       = fract(seg / 6 + randomF(seg * 111) * 0.12);
return hsv(h, 1, v);`,
  },
  {
    id: 'matrix', name: 'Digital Rain',
    desc: 'Columns of green digital rain cascading downward',
    preview: 'linear-gradient(180deg,#ffffff 0%,#00ff41 15%,#003b00 60%,#000000 100%)',
    code:
`// @param speed float 2.0 0.5 8.0
const col    = floor(x * 20);
const offset = randomF(col * 77.3);
const drop   = fract(offset + t * params.speed * (0.5 + randomF(col * 3.1) * 0.5));
const dist   = fract(y - drop);
const v      = dist < 0.15 ? pow(1 - dist / 0.15, 2) : 0;
const head   = dist < 0.02;
return hsv(0.33, head ? 0 : 1, head ? 1 : v * 0.8);`,
  },
  {
    id: 'heartbeat', name: 'Heartbeat',
    desc: 'Double-pulse thump in time with the BPM',
    preview: 'radial-gradient(ellipse,#ff0022 0%,#880011 50%,#110003 100%)',
    code:
`// @param hue float 0.0 0.0 1.0
const p1 = exp(-pow(fract(beat) * 8, 2) * 5);
const p2 = exp(-pow(max(0, fract(beat) - 0.15) * 8, 2) * 8) * 0.6;
return hsv(params.hue, 1, max(p1, p2));`,
  },
  {
    id: 'stained', name: 'Stained Glass',
    desc: 'Bright color zones separated by dark noise veins',
    preview: 'conic-gradient(from 0deg at 50% 50%,#ff2200,#ffaa00,#00dd44,#0066ff,#cc00ff,#ff2200)',
    code:
`// @param scale float 4.0 1.0 12.0
const cell = noise(x * params.scale, y * params.scale);
const vein = smoothstep(0.0, 0.08, abs(cell - 0.5));
const h    = fract(noise(x * params.scale * 0.5 + 99, y * params.scale * 0.5) + time * 0.05);
return hsv(h, 0.95, vein);`,
  },
  {
    id: 'confetti', name: 'Confetti',
    desc: 'Randomly colored sparks popping on every beat',
    preview: 'radial-gradient(circle at 20% 30%,#ff0066 0%,transparent 8%),radial-gradient(circle at 70% 60%,#00ff88 0%,transparent 6%),radial-gradient(circle at 50% 80%,#ffcc00 0%,transparent 7%),#080808',
    code:
`// @param density float 0.93 0.6 0.99
const seed = randomF(index + floor(beat * 4) * 997);
const v    = seed > params.density ? 1 : 0;
const h    = randomF(index * 3.7 + floor(beat * 4));
return hsv(h, 1, v);`,
  },
  {
    id: 'warp', name: 'Warp Speed',
    desc: 'White streaks flying outward from center like hyperspace',
    preview: 'radial-gradient(circle,#ffffff 0%,#8888ff 10%,#000022 50%,#000000 100%)',
    code:
`// @param speed float 2.0 0.5 6.0
const { r, a } = polar(x, y);
const streak   = randomF(floor(a * 40) * 73);
const travel   = fract(r * 2 - t * params.speed * streak);
const v        = travel > 0.8 ? pow((travel - 0.8) / 0.2, 2) : 0;
return hsv(0.65, 0.5, v);`,
  },
  {
    id: 'glitch', name: 'Glitch',
    desc: 'Digital corruption — random color jumps and block freezes',
    preview: 'linear-gradient(90deg,#00ffff 0% 15%,#ff00ff 15% 30%,#000000 30% 45%,#ffff00 45% 60%,#ff0000 60% 75%,#00ffff 75% 100%)',
    code:
`// @param chaos float 0.4 0.05 1.0
const frame   = floor(t * 8);
const block   = floor(index / 5);
const rndOn   = randomF(block * 71 + frame * 13);
const rndCol  = randomF(block * 37 + frame * 997);
const v       = rndOn < params.chaos ? 1 : 0;
return hsv(fract(rndCol * 3.7), 1, v);`,
  },
  {
    id: 'pulse-ring', name: 'Pulse Ring',
    desc: 'Expanding ring from artwork center on each beat',
    preview: 'radial-gradient(circle,transparent 0%,#00aaff 30%,transparent 35%,#0055ff 65%,transparent 70%)',
    code:
`// @param ringWidth float 0.06 0.01 0.2
const { r }   = polar(x, y);
const ringPos = fract(1 - beat);
const dist    = abs(r - ringPos);
const v       = dist < params.ringWidth ? pow(1 - dist / params.ringWidth, 2) : 0;
return hsv(0.58 + beat * 0.15, 0.9, v);`,
  },
  {
    id: 'inkdrop', name: 'Ink Drop',
    desc: 'Dark ink slowly diffusing and cycling through deep colors',
    preview: 'radial-gradient(ellipse,#330066 0%,#000066 30%,#001133 60%,#000000 100%)',
    code:
`// @param speed float 0.1 0.02 0.5
const ink = fbm(x * 3 + sin(t * params.speed) * 0.8,
                y * 3 + cos(t * params.speed * 0.7) * 0.8, 6);
const h   = fract(ink * 2 + time * 0.2);
const v   = pow(smoothstep(0.2, 0.8, ink), 1.5);
return hsv(h, 0.95, v * 0.9);`,
  },
  {
    id: 'strobe', name: 'Strobe Beat',
    desc: 'Sharp flash on every beat — tunable hue and duty cycle',
    preview: 'linear-gradient(90deg,#050505,#ffffff,#050505)',
    code:
`// @param duty float 0.08 0.01 0.4
// @param hue  float 0.0  0.0  1.0
const on = beat < params.duty ? 1 : 0;
return hsv(params.hue, params.hue > 0.01 ? 0.8 : 0, on);`,
  },
  {
    id: 'blocks', name: 'Color Blocks',
    desc: 'Hard-edged palette segments cycling forward',
    preview: 'linear-gradient(90deg,#ef476f 0% 20%,#ffd166 20% 40%,#06d6a0 40% 60%,#118ab2 60% 80%,#ef476f 80% 100%)',
    code:
`// @param count float 5.0 2.0 12.0
const seg = floor(fract(index / pixelCount * floor(params.count) - time * 0.3) * palette.length);
const c   = palette[seg % palette.length];
return { r: c.r * 255, g: c.g * 255, b: c.b * 255 };`,
  },
  {
    id: 'binary-pulse', name: 'Binary Pulse',
    desc: 'Each LED section blinks on a different prime-based rhythm',
    preview: 'linear-gradient(90deg,#000000 0% 45%,#ffffff 45% 55%,#000000 55% 100%)',
    code:
`// @param rate float 2.0 0.5 8.0
const primes = [2,3,5,7,11,13,17,19,23,29];
const seg    = index % 10;
const prime  = primes[seg];
const on     = fract(t * params.rate / prime) < 0.5 ? 1 : 0;
return hsv(seg / 10, 0.8, on);`,
  },
];

if (import.meta.hot) import.meta.hot.accept();
