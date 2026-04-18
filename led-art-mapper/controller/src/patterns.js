/**
 * patterns.js — pattern engine + scene definitions
 *
 * Identical engine to the controller and LED Art Mapper app.
 * Variables available: index, x, y, t, time, pixelCount + all builtins.
 * x/y are normalised 0–1 (contain mode, preserves aspect ratio).
 *
 * Used for local pattern preview when WLED is not connected, and for
 * the idle animation before a ledmap is loaded.
 */

// ── Built-in helpers ──────────────────────────────────────────────────────────

const BUILTINS = /* js */ `
function hsv(h,s,v){h=((h%1)+1)%1;const i=Math.floor(h*6),f=h*6-i,p=v*(1-s),q=v*(1-f*s),tt=v*(1-(1-f)*s);const c=[[v,tt,p],[q,v,p],[p,v,tt],[p,q,v],[tt,p,v],[v,p,q]][i%6];return{r:_c(c[0]),g:_c(c[1]),b:_c(c[2])};}
function rgb(r,g,b){return{r:_c(r),g:_c(g),b:_c(b)};}
function _c(v){return Math.round(v<0?0:v>1?255:v*255);}
function wave(x){return(Math.sin(x*6.28318)+1)*0.5;}
function triangle(x){x=fract(x);return x<0.5?x*2:2-x*2;}
function square(x,duty){return fract(x)<(duty===undefined?0.5:duty)?1:0;}
function clamp(v,a,b){return v<a?a:v>b?b:v;}
function lerp(a,b,t){return a+(b-a)*t;}
function fract(x){return x-Math.floor(x);}
function abs(x){return x<0?-x:x;}
function floor(x){return Math.floor(x);}
function ceil(x){return Math.ceil(x);}
function min(a,b){return a<b?a:b;}
function max(a,b){return a>b?a:b;}
function pow(a,b){return Math.pow(a,b);}
function sqrt(x){return Math.sqrt(x);}
function sin(x){return Math.sin(x);}
function cos(x){return Math.cos(x);}
function noise(x,y){y=y||0;const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;function fade(t){return t*t*(3-2*t);}function h(nx,ny){const n=Math.sin(nx*127.1+ny*311.7)*43758.5453;return n-Math.floor(n);}const sx=fade(xf),sy=fade(yf);return lerp(lerp(h(xi,yi),h(xi+1,yi),sx),lerp(h(xi,yi+1),h(xi+1,yi+1),sx),sy);}
function randomF(seed){const n=Math.sin(seed*127.1)*43758.5453;return n-Math.floor(n);}
`;

export function compile(code) {
  try {
    const fn = new Function('index','x','y','t','time','pixelCount', BUILTINS + '\n' + code);
    return { fn, error: null };
  } catch (e) {
    return { fn: null, error: e.message };
  }
}

export function evalPixel(fn, index, x, y, t, time, pixelCount) {
  try {
    const r = fn(index, x, y, t, time, pixelCount);
    if (!r || typeof r !== 'object') return { r:0, g:0, b:0 };
    return { r: _c255(r.r), g: _c255(r.g), b: _c255(r.b) };
  } catch { return { r:20, g:0, b:0 }; }
}

function _c255(v) { return Math.round(v < 0 ? 0 : v > 255 ? 255 : v); }

// ── Pixelblaze adapter ────────────────────────────────────────────────────────

