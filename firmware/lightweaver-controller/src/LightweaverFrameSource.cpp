#include "LightweaverFrameSource.h"

namespace {
FrameSource g_activeFrameSource = FRAME_INTERNAL;
uint32_t g_lastExternalFrameAt = 0;
}

void frameSourceMarkExternal(FrameSource src) {
  g_activeFrameSource = src;
  g_lastExternalFrameAt = millis();
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
