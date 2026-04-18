# LED Art Mapper

Browser-based tool for designing LED art installations. Draw vector paths, assign pixel counts, write patterns, preview live, and export `ledmap.json` for WLED.

## Quick start

```bash
cd app
npm install
npm run dev
```

Open `http://localhost:5173`

## Workflow

1. **Draw** — click waypoints to route your LED strip paths over your artwork. Double-click to finish a strip. Set pixel count and name.
2. **Import SVG** — load your artwork as a reference background (dimmed), or import `<path>` elements directly as strips.
3. **Pattern** — write a per-pixel JS function, hit Run. Helpers: `hsv()`, `wave()`, `clamp()`, `lerp()`, `fract()`.
4. **Export** — download `ledmap.json` for WLED, FastLED C++ array, or CSV.

## Pattern API

```js
// Called each animation frame, once per LED
// index  — global LED index (0-based, across all strips in draw order)
// x, y   — pixel position in SVG canvas units
// t      — elapsed time in seconds
// return { r, g, b }  (each 0–255)

return hsv(fract(index / 60 + t * 0.2), 1, 1);
```

## Export formats

| File | Use |
|---|---|
| `ledmap.json` | WLED MoonModules — upload via web UI → LED Preferences → 2D layout |
| `ledmap.h` | FastLED — `#include` in your Arduino sketch |
| `ledmap.csv` | Raw coordinates for any other tool |

## Hardware target

- ESP32-S3 N16R8 + WS2815 12V addressable LEDs
- WLED MoonModules firmware
- Typical pitch: 16.6 mm (60 LED/m) or 33.3 mm (30 LED/m)

## File map

```
app/
├── index.html          entry point
├── styles.css          dark UI theme
├── package.json        Vite dev server
└── src/
    ├── main.js         state, event wiring, animation loop
    ├── canvas.js       SVG drawing canvas, strip path management
    ├── mapper.js       path → equidistant pixel coordinates
    ├── patterns.js     sandboxed pattern compiler + evaluator
    ├── preview.js      live LED dot renderer (SVG circles)
    └── export.js       ledmap.json / FastLED / CSV serialisers

reference-repos/        cloned for reading only — see README inside
```