function compilePixelblaze(code) {
  // Strip 'export' keywords (we don't need ES module syntax in Function())
  const normalized = code
    .replace(/\bexport\s+var\b/g, 'var')
    .replace(/\bexport\s+function\b/g, 'function');

  // Build a factory function that creates an isolated module with its own state
  const factory = new Function(`
    'use strict';
    // Color capture — Pixelblaze patterns call rgb()/hsv() as side effects
    var __R=0,__G=0,__B=0;
    function rgb(r,g,b){__R=_c01(r);__G=_c01(g);__B=_c01(b);}
    function _c01(v){var n=v<0?0:v>1?1:v;return Math.round(n*255);}
    function hsv(h,s,v){h=((h%1)+1)%1;var i=Math.floor(h*6),f=h*6-i,p=v*(1-s),q=v*(1-f*s),tt=v*(1-(1-f)*s);var c=[[v,tt,p],[q,v,p],[p,v,tt],[p,q,v],[tt,p,v],[v,p,q]][i%6];__R=Math.round(c[0]*255);__G=Math.round(c[1]*255);__B=Math.round(c[2]*255);}

    // Pixelblaze time() function — returns 0-1 cycling value
    // time(interval): cycles once per (interval * 65.536) seconds
    var __elapsed = 0;
    function time(interval){return(__elapsed*(interval||1)/65.536)%1;}
    function __setElapsed(t){__elapsed=t;}

    // pixelCount — default value, updated each frame
    var pixelCount = 256;
    function __setPixelCount(n){pixelCount=n;}

    // array() — Pixelblaze's typed array
    function array(n){return new Float32Array(n);}

    // random() — 0-1 random (Pixelblaze built-in)
    function random(n){return Math.random()*(n===undefined?1:n);}

    // perlinFbm — used by some patterns
    function perlinFbm(x,y,t,octaves,persistence,lacunarity){
      if(octaves===undefined)octaves=4;
      if(persistence===undefined)persistence=0.5;
      if(lacunarity===undefined)lacunarity=2;
      var v=0,a=1,f=1,m=0;
      for(var i=0;i<octaves;i++){v+=_pnoise(x*f,y*f)*a;m+=a;a*=persistence;f*=lacunarity;}
      return v/m;
    }
    function _pnoise(x,y){var xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;function fade(t){return t*t*(3-2*t);}function h(nx,ny){var n=Math.sin(nx*127.1+ny*311.7)*43758.5453;return n-Math.floor(n);}var sx=fade(xf),sy=fade(yf);return _lerp(_lerp(h(xi,yi),h(xi+1,yi),sx),_lerp(h(xi,yi+1),h(xi+1,yi+1),sx),sy)*2-1;}
    function _lerp(a,b,t){return a+(b-a)*t;}

    // Standard math helpers (Pixelblaze built-ins)
    var PI=Math.PI,PI2=Math.PI*2,E=Math.E;
    function sin(x){return Math.sin(x);}
    function cos(x){return Math.cos(x);}
    function abs(x){return x<0?-x:x;}
    function floor(x){return Math.floor(x);}
    function ceil(x){return Math.ceil(x);}
    function sqrt(x){return Math.sqrt(x);}
    function pow(a,b){return Math.pow(a,b);}
    function log(x){return Math.log(x);}
    function min(a,b){return a<b?a:b;}
    function max(a,b){return a>b?a:b;}
    function clamp(v,a,b){return v<a?a:v>b?b:v;}
    function lerp(a,b,t){return a+(b-a)*t;}
    function mix(a,b,t){return a+(b-a)*t;}
    function fract(x){return x-Math.floor(x);}
    function frac(x){return x-Math.floor(x);}
    function wave(x){return(Math.sin(x*6.28318)+1)*0.5;}
    function triangle(x){x=fract(x);return x<0.5?x*2:2-x*2;}
    function square(x,d){return fract(x)<(d===undefined?0.5:d)?1:0;}
    function atan2(y,x){return Math.atan2(y,x);}
    function hypot(x,y){return Math.sqrt(x*x+y*y);}

    // Audio reactive globals — injected by main.js each frame
    var bassLevel=0,midLevel=0,trebleLevel=0;
    function __setAudio(b,m,t){bassLevel=b;midLevel=m;trebleLevel=t;}

    ${normalized}

    return {
      beforeRender: typeof beforeRender !== 'undefined' ? beforeRender : null,
      render:       typeof render       !== 'undefined' ? render       : null,
      render2D:     typeof render2D     !== 'undefined' ? render2D     : null,
      __setElapsed,
      __setAudio,
      __setPixelCount,
      __getColor:   function(){ return {r:__R,g:__G,b:__B}; },
      __clearColor: function(){ __R=__G=__B=0; },
    };
  `);

  try {
    const mod = factory();
    return { mod, error: null };
  } catch(e) {
    return { mod: null, error: e.message };
  }
}

export function detectParams(code) {
  const params = [];
  // Find: export var name = number
  const varRe = /export\s+var\s+(\w+)\s*=\s*([\d.]+)/g;
  for (const [, name, val] of code.matchAll(varRe)) {
    const cbName = 'slider' + name[0].toUpperCase() + name.slice(1);
    if (new RegExp(`function\\s+${cbName}`).test(code)) {
      params.push({
        id:       name,
        label:    name.charAt(0).toUpperCase() + name.slice(1).replace(/([A-Z])/g,' $1'),
        value:    parseFloat(val),
        default:  parseFloat(val),
        min:      0,
        max:      1,
        callback: cbName,
      });
    }
  }
  return params;
}

// Run once per frame BEFORE per-pixel calls (Pixelblaze beforeRender phase)
export function runBeforeRender(scene, deltaMs, audioState) {
  if (scene.source !== 'pixelblaze' || !scene._mod?.beforeRender) return;
  if (audioState) scene._mod.__setAudio(audioState.bass, audioState.mid, audioState.treble);
  scene._mod.beforeRender(deltaMs);
}

// Evaluate one pixel (works for both formats)
export function evalScene(scene, index, nx, ny, t, time, pixelCount, audioState) {
  try {
    if (scene.source === 'pixelblaze') {
      const mod = scene._mod;
      if (!mod) return {r:0,g:0,b:0};
      mod.__setElapsed(t);
      mod.__setPixelCount(pixelCount);
      if (audioState) mod.__setAudio(audioState.bass, audioState.mid, audioState.treble);
      mod.__clearColor();
      if (mod.render2D) mod.render2D(index, nx, ny);
      else if (mod.render) mod.render(index);
      return mod.__getColor();
    } else {
      // simple format
      if (!scene.fn) return {r:0,g:0,b:0};
      const r = scene.fn(index, nx, ny, t, time, pixelCount);
      if (!r || typeof r !== 'object') return {r:0,g:0,b:0};
      return { r: _c255(r.r), g: _c255(r.g), b: _c255(r.b) };
    }
  } catch { return {r:20,g:0,b:0}; }
}

