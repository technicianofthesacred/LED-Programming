# Lightweaver Mandala — Audio-to-Visual Mapping Spec v1

*Effects director: Fable model. This is the mapping brain — which sound feature drives which effect, and the per-pixel angular structure that replaces solid-ring flashing. Implementer wires it verbatim into the JS engine, then it ports to the ESP32.*

All formulas assume: `t` = seconds, `dt` = frame delta (~0.025 @ 40fps), `sin()` = 256-entry LUT sine, `clamp(x)` = 0..1 unless a range given, `lerp(a,b,x)` = a+(b−a)x. Per-pixel `ri, rf, ang` precomputed. Audio `bass, mid, high, energy, centroid` from the existing analyzer. Per-effect output is target brightness fed into the existing attack/decay envelope.

---

## 0. Shared machinery

### 0.1 Smoothed envelopes (one float each)
```
smooth(env, x, tauA, tauR):
    tau = (x > env) ? tauA : tauR
    env += (x - env) * min(1, dt / tau)
```
| Name | Input | tauA | tauR | Used by |
|---|---|---|---|---|
| `bassEnv` | bass | 0.06s | 0.50s | Bloom, Interference, Journey |
| `midEnv` | mid | 0.10s | 0.60s | Spiral, Journey |
| `energySlow` | energy | 0.40s | 2.00s | Temperature |
| `bassAvg` | bass | 0.80s | 0.80s | Kick detector |
| `highAvg` | high | 0.50s | 0.50s | Sparkle layer |

### 0.2 Kick (bass onset) detector — feeds Ripple, Bloom, Spiral
```
thr = max(0.30, bassAvg + 0.13)
if (prevBass <= thr) and (bass > thr) and (t - lastKick >= 0.18):
    lastKick     = t
    kickStrength = clamp(2.5 * (bass - bassAvg), 0.4, 1.0)
    fire KICK event
prevBass = bass
```
- Refractory 180 ms. `popEnv`: on KICK set `popEnv = kickStrength`, per frame `popEnv *= exp(-dt/0.22)` (≈0.892 @40fps).

### 0.3 Sparkle layer — rides on ANY effect (zero per-pixel state)
```
bucket = floor(t * 20)
h  = (i * 0x9E3779B1) XOR (bucket * 0x85EBCA77)
h ^= h >> 15;  h *= 0x2C1B3C6D;  h ^= h >> 12
u  = (h & 0xFFFF) / 65536.0
highTrans = clamp(3 * (high - highAvg))
p = 0.035 * highTrans * rf * rf
if u < p:  B = max(B, 0.95);  pixelTemp = max(pixelTemp, 1.25)
```
- Cap 24 sparkles/bucket. Scale ×0.3 for Temperature, ×0.7 for EQ ring 4.

### 0.4 Temp convention
`temp` multiplier on ramp sample point, clamp [0.8, 1.3]. Existing treble-warms-outer tilt stays on top.

---

## 1. Concentric EQ — "the spectrum is the mandala"
Drivers: all three bands split per ring.
```
bandLevel[5] = { bass, 0.5*bass+0.5*mid, mid, 0.5*mid+0.5*high, high }
L = bandLevel[ri];  L = L*L*(0.6 + 0.4*L)
scallop = 0.88 + 0.12*sin(12*ang + eqPhase)
micro   = 0.94 + 0.06*hash01(i, floor(t*8))
B = max( L*scallop*micro, (L>0.05)?0.03:0.0 )
```
State: `eqPhase += dt*0.25`. Temp: `0.9 + 0.2*rf`.

## 2. Center Bloom — "bass opens a flower"
Drivers: `bassEnv` sets radius; KICK flashes core.
```
R      = 0.15 + 0.95*bassEnv
radial = clamp((R - rf)/0.18 + 1)
fr     = clamp(1 - abs(rf - R)/0.15)
wobble = 0.6*sin(0.4*t)
petal  = 0.5 + 0.5*sin(8*ang + wobble)
B  = radial*(0.92 + 0.08*petal)*(1 - 0.55*fr*(1 - petal))
B += popEnv*0.4*clamp(1 - rf/0.35)
B += 0.08*clamp(1 - rf/0.25)
B  = min(B,1)
```
State: `bassEnv`, `popEnv`. Temp: `0.9 + 0.25*fr`.

