# LED Art Mapper — Reference Guide

## Running the app

```bash
cd led-art-mapper/app
npm install        # first time only
npm run dev        # opens at http://localhost:5173
```

---

## Concepts

### Strips and pixels

A **strip** is one continuous physical WS2815 LED strip routed along a path in your installation. You draw the path in the app, set a pixel count, and the app samples that many evenly-spaced points along the path. Those points become the LED positions.

Each LED gets a **global index** — a single sequential number that identifies it across all strips. Strip 1's pixels are 0, 1, 2…, strip 2's pick up where strip 1 left off. Order in the strips list = index order = physical wiring order.

A **ledmap.json** is the file you upload to WLED. It tells WLED the 2D position of every LED so that 2D effects map correctly onto your installation's physical shape.

### Coordinates

There are two coordinate spaces:

| Space | Used for | Values |
|---|---|---|
| SVG canvas | Drawing paths, screen position of dots | Raw pixels, depends on canvas size |
| Pattern space | `x`, `y` in your pattern code | 0.0 – 1.0 |

The app normalises from canvas → pattern space automatically before calling your pattern. It uses **contain mode**: the longest axis of your LED bounding box maps to 0–1, and the shorter axis shrinks proportionally. Aspect ratio is preserved. This matches Pixelblaze's coordinate model, so community patterns paste in directly.

---

## Drawing strips

### Tools

| Key | Button | What it does |
|---|---|---|
| `D` | ✏ Draw | Click waypoints to route a strip. Double-click to finish. |
| `S` | ↖ Select | Click a strip to highlight it in the list. |
| `X` | ✕ Delete | Click a strip to remove it. |
| — | Right-click / `Esc` | Cancel an in-progress draw. |

Keyboard shortcuts only fire when focus is not in the editor or an input field.

### Drawing a strip

1. Press `D` (or click Draw).
2. Click waypoints on the canvas to trace where the LED strip runs physically.
3. Double-click to finish the path. A prompt asks for name and pixel count.
4. The strip appears in the sidebar list. Dots appear on the canvas at the sampled LED positions.

**Pixel count** — enter the actual number of LEDs on that physical strip. You can change it later in the strips list; the app resamples immediately.

### Importing SVG

Click **Import SVG** and choose a file. Two modes:

- **Cancel (reference background)** — the SVG is pasted as a dimmed layer so you can draw strip paths on top of your artwork. The SVG geometry is not used as strip data.
- **OK (import as strips)** — each `<path>` element in the SVG becomes a strip. You'll be prompted for a pixel count for each path. Useful when your artwork file already contains the strip routing geometry.

### Strip index ranges

The strips list shows `0–59`, `60–119` etc. next to each strip. These are the global LED indices for that strip. The range directly maps to what `index` is in your pattern code.

Strips are indexed in list order. Reordering (drag-to-reorder) is not yet built — to change the index order, delete and redraw.

---

## Pattern editor

The editor runs JavaScript. Write a function body — you get several variables and return `{ r, g, b }`.

### Function signature

```js
// Called once per LED per animation frame.
// index      — global LED index, 0-based
// x, y       — normalised position, 0.0–1.0 (contain mode)
// t          — elapsed seconds since Run was pressed (unbounded)
// time       — 0–1 cycling, period ≈ 65.5 s (Pixelblaze-compatible)
// pixelCount — total number of LEDs across all strips

return { r, g, b }; // each 0–255
```

### `time` vs `t`

- **`t`** — raw elapsed seconds. Counts up forever. Good for absolute time references, delays, or when you want `sin(t * frequency)`.
- **`time`** — wraps 0→1 over ~65.5 seconds, then resets. Matches Pixelblaze's `time` variable exactly. Patterns from the Pixelblaze community use `time` — paste them in and they work.

### Built-in helpers

#### Color

```js
hsv(h, s, v)       // Convert HSV to {r,g,b}. All inputs 0–1.
                   // h wraps automatically so hsv(1.2, ...) == hsv(0.2, ...)
rgb(r, g, b)       // r/g/b each 0–1. Returns {r,g,b} with 0–255 values.
```

#### Waves (all return 0–1)

```js
wave(x)            // Sine wave. x: 0–1 = one full cycle.
triangle(x)        // Triangle wave. Rises linearly 0→1 for first half, falls 1→0 second half.
square(x, duty)    // Square wave. duty 0–1 sets pulse width (default 0.5).
```

All wave functions accept any float — they use `fract()` internally so you can feed them `index / 60 + time` and it just works.

#### Math

```js
noise(x)           // Smooth value noise, 1D. Returns 0–1.
noise(x, y)        // Smooth value noise, 2D. Returns 0–1.
randomF(seed)      // Deterministic pseudo-random 0–1 from a numeric seed.
                   // Same seed → same value every call.

clamp(v, a, b)     // Clamp v between a and b.
lerp(a, b, t)      // Linear interpolation. t=0 → a, t=1 → b.
fract(x)           // Fractional part: fract(3.7) = 0.7
abs, floor, ceil, min, max, pow, sqrt, exp, log
sin, cos           // Standard trig. Angle in radians.
```

### Writing patterns

**Return anything.** If your code doesn't reach a `return`, the pixel gets `{r:0, g:0, b:0}`. If there's a runtime error, the pixel turns dim red.

**Auto-recompile.** The editor recompiles 500 ms after you stop typing, so you see live results while writing. Hit **▶ Run** manually to restart from `t=0`.

**Use `time` for animations that loop.** Patterns that use `time` will seamlessly cycle. Patterns that use `t` will drift (accumulate) over a long session.

**Use `index / pixelCount` to get fractional position along all strips combined.** Combine with `time` for chases: `fract(index / pixelCount - time * 0.5)`.

