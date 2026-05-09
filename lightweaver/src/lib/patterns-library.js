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

  // ── Additional patterns ────────────────────────────────────────────────

  {
    id: 'calm', name: 'Calm',
    desc: 'Slow deep breathing, cool blue-green haze',
    preview: 'radial-gradient(ellipse,#003344 0%,#006655 40%,#002233 100%)',
    code:
`// @param hue  float 0.5 0.3 0.7
// @param rate float 0.2 0.05 0.8
const breath = sin(t * params.rate) * 0.5 + 0.5;
const n = fbm(x * 1.5 + t * 0.05, y * 1.5, 3);
return hsv(params.hue + n * 0.08, 0.7, pow(breath, 1.5) * (0.3 + n * 0.4));`,
  },
  {
    id: 'bloom', name: 'Bloom',
    desc: 'Expanding petals of light from the center',
    preview: 'radial-gradient(circle,#ff88aa 0%,#cc2266 40%,#220011 100%)',
    code:
`// @param petals float 6.0 3.0 12.0
// @param speed  float 0.5 0.1 2.0
const { r, a } = polar(x, y);
const petal = cos(a * params.petals + t * params.speed) * 0.5 + 0.5;
const ring  = sin(r * 10 - t * 2) * 0.5 + 0.5;
const v     = petal * ring * (1 - r * 1.4);
return hsv(0.92 + r * 0.1, 0.85, clamp(v, 0, 1));`,
  },
  {
    id: 'ember', name: 'Ember',
    desc: 'Glowing orange embers drifting upward',
    preview: 'radial-gradient(ellipse at 50% 80%,#ffaa00 0%,#cc4400 40%,#110000 100%)',
    code:
`// @param rise  float 0.8 0.2 2.5
// @param count float 0.4 0.1 1.0
const drift = fract(y + t * params.rise + noise(x * 5 + t * 0.3) * 0.3);
const spark = noise(x * 8 + t * 0.1, drift * 6);
const v     = spark > params.count ? pow((spark - params.count) / (1 - params.count), 3) : 0;
const h     = mix(0.06, 0.12, spark);
return hsv(h, 1, v);`,
  },
  {
    id: 'drift', name: 'Drift',
    desc: 'Smooth slow color clouds drifting across the canvas',
    preview: 'linear-gradient(135deg,#220066,#440099,#6600cc,#220066)',
    code:
`// @param speed float 0.12 0.02 0.5
const n1 = fbm(x * 2 + t * params.speed,       y * 2, 4);
const n2 = fbm(x * 2 - t * params.speed * 0.7, y * 2 + 1, 4);
const h  = fract(n1 * 0.6 + time * 0.15);
const v  = pow(mix(n1, n2, 0.5), 0.7);
return hsv(h, 0.75, v * 0.85);`,
  },
  {
    id: 'wave', name: 'Wave',
    desc: 'Flowing sine waves with color shifting',
    preview: 'linear-gradient(90deg,#003366,#0066cc,#00ccff,#0066cc,#003366)',
    code:
`// @param freq  float 4.0 1.0 12.0
// @param speed float 1.0 0.2 4.0
const w1 = sin(x * params.freq + t * params.speed) * 0.5 + 0.5;
const w2 = sin(x * params.freq * 0.7 - t * params.speed * 0.6 + y * 3) * 0.5 + 0.5;
const h  = mix(0.55, 0.65, mix(w1, w2, 0.5));
return hsv(h, 0.9, mix(w1, w2, 0.5));`,
  },
  {
    id: 'sunrise-v2', name: 'Sunrise Horizon Soft',
    desc: 'Gradual warm dawn gradient rising from base to top',
    preview: 'linear-gradient(0deg,#330011 0%,#cc2200 30%,#ff6600 60%,#ffcc44 85%,#ffffaa 100%)',
    code:
`// @param hour float 0.5 0.0 1.0
const phase = params.hour + sin(t * 0.05) * 0.05;
const h = mix(0.0, 0.14, smoothstep(0, 0.7, y + phase * 0.3));
const s = mix(1, 0.3, y);
const v = mix(0.1, 1, smoothstep(0, 1, y + phase));
return hsv(h, s, v);`,
  },
  {
    id: 'crystal', name: 'Crystal',
    desc: 'Faceted gem-like reflections with prismatic color',
    preview: 'conic-gradient(from 30deg,#aaeeff,#ffffff,#aaeeff,#eeffff,#aaeeff)',
    code:
`// @param facets float 8.0 3.0 20.0
const { r, a } = polar(x, y);
const facet = floor(a * params.facets) / params.facets;
const shine = noise(facet * 50 + time * 0.1, r * 10) ;
const h = fract(facet * 3.7 + time * 0.05);
const v = pow(shine, 0.5) * (1 - r);
return hsv(h, 0.4, v);`,
  },
  {
    id: 'smoke', name: 'Smoke',
    desc: 'Dark turbulent smoke clouds billowing slowly',
    preview: 'radial-gradient(ellipse,#aaaaaa 0%,#555566 40%,#111122 100%)',
    code:
`// @param speed float 0.25 0.05 1.0
const n = fbm(x * 3 + sin(t * params.speed * 0.5) * 0.4,
              y * 3 - t * params.speed, 6);
const v = smoothstep(0.3, 0.8, n);
const h = mix(0.6, 0.7, n);
return hsv(h, 0.25, v * 0.7);`,
  },
  {
    id: 'ice', name: 'Ice Crystal',
    desc: 'Cold blue crystalline frost patterns',
    preview: 'linear-gradient(135deg,#aaddff,#eeffff,#88ccff,#ffffff)',
    code:
`// @param scale float 5.0 2.0 12.0
const n1 = noise(x * params.scale, y * params.scale + t * 0.1);
const n2 = noise(x * params.scale * 2 + 10, y * params.scale * 2 - t * 0.05);
const ice = abs(n1 - 0.5) * 2;
const crack = ice < 0.08 ? 1 : 0;
const bg = smoothstep(0.3, 0.7, n2);
return hsv(0.58 + bg * 0.05, mix(0.3, 0.7, bg), crack ? 1 : mix(0.3, 0.85, bg));`,
  },
  {
    id: 'volt', name: 'Volt',
    desc: 'Electric crackling arcs with audio-reactive energy',
    preview: 'linear-gradient(90deg,#000022,#3333ff,#aaaaff,#ffffff,#3333ff,#000022)',
    code:
`// @param chaos float 0.5 0.1 1.0
// Bass-reactive arc intensity
const react = 1 + bass * 2;
const frame = floor(t * 12);
const col   = floor(x * 16);
const row   = floor(y * 8);
const rnd   = randomF(col * 17 + row * 53 + frame * 97);
const v     = rnd < params.chaos * react * 0.5 ? pow(rnd * 2, 0.3) : 0;
const h     = 0.6 + rnd * 0.15;
return hsv(h, mix(0.5, 0.0, v), v);`,
  },
  {
    id: 'waterfall', name: 'Waterfall',
    desc: 'Cascading blue-white streams flowing downward',
    preview: 'linear-gradient(180deg,#eeffff 0%,#88ddff 30%,#2299cc 70%,#003355 100%)',
    code:
`// @param speed float 1.5 0.3 5.0
const col    = floor(x * 24);
const offset = randomF(col * 31.7) * 6;
const drop   = fract(y + t * params.speed * (0.5 + randomF(col * 2.3) * 0.8) + offset);
const tail   = pow(max(0, 1 - drop * 5), 2);
const foam   = drop < 0.05 ? 1 : 0;
return hsv(mix(0.55, 0.62, drop), foam ? 0.1 : 0.85, foam ? 1 : tail * 0.9);`,
  },
  {
    id: 'galaxy', name: 'Galaxy',
    desc: 'Spiral arms of stars rotating around a bright core',
    preview: 'radial-gradient(ellipse,#ffffff 0%,#aaaaff 10%,#221133 50%,#000011 100%)',
    code:
`// @param arms  float 3.0 2.0 6.0
// @param spin  float 0.3 0.05 1.0
const { r, a } = polar(x, y);
const spiral = fract(a / TAU * params.arms - r * 4 - t * params.spin);
const arm    = pow(cos(spiral * TAU) * 0.5 + 0.5, 4);
const core   = exp(-r * r * 20);
const star   = randomF(floor(x * 100) + floor(y * 100) * 101) > 0.98 ? 1 : 0;
const v      = clamp(arm * (1 - r) + core + star * 0.5, 0, 1);
return hsv(0.65 + r * 0.1, mix(0.8, 0, core * 3), v);`,
  },

  // ── New: high-impact + audio-reactive patterns ───────────────────────────
  {
    id: 'bass-pulse', name: 'Bass Pulse',
    desc: 'Radial rings that explode outward on every bass beat',
    preview: 'radial-gradient(circle,#ff6600,#aa0033,#000033)',
    code:
`// @param speed   float 1.0 0.3 3.0
// @param rings   float 4.0 1.0 8.0
const { r, a } = polar(x, y);
const kick  = 0.4 + bass * 0.6;
const wave  = sin((r * params.rings - t * params.speed) * TAU) * 0.5 + 0.5;
const glow  = exp(-r * r * 4) * kick;
const v     = mix(wave * (1 - r), 1, glow);
return hsv(0.02 + r * 0.08 + beat * 0.15, 0.9, v * kick);`,
  },
  {
    id: 'spectrum', name: 'Spectrum Bars',
    desc: 'Real-time audio spectrum displayed as vertical bars',
    preview: 'linear-gradient(90deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff)',
    code:
`// Visualize bass/mid/hi as colored vertical bars
const band = x < 0.33 ? bass : x < 0.66 ? mid : hi;
const h    = x < 0.33 ? 0.02 : x < 0.66 ? 0.13 : 0.65;
const lit  = y > 1 - band;
const edge = y > 0.98 - band && y < 1.02 - band;
const peak = randomF(floor(x * 40) + 0.1) < 0.03 && y < 0.05;
const v    = edge ? 1 : (lit ? mix(0.3, 0.9, 1 - y) : 0.04) + (peak ? 0.7 : 0);
return hsv(h, 0.85, v);`,
  },
  {
    id: 'vortex', name: 'Vortex',
    desc: 'Hypnotic rotating spiral arms pulling toward center',
    preview: 'conic-gradient(from 0deg,#ff00ff,#00ffff,#ffff00,#ff00ff)',
    code:
`// @param arms  float 3.0 2.0 8.0
// @param twist float 2.0 0.5 5.0
const { r, a } = polar(x, y);
const swirl   = fract(a / TAU + r * params.twist - t * 0.4);
const arm     = pow(sin(swirl * params.arms * TAU) * 0.5 + 0.5, 3);
const core    = exp(-r * 8);
const v       = mix(arm * (1 - r * 0.9), 1, core);
const h       = fract(0.7 + a / TAU * 0.3 + t * 0.05);
return hsv(h, 1.0, v);`,
  },
  {
    id: 'comet', name: 'Comet',
    desc: 'Multiple streaking comets with glowing tails',
    preview: 'linear-gradient(135deg,#ffffff,#88aaff,#001133)',
    code:
`// @param count  float 3.0 1.0 8.0
// @param speed  float 1.0 0.3 4.0
let v = 0, h = 0.6;
const n = floor(params.count);
for (let i = 0; i < n; i++) {
  const phase  = randomF(i * 17.3);
  const angle  = randomF(i * 31.1) * TAU;
  const cx     = 0.5 + cos(angle + t * params.speed * (0.5 + phase * 0.5)) * 0.8;
  const cy     = 0.5 + sin(angle + t * params.speed * (0.5 + phase * 0.5)) * 0.8;
  const dx     = x - cx, dy = y - cy;
  const dist   = sqrt(dx * dx + dy * dy);
  const trail  = exp(-dist * 12);
  v = max(v, trail);
  h = mix(h, 0.55 + phase * 0.2, trail);
}
return hsv(h, 0.6 + v * 0.4, v);`,
  },
  {
    id: 'snowfield', name: 'Snowfield',
    desc: 'Gently drifting snowflakes with varying speeds',
    preview: 'linear-gradient(180deg,#000033 0%,#112244 50%,#ffffff 100%)',
    code:
`// @param density float 0.04 0.005 0.15
// @param speed   float 0.3  0.05  1.5
const cols = 60;
const col  = floor(x * cols);
const seed = col * 1.618 + 0.1;
const yOff = fract(seed * 7.3) * 0.8;
const fall = fract(randomF(seed) * 0.5 + t * params.speed * (0.4 + fract(seed * 3.1) * 0.6) + yOff);
const size = 0.015 + fract(seed * 11.7) * 0.02;
const hit  = abs(y - fall) < size;
const glow = exp(-abs(y - fall) / (size * 3)) * params.density * 25;
const v    = hit ? 0.85 + fract(seed * 5.3) * 0.15 : glow * 0.4;
return hsv(0.58, hit ? 0.05 : 0.3, v * (0.5 + mid * 0.5));`,
  },
  {
    id: 'mandala', name: 'Mandala',
    desc: 'Symmetrical mandala petals responding to bass',
    preview: 'radial-gradient(circle,#ffcc44,#ff6600,#220044)',
    code:
`// @param petals  float 8.0 3.0 16.0
// @param layers  float 3.0 1.0 6.0
const { r, a } = polar(x, y);
let v = 0;
const petal  = params.petals;
const beat_r = 0.3 + bass * 0.7;
for (let i = 1; i <= floor(params.layers); i++) {
  const ring  = sin((r * i * 5 - t * 0.6) * TAU) * 0.5 + 0.5;
  const spoke = pow(abs(sin(a * petal * 0.5)), 3);
  const fade  = exp(-abs(r - i * 0.18 * beat_r) * 12);
  v += ring * spoke * fade / i;
}
const h = fract(0.08 + r * 0.3 + a / TAU * 0.1 + t * 0.05);
return hsv(h, 0.95, clamp(v, 0, 1));`,
  },
  {
    id: 'color-organ', name: 'Color Organ',
    desc: 'Each audio band controls a separate color zone with smooth blending',
    preview: 'linear-gradient(135deg,#ff0044,#44ff00,#0044ff)',
    code:
`// Full-range audio-reactive color organ
const bassZone = exp(-pow((x - 0.15) * 5, 2)) * bass;
const midZone  = exp(-pow((x - 0.5)  * 4, 2)) * mid;
const hiZone   = exp(-pow((x - 0.85) * 5, 2)) * hi;
const energy   = bassZone + midZone + hiZone;
const h        = (bassZone * 0.0 + midZone * 0.33 + hiZone * 0.65) / max(0.001, energy);
const s        = 0.8 + energy * 0.2;
const v        = 0.1 + energy * 0.9;
const vBar     = y < energy ? v : 0.05 + sin(y * 12 - t * 4) * 0.02;
return hsv(h, s, vBar);`,
  },
  {
    id: 'lissajous', name: 'Lissajous',
    desc: 'Animated Lissajous curves drawing geometric shapes',
    preview: 'radial-gradient(ellipse,#00ffaa,#0088ff,#000022)',
    code:
`// @param freqX  float 3.0 1.0 8.0
// @param freqY  float 2.0 1.0 8.0
// @param thick  float 0.03 0.005 0.12
const steps = 120;
let v = 0;
for (let i = 0; i < steps; i++) {
  const tOff  = i / steps * TAU;
  const lx    = sin(params.freqX * tOff + t * 0.7) * 0.5 + 0.5;
  const ly    = sin(params.freqY * tOff)             * 0.5 + 0.5;
  const dist  = sqrt(pow(x - lx, 2) + pow(y - ly, 2));
  v = max(v, exp(-dist * dist / (params.thick * params.thick)));
}
const hue = fract(0.5 + t * 0.06 + v * 0.3);
return hsv(hue, 0.85, v * (0.6 + hi * 0.4));`,
  },

  // ── Additional patterns ─────────────────────────────────────────────────────
  {
    id: 'solar', name: 'Solar Flare',
    desc: 'Radiant solar corona with erupting plasma tendrils',
    preview: 'radial-gradient(circle,#ffffff 0%,#ffee00 15%,#ff6600 40%,#220000 100%)',
    code:
`// @param corona float 2.0 0.5 5.0
const { r, a } = polar(x, y);
const corona = exp(-r * r * params.corona);
const flare  = pow(max(0, noise(a * 4 + t * 0.3, r * 3 - t * 0.5)), 2) * (1 - r);
const loop   = sin(r * 8 - t * 2) * 0.5 + 0.5;
const v      = clamp(corona + flare * 0.7 + loop * 0.1 * (1 - r), 0, 1);
const h      = lerp(0.08, 0.02, min(1, v * 2));
return hsv(h, lerp(0.3, 1.0, v), v);`,
  },
  {
    id: 'prism', name: 'Prism',
    desc: 'White light split through a crystal prism into spectral bands',
    preview: 'linear-gradient(135deg,#ff0000,#ff8800,#ffff00,#00ff00,#0088ff,#8800ff)',
    code:
`// @param spread float 1.0 0.3 3.0
// @param angle  float 0.3 0.0 1.0
const beam = exp(-pow((x - 0.5 - sin(t * 0.2) * 0.15) * 6, 2));
const band = fract((y + x * params.angle) * params.spread);
const h    = band;
const sat  = 0.95;
const v    = beam * (0.6 + sin(band * TAU * 3 + t * 2) * 0.3);
return hsv(h, sat, v);`,
  },
  {
    id: 'dna', name: 'DNA Helix',
    desc: 'Double helix spiraling through the LED array',
    preview: 'linear-gradient(135deg,#0044ff,#00ff88,#0044ff)',
    code:
`// @param pitch float 4.0 1.0 8.0
// @param width float 0.08 0.02 0.2
const helix1 = sin(y * params.pitch * TAU + t) * 0.35 + 0.5;
const helix2 = sin(y * params.pitch * TAU + t + PI) * 0.35 + 0.5;
const d1 = abs(x - helix1);
const d2 = abs(x - helix2);
const strand1 = exp(-d1 * d1 / (params.width * params.width));
const strand2 = exp(-d2 * d2 / (params.width * params.width));
const rung    = (floor(y * params.pitch * 4 + t * 2) % 2 === 0)
                  ? exp(-pow(x - (helix1 + helix2) * 0.5, 2) * 40) * 0.5 : 0;
return hsv(0.55 + strand2 * 0.3, 0.9, clamp(strand1 + strand2 + rung, 0, 1));`,
  },
  {
    id: 'fluid', name: 'Fluid',
    desc: 'Incompressible fluid swirl with pressure-based coloring',
    preview: 'conic-gradient(from 45deg,#0033aa,#00aaff,#00ffdd,#0033aa)',
    code:
`// @param visc float 0.8 0.2 2.0
const q1 = sin(x * 3.1 + t * 0.7) * cos(y * 2.4 - t * 0.5);
const q2 = cos(x * 2.3 - t * 0.4) * sin(y * 3.7 + t * 0.6);
const q3 = sin((x + y) * params.visc + t);
const p  = q1 + q2 * 0.6 + q3 * 0.3;
const h  = fract(p * 0.5 + 0.55 + t * 0.03);
const v  = 0.4 + abs(p) * 0.4;
return hsv(h, 0.85, min(v, 1));`,
  },
  {
    id: 'circuit', name: 'Circuit',
    desc: 'Electronic circuit board traces with pulsing data packets',
    preview: 'linear-gradient(135deg,#001100,#003300,#00aa44,#001100)',
    code:
`// @param speed float 2.0 0.5 6.0
const gx = floor(x * 20) / 20;
const gy = floor(y * 12) / 12;
const hx = fract(x * 20);
const hy = fract(y * 12);
const horiz  = hy < 0.12 ? 1 : 0;
const vert   = hx < 0.12 ? 1 : 0;
const pulse  = fract(gx * 3.7 + gy * 2.3 - t * params.speed);
const packet = (pulse < 0.08) ? 1 : 0;
const trace  = max(horiz, vert) * randomF(floor(gx * 20) + floor(gy * 12) * 21);
const v      = max(trace * 0.35, packet * trace);
return hsv(0.35, 0.8, v);`,
  },
  {
    id: 'nova', name: 'Nova',
    desc: 'Supernova explosion with shockwave rings expanding outward',
    preview: 'radial-gradient(circle,#ffffff 0%,#ffcc00 20%,#ff2200 50%,#110022 100%)',
    code:
`// @param rings  float 5.0 2.0 10.0
// @param speed  float 0.5 0.1 1.5
const { r, a } = polar(x, y);
const expand   = fract(t * params.speed);
const shockwave = 0;
let total = 0;
for (let i = 0; i < floor(params.rings); i++) {
  const front = fract(expand + i / params.rings);
  const dist  = abs(r - front);
  total += exp(-dist * dist * 80) * (1 - front) * (1 + bass);
}
const core = exp(-r * r * 30);
const h    = lerp(0.07, 0.82, r);
return hsv(h, 0.9, clamp(total + core, 0, 1));`,
  },
  {
    id: 'tide', name: 'Tide',
    desc: 'Gentle ocean tide — waves lapping and receding',
    preview: 'linear-gradient(180deg,#001133 0%,#003366 30%,#0066aa 60%,#88ccff 100%)',
    code:
`// @param swell float 0.4 0.05 1.0
// @param foam  float 0.08 0.01 0.2
const wave1 = sin(x * TAU * 2 - t * 0.8) * params.swell * 0.15 + 0.45;
const wave2 = sin(x * TAU * 3 + t * 1.1) * params.swell * 0.08 + wave1;
const submerged = y > wave2;
const surface   = abs(y - wave2) < params.foam;
const depth     = clamp((y - wave2) / 0.4, 0, 1);
const h  = submerged ? lerp(0.56, 0.6, depth) : 0.0;
const s  = submerged ? 0.85 : 0;
const v  = surface ? 1 : (submerged ? lerp(0.8, 0.3, depth) : 0.02);
return hsv(h, s, v);`,
  },
  {
    id: 'hyperspace', name: 'Hyperspace',
    desc: 'Warp speed jump — stars stretching into light streaks',
    preview: 'radial-gradient(circle at center,#ffffff 0%,#8888ff 15%,#000011 60%,#000000 100%)',
    code:
`// @param warp  float 1.0 0.3 3.0
// @param count float 60  20  120
const n    = floor(params.count);
const warp = params.warp;
let v = 0, hh = 0.6;
for (let i = 0; i < n; i++) {
  const seed = i * 0.618033;
  const sx   = fract(seed * 7.3) - 0.5;
  const sy   = fract(seed * 13.7) - 0.5;
  const len  = sqrt(sx * sx + sy * sy);
  const nx   = sx / len, ny = sy / len;
  const frac = fract(seed * 3.1 + t * warp * (0.5 + fract(seed * 5.7) * 0.5));
  const cx   = 0.5 + nx * frac;
  const cy   = 0.5 + ny * frac;
  const tailLen = 0.03 + frac * 0.12 * warp;
  const tx   = 0.5 + nx * (frac - tailLen);
  const ty   = 0.5 + ny * (frac - tailLen);
  const onLine = abs((x - tx) * ny - (y - ty) * nx);
  const inSeg  = (x - tx) * nx + (y - ty) * ny;
  if (onLine < 0.004 && inSeg > 0 && inSeg < tailLen * len) {
    const brightness = (1 - onLine * 250) * (inSeg / (tailLen * len));
    v = max(v, brightness);
  }
}
return hsv(0.6 + v * 0.1, 0.7 - v * 0.4, min(v * 1.5, 1));`,
  },
  {
    id: 'zen', name: 'Zen',
    desc: 'Slow meditative breathing — minimal geometric mandala',
    preview: 'radial-gradient(circle,#334455 0%,#111122 50%,#050510 100%)',
    code:
`// @param speed float 0.15 0.05 0.5
const { r, a } = polar(x, y);
const breathe   = sin(t * params.speed * TAU) * 0.5 + 0.5;
const ring      = sin(r * 12 - breathe * 4) * 0.5 + 0.5;
const spoke     = pow(abs(sin(a * 6)), 6);
const glow      = exp(-r * r * 3) * breathe;
const v         = ring * spoke * (1 - r) * 0.6 + glow;
const h         = 0.6 + breathe * 0.05;
return hsv(h, lerp(0.5, 0.8, breathe), clamp(v, 0, 1));`,
  },
  {
    id: 'glitter', name: 'Glitter',
    desc: 'Dense holographic glitter with shifting rainbow shimmer',
    preview: 'radial-gradient(circle at 30% 40%,#ffffff,transparent 20%),radial-gradient(circle at 70% 60%,#ffaaff,transparent 25%),#220033',
    code:
`// @param hue    float 0.0 0.0 1.0
// @param speed  float 3.0 0.5 8.0
const grain = floor(x * 80) + floor(y * 60) * 80;
const phase = randomF(grain) * TAU;
const flick = sin(phase + t * params.speed * (0.5 + randomF(grain + 0.1) * 1.5));
const shine = pow(max(0, flick), 5);
const hue   = fract(params.hue + randomF(grain + 0.2) * 0.15 + t * 0.02);
const v     = shine * (0.6 + hi * 0.4);
return hsv(hue, lerp(0.0, 0.8, shine), v);`,
  },
  {
    id: 'morse', name: 'Morse',
    desc: 'Dots and dashes chasing across the strip in morse code rhythm',
    preview: 'linear-gradient(90deg,#000011,#000011 40%,#4488ff 45%,#ffffff 50%,#4488ff 55%,#000011 60%,#000011)',
    code:
`// @param speed float 1.0 0.2 4.0
// SOS in morse: ... --- ...
const SOS = [1,0,1,0,1,0, 0,0, 3,0,3,0,3,0, 0,0, 1,0,1,0,1,0, 0,0,0,0];
const total = SOS.reduce((a,b) => a+b, 0) * 0.15;
const tp    = fract(t * params.speed * 0.5) * total;
let acc = 0, on = false;
for (let i = 0; i < SOS.length; i++) {
  const dur = SOS[i] * 0.15;
  if (tp >= acc && tp < acc + dur) { on = i % 2 === 0 && SOS[i] > 0; break; }
  acc += dur;
}
const dot = abs(index / pixelCount - fract(t * params.speed * 0.3)) < 0.02;
const glow = max(0, 1 - abs(index / pixelCount - fract(t * params.speed * 0.3)) / 0.1);
const v = on ? (dot ? 1 : glow * 0.3) : 0.02;
return hsv(0.58, on ? 0.7 : 0, v);`,
  },
  {
    id: 'bubble', name: 'Bubbles',
    desc: 'Iridescent soap bubbles rising and popping',
    preview: 'radial-gradient(circle at 25% 60%,#aaffee,transparent 30%),radial-gradient(circle at 65% 35%,#ffaacc,transparent 25%),radial-gradient(circle at 80% 70%,#aaccff,transparent 20%),#000011',
    code:
`// @param count  float 6.0 2.0 12.0
// @param rise   float 0.4 0.1 1.5
let r=0,g=0,b=0;
const n = floor(params.count);
for (let i = 0; i < n; i++) {
  const seed  = i + 0.5;
  const bx    = fract(seed * 0.618) * 0.8 + 0.1;
  const by    = fract(fract(seed * 1.732) + t * params.rise * (0.4 + fract(seed * 2.1) * 0.6));
  const size  = 0.06 + fract(seed * 3.7) * 0.08;
  const dist  = sqrt(pow(x - bx, 2) + pow(y - by, 2));
  const ring  = exp(-pow((dist - size) / (size * 0.2), 2));
  const pop   = fract(by + 0.05) < 0.03 ? exp(-dist * 30) : 0;
  const hue   = fract(seed * 0.41 + t * 0.08);
  const irid  = cos((dist - t * 0.1) * 40) * 0.3;
  const h2    = fract(hue + irid);
  const ir = sin(h2 * TAU) * 0.5 + 0.5;
  const ig = sin(h2 * TAU + TAU / 3) * 0.5 + 0.5;
  const ib = sin(h2 * TAU + TAU * 2 / 3) * 0.5 + 0.5;
  const bright = (ring + pop * 0.8) * (0.7 + bass * 0.3);
  r = max(r, ir * bright); g = max(g, ig * bright); b = max(b, ib * bright);
}
return { r: r*255, g: g*255, b: b*255 };`,
  },

  // ── BPM-synced patterns ─────────────────────────────────────────────────────
  {
    id: 'strobe-bpm', name: 'Strobe BPM',
    desc: 'Hard strobe synced to BPM — use at low brightness',
    preview: 'linear-gradient(90deg,#ffffff,#000000)',
    code:
`// @param duty  float 0.15 0.05 0.5
// @param hue   float 0.0  0.0  1.0
const on = beat < params.duty;
return hsv(params.hue, 0.1, on ? 1 : 0);`,
  },
  {
    id: 'kick-flash', name: 'Kick Flash',
    desc: 'Ring flash on every beat, bass amplified',
    preview: 'radial-gradient(circle,#ffffff 0%,#ff2200 40%,#000000 100%)',
    code:
`// @param color float 0.02 0.0 1.0
const { r } = polar(x, y);
const kick = pow(1 - beat, 6) * (1 + bass * 2);
const ring = exp(-pow((r - beat * 0.8) * 6, 2)) * kick;
const core = exp(-r * 4) * pow(1 - beat, 8);
return hsv(params.color, 0.85, clamp(ring + core, 0, 1));`,
  },
  {
    id: 'beat-grid', name: 'Beat Grid',
    desc: 'Geometric grid tiles that flash on each beat',
    preview: 'linear-gradient(45deg,#222244,#4444aa)',
    code:
`// @param cols  float 8.0 2.0 16.0
// @param speed float 1.0 0.5 4.0
const col = floor(x * params.cols);
const row = floor(y * params.cols * 0.75);
const offset = fract((col + row * 0.7) / (params.cols * 2));
const phase  = fract(beat + offset);
const flash  = pow(1 - phase, 4);
const hue    = fract(0.6 + offset * 0.4 + t * 0.02);
return hsv(hue, 0.8, flash * 0.9 + 0.05);`,
  },
  {
    id: 'pulse-expand', name: 'Pulse Expand',
    desc: 'Radial pulse expanding outward on every beat',
    preview: 'radial-gradient(circle,#ff00ff 0%,#000033 70%)',
    code:
`// @param hue float 0.8 0.0 1.0
const { r } = polar(x, y);
const ring = exp(-pow((r - beat) * 8, 2));
const fill = exp(-r * 2) * pow(1 - beat, 3);
return hsv(params.hue + r * 0.1, 0.9, clamp(ring + fill, 0, 1) * (1 + bass));`,
  },
  {
    id: 'confetti-bpm', name: 'Confetti Beat',
    desc: 'Random color confetti explosion synced to each beat',
    preview: 'conic-gradient(from 0deg,#ff0000,#00ff00,#0000ff,#ffff00,#ff00ff,#ff0000)',
    code:
`// @param density float 0.3 0.05 0.8
const frame = floor(beat * 8);
const seed  = randomF(index + frame * 997);
const hit   = seed < params.density * (1 + bass);
const h     = randomF(index * 0.618 + frame * 0.073);
const flash = pow(1 - beat, 4);
return hsv(h, 0.9, hit ? flash : 0);`,
  },
  // ── Even more patterns ────────────────────────────────────────────────────
  {
    id: 'ribbons', name: 'Silk Ribbons',
    desc: 'Flowing layered color ribbons twisting through space',
    preview: 'linear-gradient(45deg, #ff4488, #ff8800, #ffff00, #00ff88, #0088ff, #8800ff)',
    code:
`// @param count float 4.0 2.0 8.0
// @param speed float 0.6 0.1 2.0
const n = floor(params.count);
let c = 0.0;
for (let i = 0; i < n; i++) {
  const phase = i / n;
  const wave = sin((x + y) * 4.0 + time * params.speed + phase * TWO_PI) * 0.5 + 0.5;
  c += wave / n;
}
return hsv(fract(c + time * 0.05), 0.9, 0.9);`,
  },
  {
    id: 'tesseract', name: 'Tesseract',
    desc: 'Rotating 4D hypercube projection with geometric precision',
    preview: 'conic-gradient(from 45deg, #001166, #0033ff, #0088ff, #00ffff, #001166)',
    code:
`// @param rot4d float 0.5 0.0 2.0
const a = atan2(y - 0.5, x - 0.5);
const r = sqrt(pow(x - 0.5, 2) + pow(y - 0.5, 2));
const a4d = time * params.rot4d;
const proj = sin(r * 8 + a * 4 + a4d) * 0.3 + sin(r * 6 - a * 3 + a4d * 1.4) * 0.3;
const grid = abs(sin((proj + 0.5) * PI * 4));
return hsv(0.6 + proj * 0.15, 0.9, clamp(pow(grid, 3), 0, 1));`,
  },
  {
    id: 'zodiac', name: 'Zodiac Wheel',
    desc: 'Rotating astrology wheel with glowing constellation segments',
    preview: 'conic-gradient(from 0deg, #220033, #6600cc, #220033, #6600cc, #220033)',
    code:
`// @param segments float 12.0 3.0 24.0
const { r, a } = polar(x, y);
const n = floor(params.segments);
const seg = floor(fract(a / (1.0 / n)) * n);
const rim = exp(-pow((r - 0.38) * 12, 2));
const spoke = exp(-pow(fract(a * n) - 0.5, 2) * 80) * smoothstep(0.15, 0.4, r);
const h = seg / n + time * 0.02;
const v = clamp((rim + spoke) * (0.7 + 0.3 * sin(time * 2 + seg)), 0, 1);
return hsv(h, 0.85, v);`,
  },
  {
    id: 'constellation', name: 'Constellation',
    desc: 'Star field with connected constellation lines pulsing',
    preview: 'radial-gradient(circle, #ffffff 1%, #001133 20%, #000000 100%)',
    code:
`// @param stars float 20.0 5.0 50.0
// @param twinkle float 2.0 0.5 5.0
const n = floor(params.stars);
let brightness = 0.0;
for (let i = 0; i < n; i++) {
  const sx = fract(sin(i * 127.1) * 43758.5);
  const sy = fract(cos(i * 311.7) * 12345.6);
  const d  = sqrt(pow(x - sx, 2) + pow(y - sy, 2));
  const t2  = fract(time * params.twinkle * 0.1 + i * 0.37);
  brightness += exp(-d * 40) * (0.4 + 0.6 * abs(sin(time * params.twinkle + i)));
}
return hsv(0.65, 0.3 - brightness * 0.2, clamp(brightness, 0, 1));`,
  },
  {
    id: 'pendulum', name: 'Pendulum',
    desc: 'Swinging pendulum traces Lissajous patterns in light',
    preview: 'radial-gradient(ellipse, #ffff44 0%, #ff8800 30%, #440000 100%)',
    code:
`// @param freq float 3.0 1.0 8.0
// @param damping float 0.1 0.0 0.5
const t2 = time * 0.5;
const px = sin(t2 * params.freq) * exp(-t2 * params.damping * 0.01);
const py = sin(t2 * params.freq * 1.41 + 1.0) * 0.8;
const d = sqrt(pow(x - (px * 0.4 + 0.5), 2) + pow(y - (py * 0.4 + 0.5), 2));
const glow = exp(-d * 20);
return hsv(0.1, 1.0, clamp(glow * 2, 0, 1));`,
  },
  {
    id: 'iceberg', name: 'Iceberg',
    desc: 'Deep blue underwater gradients with surface light caustics',
    preview: 'linear-gradient(180deg, #cceeFF 0%, #0044aa 40%, #001133 100%)',
    code:
`// @param caustic float 3.0 1.0 8.0
const depth = 1.0 - y;
const surface = smoothstep(0.85, 1.0, y);
const caus = sin(x * params.caustic * 8 + time * 2) * sin(x * params.caustic * 5.3 - time * 1.7);
const light = surface * (0.5 + caus * 0.4) + depth * 0.1;
const h = lerp(0.57, 0.65, depth);
const s = lerp(0.2, 0.95, depth);
return hsv(h, s, clamp(light + depth * 0.15, 0, 1));`,
  },
  {
    id: 'soundwave', name: 'Sound Wave',
    desc: 'Classic oscilloscope-style sine wave display',
    preview: 'linear-gradient(90deg, #000022 0%, #003366 50%, #000022 100%)',
    code:
`// @param freq float 3.0 0.5 10.0
// @param amp float 0.3 0.05 0.8
const wave = sin(x * params.freq * TWO_PI + time * 4) * params.amp;
const d = abs(y - 0.5 - wave * 0.4);
const glow = exp(-d * 30) + exp(-d * 8) * 0.3;
const h = 0.6 + wave * 0.1;
return hsv(h, 0.9, clamp(glow, 0, 1));`,
  },
  {
    id: 'mandelbrot', name: 'Mandelbrot',
    desc: 'Classic Mandelbrot set fractal rendered in real-time',
    preview: 'radial-gradient(circle, #ff8800 10%, #220000 40%, #000033 70%, #001166 100%)',
    code:
`// @param zoom float 2.5 0.5 5.0
// @param iter float 16.0 4.0 32.0
const cx = (x - 0.5) * params.zoom * 2.5 - 0.5;
const cy = (y - 0.5) * params.zoom * 2.0;
let zx = 0, zy = 0, i = 0;
const maxI = floor(params.iter);
while (i < maxI && zx * zx + zy * zy < 4) {
  const tmp = zx * zx - zy * zy + cx;
  zy = 2 * zx * zy + cy; zx = tmp; i++;
}
const t2 = i / maxI;
return t2 >= 1.0 ? rgb(0,0,0) : hsv(fract(t2 * 3 + time * 0.05), 0.9, t2 > 0.1 ? 0.8 : 0.2);`,
  },
  {
    id: 'cityscape', name: 'Cityscape',
    desc: 'Night skyline silhouette with glowing windows',
    preview: 'linear-gradient(180deg, #000011 0%, #001133 50%, #ff8800 70%, #ffcc00 100%)',
    code:
`// @param density float 8.0 3.0 20.0
const bld = floor(x * params.density);
const h2 = 0.4 + fract(sin(bld * 127.1) * 0.3) * 0.3;
const top = 1.0 - h2;
const inBuilding = y > top ? 1.0 : 0.0;
const winRow = floor((y - top) / 0.05);
const winCol = floor(x * params.density * 3);
const winOn = fract(sin(bld * 100 + winRow * 17 + winCol * 7) * 4312) > 0.4;
const winGlow = inBuilding * winOn ? 1.0 : 0.0;
const sky = 1.0 - y;
const horizon = exp(-pow((y - top) * 12, 2)) * 0.5;
const h = lerp(0.65, 0.08, sky);
return hsv(h, 0.9, inBuilding * (0.15 + winGlow * 0.85) + sky * 0.05 + horizon);`,
  },
  {
    id: 'lotus', name: 'Lotus Bloom',
    desc: 'Unfolding lotus flower petals with soft radial glow',
    preview: 'radial-gradient(circle, #ffaacc 0%, #ff4488 40%, #220022 100%)',
    code:
`// @param petals float 8.0 3.0 16.0
// @param bloom float 0.5 0.0 1.0
const { r, a } = polar(x, y);
const n = floor(params.petals);
const petal = 0.5 + 0.5 * sin(a * n + time * 0.3);
const shape = r / (0.15 + 0.35 * params.bloom * petal);
const v = exp(-pow(shape - 0.8, 2) * 8) + exp(-r * 4) * 0.5;
const h = 0.88 + petal * 0.06;
return hsv(h, 0.85, clamp(v, 0, 1));`,
  },
  // ── More patterns ─────────────────────────────────────────────────────────
  {
    id: 'northern', name: 'Northern Lights',
    desc: 'Slow sweeping aurora borealis curtains',
    preview: 'linear-gradient(180deg,#001020 0%,#004030 40%,#00aa88 70%,#00ffcc 90%,#8844ff 100%)',
    code:
`// @param speed float 0.4 0.05 2.0
// @param width float 3.0 1.0 8.0
const col = x * params.width + time * params.speed;
const h1 = sin(col) * 0.5 + sin(col * 0.7 + time * 0.3) * 0.3;
const curtain = smoothstep(0.0, 0.3, y) * smoothstep(1.0, 0.6, y);
const h = 0.45 + h1 * 0.15;
const v = curtain * (0.5 + sin(col * 2.1 + time) * 0.4);
return hsv(h, 0.9, clamp(v, 0, 1));`,
  },
  {
    id: 'kaleido', name: 'Kaleidoscope',
    desc: 'Mirrored radial symmetry pattern with evolving geometry',
    preview: 'conic-gradient(from 0deg, #ff0088, #8800ff, #0088ff, #00ff88, #ff0088)',
    code:
`// @param slices float 6.0 2.0 16.0
// @param zoom float 3.0 1.0 8.0
const { r, a } = polar(x, y);
const slices = floor(params.slices);
const fa = fract(a / (1.0 / slices) * 0.5) * 2.0;
const ma = (fa > 1.0 ? 2.0 - fa : fa) / slices * TWO_PI;
const kr = r * params.zoom;
const h = fract(sin(kr * 3.1 + time) * 0.3 + cos(ma * 2 + time * 0.7) * 0.2);
return hsv(h, 0.95, smoothstep(0.0, 0.1, 1.0 - r));`,
  },
  {
    id: 'watercolor', name: 'Watercolor Wash',
    desc: 'Soft blending washes of color drifting across the canvas',
    preview: 'radial-gradient(ellipse at 30% 40%, #ff9988 0%, #cc44aa 40%, #4466ff 100%)',
    code:
`// @param drift float 0.3 0.05 1.0
const x2 = x + sin(y * 2.3 + time * params.drift) * 0.3;
const y2 = y + cos(x * 1.7 + time * params.drift * 0.8) * 0.3;
const h = fract(x2 * 0.3 + y2 * 0.2 + time * 0.05);
const s = 0.5 + sin(x * 3 + y * 2 + time * 0.4) * 0.3;
const v = 0.7 + sin(x2 * 4 + time * 0.6) * 0.2;
return hsv(h, s, v);`,
  },
  {
    id: 'digitrain', name: 'Digital Rain',
    desc: 'Matrix-style falling columns of green characters',
    preview: 'linear-gradient(180deg, #001500, #003300, #00ff41 80%, #ffffff)',
    code:
`// @param speed float 1.5 0.3 5.0
// @param density float 0.4 0.1 0.9
const col = floor(x * 24) / 24;
const seed = randomF(col * 127.1);
const phase = time * params.speed * (0.5 + seed * 0.5);
const pos = fract(y + phase);
const head = pos < 0.05 ? 1.0 : 0.0;
const trail = exp(-pos * 6.0) * smoothstep(params.density, 0.0, seed);
const on = randomF(col * 23.1 + floor(phase * 15)) > (1 - params.density);
return on ? hsv(0.35, head > 0 ? 0.0 : 0.8, clamp(trail + head * 1.5, 0, 1)) : rgb(0, 0, 0);`,
  },
  {
    id: 'sunrise', name: 'Sunrise',
    desc: 'Warm horizon glow transitioning from deep purple to golden daylight',
    preview: 'linear-gradient(180deg, #220033 0%, #8800aa 30%, #ff4400 60%, #ff9900 80%, #ffdd00 100%)',
    code:
`// @param horizon float 0.5 0.1 0.9
// @param speed float 0.1 0.01 0.5
const t2 = fract(time * params.speed);
const sunY = params.horizon + sin(t2 * PI) * 0.3;
const d = abs(y - sunY);
const glow = exp(-d * d * 40) + exp(-d * 6) * 0.4;
const skyH = lerp(0.78, 0.08, clamp((y - sunY + 0.2) / 0.4, 0, 1));
const skyV = 0.3 + y * 0.4;
return hsv(skyH, 0.9, clamp(skyV + glow, 0, 1));`,
  },
  {
    id: 'fractal', name: 'Fractal Noise',
    desc: 'Layered octave noise creating organic fractal texture',
    preview: 'radial-gradient(circle, #ffffff 0%, #8888ff 30%, #4400aa 60%, #110022 100%)',
    code:
`// @param octaves float 4.0 1.0 6.0
// @param lacunarity float 2.1 1.5 4.0
// @param gain float 0.5 0.2 0.8
let v = 0.0, amp = 0.5, freq = 1.0;
const oct = floor(params.octaves);
for (let i = 0; i < oct; i++) {
  v += sin(x * freq * 6.2 + time * (1 + i * 0.3)) * sin(y * freq * 4.8 + time * 0.7) * amp;
  freq *= params.lacunarity;
  amp  *= params.gain;
}
return hsv(fract(v + time * 0.05), 0.7 + v * 0.3, 0.5 + v * 0.5);`,
  },
  {
    id: 'thermal', name: 'Thermal Vision',
    desc: 'Infrared thermal camera simulation with cold-to-hot color mapping',
    preview: 'linear-gradient(90deg, #000066 0%, #0066ff 25%, #00ff66 45%, #ffff00 65%, #ff4400 80%, #ffffff 100%)',
    code:
`// @param speed float 0.8 0.1 3.0
const heat = sin(x * 4.1 + time * params.speed) * 0.3
           + sin(y * 3.7 - time * params.speed * 0.7) * 0.3
           + sin((x + y) * 2.9 + time * params.speed * 1.3) * 0.4;
const v = clamp(heat * 0.5 + 0.5, 0, 1);
const h = lerp(0.66, 0.0, v);
return hsv(h, 1.0, v);`,
  },
  {
    id: 'jellyfish', name: 'Jellyfish',
    desc: 'Pulsating translucent jellyfish drifting upward',
    preview: 'radial-gradient(ellipse 60% 80% at 50% 70%, #ffffff44 0%, #8800ff88 40%, #440088 70%, #000022 100%)',
    code:
`// @param pulse float 1.0 0.3 3.0
// @param tentacles float 6.0 3.0 12.0
const { r, a } = polar(x, y - 0.3);
const bell = exp(-r * r * 8) * (0.5 + 0.5 * sin(time * params.pulse * TWO_PI));
const t = sin(a * params.tentacles + time * 2) * 0.5 + 0.5;
const tentacle = exp(-r * 3) * t * 0.5;
const h = 0.72 + sin(time * 0.3) * 0.1;
return hsv(h, 0.8, clamp(bell + tentacle, 0, 1));`,
  },
  {
    id: 'pixelate', name: 'Pixel Art',
    desc: 'Animated low-resolution pixel blocks with cycling colors',
    preview: 'linear-gradient(45deg, #ff0000 0%, #00ff00 33%, #0000ff 66%, #ffff00 100%)',
    code:
`// @param size float 0.15 0.05 0.4
// @param speed float 0.5 0.1 3.0
const px = floor(x / params.size) * params.size;
const py = floor(y / params.size) * params.size;
const seed = floor(px * 100 + py * 7 + floor(time * params.speed));
const h = fract(sin(seed * 127.1 + 311.7) * 43758.5);
return hsv(h, 0.9, 0.9);`,
  },
  {
    id: 'smoke-haze', name: 'Smoke & Haze',
    desc: 'Billowing smoke tendrils with shifting opacity',
    preview: 'linear-gradient(180deg, #cccccc 0%, #888888 40%, #444444 70%, #111111 100%)',
    code:
`// @param rise float 0.3 0.05 1.5
// @param swirl float 2.0 0.5 5.0
const tx = x + sin(y * params.swirl + time * 0.7) * 0.1;
const ty = y - time * params.rise;
const d1 = sin(tx * 5.1 + ty * 3.7 + time * 0.4);
const d2 = sin(tx * 3.3 - ty * 4.9 + time * 0.6);
const v = clamp((d1 + d2) * 0.3 + 0.5, 0, 1);
const h = 0.55 + v * 0.1;
return hsv(h, 0.05 + v * 0.1, v * 0.8);`,
  },

  // ── Batch 4: 10 more patterns ───────────────────────────────────────────
  {
    id: 'lava-lamp', name: 'Lava Lamp',
    desc: 'Slow blobs of color rising and falling',
    preview: 'linear-gradient(180deg, #ff6600 0%, #cc0044 50%, #440022 100%)',
    code:
`// @param speed float 0.4 0.1 2.0
// @param blobs float 3.0 1.0 8.0
const t2 = time * params.speed;
let v = 0;
for (let i = 0; i < params.blobs; i++) {
  const bx = sin(i * 2.4 + t2 * 0.3) * 0.4 + 0.5;
  const by = (fract(i * 0.618 + t2 * 0.15) * 1.4) - 0.2;
  const d = sqrt((x - bx)*(x - bx)*4 + (y - by)*(y - by));
  v += 0.1 / (d + 0.05);
}
const hue = fract(v * 0.15 + 0.95);
return hsv(hue, 1, clamp(v * 0.6, 0, 1));`,
  },

  {
    id: 'aurora-borealis', name: 'Aurora Borealis',
    desc: 'Vertical curtains of pale green and violet light',
    preview: 'linear-gradient(90deg, #003322 0%, #00ffaa 30%, #4400aa 60%, #00ffaa 80%, #003322 100%)',
    code:
`// @param width float 0.25 0.05 1.0
// @param drift float 1.0 0.2 3.0
const tx = x + fbm(x * 2 + time * params.drift * 0.1, y * 0.5, 2) * 0.3;
const curtain = sin(tx * 8 + time * 0.4) * 0.5 + 0.5;
const yfade = smoothstep(0, 0.4, y) * smoothstep(1, 0.6, y);
const v = curtain * yfade * params.width * 4;
const hue = 0.38 + curtain * 0.25;
return hsv(hue, 0.7, clamp(v, 0, 1));`,
  },

  {
    id: 'circuit-board', name: 'Circuit Board',
    desc: 'Pulsing data packets along PCB traces',
    preview: 'linear-gradient(135deg, #001100 0%, #003300 40%, #00ff44 60%, #001100 100%)',
    code:
`// @param density float 6.0 2.0 16.0
// @param speed float 1.5 0.5 4.0
const gx = floor(x * params.density) / params.density;
const gy = floor(y * params.density) / params.density;
const line = step(abs(x - gx), 0.02) + step(abs(y - gy), 0.02);
const packet = step(0.85, sin(gx * 7.3 + gy * 5.1 + time * params.speed));
const v = clamp(line * 0.3 + packet, 0, 1);
return hsv(0.35, 0.9, v);`,
  },

  {
    id: 'wormhole', name: 'Wormhole',
    desc: 'Spiraling tunnel into infinite depth',
    preview: 'radial-gradient(circle, #ffffff 0%, #4400aa 30%, #000044 60%, #000000 100%)',
    code:
`// @param speed float 1.0 0.2 4.0
// @param twist float 3.0 0.5 8.0
const { r, a } = polar(x, y);
const depth = fract(r * 4 - time * params.speed);
const spiral = fract(a / (PI * 2) * params.twist + time * 0.3);
const v = pow(1 - depth, 2);
return hsv(fract(spiral + depth * 0.3), 0.8, v);`,
  },

  {
    id: 'bioluminescence', name: 'Bioluminescence',
    desc: 'Glowing sea creatures moving through dark water',
    preview: 'radial-gradient(circle at 30% 60%, #00ffcc44, transparent), radial-gradient(circle at 70% 30%, #0044ff44, transparent), linear-gradient(180deg, #000022, #001133)',
    code:
`// @param creatures float 5.0 2.0 12.0
// @param glow float 0.12 0.04 0.3
const t = time * 0.3;
let acc = 0;
for (let i = 0; i < params.creatures; i++) {
  const cx = fract(i * 0.37 + sin(i * 2.1 + t * 0.4) * 0.2);
  const cy = fract(i * 0.61 + cos(i * 1.7 + t * 0.3) * 0.15 + t * 0.05);
  const d = length(vec2(x - cx, y - cy));
  acc += params.glow / (d * d + 0.001);
}
const hue = 0.5 + sin(x * 3 + time * 0.2) * 0.1;
return hsv(hue, 0.8, clamp(acc, 0, 1));`,
  },

  {
    id: 'prismatic', name: 'Prismatic',
    desc: 'White light splitting into spectrum bands',
    preview: 'linear-gradient(90deg, #ff0000, #ff8800, #ffff00, #00ff00, #0088ff, #8800ff)',
    code:
`// @param bands float 6.0 2.0 12.0
// @param angle float 0.3 0.0 1.0
const xr = x * cos(params.angle * PI) - y * sin(params.angle * PI);
const hue = fract(xr * params.bands * 0.5 + time * 0.1);
const shimmer = 0.8 + sin(xr * 60 + time * 5) * 0.2;
return hsv(hue, 0.95, shimmer);`,
  },

  {
    id: 'meteor-shower', name: 'Meteor Shower',
    desc: 'Streaking meteors with glowing tails',
    preview: 'linear-gradient(150deg, #000011 0%, #001133 40%, #ffffff88 50%, #000011 60%)',
    code:
`// @param count float 8.0 2.0 20.0
// @param speed float 2.0 0.5 5.0
let v = 0;
let hue = 0;
for (let i = 0; i < params.count; i++) {
  const ox = fract(i * 0.618);
  const streak = fract(ox + i * 0.23);
  const mx = ox + (time * params.speed * (0.8 + i * 0.05)) * -0.3;
  const my = fract(i * 0.382 + time * params.speed * (0.6 + i * 0.03));
  const dx = x - fract(mx);
  const dy = y - fract(my);
  const tail = clamp(1 - (dx * dx + dy * dy) * 80, 0, 1) * clamp(1 - dx * 8, 0, 1);
  if (tail > v) { v = tail; hue = 0.6 + i * 0.05; }
}
return hsv(hue, 0.3 + v * 0.7, v);`,
  },

  {
    id: 'pixel-rain', name: 'Pixel Rain',
    desc: 'Columns of falling glowing pixels',
    preview: 'linear-gradient(180deg, #000000 0%, #00ff00 40%, #003300 80%)',
    code:
`// @param speed float 2.0 0.5 6.0
// @param density float 0.5 0.1 1.0
const col = floor(x * 20);
const offset = fract(col * 0.618);
const head = fract(time * params.speed * (0.7 + offset * 0.6) + offset);
const dist = fract(head - y + 1);
const tail = pow(1 - dist, 3);
const active = step(1 - params.density, fract(col * 0.314 + 0.5));
const v = tail * active;
return hsv(0.35, 0.8, v);`,
  },

  {
    id: 'crystallize', name: 'Crystallize',
    desc: 'Geometric crystal facets refracting light',
    preview: 'linear-gradient(135deg, #88ccff 0%, #ffffff 30%, #aaddff 50%, #4488cc 80%, #88ccff 100%)',
    code:
`// @param facets float 8.0 4.0 20.0
// @param shimmer float 1.5 0.5 4.0
const gx = floor(x * params.facets + 0.5) / params.facets;
const gy = floor(y * params.facets + 0.5) / params.facets;
const mx = x - gx;
const my = y - gy;
const edge = 1 - smoothstep(0, 0.04, length(vec2(mx, my)));
const face = sin(gx * 7 + gy * 5 + time * params.shimmer);
const hue = 0.58 + face * 0.08;
const v = edge * 0.8 + 0.2 + face * 0.1;
return hsv(hue, 0.4, clamp(v, 0, 1));`,
  },

  {
    id: 'hypnotic-spiral', name: 'Hypnotic Spiral',
    desc: 'Mesmerizing rotating concentric rings',
    preview: 'conic-gradient(from 0deg, #ff0000, #ff8800, #ffff00, #00ff00, #0088ff, #8800ff, #ff0000)',
    code:
`// @param rings float 5.0 2.0 12.0
// @param speed float 1.0 0.2 4.0
const { r, a } = polar(x, y);
const spin = fract(a / (PI * 2) + time * params.speed * 0.15);
const ring = fract(r * params.rings * 2 - time * params.speed * 0.5);
const v = step(0.4, abs(sin(ring * PI)));
return hsv(fract(spin + ring * 0.3), 0.95, v);`,
  },

  // ── Batch 5: Audio-reactive and performance patterns ─────────────────────
  {
    id: 'bass-bloom', name: 'Bass Bloom',
    desc: 'Expanding rings triggered by bass hits',
    preview: 'radial-gradient(circle, #ff4400 0%, #ff8800 40%, #220000 100%)',
    code:
`// @param size float 0.8 0.3 2.0
// @param decay float 4.0 1.0 10.0
const { r } = polar(x, y);
const pulse = bass * params.size;
const ring = abs(r - pulse);
const v = exp(-ring * params.decay * 8) * bass;
return hsv(0.02 + bass * 0.1, 1, v);`,
  },

  {
    id: 'spectrum-waterfall', name: 'Spectrum Waterfall',
    desc: 'Audio spectrum scrolling down like a waterfall',
    preview: 'linear-gradient(180deg, #00ffff 0%, #0088ff 30%, #004488 60%, #000022 100%)',
    code:
`// @param bands float 8.0 4.0 24.0
// @param falloff float 3.0 1.0 8.0
const b = floor(x * params.bands);
const audioVal = mix(bass, mix(mid, hi, fract(b / params.bands)), b / params.bands);
const yscale = 1 - y;
const v = clamp((audioVal - y) * params.falloff, 0, 1);
const hue = 0.65 - b / params.bands * 0.3;
return hsv(hue, 0.9, v);`,
  },

  {
    id: 'strobe-color', name: 'Color Strobe',
    desc: 'BPM-synced strobe with color cycle',
    preview: 'linear-gradient(90deg, #ff0000, #00ff00, #0000ff, #ff0000)',
    code:
`// @param rate float 2.0 0.5 8.0
// @param hueSpeed float 0.5 0.0 2.0
const flash = step(0.15, fract(beat * params.rate));
const hue = fract(time * params.hueSpeed);
return hsv(hue, 1, flash);`,
  },

  {
    id: 'neon-sign', name: 'Neon Sign',
    desc: 'Flickering neon tube effect with color glow',
    preview: 'linear-gradient(90deg, #ff44ff 0%, #cc00cc 30%, #ff88ff 50%, #cc00cc 70%, #ff44ff 100%)',
    code:
`// @param hue float 0.85 0.0 1.0
// @param flicker float 0.1 0.0 0.5
const glow = 0.7 + sin(time * 3.14 * 7) * 0.05 * params.flicker
           + sin(time * 3.14 * 13) * 0.03 * params.flicker;
const base = pow(1 - abs(y - 0.5) * 2, 3);
return hsv(params.hue, 0.9, base * glow);`,
  },

  // ── Batch 6: Ambient, generative, and party patterns ─────────────────────
  {
    id: 'oil-slick', name: 'Oil Slick',
    desc: 'Iridescent swirling rainbow surface',
    preview: 'conic-gradient(from 45deg, #ff0088, #00ffcc, #ff8800, #8800ff, #00ff44, #ff0088)',
    code:
`// @param scale float 2.0 0.5 6.0
// @param drift float 0.3 0.0 1.5
const n1 = noise(x * params.scale + time * 0.1, y * params.scale + time * params.drift);
const n2 = noise(x * params.scale * 1.7 - time * 0.07, y * params.scale * 1.3 + time * 0.05);
const hue = fract(n1 * 0.8 + n2 * 0.4 + time * 0.05);
return hsv(hue, 1, 0.7 + n1 * 0.3);`,
  },

  {
    id: 'starfield', name: 'Starfield',
    desc: 'Warp-speed star tunnel through hyperspace',
    preview: 'radial-gradient(circle, #ffffff 0%, #8888ff 20%, #0000aa 60%, #000000 100%)',
    code:
`// @param speed float 1.5 0.2 5.0
// @param density float 80.0 20.0 200.0
const { r, a } = polar(x, y);
const id = floor(a * params.density / (PI * 2));
const rng = fract(sin(id * 127.1) * 43758.5);
const offset = fract(rng + time * params.speed * (0.2 + rng * 0.8));
const starR = offset;
const size = 0.002 + rng * 0.008;
const v = smoothstep(size, 0, abs(r - starR));
return [v * 0.9, v * 0.9, v];`,
  },

  {
    id: 'lava-flow', name: 'Lava Flow',
    desc: 'Molten lava slowly oozing with heat shimmer',
    preview: 'linear-gradient(180deg, #ff2200 0%, #ff6600 30%, #cc3300 60%, #440000 100%)',
    code:
`// @param viscosity float 0.5 0.1 2.0
// @param heat float 1.0 0.3 2.5
const s = params.viscosity;
const n = noise(x * 2 + sin(y * 3 + time * s) * 0.3, y * 1.5 - time * s * 0.3);
const n2 = noise(x * 3 - time * 0.2, y * 2 + n * 0.5 + time * s * 0.1);
const t = clamp(n * 0.7 + n2 * 0.3 + 0.2, 0, 1);
const hue = mix(0.02, 0.08, t * t);
return hsv(hue, 1, pow(t, 0.7) * params.heat);`,
  },

  {
    id: 'aurora-curtain', name: 'Aurora Curtain',
    desc: 'Flowing curtains of northern lights',
    preview: 'linear-gradient(180deg, #00ffaa 0%, #0088ff 50%, #8800cc 100%)',
    code:
`// @param bands float 3.0 1.0 8.0
// @param speed float 0.4 0.1 2.0
const wave = sin(x * params.bands * PI + time * params.speed + sin(time * 0.7) * 2) * 0.5 + 0.5;
const curtain = smoothstep(0.0, 0.3, 1 - y) * smoothstep(1.0, 0.4, 1 - y);
const hue = mix(0.45, 0.75, wave + x * 0.2);
const v = wave * curtain * (0.6 + noise(x * 2 + time * 0.1, time * 0.05) * 0.4);
return hsv(hue, 0.85, v);`,
  },

  {
    id: 'digital-rain-v2', name: 'Digital Rain II',
    desc: 'Matrix-style falling code columns with glow',
    preview: 'linear-gradient(180deg, #00ff44 0%, #004422 50%, #000000 100%)',
    code:
`// @param cols float 20.0 8.0 48.0
// @param speed float 1.5 0.3 5.0
const col = floor(x * params.cols);
const seed = fract(sin(col * 293.7) * 47891.3);
const fallY = fract(seed + time * params.speed * (0.5 + seed * 0.8));
const dist = abs(y - fallY);
const trail = exp(-dist * 14) + exp(-abs(y - fract(fallY + 0.3)) * 20) * 0.3;
return hsv(0.35, 1, clamp(trail, 0, 1));`,
  },

  {
    id: 'tie-dye', name: 'Tie Dye',
    desc: 'Psychedelic concentric circle dye patterns',
    preview: 'conic-gradient(from 0deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
    code:
`// @param rings float 6.0 2.0 16.0
// @param warp float 0.8 0.0 3.0
const dx = x - 0.5, dy = y - 0.5;
const nx = dx + sin(dy * PI * 2 + time) * params.warp * 0.12;
const ny = dy + cos(dx * PI * 2 + time * 0.7) * params.warp * 0.12;
const r = sqrt(nx*nx + ny*ny) * 2.8;
const hue = fract(r * params.rings * 0.15 + time * 0.07);
return hsv(hue, 1, 0.9);`,
  },

  {
    id: 'plasma-ball', name: 'Plasma Ball',
    desc: 'Electric tendrils emanating from center',
    preview: 'radial-gradient(circle, #ffffff 0%, #8888ff 15%, #4400ff 40%, #110044 100%)',
    code:
`// @param tendrils float 5.0 2.0 12.0
// @param lightning float 1.0 0.2 3.0
const { r, a } = polar(x, y);
const t = time * params.lightning;
const bolt = 0;
let v = 0;
for (let i = 0; i < 3; i++) {
  const ta = a + noise(r * 3 + i * 7.3, t * 0.5 + i) * 2.5;
  const wave = sin(ta * params.tendrils + t * 2 + i * 2.1) * 0.5 + 0.5;
  v += wave * exp(-r * 4) * (1 - r);
}
v = clamp(v, 0, 1);
return hsv(0.65 + v * 0.2, 1 - v * 0.5, v * v);`,
  },

  {
    id: 'breathing-grid', name: 'Breathing Grid',
    desc: 'Pulsing grid of glowing nodes synchronized to BPM',
    preview: 'radial-gradient(circle at 25% 25%, #4488ff 0%, #000022 40%), radial-gradient(circle at 75% 75%, #4488ff 0%, #000022 40%)',
    code:
`// @param gridSize float 5.0 2.0 12.0
// @param hue float 0.6 0.0 1.0
const gx = fract(x * params.gridSize) - 0.5;
const gy = fract(y * params.gridSize) - 0.5;
const d = sqrt(gx*gx + gy*gy);
const pulse = sin(beat * PI * 2) * 0.5 + 0.5;
const node = smoothstep(0.25, 0, d) * (0.3 + pulse * 0.7);
return hsv(params.hue, 0.8, node);`,
  },

  {
    id: 'kaleidoscope-v2', name: 'Kaleidoscope II',
    desc: 'Multi-fold symmetry with fractal detail',
    preview: 'conic-gradient(from 0deg, #ff0088, #8800ff, #0088ff, #00ff88, #88ff00, #ff8800, #ff0088)',
    code:
`// @param folds float 6.0 3.0 16.0
// @param zoom float 2.0 1.0 5.0
const { r, a } = polar(x, y);
const sector = PI * 2 / params.folds;
const fa = mod(a + time * 0.1, sector);
const ma = fa < sector * 0.5 ? fa : sector - fa;
const nx = cos(ma) * r * params.zoom;
const ny = sin(ma) * r * params.zoom;
const hue = fract(noise(nx + time * 0.05, ny) + time * 0.03);
return hsv(hue, 1, 0.5 + r * 0.5);`,
  },

  {
    id: 'particle-burst', name: 'Particle Burst',
    desc: 'Explosive particle bursts at random positions',
    preview: 'radial-gradient(circle, #ffff88 0%, #ff8800 30%, #ff0000 60%, #000000 100%)',
    code:
`// @param count float 4.0 1.0 10.0
// @param lifetime float 1.5 0.5 4.0
let v = 0, hue = 0;
for (let i = 0; i < 4; i++) {
  const seed = fract(sin(i * 137.1 + floor(time / params.lifetime) * 43.2) * 4375.8);
  const seed2 = fract(sin(i * 291.7 + floor(time / params.lifetime) * 71.3) * 6831.4);
  const bx = seed - 0.5, by = seed2 - 0.5;
  const age = fract(time / params.lifetime + seed * 0.3);
  const d = distance(x - 0.5 - bx, y - 0.5 - by, 0, 0);
  const ring = abs(d - age * 0.8);
  const flash = exp(-ring * 20) * (1 - age);
  v += flash;
  hue = mix(hue, seed, flash);
}
return hsv(hue, 1, clamp(v, 0, 1));`,
  },

  // ── Batch 7: Experimental and reactive patterns ───────────────────────────
  {
    id: 'voronoi', name: 'Voronoi',
    desc: 'Cellular Voronoi diagram with glowing borders',
    preview: 'conic-gradient(from 30deg at 30% 70%, #ff0055, #0055ff, #00ff88, #ff0055)',
    code:
`// @param cells float 6.0 2.0 16.0
// @param borderWidth float 0.04 0.01 0.15
// @param hueOffset float 0.0 0.0 1.0
const N = int(params.cells);
let minD1 = 99.0, minD2 = 99.0;
let cellHue = 0.0;
for (let i = 0; i < 12; i++) {
  if (i >= N) break;
  const sx = fract(sin(float(i) * 127.1 + 0.3) * 43758.5);
  const sy = fract(sin(float(i) * 311.7 + 0.9) * 18731.2);
  const cx = sx + sin(time * 0.2 + float(i) * 2.1) * 0.1;
  const cy = sy + cos(time * 0.17 + float(i) * 1.7) * 0.1;
  const d = distance(x, y, cx, cy);
  if (d < minD1) { minD2 = minD1; minD1 = d; cellHue = fract(sx + params.hueOffset); }
  else if (d < minD2) minD2 = d;
}
const border = smoothstep(0, params.borderWidth, minD2 - minD1);
return hsv(cellHue, 0.7, border * 0.85 + (1 - border) * 0.1);`,
  },

  {
    id: 'interference', name: 'Interference',
    desc: 'Concentric wave interference patterns creating moiré',
    preview: 'radial-gradient(circle, #00ffff 0%, #0033aa 40%, #000066 70%, #000000 100%)',
    code:
`// @param waves float 3.0 1.0 8.0
// @param speed float 0.8 0.1 3.0
// @param spread float 12.0 4.0 32.0
let v = 0;
const cx1 = 0.3 + sin(time * 0.2) * 0.15;
const cy1 = 0.3 + cos(time * 0.17) * 0.15;
const cx2 = 0.7 + sin(time * 0.13 + 2) * 0.15;
const cy2 = 0.7 + cos(time * 0.23 + 1) * 0.15;
for (let i = 0; i < 3; i++) {
  const r1 = sqrt(pow(x - cx1, 2) + pow(y - cy1, 2));
  const r2 = sqrt(pow(x - cx2, 2) + pow(y - cy2, 2));
  v += sin(r1 * params.spread - time * params.speed) * 0.33;
  v += sin(r2 * params.spread - time * params.speed * 0.7) * 0.33;
}
const intensity = (v + 1) * 0.5;
return hsv(0.58 + intensity * 0.15, 0.9, intensity * intensity);`,
  },

  {
    id: 'mirror-warp', name: 'Mirror Warp',
    desc: 'Fluid motion mirrored on multiple axes',
    preview: 'conic-gradient(from 45deg, #ff4488, #4488ff, #44ff88, #ff8844, #ff4488)',
    code:
`// @param axis float 2.0 1.0 4.0
// @param speed float 0.7 0.1 2.5
// @param twist float 1.5 0.0 4.0
const ax = fract(x * params.axis) < 0.5 ? fract(x * params.axis) : 1 - fract(x * params.axis);
const ay = fract(y * params.axis) < 0.5 ? fract(y * params.axis) : 1 - fract(y * params.axis);
const wx = ax + sin(ay * PI * params.twist + time * params.speed) * 0.2;
const wy = ay + cos(ax * PI * params.twist + time * params.speed * 0.7) * 0.2;
const hue = fract(noise(wx * 2, wy * 2 + time * 0.1) + time * 0.05);
return hsv(hue, 1, 0.8 + wx * 0.2);`,
  },

  {
    id: 'sand-dune', name: 'Sand Dune',
    desc: 'Wind-rippled desert dunes with warm shifting sands',
    preview: 'linear-gradient(135deg, #ff8800 0%, #ffcc44 30%, #cc6600 60%, #884400 100%)',
    code:
`// @param dunes float 4.0 1.0 10.0
// @param wind float 0.3 0.0 1.5
const n1 = noise(x * params.dunes + time * params.wind, y * 2 + sin(x * 3 + time * 0.2) * 0.3);
const n2 = noise(x * params.dunes * 2 - time * params.wind * 0.5, y * 4);
const dune = n1 * 0.7 + n2 * 0.3;
const hue = mix(0.08, 0.12, dune);
return hsv(hue, 0.7 + dune * 0.3, 0.3 + dune * 0.7);`,
  },

  {
    id: 'retro-scan', name: 'Retro Scan',
    desc: 'CRT scanline scan effect with phosphor glow',
    preview: 'repeating-linear-gradient(180deg, #00ff44 0px, #00aa22 2px, #001100 4px)',
    code:
`// @param scanlines float 24.0 8.0 60.0
// @param phosphor float 0.7 0.0 1.5
// @param hue float 0.35 0.0 1.0
const scanLine = fract(y * params.scanlines + time * 0.3);
const glow = smoothstep(0.0, 0.1, scanLine) * smoothstep(0.5, 0.35, scanLine);
const noise_v = noise(x * 3 + time * 0.2, y * 2 - time * 0.15);
const v = glow * (0.5 + noise_v * 0.5) * params.phosphor;
return hsv(params.hue, 0.95, clamp(v, 0, 1));`,
  },

  {
    id: 'deep-sea', name: 'Deep Sea',
    desc: 'Bioluminescent creatures floating in the abyss',
    preview: 'radial-gradient(circle at 40% 60%, #0055aa 0%, #001133 50%, #000022 100%)',
    code:
`// @param creatures float 5.0 2.0 12.0
// @param glow float 6.0 2.0 15.0
let v = 0, hue = 0;
for (let i = 0; i < 8; i++) {
  const sx = fract(sin(float(i) * 73.1) * 4375.8 + time * 0.05);
  const sy = fract(cos(float(i) * 149.3) * 9182.1 + time * 0.03 * (0.5 + fract(sin(float(i) * 31.7) * 2718.3)));
  const d = distance(x, y, sx, sy);
  const creature = exp(-d * params.glow * (3 + sin(time * 2 + float(i)) * 1.5));
  v += creature * (0.4 + sin(time * 3 + float(i) * 2.1) * 0.3);
  hue = mix(hue, fract(float(i) * 0.13 + 0.48), creature);
}
return hsv(hue, 1, clamp(v, 0, 1) + 0.04);`,
  },

  {
    id: 'paint-drip', name: 'Paint Drip',
    desc: 'Vibrant paint drips flowing down from the top',
    preview: 'linear-gradient(180deg, #ff0055 0%, #ff8800 20%, #ffff00 40%, #00ff44 60%, #0044ff 80%, #8800ff 100%)',
    code:
`// @param streams float 8.0 3.0 20.0
// @param viscosity float 3.0 0.5 8.0
// @param hueShift float 0.0 0.0 1.0
const col = floor(x * params.streams);
const phase = fract(sin(col * 127.1) * 43758.5);
const flowY = fract(y - time * (0.1 + phase * 0.15) / params.viscosity);
const drip = pow(1 - flowY, params.viscosity) * 0.7 + (1 - abs(fract(x * params.streams) - 0.5) * 2) * 0.3;
const hue = fract(col / params.streams + params.hueShift + time * 0.02);
return hsv(hue, 1, clamp(drip, 0, 1));`,
  },

  {
    id: 'snow-globe', name: 'Snow Globe',
    desc: 'Gently falling snowflakes with a warm glow center',
    preview: 'radial-gradient(circle, #ffcc88 0%, #4488bb 40%, #001133 100%)',
    code:
`// @param flakes float 40.0 10.0 100.0
// @param speed float 0.2 0.05 1.0
let v = 0;
const N = int(params.flakes);
for (let i = 0; i < 60; i++) {
  if (i >= N) break;
  const fi = float(i);
  const fx = fract(sin(fi * 73.1) * 4375.8);
  const fy = fract(cos(fi * 149.3) * 9182.1 + time * params.speed * (0.4 + fract(sin(fi * 31.7) * 2718.3) * 0.6));
  const d = distance(x, y, fx, fy);
  v += smoothstep(0.025, 0, d);
}
const globe = exp(-distance(x, y, 0.5, 0.6) * 4);
return mix([v * 0.9, v * 0.95, v], [1, 0.85, 0.5], globe * 0.3);`,
  },

  {
    id: 'thermal-cam', name: 'Thermal Camera',
    desc: 'Infrared heat map with hot/cold color mapping',
    preview: 'linear-gradient(90deg, #0000ff 0%, #00ffff 25%, #00ff00 50%, #ffff00 75%, #ff0000 100%)',
    code:
`// @param scale float 2.0 0.5 5.0
// @param speed float 0.3 0.05 1.5
const n1 = noise(x * params.scale + time * params.speed * 0.3, y * params.scale + time * params.speed * 0.2);
const n2 = noise(x * params.scale * 2.3 - time * params.speed, y * params.scale * 1.7 + time * params.speed * 0.5);
const heat = clamp(n1 * 0.6 + n2 * 0.4 + 0.3, 0, 1);
// Blue → cyan → green → yellow → red thermal map
const hue = (1 - heat) * 0.67;
return hsv(hue, 1, 0.4 + heat * 0.6);`,
  },

  {
    id: 'lissajous-v2', name: 'Lissajous II',
    desc: 'Animated parametric Lissajous curves with color trails',
    preview: 'radial-gradient(circle, #ff00ff 0%, #00ffff 40%, #000044 100%)',
    code:
`// @param freqX float 3.0 1.0 8.0
// @param freqY float 2.0 1.0 8.0
// @param phase float 0.5 0.0 1.0
// @param width float 0.02 0.005 0.08
const lx = sin(time * params.freqX * 0.7 + params.phase * PI * 2) * 0.4 + 0.5;
const ly = sin(time * params.freqY * 0.7) * 0.4 + 0.5;
const d = distance(x, y, lx, ly);
const glow = exp(-d / params.width) + exp(-d / (params.width * 3)) * 0.3;
const hue = fract(time * 0.07 + d * 2);
return hsv(hue, 1, clamp(glow, 0, 1));`,
  },

  // ── Batch 8: Artistic and show-ready patterns ────────────────────────────
  {
    id: 'watercolor-wash', name: 'Watercolor Wash',
    desc: 'Soft watercolor paint bleeding through wet paper',
    preview: 'radial-gradient(ellipse at 30% 40%, #ff9988 0%, #cc88ff 40%, #88ccff 80%)',
    code:
`// @param bleeds float 3.0 1.0 8.0
// @param saturation float 0.6 0.1 1.0
const n = noise(x * params.bleeds + sin(y * 2) * 0.3, y * params.bleeds + cos(x * 2) * 0.3 + time * 0.04);
const n2 = noise(x * params.bleeds * 1.5 + time * 0.02, y * params.bleeds * 1.5 + time * 0.03);
const hue = fract(n * 0.6 + n2 * 0.2 + x * 0.15 + y * 0.1);
const v = 0.4 + (n + n2) * 0.3;
return hsv(hue, params.saturation * (0.7 + n2 * 0.3), v);`,
  },

  {
    id: 'pixel-sort', name: 'Pixel Sort',
    desc: 'Glitchy pixel sorting with bright streaks',
    preview: 'linear-gradient(90deg, #000000 0%, #ffffff 20%, #ff0088 40%, #000000 60%, #00ffff 80%, #000000 100%)',
    code:
`// @param threshold float 0.5 0.1 0.95
// @param streak float 0.3 0.05 0.8
const col = floor(x * 64);
const seed = fract(sin(col * 73.1 + floor(time * 0.3) * 43.2) * 4375.8);
const isActive = seed > params.threshold;
const streak = fract(y + time * (isActive ? 1.5 : 0.1));
const bright = isActive ? pow(1 - streak, 4) : 0;
const hue = fract(col / 64 + time * 0.05 + seed * 0.5);
return isActive ? hsv(hue, 0.8, bright * 2) : [0, 0, 0];`,
  },

  {
    id: 'prism-split', name: 'Prism Split',
    desc: 'White light refracting through a prism into rainbow',
    preview: 'linear-gradient(135deg, #ffffff 0%, #ff0000 16%, #ff8800 33%, #ffff00 50%, #00ff00 67%, #0088ff 83%, #8800ff 100%)',
    code:
`// @param angle float 0.3 0.0 1.0
// @param spread float 2.0 0.5 5.0
// @param blur float 0.1 0.01 0.4
const ax = cos(params.angle * PI * 2), ay = sin(params.angle * PI * 2);
const proj = (x - 0.5) * ax + (y - 0.5) * ay;
const t = proj * params.spread + 0.5 + sin(time * 0.3) * 0.05;
const hue = clamp(t, 0, 1);
const onBeam = smoothstep(params.blur, 0, abs((x - 0.5) * ay - (y - 0.5) * ax));
return hsv(hue, 1, onBeam * 0.9 + 0.05);`,
  },

  {
    id: 'fiber-optic', name: 'Fiber Optic',
    desc: 'Glowing fiber optic strands with light tips',
    preview: 'radial-gradient(circle at 50% 100%, #ffffff 0%, #aaaaff 5%, #0033aa 40%, #000022 100%)',
    code:
`// @param strands float 12.0 4.0 32.0
// @param tipSize float 0.03 0.005 0.1
const col = floor(x * params.strands);
const phase = fract(sin(col * 127.1) * 43758.5);
const baseX = (col + 0.5) / params.strands;
const tipY = 0.8 + sin(time * (0.3 + phase * 0.5) + phase * PI * 2) * 0.15;
const dx = x - baseX, dy = y - tipY;
const tip = exp(-(dx*dx + dy*dy) / (params.tipSize * params.tipSize));
const fiber = smoothstep(0.008, 0, abs(x - baseX)) * (1 - y);
const hue = fract(phase + time * 0.05);
return hsv(hue, tip > 0.1 ? 0.3 : 0.9, clamp(tip * 3 + fiber * 0.4, 0, 1));`,
  },

  {
    id: 'mirror-tunnel', name: 'Mirror Tunnel',
    desc: 'Infinite mirror hall zoom with color cycling',
    preview: 'radial-gradient(circle, #ffffff 0%, #8844ff 20%, #0033aa 50%, #000011 100%)',
    code:
`// @param speed float 0.5 0.1 2.0
// @param hueSpeed float 0.1 0.0 0.5
const { r, a } = polar(x, y);
const depth = fract(r * 4 - time * params.speed);
const sector = abs(fract(a / (PI / 2)) - 0.5);
const grid = step(0.04, sector) * step(0.04, depth);
const hue = fract(depth * 0.3 + time * params.hueSpeed);
return hsv(hue, 0.7 + depth * 0.3, grid * (0.3 + (1 - depth) * 0.7));`,
  },

  {
    id: 'bubble-wrap', name: 'Bubble Wrap',
    desc: 'Satisfying iridescent bubbles floating up',
    preview: 'radial-gradient(circle at 30% 30%, #ffffff 0%, #aaddff 20%, #0088cc 60%, #001133 100%)',
    code:
`// @param count float 12.0 4.0 30.0
// @param iridescence float 0.4 0.0 1.0
let v = 0, hue = 0.55;
const N = int(params.count);
for (let i = 0; i < 20; i++) {
  if (i >= N) break;
  const fi = float(i);
  const bx = fract(sin(fi * 73.1) * 4375.8);
  const by = fract(cos(fi * 149.3) * 9182.1 - time * 0.08 * (0.5 + fract(sin(fi * 31.7) * 2718.3) * 0.5));
  const r = sqrt(pow(x - bx, 2) + pow(y - fract(by), 2));
  const rad = 0.04 + fract(sin(fi * 211.3) * 6831.4) * 0.04;
  const shell = smoothstep(rad, rad * 0.7, r) - smoothstep(rad * 0.7, rad * 0.4, r);
  const shimmer = fract(sin(fi * 371.2) * 8173.4 + params.iridescence);
  v += shell * 0.8;
  hue = mix(hue, shimmer * 0.9, shell * 0.5);
}
return hsv(hue, 0.6, clamp(v, 0, 1));`,
  },

  {
    id: 'lightning-storm', name: 'Lightning Storm',
    desc: 'Dramatic lightning bolts flashing across a dark sky',
    preview: 'radial-gradient(circle, #ffffff 0%, #aaaaff 10%, #0022aa 50%, #000022 100%)',
    code:
`// @param frequency float 0.3 0.05 1.5
// @param branches float 3.0 1.0 7.0
const bolt = floor(time * params.frequency);
const bx = fract(sin(bolt * 73.1) * 43758.5);
const age = fract(time * params.frequency);
let v = 0;
for (let b = 0; b < params.branches; b++) {
  const offset = fract(sin(bolt * 137.1 + b * 73.2) * 6183.4) * 0.15;
  const seg = floor(y * 8);
  const wobble = fract(sin(bolt * 217.3 + b + seg * 31.4) * 8173.2) * 0.08;
  const lx = bx + offset + wobble;
  const d = abs(x - lx) / (0.008 + age * 0.02);
  v += exp(-d) * (1 - age) * (1 - abs(y - 0.5) * 0.5);
}
return [v * 0.9, v * 0.9, v];`,
  },

  {
    id: 'neon-grid', name: 'Neon Grid',
    desc: 'Tron-style glowing grid with moving scan lines',
    preview: 'linear-gradient(0deg, transparent 48%, #00ffff 50%, transparent 52%), linear-gradient(90deg, transparent 48%, #00ffff 50%, transparent 52%)',
    code:
`// @param gridScale float 8.0 3.0 20.0
// @param scanSpeed float 1.0 0.1 4.0
// @param hue float 0.5 0.0 1.0
const gx = fract(x * params.gridScale);
const gy = fract(y * params.gridScale);
const gridLine = 1 - smoothstep(0.0, 0.04, min(min(gx, 1-gx), min(gy, 1-gy)));
const scanY = fract(y - time * params.scanSpeed * 0.1);
const scan = exp(-abs(scanY - 0.5) * 30) * 0.4;
const v = gridLine + scan;
return hsv(params.hue, 1, clamp(v, 0, 1));`,
  },

  {
    id: 'oil-painting', name: 'Oil Painting',
    desc: 'Thick impasto brushstrokes with rich texture',
    preview: 'conic-gradient(from 20deg, #cc3322, #ee8833, #ddcc22, #22aa44, #2244cc, #aa22cc, #cc3322)',
    code:
`// @param brushSize float 0.15 0.04 0.4
// @param strokes float 6.0 2.0 14.0
const n = noise(x * params.strokes, y * params.strokes + time * 0.03);
const nx = x + sin(n * PI * 2 + time * 0.05) * params.brushSize;
const ny = y + cos(n * PI * 2 + time * 0.04) * params.brushSize;
const color = noise(nx * 1.5, ny * 1.5 + time * 0.01);
const texture = noise(x * params.strokes * 3, y * params.strokes * 3) * 0.15;
const hue = fract(color + time * 0.02);
return hsv(hue, 0.85, 0.5 + color * 0.4 + texture);`,
  },

  {
    id: 'sunrise-horizon', name: 'Sunrise Horizon',
    desc: 'Dramatic sunrise with god rays and warm sky gradient',
    preview: 'linear-gradient(180deg, #220022 0%, #aa2200 30%, #ff6600 60%, #ffcc00 80%, #ffff88 100%)',
    code:
`// @param speed float 0.1 0.01 0.5
// @param rays float 8.0 3.0 16.0
const sunY = 0.35 + sin(time * params.speed) * 0.05;
const skyGrad = clamp(1 - (y - sunY) * 3, 0, 1);
const hue = mix(0.0, 0.12, skyGrad * skyGrad);
const brightness = mix(0.05, 0.95, skyGrad * skyGrad * skyGrad);
const { a } = polar(x, y);
const ray = pow(max(0, sin(a * params.rays + time * 0.1) * 0.5 + 0.5), 6);
const sunDist = distance(x, y, 0.5, sunY);
const sun = exp(-sunDist * 10);
const v = brightness + ray * 0.15 + sun * 0.5;
return hsv(hue, 0.9 - sun * 0.4, clamp(v, 0, 1));`,
  },
];

if (import.meta.hot) import.meta.hot.accept();
