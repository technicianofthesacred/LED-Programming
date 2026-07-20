# Pattern Lab operator guide

Pattern Lab is Lightweaver's separate workspace for turning a familiar LED
look into a detailed five-to-fifteen-minute journey. It is designed to be easy
first: choose a source, move five artistic controls, choose how the look
evolves, and save a variation. Technical controls remain collapsed unless they
are needed.

The current runtime remains **ESP32-S3 only**. Pattern Lab runs in the public
Studio at `led.mandalacodes.com`; the finished card experience runs on the
Lightweaver card. A Raspberry Pi is not part of this workflow.

## Open the separate workspace

Open **Pattern Lab** from the Studio navigation, or use
`#screen=pattern-lab`. The route, renderer, worker, styles, and draft storage
are isolated from Patterns, Layout, Playlist, Show, and Card.

Pattern Lab reads a snapshot of the current mapped artwork so its preview has
the correct sculpture shape. It does not change the active project, playlist,
show, card configuration, or LEDs while you edit.

On a phone, the artwork stays full width. Tap **Controls** to open the authoring
drawer and **Close** or the backdrop to return to the artwork.

## Make a long pattern

1. In **Choose pattern**, start with any built-in Lightweaver pattern or one of
   the five living simulations: Particle Drift, Living Ripples, Wandering
   Trails, Cellular Field, or Reaction Diffusion.
2. In **Sculpt the look**, adjust Color, Movement, Shape, Texture, and Energy.
   These are the normal controls; **Advanced controls** is optional.
3. Turn on **Long Evolution**. Choose a character — Slow Bloom, Wandering,
   Tidal, Breathing, Gather & Release, or Rare Surprises — then set a duration
   from 5 to 15 minutes and the amount of change.
4. Use **Beginning**, **Middle**, **End**, or the journey scrubber to inspect
   the complete arc without waiting in real time. Use Play/Pause for motion.
5. Compare **Source** and **Draft**. Preview the four seeded variations, choose
   one, or ask for **New variation**. Lock the seed when the movement should be
   repeatable.
6. Tap **Save private draft**. Drafts are stored only in this browser under a
   Pattern-Lab-specific storage key. **Export recipe** creates a portable
   `.lwrecipe.json`; **Import recipe** validates a temporary copy before it can
   replace the working draft.

Up to three optional layers can be reordered and blended. Because the everyday
workflow does not require layers, keep that section closed until the main look
already feels right.

## Use a WAV file without storing the music

Open **Offline audio lanes** under Long Evolution and choose a WAV file. Studio
analyzes it locally into bass, mid, high, level, centroid, flux, and onset
lanes. The recipe stores those numeric lanes, analysis settings, and a
fingerprint; it does **not** store the WAV or upload the audio.

Offline-audio recipes are deliberately **Bake to card** in v1. The analysis
must cover the complete selected evolution duration. Remove the analysis if a
smaller recipe without audio-driven movement is preferred.

## Preview on the real lights safely

**Preview on Lights** is the only Pattern Lab action that directly controls the
card. Opening Pattern Lab, changing a control, scrubbing, or selecting a
variation never starts hardware output.

Before starting, connect to the Lightweaver card on the same local network.
When Preview on Lights is pressed, Studio snapshots the current card zones and
selected look, claims the existing frame stream, and shows an explicit live
state. Press **Stop preview** before navigating away. Stop cancels streaming
first and then restores the snapshot. Leaving the screen, a delivery error, or
another tab taking stream ownership also follows the bounded cleanup path; if
a snapshot was unavailable, Studio uses the existing safe reset/project
fallback.

Do not treat the browser preview as physical acceptance. Color order, gamma,
brightness, power limiting, timing, and the exact mapped pixel order must still
be checked on the intended card and strip.

## Card compatibility and exports

Open **Card compatibility & diagnostics** only when preparing delivery. Studio
reports one of four outcomes:

- **Live on card** — the recipe fits the declared native ESP32-S3 subset and
  measured budgets.
- **Bake to card** — Studio can render the complete journey to `.lwseq` for
  microSD playback.
- **Simplify for card** — a separate compatible variant can be created; the
  source recipe stays unchanged.
- **Studio only** — a requirement, target, or resource estimate is unknown or
  unsupported, so export fails closed.

The deterministic bake uses the locked physical wiring order and writes the
existing `LWSEQ1` format plus a canonical JSON sidecar. The sidecar records
SHA-256 hashes for the recipe, physical layout/order, optional audio lanes, and
the `.lwseq`, along with FPS, frame count, pixel count, and seed. Repeating a
bake with identical canonical inputs produces identical bytes. Baking is
cancellable and refuses unknown wiring, unresolved audio, non-deterministic
inputs, durations over 15 minutes, or files beyond the bounded storage cap.

The same panel can export an xLights `.xmodel`, a MADRIX fixture CSV, and
Art-Net setup notes in locked physical wiring order. These are layout/lighting
software handoffs; they do not change the current project or connected lights.

The firmware also contains a bounded native recipe v1 parser, registry,
renderer integration, and capability descriptor. It supports at most three
layers and a fixed source/transform/mask/blend/modulator vocabulary. Particles,
reaction diffusion, graphs, shaders, and audio remain bake-only. The firmware
descriptor intentionally reports `physicalParityVerified: false` until the
real-card gate is completed.

## Experimental tools

Advanced Graph, Shader Bake, and card Art-Net recording are disabled by
default. Enabling a UI gate does not authorize arbitrary code on the ESP32:
graph and shader work must lower into the canonical Recipe contract or trusted
`LWSEQ1` bytes. Studio-side recording is preferred. Card-side Art-Net-to-SD
recording remains blocked until sustained-write, dropped-frame, power-loss,
and filesystem-recovery tests pass on hardware.

## Before calling a Pattern Lab build released

Run the automated commands in
[the deployment checklist](deployment-checklist.md#pattern-lab-release-acceptance),
then complete every physical item there on a representative ESP32-S3 and the
intended mapped strip/artwork. In particular, confirm a native recipe matches
Studio and a complex baked recipe plays in the correct physical order for the
full intended duration.

**Use in Project** always opens an inline review before changing the active
project. A live-compatible recipe adds and selects a new saved look without
overwriting built-ins or existing looks. A bake-compatible recipe requires a
completed bake of that exact draft, adds only bounded sequence metadata to the
project, and downloads the verified controller package that carries the actual
`.lwseq` bytes and hash sidecar. Canceling the review changes nothing.
