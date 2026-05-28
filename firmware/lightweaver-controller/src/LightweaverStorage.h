#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <SD.h>
#include "LightweaverTypes.h"

struct RuntimeLoadResult {
  bool ok = false;
  RuntimeSource source = SOURCE_DEFAULTS;
  String message;
};

void applyDefaultRuntimeConfig(RuntimeConfig& config);
RuntimeLoadResult loadRuntimeConfig(RuntimeConfig& config);
bool saveRuntimeConfigJson(const String& json, RuntimeConfig& config, String& message);
bool saveWifiConfigJson(const String& json, RuntimeConfig& config, String& message);
String runtimeStatusJson(const RuntimeConfig& config, ErrorCode errorCode, uint16_t totalPixels, uint8_t currentLookIndex);
