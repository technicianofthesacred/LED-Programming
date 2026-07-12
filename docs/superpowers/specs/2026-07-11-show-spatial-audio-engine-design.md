# Lightweaver Show Spatial Audio Engine Design

**Date:** 2026-07-11  
**Status:** Approved direction, pending written-spec review

## Purpose

Rebuild the Show engine so every mode clearly responds to music across the whole installation without becoming harsh, frantic, or strobing. The preview and physical output must share one spatial truth: either the idealized five-ring mandala or the LEDs currently defined in Layout.

This replaces the current assumption that sparse or slow geometry may leave most layers visually inactive. Sparse foreground effects remain valid, but every connected layer must carry a subtle musical breath underneath them.

## User-visible behavior

### Sound transport

- When a song file is playing, Show provides a visible **Pause song** control beside the selected file.
- Pausing freezes the song, preview, engine time, and physical-light frame together.
- Resuming continues from the same song timestamp and visual frame.
- Microphone and Quiet retain their existing meanings; Pause is only shown for a loaded song.
- Selecting a new song replaces the current song and returns transport to playing.

### Spatial template switch

Show provides a two-option switch above the preview:

- **Mandala** uses the five-ring reference geometry.
- **Connected layout** uses the current project strips and their stored LED x/y positions.

The selected template controls both preview placement and physical effect mapping. It is not a cosmetic preview option.

Connected-layout mode:

- includes every non-hidden strip with valid pixels;
- preserves physical output order while using x/y coordinates for field evaluation;
- normalizes the layout bounds into a centered coordinate system without distorting aspect ratio;
- updates when the project layout changes;
- falls back to Mandala with a clear inline explanation if no usable layout pixels exist.

## Engine architecture

The engine has three explicit layers.

### 1. Stable audio analysis

Replace maximum-bin sampling and self-erasing automatic gain behavior with a stable musical signal model:

- logarithmic bass, mid, and high bands derived from RMS or weighted energy;
- a slowly adapting noise floor and headroom that preserve sustained music instead of normalizing it toward zero;
- broadband energy and spectral centroid;
- spectral flux or equivalent positive-energy change;
- a transient/beat envelope with quick but eased attack and a gentle release;
- confidence gating so ambient noise does not create constant false beats.

The analyzer exposes raw musical features. It does not decide effect geometry.

Required behavior:

- sustained input remains responsive after at least five minutes;
- a clear transient reaches the engine within 150–300 ms;
- silence returns smoothly to the living-coal idle;
- sensitivity changes useful dynamic range without forcing saturation.

### 2. Shared whole-piece beat substrate

Every mode receives a restrained background modulation derived from the beat envelope.

- Every valid ring or connected strip participates.
- The substrate adds a small luminance lift, approximately 3–8% in Calm and 6–14% in Active.
- The lift includes a slow spatial phase offset so the installation breathes through its layers rather than flashing uniformly.
- Propagation is gentle and continuous. No hard on/off pulse, strobe, or abrupt full-field change.
- The substrate cannot erase the foreground mode's dark areas; it supplies motion, not a bright wash.
- Beat response modulates amplitude and spatial phase, never the authored long-term motion speed.

For Mandala, propagation can move radially or angularly according to the mode. For Connected layout, propagation uses normalized x/y position, radial distance from layout center, strip identity, and pixel progress along the strip.

### 3. Mode-specific spatial field

Each mode becomes a field function evaluated at normalized pixel coordinates. The same function works against Mandala pixels and connected-layout pixels.

Each pixel sample includes:

- normalized x/y;
- normalized radius and angle around the active template center;
- layer or strip index;
- progress within its strip;
- bass, mid, high, energy, centroid, flux, and beat envelope;
- authored engine time.

Mode-specific expectations:

- **Meridian:** retains a primary crisp layer, with quieter travelling echoes across every other layer.
- **Hearth:** remains full-field; bass and beat create localized warmth movement instead of only uniform brightness.
- **Embers:** retains sparse foreground sparks over a barely visible whole-piece ember shimmer.
- **Strata:** remains the clearest spectrum mode, but adjacent bands overlap enough for continuous spatial movement.
- **Tide:** every swell must traverse the full normalized radius and reach every layer before resolving.
- **Lattice:** keeps its geometric star while beat energy gently articulates nodes across the full field.
- **Procession:** widens and brightens its arms enough for legible whole-piece travel; it cannot depend only on mids.
- **Bloom:** petals must open through the entire normalized radius, including the outermost layer, with a soft trailing response.
- **Spiral:** retains authored rotation while beat and broadband energy visibly travel along and around its arms; it cannot depend only on mids.

