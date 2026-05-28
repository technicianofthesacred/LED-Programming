#pragma once

#include <Arduino.h>
#include <WebServer.h>

// Pretend-WLED JSON API. The Lightweaver card answers a small subset of
// WLED's HTTP JSON API so the existing designer's WLED bar / DevicesPanel /
// live-frame push path can talk to the card without changes.
//
// Endpoints registered against the supplied WebServer:
//   GET  /json/info      — device identifying as WLED-shaped JSON
//   GET  /json/state     — current playback state in WLED's shape
//   POST /json/state     — accept state changes; honors `seg[0].i` raw RGB
//                          stream (the live-preview path) and on/bri toggles
//   GET  /json/effects   — array of our pattern names (mapped to WLED effect
//                          IDs by index in the same order /api/patterns
//                          returns)
//   GET  /json/palettes  — small starter list (Default + 1 per Color Order)
//   GET  /json           — combined info+state+effects+palettes (the same
//                          shape stock WLED returns on /json)
//
// Not implemented (acceptable — graceful 404):
//   POST /json/effects, /json/palettes, /json/cfg, /presets.json,
//   /ledmap.json, segment-specific lighting params beyond what zones express.

namespace lw_wled {

void registerEndpoints(WebServer& server);

}
