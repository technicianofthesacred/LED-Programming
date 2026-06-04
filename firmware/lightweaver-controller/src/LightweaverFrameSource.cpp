#include "LightweaverFrameSource.h"

namespace {
FrameSource g_activeFrameSource = FRAME_INTERNAL;
uint32_t g_lastExternalFrameAt = 0;
}

void frameSourceMarkExternal(FrameSource src) {
  g_activeFrameSource = src;
  g_lastExternalFrameAt = millis();
}

bool frameSourceClaim(FrameSource src) {
  uint32_t now = millis();
  // Another external source owns the canvas if it is non-internal, different
  // from us, and still within the streaming window. First claimant holds the
  // canvas until it stops feeding (or a local action cancels the stream).
  bool ownedByOther = g_activeFrameSource != FRAME_INTERNAL &&
                      g_activeFrameSource != src &&
                      (now - g_lastExternalFrameAt) < LW_STREAM_TIMEOUT_MS;
  if (ownedByOther) return false;
  g_activeFrameSource = src;
  g_lastExternalFrameAt = now;
  return true;
}

bool frameSourceIsStreaming() {
  if (g_activeFrameSource == FRAME_INTERNAL) return false;
  return (millis() - g_lastExternalFrameAt) < LW_STREAM_TIMEOUT_MS;
}

void frameSourceTick() {
  // If the external producer has gone quiet for longer than the watchdog,
  // surrender the canvas back to internal rendering.
  if (g_activeFrameSource != FRAME_INTERNAL && !frameSourceIsStreaming()) {
    g_activeFrameSource = FRAME_INTERNAL;
  }
}

FrameSource frameSourceActive() {
  return g_activeFrameSource;
}

void frameSourceCancelStream() {
  g_activeFrameSource = FRAME_INTERNAL;
  g_lastExternalFrameAt = 0;
}