“Livelier” means stronger and more legible musical modulation plus visible spatial travel. It does not mean strobing or uncontrolled speed.

## Calm and Active

- **Calm** is clearly responsive but restrained. A listener can always perceive gentle movement across the whole object.
- **Active** increases beat-substrate depth, foreground contrast, propagation breadth, and response articulation.
- Active may shorten release within safe bounds, but it does not simply increase global brightness.
- Neither preset changes authored rotation speed based on instantaneous audio.

## Pause model

The engine supports an explicit paused state.

- While paused, analyzer updates, engine time, foreground motion, beat decay, preview rendering changes, and newly encoded light frames stop.
- The last frame remains displayed and continues to be available to the frame-stream keepalive so the controller watchdog does not replace it.
- Resume resets frame-loop timing so elapsed wall time during pause is never applied as one large animation step.
- Stopping the song with Quiet remains distinct: Quiet releases toward idle; Pause freezes.

## Data flow

1. Microphone or song audio enters the analyzer.
2. The analyzer emits stable bands, energy, centroid, flux, and beat envelope.
3. The selected template provides normalized pixel samples.
4. The shared beat substrate produces low-amplitude whole-piece modulation.
5. The selected mode produces its foreground spatial field.
6. Substrate and foreground combine under palette, master-brightness, and warmth constraints.
7. The same computed frame drives the preview and physical-light stream.

## Error handling and edge cases

- Empty or invalid connected layouts fall back to Mandala and explain why.
- Degenerate layouts with zero width or height normalize safely without division by zero.
- Hidden strips do not appear or receive streamed pixels when Connected layout is selected.
- Layout changes invalidate spatial samples without recreating the audio context.
- Audio-context interruption preserves the selected source and resumes only after a permitted user gesture.
- If physical delivery fails while paused, the existing stream-health recovery still reports the failure.
- Large layouts reuse typed buffers and cached geometry to avoid per-frame allocations.

## Quantitative acceptance criteria

Tests must validate musical quality contracts rather than only nonzero output.

### Audio analysis

- Constant analyzer input retains at least 70% of its stabilized energy after five minutes.
- A synthetic transient produces a beat-envelope response within 300 ms.
- Broadband, bass-led, mid-led, and high-led fixtures produce distinguishable feature vectors.
- Silence and low-level background noise do not continuously trigger beats.

### Spatial coverage

- Every mode changes every Mandala ring during a repeated-beat fixture.
- Every mode changes every valid connected strip during the same fixture.
- In Calm, at least 80% of pixels show measurable temporal change over an eight-second musical fixture, while sparse foreground identity is assessed separately.
- In Active, at least 90% show measurable temporal change.
- Tide and Bloom demonstrably reach the outermost normalized radius.

### Responsiveness

- Every lively mode produces a measurable whole-frame beat delta above a defined regression threshold.
- No mode is driven exclusively by one band without a broadband or beat fallback.
- Calm and Active produce materially different modulation depth without exceeding the brightness ceiling.

### Template parity

- A field sampled on equivalent Mandala and connected-layout coordinates produces equivalent normalized behavior.
- Connected-layout physical frame order matches the project's strip/output order.
- Preview pixel colors exactly match the corresponding streamed frame colors.

### Pause

- Song time, engine time, preview frame, and streamed frame remain unchanged while paused.
- Resume continues without a time jump or restart.

## Scope

Included:

- audio feature extraction;
- beat substrate;
- all nine Show mode field functions;
- Mandala/Connected layout template switch;
- song pause/resume;
- preview and stream parity;
- regression and integration tests.

Excluded:

- firmware-native reimplementation of the Show engine;
- Raspberry Pi runtime work;
- new palettes outside the existing warm corridor;
- automatic BPM synchronization or tempo-locked choreography;
- changes to the Layout editor itself.

## Migration

Existing mode names and ordering remain stable. Internal engine APIs may change. The Show screen defaults to Connected layout when usable layout geometry exists, otherwise Mandala. The selected template may be kept as local Show preference; it does not modify project geometry.