## 3. Radial Ripple — "every kick launches a wave"
Max 3 ripples `{r, strength, phase}`. On KICK claim free/oldest slot. Per frame `r += dt*0.9`, kill `r>1.35`. `phase = frac(birthTime*1.113)*2π`.
```
per live ripple j:
  r_eff = r_j + 0.05*sin(9*ang + phase_j)
  d     = rf - r_eff
  w     = clamp(1 - abs(d)/0.12);  w = w*w
  spoke = 0.7 + 0.3*sin(9*ang - 2*r_j)
  Bj    = strength_j*(1 - 0.55*r_j)*w*spoke
B = min(1, 0.04 + 0.10*bass*clamp(1 - rf/0.3) + Σ Bj)
```
State: 9 floats. Temp: `1.0 + 0.25*wMax`.

## 4. Orbiting Spiral — "melody speed, made visible"
Drivers: `midEnv`→speed, `energy`→brightness, KICK→arms fatten. 3 arms, twist 1.8 rad center→rim.
```
a  = ang - theta - 1.8*rf
u  = a*(3/2π);  f = u - floor(u)
dA = min(f, 1-f)*(2π/3)
halfW = 0.35 + 0.25*popEnv
arm   = clamp(1 - dA/halfW);  arm = arm*arm
B = arm*(0.30 + 0.70*energy) + 0.05
```
State: `theta += dt*(0.4 + 2.6*midEnv)`, `popEnv`. Temp: `0.95 + 0.25*rf*high`.

## 5. Standing Interference — "bass crystallizes the symmetry"
k=6. Drivers: `bassEnv`→node contrast, `mid`→12-star, `energy`→level, `centroid`→precession.
```
p  = 0.5 + 0.5*sin(6*ang + nodePhase + 2.0*rf)
p2 = p*p
C     = 0.30 + 0.70*bassEnv
level = 0.25 + 0.75*energy
B  = level*((1 - C) + C*p2)
q  = 0.5 + 0.5*sin(12*ang - 2*nodePhase)
B += level*0.25*mid*q*q*q
B  = min(B,1)
```
State: `nodePhase += dt*(0.15 + 0.5*(centroid - 0.5))`. Temp: `0.9 + 0.35*p2*bassEnv`.

## 6. Temperature Field — "the room's mood, as heat"
Drivers: `energySlow`→brightness, `centroid`→warmth. No transient response (that IS its identity).
```
B = (0.15 + 0.65*energySlow)
      * (0.93 + 0.07*sin(3*ang + driftPhase + 1.5*rf))
      * (0.985 + 0.03*hash01(i, floor(t*4))*energySlow)
temp = clamp(0.80 + 0.35*rf + 0.30*(centroid - 0.5), 0.8, 1.3)
```
State: `driftPhase += dt*0.08`, `energySlow`. Sparkle ×0.3.

## 7. Journey — "an unattended set list"
Crossfades EQ(0)/Interference(1)/Spiral(2) on 90s clock + character nudges.
```
base_j = 0.5 + 0.5*sin(2π*t/90 + j*2π/3);  base_j = base_j*base_j
nudge_EQ     = 0.35*clamp(1.5*abs(bass - high))
nudge_Interf = 0.35*bassEnv
nudge_Spiral = 0.35*midEnv
raw_j = base_j + nudge_j
w_j  += (raw_j - w_j)*min(1, dt/3.0)
wSum = w0+w1+w2;  w_j /= wSum
B    = Σ w_j*B_j(pixel);  temp = Σ w_j*temp_j(pixel)
skip sub-effect if w_j < 0.05
```

## Diversity table
| # | Effect | PRIMARY driver | Most visible response |
|---|---|---|---|
| 1 | Concentric EQ | per-band levels | WHICH rings lit — live spectrum |
| 2 | Center Bloom | bass envelope | bloom RADIUS — flower opens/closes |
| 3 | Radial Ripple | bass onsets | wavefront LAUNCHES per kick |
| 4 | Orbiting Spiral | mid level | rotation SPEED of arms |
| 5 | Standing Interference | bass env → contrast | petals SNAP soft→hard star |
| 6 | Temperature Field | slow energy + centroid | GLOW + WARMTH, nothing fast |
| 7 | Journey | character over minutes | WHICH effect dominates |
| + | Sparkle (overlay) | high transients | rim TWINKLES on cymbals |

Cost: worst case Journey 3 sub-effects ≈ 2M ops/s, <1% of a 240MHz core. ~25 floats total state, one 3-slot ripple array, no FFT beyond band split, no per-pixel history.
