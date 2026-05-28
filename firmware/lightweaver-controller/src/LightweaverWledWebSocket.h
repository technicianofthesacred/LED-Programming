#pragma once

#include <Arduino.h>

// WebSocket server on port 81 — the live frame push channel for the
// designer. Listens at ws://<host>:81/ . Designer's useWled hook is told
// to use port 81 instead of 80 (port 80 hosts the HTTP server already).
// Incoming messages are shaped `{v: true, seg: [{i: ["FF0000", ...]}]}`
// at up to 25 fps.
//
// We translate each incoming message into the same render path as the
// HTTP POST /json/state route: decode hex pixels into leds[], apply
// customer manualBrightness, and mark the FrameSource as WLED_REALTIME
// so the priority system yields the internal renderer.

void setupWledWebSocket();
void handleWledWebSocket();
bool wledWebSocketHasClients();