// Set a parameter slider value
export function setParam(scene, paramId, value) {
  if (scene.source !== 'pixelblaze' || !scene._mod) return;
  const param = scene.params?.find(p => p.id === paramId);
  if (!param) return;
  param.value = value;
  try { scene._mod[param.callback]?.(value); } catch {}
}

// ── Scene definitions ─────────────────────────────────────────────────────────

export const SCENES = [
  {
    id: 'fire', name: 'Fire', preset: 1, color: '#ff3300',
    code: `
const n  = noise(x * 2.5, y * 3.5 - t * 1.2);
const n2 = noise(x * 5 + 0.3, y * 6 - t * 2.0);
const v  = clamp((n * 0.6 + n2 * 0.4) * 1.5, 0, 1);
return hsv(lerp(0.02, 0.1, n), 1, pow(v, 1.4));`,
  },
  {
    id: 'aurora', name: 'Aurora', preset: 2, color: '#00ccaa',
    code: `
const w1 = wave(x * 2.5 + time * 0.6 + y * 0.4);
const w2 = wave(x * 3.5 - time * 0.35 + y * 0.6);
const mix = (w1 + w2) * 0.5;
const h   = lerp(0.44, 0.68, mix);
return hsv(h, 0.85, w1 * 0.55 + 0.45);`,
  },
  {
    id: 'plasma', name: 'Plasma', preset: 3, color: '#cc00ff',
    code: `
const a = sin(x * 9  + time * 4.5);
const b = sin(y * 7  - time * 3.2);
const c = sin((x+y)*6 + time * 2.1);
const v = (a + b + c + 3) / 6;
return hsv(fract(v + time * 0.12), 0.9, 0.65 + v * 0.35);`,
  },
  {
    id: 'ocean', name: 'Ocean', preset: 4, color: '#0077ff',
    code: `
const n    = noise(x * 2.2 + time * 0.35, y * 3.0 + time * 0.2);
const swell = wave(x * 3.5 - time * 1.4 + n * 1.8);
const depth = 1 - y * 0.55;
return hsv(0.57 + n * 0.07, 0.88, swell * depth * 0.85 + 0.08);`,
  },
  {
    id: 'ember', name: 'Ember', preset: 5, color: '#ff5500',
    code: `
const n = noise(x * 3.5 + time * 0.25, y * 3.5 - time * 0.15);
const v = pow(n, 0.65);
const spark = randomF(index + floor(t * 4) * 997) > 0.985 ? 0.6 : 0;
return hsv(lerp(0.0, 0.07, n * n), 1, v * 0.85 + spark);`,
  },
  {
    id: 'midnight', name: 'Midnight', preset: 6, color: '#1122aa',
    code: `
const twinkle = randomF(index + floor(t * 5) * 1337) > 0.975 ? 1 : 0;
const drift   = wave(index * 0.04 + time * 0.7) * 0.12;
const nebula  = noise(x * 4 + time * 0.15, y * 4) * 0.25;
return hsv(0.64 + nebula, 0.9, twinkle * 0.9 + drift + nebula);`,
  },
  {
    id: 'pulse', name: 'Pulse', preset: 7, color: '#aaaaaa',
    code: `
const breathe = pow(wave(time * 0.5), 2.5);
const warm    = wave(time * 0.2) * 0.15;
return hsv(warm * 0.08, warm * 0.4, breathe * 0.85 + 0.04);`,
  },
  {
    id: 'electric', name: 'Electric', preset: 8, color: '#8888ff',
    code: `
const n1   = noise(x * 9 + time * 2.5, y * 9);
const n2   = noise(x * 5 - time * 3.5, y * 5 + time);
const bolt = pow(max(0, (n1 + n2) * 0.5 - 0.28) * 2.2, 2.5);
const flicker = wave(t * 11 + index) * 0.04;
return hsv(0.64 + bolt * 0.08, 0.55, bolt + flicker);`,
  },

  // ── Pixelblaze patterns ───────────────────────────────────────────────────

  {
    id: 'ice-floes', name: 'Ice Floes', preset: null, color: '#aaddff',
    source: 'pixelblaze',
    code: `/* Ice Floes 2D — ZRanger1 7/30/2021 */
var frameTimer = 9999;
var simulationSpeed = 60;
var numPoints = 4;
var Points = array(numPoints);
export var speed = .575;

export function sliderSpeed(v) {
  speed = 2 * v;
}

function initPoints() {
  for (var i = 0; i < numPoints; i++) {
    var b = Points[i];
    b[0] = random(1);
    b[1] = random(1);
    b[2] = random(0.02) - 0.05;
    b[3] = 0.015 * (random(1) - 0.5);
  }
}

function createPoints() {
  for (var i = 0; i < numPoints; i++) {
    Points[i] = array(4);
  }
  initPoints();
}

function doRiver(delta) {
  for (var i = 0; i < numPoints; i++) {
    var b = Points[i];
    b[0] = frac(b[0] + (b[2] * speed));
    b[1] = frac(b[1] + b[3]);
    if (b[0] < 0) { b[0] = 0.9998; }
    else if (b[1] < 0) { b[1] = 0.9998; }
    if (b[1] < 0) { b[1] = 0; b[3] = -b[3]; continue; }
    if (b[1] > 1) { b[1] = 1; b[3] = -b[3]; continue; }
  }
}

function wrappedEuclid(dx, dy) {
  if (dx > 0.5) { dx = 1 - dx; }
  if (dy > 0.5) { dy = 1 - dy; }
  return hypot(dx, dy);
}

createPoints();

export function beforeRender(delta) {
  frameTimer += delta;
  if (frameTimer > simulationSpeed) {
    doRiver(frameTimer);
    frameTimer = 0;
  }
}

export function render2D(index, x, y) {
  var minDistance, i, r, h, v;
  minDistance = 1;
  for (i = 0; i < numPoints; i++) {
    r = wrappedEuclid(abs(Points[i][0] - x), abs(Points[i][1] - y));
    if (r <= minDistance) {
      h = (abs(r - minDistance) < 0.12) ? 0.6667 : 0.55 + (r * .15);
      minDistance = r;
    }
  }
  var bri = 1 - minDistance; bri = bri * bri * bri;
  hsv(h, (h == 0.6667) ? 1 : 1.21 - bri, bri);
}`,
    _mod: null,
    params: [],
  },

  {
    id: 'line-splash', name: 'Ripples', preset: null, color: '#0066ff',
    source: 'pixelblaze',
    code: `/* Line Splash 2D — JEM(ZRanger1) 10/16/2020 */
var displayWidth = 32;
var displayHeight = 16;
var initialLevel = displayHeight / 2;
var maxWidthIndex = displayWidth - 1;

export var tension = 0.007;
export var damping = 0.008;
export var spread = 0.003;

var waterLevel = array(displayWidth);
var waterSpeed = array(displayWidth);

var dropInterval = 300;
var frameTimer = 0;
var lineWidth = 1.2;
var hue = 0.6666;
var hueTimer;

export function sliderTension(v) {
  tension = 0.05 * v * v;
}

export function sliderDamping(v) {
  damping = 0.05 * v * v;
}

export function sliderSpread(v) {
  spread = 0.01 * v * v;
}

export function sliderLineWidth(v) {
  lineWidth = 0.5 + (3 * v);
}

function initWater() {
  for (var i = 0; i < displayWidth; i++) {
    waterLevel[i] = initialLevel;
    waterSpeed[i] = 0;
  }
}

initWater();

export function beforeRender(delta) {
  var i, n1, n2;
  hueTimer = time(0.1);
  frameTimer += delta;
  if (frameTimer > dropInterval) {
    waterSpeed[random(displayWidth)] = 0.1 * random(1 + displayHeight / 2);
    dropInterval = random(700);
    frameTimer = 0;
  }
  for (i = 0; i < displayWidth; i++) {
    var newSpeed = initialLevel - waterLevel[i];
    waterSpeed[i] += (tension * newSpeed) - (waterSpeed[i] * damping);
    waterLevel[i] += waterSpeed[i];
    n1 = clamp(i - 1, 0, maxWidthIndex); n2 = clamp(i - 2, 0, maxWidthIndex);
    var lWave = spread * (waterLevel[i] - waterLevel[n2]);
    lWave += spread * (waterLevel[i] - waterLevel[n1]);
    waterSpeed[n1] += lWave;
    waterLevel[n1] += lWave;
    n1 = clamp(i + 1, 0, maxWidthIndex); n2 = clamp(i + 2, 0, maxWidthIndex);
    var rWave = spread * (waterLevel[i] - waterLevel[n1]);
    rWave += spread * (waterLevel[i] - waterLevel[n2]);
    waterSpeed[n1] += rWave;
    waterLevel[n1] += rWave;
  }
}

export function render2D(index, x, y) {
  var s, b;
  s = y * 1.75;
  x *= displayWidth;
  y *= displayHeight;
  b = (abs(waterLevel[x] - y) < lineWidth);
  hsv(hue, s, b);
}`,
    _mod: null,
    params: [],
  },

  {
    id: 'metaballs', name: 'Metaballs', preset: null, color: '#ff4400',
    source: 'pixelblaze',
    code: `/* Metaballs of Fire — JEM(ZRanger1) 07/30/2021 */
var maxPoints = 8;
var Points = array(maxPoints);

export var numPoints = 5;
export var speed = 0.05;
export var splatter = 1.75;

export function sliderNumberOfPoints(v) {
  var n;
  n = floor(4 + (v * (maxPoints - 4)));
  if (n != numPoints) {
    numPoints = n;
    splatter = 1.5 + (numPoints - 4) / 7.8;
    initPoints();
  }
}

export function sliderSpeed(v) {
  speed = 0.15 * v;
}

function initPoints() {
  for (var i = 0; i < numPoints; i++) {
    var b = Points[i];
    b[0] = random(1);
    b[1] = random(1);
    b[2] = -0.5 + random(1);
    b[3] = -0.5 + random(1);
  }
}

function createPoints() {
  for (var i = 0; i < maxPoints; i++) {
    Points[i] = array(4);
  }
  initPoints();
}

function bounce() {
  for (var i = 0; i < numPoints; i++) {
    var b = Points[i];
    b[0] += b[2] * speed;
    b[1] += b[3] * speed;
    if (b[0] < 0) { b[0] = 0; b[2] = -b[2]; continue; }
    if (b[1] < 0) { b[1] = 0; b[3] = -b[3]; continue; }
    if (b[0] > 1) { b[0] = 1; b[2] = -b[2]; continue; }
    if (b[1] > 1) { b[1] = 1; b[3] = -b[3]; continue; }
  }
}

createPoints();

export function beforeRender(delta) {
  bounce();
}

export function render2D(index, x, y) {
  var minDistance, i, r;
  minDistance = 1;
  for (i = 0; i < numPoints; i++) {
    r = minDistance * hypot(Points[i][0] - x, Points[i][1] - y) * splatter;
    minDistance = min(r, minDistance);
  }
  if (minDistance >= 0.082) {
    rgb(0, 0, 0);
  } else {
    hsv(0.082 - minDistance, 1, 1.2 - (wave(5 * minDistance)));
  }
}`,
    _mod: null,
    params: [],
  },

  {
    id: 'sunrise', name: 'Sunrise', preset: null, color: '#ffaa00',
    source: 'pixelblaze',
    code: `/* 2D Sunrise/solar activity simulator — JEM(ZRanger1) 04/04/2021 */
var width = 16;
var height = 16;
var centerX = (width - 1) / 2;
var centerY = (width - 1) / 2;

var sunDiameter = 5.79;
var sunMask = array(width * height);
var frameBuffer = array(height);
var frameTimer = 9999;

var _x = 0;
var _y = 1;
var _dx = 2;
var _dy = 3;
var _hue = 4;

var MAX_PARTICLES = 32;
var numParticles = 26;
var gravity = -155;
var drift;
var sunRise = (height - 1);
var speed = 80;
var C = 3.25;
var r1, r2, t1;

var pb1 = array(MAX_PARTICLES);
var pb2 = array(MAX_PARTICLES);
var particles, work_particles;

export function sliderMakeTheSunRise(v) {
  preRender = doFadeout;
}

function initSunMask() {
  for (var i = 0; i < width * height; i++) {
    var x = i % width;
    var y = floor(i / width);
    x = centerX - x; y = centerY - y;
    var dx = sqrt(x * x + y * y);
    dx = (dx < sunDiameter) * (1 - (dx / sunDiameter));
    sunMask[i] = dx;
  }
}

function renderSunMask() {
  for (var y1 = 0; y1 < height; y1++) {
    if ((y1 + sunRise) >= height) break;
    for (var x1 = 0; x1 < width; x1++) {
      var v2 = sunMask[x1 + (y1 * width)];
      if (v2) {
        var x = x1 / width; var y = y1 / height;
        var v1 = wave(x * r1 + y) + triangle(x - y * r2) + wave(v2);
        v1 = v1 / 3;
        v1 = (v1 * v1 * v1);
        frameBuffer[x1][y1 + sunRise] = floor((0.2 * v1) * 1000) + (v2 * v1 * 4);
      }
    }
  }
}

function allocateFrameBuffer() {
  for (var i = 0; i < height; i++) {
    frameBuffer[i] = array(width);
  }
}

function coolFrameBuffer() {
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      var n = frameBuffer[x][y] % 1;
      if (!n) continue;
      frameBuffer[x][y] = floor(frameBuffer[x][y]) + max(0, n - 0.081);
    }
  }
}

function allocateParticleLists() {
  for (var i = 0; i < MAX_PARTICLES; i++) {
    pb1[i] = array(5);
    pb2[i] = array(5);
  }
}

function initParticles() {
  particles = pb1;
  work_particles = pb2;
  var sunRadius = -sunDiameter / 2;
  for (var i = 0; i < MAX_PARTICLES; i++) {
    particles[i][_x] = centerX + sunRadius + random(sunDiameter);
    particles[i][_y] = centerY + sunRadius + random(sunDiameter);
    particles[i][_dx] = 0;
    particles[i][_dy] = 0;
    particles[i][_hue] = random(0.06);
  }
}

function swapParticleBuffers() {
  var tmp = work_particles;
  work_particles = particles;
  particles = tmp;
}

function moveParticles() {
  drift = random(2) - 1;
  for (var i = 0; i < numParticles; i++) {
    var dx = (particles[i][_x] - (centerX + drift));
    var dy = (particles[i][_y] - (centerY + drift));
    var r = sqrt(dx * dx + dy * dy);
    var f = (r > 1) ? gravity / r * r : gravity;
    var accel_x = f * dx / r;
    var accel_y = f * dy / r;
    work_particles[i][_dx] = clamp(particles[i][_dx] + (accel_x / 100), -C, C);
    work_particles[i][_dy] = clamp(particles[i][_dy] + (accel_y / 100), -C, C);
    work_particles[i][_x] = particles[i][_x] + work_particles[i][_dx];
    work_particles[i][_y] = particles[i][_y] + work_particles[i][_dy];
    if ((work_particles[i][_x] < 0) || (work_particles[i][_x] >= width)) continue;
    if ((work_particles[i][_y] < 0) || (work_particles[i][_y] >= height)) continue;
    if (r >= (sunDiameter * 0.9)) {
      work_particles[i][_hue] = particles[i][_hue];
      var bri = frameBuffer[work_particles[i][_x]][work_particles[i][_y]] % 1;
      bri = (bri) ? bri : 0.5;
      frameBuffer[work_particles[i][_x]][work_particles[i][_y]] = (floor((work_particles[i][_hue] + t1) * 1000)) + bri;
    }
  }
  swapParticleBuffers();
}

allocateFrameBuffer();
allocateParticleLists();
initSunMask();
initParticles();

var fadeTime = 0;
function doFadeout(delta) {
  frameTimer += delta;
  fadeTime += delta;
  if (frameTimer > speed) {
    coolFrameBuffer();
    frameTimer = 0;
  }
  if (fadeTime > 1500) {
    fadeTime = 0;
    sunRise = (height - 1);
    preRender = doSunrise;
  }
}

var sunrisePause = 0;
function doSunrise(delta) {
  frameTimer += delta;
  sunRise = max(0, sunRise - (delta * 0.007));
  if (sunRise == 0) sunrisePause += delta;
  r1 = wave(time(0.064));
  r2 = wave(time(0.035));
  t1 = 0.05 * time(0.08);
  if (frameTimer > speed) {
    coolFrameBuffer();
    renderSunMask();
    frameTimer = 0;
  }
  if (sunrisePause > 2500) {
    sunrisePause = 0;
    preRender = doActiveSun;
  }
}

function doActiveSun(delta) {
  frameTimer += delta;
  r1 = wave(time(0.064));
  r2 = wave(time(0.035));
  t1 = 0.05 * time(0.08);
  if (frameTimer > speed) {
    coolFrameBuffer();
    renderSunMask();
    moveParticles();
    frameTimer = 0;
  }
}

var preRender = doSunrise;

export function beforeRender(delta) {
  preRender(delta);
}

export function render2D(index, x, y) {
  var x1, y1, v, h;
  x1 = floor(x * width); y1 = floor(y * height);
  v = frameBuffer[x1][y1];
  h = floor(v) / 1000;
  v = v % 1;
  hsv(h, 1, v);
}`,
    _mod: null,
    params: [],
  },

  {
    id: 'voronoi', name: 'Voronoi', preset: null, color: '#00ffaa',
    source: 'pixelblaze',
    code: `/* Animated Voronoi — JEM(ZRanger1) 12/31/2020 */
var numModes = 7;
var distance = array(numModes);

distance[0] = euclidean;
distance[1] = wavedistance;
distance[2] = deviation;
distance[3] = chebyshev;
distance[4] = eggcrate;
distance[5] = manhattan;
distance[6] = squarewaves;

var numRenderers = 6;
var gamma = array(numRenderers);

gamma[0] = original;
gamma[1] = originalG;
gamma[2] = crispyC;
gamma[3] = crispyCI;
gamma[4] = crispyCG;
gamma[5] = crispyCIG;

var maxPoints = 8;
var Points = array(maxPoints);

export var numPoints = 5;
export var speed = 0.035;
export var drawMode = 0;
export var distMethod = 0;

export function sliderNumberOfPoints(v) {
  var n;
  n = floor(1 + (v * (maxPoints - 1)));
  if (n != numPoints) {
    numPoints = n;
    initPoints();
  }
}

export function sliderDistanceMethod(v) {
  distMethod = floor((numModes - 1) * v);
}

export function sliderDrawingMode(v) {
  drawMode = floor((numRenderers - 1) * v);
}

export function sliderSpeed(v) {
  speed = 0.15 * v;
}

function initPoints() {
  var h = 0;
  for (var i = 0; i < numPoints; i++) {
    var b = Points[i];
    b[0] = random(1);
    b[1] = random(1);
    b[2] = random(1);
    b[3] = random(1);
    b[4] = h + i / numPoints;
  }
}

function createPoints() {
  for (var i = 0; i < maxPoints; i++) {
    Points[i] = array(5);
  }
  initPoints();
}

function bounce() {
  for (var i = 0; i < numPoints; i++) {
    var b = Points[i];
    b[0] += b[2] * speed;
    b[1] += b[3] * speed;
    if (b[0] < 0) { b[0] = 0; b[2] = -b[2]; continue; }
    if (b[1] < 0) { b[1] = 0; b[3] = -b[3]; continue; }
    if (b[0] > 1) { b[0] = 1; b[2] = -b[2]; continue; }
    if (b[1] > 1) { b[1] = 1; b[3] = -b[3]; continue; }
  }
}

function euclidean(x, y) { return sqrt((x * x) + (y * y)); }
function wavedistance(x, y) { return wave((x * x) + (y * y)); }
function chebyshev(x, y) { return max(abs(x), abs(y)); }
function deviation(x, y) { return abs(sqrt((x * x) + (y * y)) - 0.52038); }
function manhattan(x, y) { return abs(x) + abs(y); }
function eggcrate(x, y) { return 1 - (0.1 * (cos(x * PI2) + sin(y * PI2))); }
function squarewaves(x, y) { return square(manhattan(x, y), .75); }

function original(d, hue) { hsv(hue, 1, 1); }
function originalG(d, hue) { var bri = 1 - d; bri = bri * bri * bri; hsv(hue, 1, bri); }
function crispyC(d, hue) { hsv(hue + d, 1, d); }
function crispyCI(d, hue) { hsv(hue + d, 1, 1 - d); }
function crispyCIG(d, hue) { var bri = 1 - d; bri = bri * bri * bri; hsv(hue + d, 1, bri); }
function crispyCG(d, hue) { var bri = d * d * d * d; hsv(hue + d, 1, bri); }

createPoints();

export function beforeRender(delta) {
  bounce();
}

export function render2D(index, x, y) {
  var minDistance, i, r, h;
  minDistance = 32765;
  for (i = 0; i < numPoints; i++) {
    r = distance[distMethod](Points[i][0] - x, Points[i][1] - y);
    if (r < minDistance) {
      h = Points[i][4];
      minDistance = r;
    }
  }
  gamma[drawMode](minDistance, h);
}`,
    _mod: null,
    params: [],
  },

  {
    id: 'color-clouds', name: 'Color Clouds', preset: null, color: '#ffeecc',
    source: 'pixelblaze',
    code: `/* Color Clouds — ZRanger1 12/2022 */
export var speed = 0.7;
export var waveLength = 1.31;
export var contrast = 0.07;

var k1, k2, k3, k4;
var t1, t2, t3, t4;
var depth = 0.07;

export function sliderSpeed(v) {
  if (v == 0) {
    speed = 0;
  } else {
    speed = max(0.04, 1.5 * (1 - v));
  }
}

export function sliderContrast(v) {
  depth = v * v;
}

export function sliderClouds(v) {
  waveLength = 2 * v * v;
}

export function beforeRender(delta) {
  k1 = waveLength * 11;
  k2 = waveLength * 15;
  k3 = waveLength * 7;
  k4 = waveLength * 5;
  t1 = time(speed * .16);
  t2 = time(speed * .1);
  t3 = time(speed * .14);
  t4 = time(speed * .11);
}

export function render(index) {
  var x, v, r, g, b;
  r = 0; g = 0; b = 0;
  x = index / pixelCount;
  r = wave((k1 * x) - t1);
  g = wave((k2 * x) + t2);
  b = wave((k3 * x) + t3);
  v = depth * (-1 + 2 * wave((k4 * x) - t4));
  r = (r + v) / 2;
  g = (g + v) / 2;
  b = (b + v) / 2;
  rgb(r, g, b);
}`,
    _mod: null,
    params: [],
  },

  {
    id: 'fire-glow', name: 'Fire Glow', preset: null, color: '#ff6600',
    source: 'pixelblaze',
    code: `/* 1D Firelight glow — ZRanger1 10/2025 */
export var speed = 0.0125;
export var complexity = 5.6;

export function sliderSpeed(v) {
  speed = mix(0.005, 0.2, v * v);
}

export function sliderComplexity(v) {
  complexity = 0.5 + v * 8;
}

function fbm(x, y) {
  return perlinFbm(x, y, PI, complexity, 0.8, 3);
}

function pattern(px, py) {
  var k = sin(PI2 * px + t1);
  var r = fbm(k, py + t1);
  r -= fbm(py - t1, k);
  return 0.5 + r / 2;
}

var timebase = 0;
var t1;

export function beforeRender(delta) {
  timebase = (timebase + delta / 1000) % 3600;
  t1 = timebase * speed;
}

export function render(index) {
  var pos = index / pixelCount;
  var f = pattern(pos, 1 - pos);
  var hue = 0.002 + f * 0.03;
  var sat = 1.925 - f;
  var bri = f * f;
  hsv(hue, sat, bri);
}`,
    _mod: null,
    params: [],
  },

  {
    id: 'dark-bolt', name: 'Dark Bolt', preset: null, color: '#6600ff',
    source: 'pixelblaze',
    code: `/* Dark Bolt — JEM(ZRanger1) 10/13/2020 */
var t1;
export var speed = 0.017;
export var size = 32;
var hue = 0;
var sat = 1;
var bri = 0.8;
var dir = 0;

var modes = array(2);
modes[0] = function() { t1 = pow(time(speed), 5) * pixelCount; };
modes[1] = function() { t1 = (1 - pow(time(speed), 5)) * pixelCount; };

export function sliderSize(v) {
  size = max(3, pixelCount * (v / 3));
}

export function sliderSpeed(v) {
  speed = max(0.0025, 0.1 * (1 - v));
}

export function sliderDirection(v) {
  dir = floor(v + 0.5);
}

export function beforeRender(delta) {
  modes[dir]();
}

export function render(index) {
  var b = clamp(abs((index - t1) / size), 0, bri);
  b = b * b * b;
  hsv(hue, sat, b);
}`,
    _mod: null,
    params: [],
  },

  {
    id: 'hypersnow', name: 'Hypersnow', preset: null, color: '#cceeff',
    source: 'pixelblaze',
    code: `/* Hypersnow — JEM(ZRanger1) 07/20/2020 */
var frameTime = 0;
var pix = -1;

var hue = 0.7;
var sat = 0.5;
var bri = 0.2;

export var speed = 250;
export var hold = 80;
export var max_delay = 500;

var sparks = array(512);

export function sliderMaxDelay(v) {
  max_delay = v * 1000;
}

export function sliderSparkHold(v) {
  hold = (v * v) * 250;
}

export function beforeRender(delta) {
  frameTime += delta;
  if (pix == -1) {
    if (frameTime > speed) {
      var nsparks = random(pixelCount / 3);
      for (var i = 0; i < nsparks; i++) {
        sparks[floor(random(1) * pixelCount)] = 1;
      }
      frameTime = 0;
      pix = 0;
      speed = random(max_delay);
    }
  } else if (frameTime > hold) {
    pix = -1;
    for (var i = 0; i < pixelCount; i++) {
      sparks[i] = 0;
    }
  }
}

export function render(index) {
  if (sparks[index]) {
    rgb(1, 1, 1);
    return;
  }
  hsv(hue, sat, bri);
}`,
    _mod: null,
    params: [],
  },

  {
    id: 'oasis', name: 'Oasis', preset: null, color: '#00cc88',
    source: 'pixelblaze',
    code: `/* Oasis — JEM(ZRanger1) 10/20/2020 */
var _speed = 0;
var _direction = 1;
var _divisor = 2;
var _tSpeed = 3;
var _cSpeed = 4;
var _cWlen = 5;
var descriptorSize = 6;

var layer1 = array(descriptorSize);
var layer2 = array(descriptorSize);
var layer3 = array(descriptorSize);
var layer4 = array(descriptorSize);

var gamma = array(512);

export var speed = 1;
export var whiteCaps = 1.46;
export var depth = 0.65;
export var aura = 0.66667;
export var wavelenScale = 1;

var baseHue;

export function sliderHue(v) { aura = v; }
export function sliderSpeed(v) { speed = 1.5 + (4.5 * (1 - v)); }
export function sliderWhitecaps(v) { whiteCaps = 1 + (1 - v); }
export function sliderDepth(v) { depth = (1 - v); }
export function sliderWavelength(v) {
  wavelenScale = 0.15 + (2 * (1 - v));
  setup();
}

function waveReverse(n) { return 1 - time(n); }
function waveForward(n) { return time(n); }

function gammatron(index) {
  var v, n;
  n = ((index + layer1[3]) * layer1[5]) / pixelCount;
  v = gamma[floor(511 * abs(n % 1))];
  n = ((index + layer2[3]) * layer2[5]) / pixelCount;
  v += gamma[floor(511 * (n % 1))];
  n = ((index + layer3[3]) * layer3[5]) / pixelCount;
  v += gamma[floor(511 * (n % 1))];
  n = ((index + layer4[3]) * layer4[5]) / pixelCount;
  v += gamma[floor(511 * (n % 1))];
  return v / 4;
}

function scaleWaveToStrip(divisor) {
  return divisor * (pixelCount / 150);
}

function scaleSpeedToStrip(seconds) {
  return (seconds / 65.356) * (pixelCount / 150);
}

function initWave(w, spd, dir, divisor) {
  w[_speed] = scaleSpeedToStrip(spd * speed);
  w[_direction] = dir ? waveForward : waveReverse;
  w[_divisor] = divisor * wavelenScale;
  w[_cSpeed] = w[_speed];
  w[_cWlen] = w[_divisor];
}

function setup() {
  initWave(layer1, 10, 1, 21);
  initWave(layer2, 6, 1, 9);
  initWave(layer3, 15, 0, 11);
  initWave(layer4, 22, 0, 5);
}

for (var i = 0; i < 512; i++) {
  gamma[i] = pow(wave(0.25 + (i / 512)), 4);
}

setup();

export function beforeRender(delta) {
  var t = triangle(time(0.3));
  layer1[3] = pixelCount * layer1[1](layer1[4]);
  layer2[3] = pixelCount * layer2[1](layer2[4]);
  layer3[3] = pixelCount * layer3[1](layer3[4]);
  layer4[3] = pixelCount * layer4[1](layer4[4]);
  layer4[5] = layer4[2] * (0.9 + (t * 0.2));
  baseHue = aura + (0.02 * t);
}

export function render(index) {
  var h, s, v;
  v = gammatron(index);
  h = baseHue - (depth * v * 0.3);
  s = whiteCaps - v;
  hsv(h, s, v);
}`,
    _mod: null,
    params: [],
  },
];

SCENES.forEach(scene => {
  if (scene.source === 'pixelblaze') {
    const { mod, error } = compilePixelblaze(scene.code);
    if (error) console.warn(`Scene "${scene.name}" compile error:`, error);
    scene._mod = mod;
    scene.params = detectParams(scene.code);
    // Call sliders with default values to initialize state
    scene.params.forEach(p => {
      try { mod?.[p.callback]?.(p.value); } catch {}
    });
  } else {
    const { fn, error } = compile(scene.code);
    if (error) console.warn(`Scene "${scene.name}" compile error:`, error);
    scene.fn = fn;
    scene.params = [];
  }
});
