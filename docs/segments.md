# Lightweaver — Segments (template)

WLED **segments** are named ranges of LEDs on the same strip that can each run their own effect, colour, palette, and brightness. For Lightweaver, each laser-cut zone of the artwork should be a segment so the visitor UI and Madrix can address zones independently without re-wiring the strip.

Fill in the table below once the artwork is final and the strip has been laid out in `led-art-mapper/`. Replace the placeholder rows; keep the column headers.

---

## Zone table (TEMPLATE — replace placeholder rows)

| Zone Name    | Segment ID | LED Start | LED Count | Notes |
|--------------|-----------:|----------:|----------:|-------|
| Outer Ring   | 0          | 0         | 60        | TODO  |
| Inner Ring   | 1          | 60        | 40        | TODO  |
| Left Petal   | 2          | 100       | 24        | TODO  |
| Right Petal  | 3          | 124       | 24        | TODO  |
| Centre Bloom | 4          | 148       | 32        | TODO  |
| Stem         | 5          | 180       | 18        | TODO  |

Conventions:
- Segment IDs are contiguous from 0.
- `LED Start` is the absolute index on the physical strip (0-based).
- `LED Count` is the number of LEDs in this zone — `start + count` of zone N should equal `start` of zone N+1 unless there is an intentional gap.

---

## Applying a segment via the WLED JSON API

POST to `http://<wled-ip>/json/state`. The example below creates / updates segment 0 (`Outer Ring`, indices 0–59):

```json
POST /json/state
Content-Type: application/json

{
  "seg": [
    {
      "id":  0,
      "n":   "Outer Ring",
      "start": 0,
      "stop":  60,
      "grp":   1,
      "spc":   0,
      "on":    true,
      "bri":   200,
      "col":   [[255, 180, 120]],
      "fx":    0,
      "sx":    128,
      "ix":    128,
      "pal":   0
    }
  ]
}
```

Notes:
- `stop` is **exclusive** — `start: 0, stop: 60` covers indices 0..59 (60 LEDs).
- Send one element of `seg` per zone you want to set. Omitted segments retain their current state.
- After defining all segments, save them as a **preset** in the WLED UI so they survive reboots and can be recalled with `{ "ps": <id> }`.

---

## Keep design and runtime in sync

Once you've defined zones here, mirror them into `led-art-mapper`'s `ledmap.json` export so the design tool, the visitor UI, and the WLED runtime all use the same zone names and indices. Zone name drift between these three is the most common source of "the wrong thing lit up" bugs.
