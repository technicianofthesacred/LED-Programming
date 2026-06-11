#pragma once

#include <Arduino.h>
#include <WebServer.h>
#include "LightweaverTypes.h"
#include "LightweaverStorage.h"

void setupLightweaverWeb(RuntimeConfig& config, ErrorCode& errorCode, uint16_t& totalPixels, uint8_t& currentLookIndex);
void handleLightweaverWeb();

// Shared CORS origin allowlist (Studio origins + local dev). Used by both the
// Lightweaver API and the WLED-compat JSON API so the unauthenticated control
// endpoints stop echoing Access-Control-Allow-Origin: * to arbitrary sites.
bool corsOriginAllowed(const String& origin);