**Use `x`, `y` for spatial effects.** These are 0–1 normalised to your installation's bounding box, so a radial effect at `(0.5, 0.5)` centres on the middle of your layout regardless of scale or canvas position.

---

### Pattern examples

#### Animated rainbow (default)
```js
return hsv(fract(index / 60 + time), 1, 1);
```

#### Pixelblaze-style rainbow (uses `time` global directly)
```js
return hsv(x + time, 1, 1);
```

#### Fire — noise-based warm glow moving upward
```js
const n = noise(x * 3, y * 4 - t * 1.5);
const v = clamp(n * 1.5, 0, 1);
return hsv(lerp(0.0, 0.1, n), 1, v); // red → orange
```

#### Plasma — overlapping spatial sine waves
```js
const h = sin(x * 6 + time * 3.14) * 0.5
        + sin(y * 5 - time * 2.1)  * 0.5;
return hsv(fract(h * 0.5 + 0.5), 0.9, 1);
```

#### Chase — single dot travelling along all strips
```js
const pos  = fract(time * 0.8);
const dist = abs(index / pixelCount - pos);
return hsv(0.55, 1, max(0, 1 - dist * 40));
```

#### Sparkle — random white flashes
```js
const seed = randomF(index + floor(t * 10) * 1000);
const v    = seed > 0.96 ? 1 : 0;
return { r: v*255, g: v*255, b: v*255 };
```

#### Solid colour (white)
```js
return { r: 255, g: 255, b: 255 };
```

#### Colour by position (debug tool)
```js
// x → hue, y → brightness. Useful for verifying ledmap layout.
return hsv(x, 1, 0.5 + y * 0.5);
```

#### Stripes perpendicular to strip direction
```js
return hsv(fract(x * 8 + time), 1, 1);
```

#### Pulse — whole installation breathing
```js
const v = wave(time * 2);
return hsv(0.6, 1, v);
```

#### Noise texture with colour shift
```js
const n = noise(x * 5 + time, y * 5);
return hsv(n + time * 0.2, 0.8, n);
```

---

## Exporting

### WLED ledmap.json

```
Export tab → ↓ WLED ledmap.json
```

Upload to your ESP32-S3 via **WLED web UI → Config → LED Preferences → 2D setup → Custom ledmap**. The file maps each LED index to its 2D position. WLED uses this to correctly apply 2D effects to your freeform layout.

Format produced:
```json
{
  "n": 120,
  "map": [
    [0.00, 0.50],
    [0.02, 0.48],
    ...
  ]
}
```
Index in the array = LED index. Value = [x, y] normalised position.

**Normalize coords (checked by default)** — maps your bounding box to 0–1. Leave checked unless you have a specific reason to use raw canvas pixels.

**Scale X/Y** — multiply the output coordinates. Use to match a specific grid size WLED expects (e.g. Scale X: 16, Scale Y: 9 for a 16×9 matrix).

**Offset X/Y** — shift all coordinates by a fixed amount.

### FastLED ledmap.h

```
Export tab → ↓ FastLED ledmap.h
```

A C++ header file with a PROGMEM array you can `#include` in your Arduino/ESP32 sketch:

```cpp
const Point ledCoords[120] PROGMEM = {
  {0.00f, 0.50f},  // LED 0
  {0.02f, 0.48f},  // LED 1
  ...
};
```

### CSV

Raw index, x, y — one row per LED. Import into any tool that accepts tabular coordinates (Excel, Python, TouchDesigner, etc).

---

## Saving and loading projects

**Save** — downloads `led-project.json` containing all strip paths, pixel counts, names, colours, and all pattern code. Does not save the reference background SVG.

**Load** — restores strips and patterns from a saved JSON file. The canvas re-renders all strips from the saved path data.

The project file does not include computed pixel positions — those are re-derived from the path data on load.

---

## Hardware connection

This app produces a `ledmap.json` you upload to WLED. It doesn't talk to the hardware directly.

```
Physical installation
  → WS2815 LEDs wired to ESP32-S3 N16R8
  → Running WLED MoonModules firmware
  → Connected to your WiFi

Workflow:
  1. Draw your LED paths in this app (matching physical strip routing)
  2. Export ledmap.json
  3. Open WLED web UI (ESP32-S3 IP address)
  4. Config → LED Preferences → scroll to 2D setup
  5. Upload ledmap.json
  6. WLED 2D effects now map to your physical installation layout
```

**Pixel count accuracy matters.** The number of pixels you set per strip in this app must exactly match the physical LED count on that strip. Off-by-one shifts all subsequent LEDs in the map.

**Strip order = wiring order.** The strip that is first in the sidebar list must be the first strip wired to the data pin (closest to the ESP32). Second strip second, etc.

---

## Reference repos (read-only)

Cloned into `reference-repos/` for reference:

| Repo | What it's useful for |
|---|---|
| `led-mapper/` | See `js/fastled.js` for FastLED normalisation approach; `js/coordinates.js` for tab-delimited import format |
| `pixelblaze/` | `README.expressions.md` — full function reference; `README.mapper.md` — coordinate model and map format spec |
| `PixelTeleporter/` | 3D mapping function examples in `/examples/MappingFunctions/` — adapts to 2D patterns |
| `PixelblazePatterns/` | Community pattern library — all patterns use `time`, `x`, `y` directly, paste into this app's editor |
| `WLED-Ledmap-Generator/` | `XYmapper.js` — how WLED's matrix ledmap format works (rectangular grid, not freeform) |

**Note on WLED ledmap formats:** The WLED-Ledmap-Generator uses a rectangular matrix format (`width`, `height`, flat index array) designed for serpentine LED panels. This app uses the freeform format (`[[x,y],...]`) which is what WLED MoonModules uses for custom 2D layouts. Both are valid WLED formats; they serve different use cases.
