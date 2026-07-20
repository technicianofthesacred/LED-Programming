#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <SD.h>
#include "LightweaverTypes.h"

struct RuntimeLoadResult {
  bool ok = false;
  RuntimeSource source = SOURCE_DEFAULTS;
  bool bootedCandidate = false;
  bool safeMode = false;
  bool configValid = false;
  bool knownGoodProject = false;
  ProvisioningPhase runtimePhase = ProvisioningPhase::Factory;
  String message;
};

void applyDefaultRuntimeConfig(RuntimeConfig& config);
void ensureDefaultZone(RuntimeConfig& config);
RuntimeLoadResult loadRuntimeConfig(RuntimeConfig& config);
bool saveRuntimeConfigJson(const String& json, RuntimeConfig& config, String& message);
bool stageRuntimeConfigJson(const String& json, String& activationId, String& message);
bool activateStagedRuntimeConfig(const String& activationId, String& message);
bool confirmCandidateRuntimeConfig(const String& activationId, String& message);
bool rollbackCandidateRuntimeConfig(const String& activationId, String& message);
bool runtimeConfigJsonChangesWiring(const String& json, const RuntimeConfig& current, bool& changes, String& message);
bool setRuntimeWiringDiscoveryBatch(uint8_t batchIndex, String& message);
bool clearRuntimeWiringDiscovery(String& message);
bool armRuntimeRecoveryAfterRestart(String& message);
bool runtimeRecoveryAfterRestartPending();
bool clearRuntimeRecoveryAfterRestart(String& message);
WiringSafetyStatus getRuntimeWiringSafetyStatus();
String runtimeWiringSafetyStatusJson();
bool saveWifiConfigJson(const String& json, RuntimeConfig& config, String& message);
String runtimeStatusJson(const RuntimeConfig& config, ErrorCode errorCode, uint16_t totalPixels, uint8_t currentLookIndex);
