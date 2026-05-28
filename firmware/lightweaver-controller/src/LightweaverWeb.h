#pragma once

#include <Arduino.h>
#include <WebServer.h>
#include "LightweaverTypes.h"
#include "LightweaverStorage.h"

void setupLightweaverWeb(RuntimeConfig& config, ErrorCode& errorCode, uint16_t& totalPixels, uint8_t& currentLookIndex);
void handleLightweaverWeb();
