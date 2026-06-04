#pragma once

#include <Arduino.h>

// Where the current LED frame is coming from. The card normally renders its
// own patterns internally (FRAME_INTERNAL). External sources (WLED realtime
// UDP, Art-Net) can take over the canvas for live streaming; when their packets
// stop arriving for ~2 seconds we fall back to internal rendering.
enum FrameSource : uint8_t {
  FRAME_INTERNAL = 0,
  FRAME_WLED_REALTIME = 1,
  FRAME_ARTNET = 2,
};

// Streaming is considered "active" when an external source has delivered a
// frame in the last STREAM_TIMEOUT_MS. After the timeout we revert to internal.
static constexpr uint32_t LW_STREAM_TIMEOUT_MS = 2000;

// Called by a frame producer (WLED realtime / Art-Net listener) immediately
// after it has written a fresh frame into the global leds[] buffer. Updates
// the active source and the last-seen timestamp.
void frameSourceMarkExternal(FrameSource src);

// Called by a frame producer BEFORE it writes into leds[]. Returns true if the
// caller may take/keep the canvas this tick, false if a *different* external
// source is currently live (delivered a frame within STREAM_TIMEOUT_MS). This
// gives the canvas to whichever external source claimed it first and locks the
// others out until the owner goes quiet — without it, Art-Net and a designer
// preview stream would each overwrite leds[] every tick and the strip would
// tear. A producer that is denied should skip its write (and drain its packet).
bool frameSourceClaim(FrameSource src);

// Call once per loop(). If the streaming watchdog has expired and we're not
// already on INTERNAL, fall back to INTERNAL so the pattern renderer takes
// over again.
void frameSourceTick();

// True when an external source is currently driving the canvas (source !=
// INTERNAL and a frame arrived recently).
bool frameSourceIsStreaming();

// Current frame source.
FrameSource frameSourceActive();

// Force an immediate return to INTERNAL. Used when the customer taps a
// pattern tile in the UI: the explicit local action overrides whatever
// external stream may be running.
void frameSourceCancelStream();
