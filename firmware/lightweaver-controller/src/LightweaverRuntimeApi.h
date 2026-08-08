#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include "LightweaverProvisioningPolicy.h"

struct RuntimeConfig;

struct FactoryResetResult {
  bool accepted = false;
  bool pendingVerification = false;
  String message;
};

void runtimeSetBrightness(float value01);     // 0.02..1.0
void runtimeSetSpeed(float speed);             // 0.25..4.0
void runtimeSetHueShift(int16_t shift);        // -128..128
void runtimeSetBlackout(bool on);
void runtimeNextPattern();
void runtimePreviousPattern();
bool runtimeSelectPatternById(const String& id);
void runtimeTriggerIdentify();
void runtimeSetCustomHue(uint8_t hue);
void runtimeSetCustomSaturation(uint8_t sat);
void runtimeSetCustomBreathe(bool on);
void runtimeSetCustomDrift(bool on);
uint8_t runtimeGetCustomHue();
uint8_t runtimeGetCustomSaturation();
bool runtimeGetCustomBreathe();
bool runtimeGetCustomBreatheZ(const String& targetId);
bool runtimeGetCustomDrift();

// Zone-targeted setters. Empty targetId broadcasts under sync rules.
void runtimeSetBrightnessZ(const String& targetId, float value01);
void runtimeSetSpeedZ(const String& targetId, float speed);
void runtimeSetHueShiftZ(const String& targetId, int16_t shift);
void runtimeSetBlackoutZ(const String& targetId, bool on);
void runtimeSetCustomHueZ(const String& targetId, uint8_t hue);
void runtimeSetCustomSaturationZ(const String& targetId, uint8_t sat);
void runtimeSetCustomBreatheZ(const String& targetId, bool on);
void runtimeSetBreatheSettingsZ(const String& targetId, uint8_t lowerPct, uint8_t upperPct, uint8_t cycleSeconds);
uint8_t runtimeGetBreatheLowerPct();
uint8_t runtimeGetBreatheUpperPct();
uint8_t runtimeGetBreatheCycleSeconds();
uint8_t runtimeGetBreatheLowerPctZ(const String& targetId);
uint8_t runtimeGetBreatheUpperPctZ(const String& targetId);
uint8_t runtimeGetBreatheCycleSecondsZ(const String& targetId);
void runtimeSetCustomDriftZ(const String& targetId, bool on);
bool runtimeCanSelectPatternByIdZ(const String& targetId, const String& patternId);
bool runtimePreparePatternByIdZ(const String& targetId, const String& patternId);
bool runtimePrepareStepPattern(int8_t direction);
bool runtimeCommitPreparedPatternSelection();
void runtimeDiscardPreparedPatternSelection();
bool runtimeSelectPatternByIdZ(const String& targetId, const String& patternId);
String runtimeCurrentPatternId();

void runtimeSetLedColorOrder(const String& order);
bool runtimeCanSetLedColorOrder(const String& order);
String runtimeGetLedColorOrder();
bool runtimeControlTargetExists(const String& targetId);
bool runtimePatternAffectsAllOutputs(const String& targetId, const String& patternId);
bool runtimeCanStepPattern(int8_t direction);
uint8_t runtimeAffectedOutputCount(const String& targetId, bool syncZones, ProvisioningOutputScope scope);
String runtimeAffectedOutputId(const String& targetId, bool syncZones,
                               ProvisioningOutputScope scope, uint8_t affectedIndex);
uint32_t runtimeAdvanceStateRevision();
uint32_t runtimeStateRevision();
void runtimeSetSyncZones(bool on);
bool runtimeGetSyncZones();
String runtimeZonesJson();
String runtimeRecoverLights(const String& patternId, float brightness, bool syncZones);
String runtimeWiringSafetyStatus();
uint32_t runtimeWiringProbationRemainingMs();
bool runtimeActivateWiringCandidate(const String& activationId, String& message);
bool runtimeConfirmWiringCandidate(const String& activationId, String& message);
bool runtimeRollbackWiringCandidate(const String& activationId, String& message);
String runtimeSafeDiscoveryOutput(uint8_t batchIndex);
bool runtimeStopSafeDiscovery(String& message);

// Drift palette (min/max hue bounds for custom-color drift)
void runtimeSetDriftRange(uint8_t lo, uint8_t hi);
void runtimeSetDriftRangeZ(const String& targetId, uint8_t lo, uint8_t hi);
uint8_t runtimeGetDriftHueMin();
uint8_t runtimeGetDriftHueMax();
float runtimeGetBrightness();
float runtimeGetBrightnessZ(const String& targetId);
float runtimeGetSpeed();
int16_t runtimeGetHueShift();
bool runtimeIsBlackedOut();
String runtimeCardId();
String runtimeBootId();
const char* runtimeProvisioningPhase();
bool runtimeCommandReady();
// Pattern/brightness/scene control. Ignores WiFi transport transitions: local
// playback is safe while the radio is unsettled.
bool runtimePlaybackReady();
bool runtimeOutputReady();
bool runtimeConfigValid();
bool runtimeKnownGoodProject();
// True when this boot fell back to safe defaults because a project that is
// STILL PRESENT in NVS could not be read. Such a card publishes exactly the
// absence a factory-erased one does — no project identity, knownGoodProject
// false, source defaults — so without this flag a caller cannot tell "nothing
// to lose" from "the owner's artwork is still here, just unread". Strip
// discovery writes its bench config straight over a blank card, so that
// distinction is the difference between rescuing a card and overwriting a
// piece. Already surfaced as the 'safe-mode' state on /api/wiring/status; this
// exposes the same truth on the status and firmware-info envelopes.
bool runtimeSafeModeActive();
// Blank-card port probe. Pins the beacon to one port so the owner can ask a
// specific port "is my strip on you?" and read the answer immediately, instead
// of waiting for the sweep to reach it. Needs no config and no reboot: every
// available approved GPIO already holds a beacon controller. Returns false if
// this card cannot drive that GPIO. litPixels reports how many pixels the probe
// lights, which is the bench-safe beacon limit rather than the whole strip —
// the card does not yet know the strip length or the supply.
bool runtimeBeaconPinPort(uint8_t gpio, uint16_t& litPixels);
void runtimeBeaconReleasePort();
bool runtimeBeaconPortsAvailable(uint8_t* gpios, uint8_t capacity, uint8_t& count);
void runtimeApplySavedConfig();
void runtimeMarkRestartPending();
void runtimeArmConfigRestartFallback();
void runtimeSetWifiTransitionPending(bool pending);
String runtimeFirmwareInfo();
void serializeKaleidoscopeMappings(JsonArray target, const RuntimeConfig& config);
String runtimeRecipeCapabilities();
FactoryResetResult runtimeFactoryReset();
bool runtimeFinalizeFactoryResetRadio(String& message);
void runtimeResetWifi();
bool runtimeClearProject(String& message);
bool runtimeRename(const String& pieceName, const String& hostname, String& message);

// External-frame streaming. When a source (WLED realtime UDP / Art-Net) is
// pushing frames at us, runtimeIsStreaming() is true and the internal
// renderer yields. runtimeFrameSource() returns the enum cast to uint8_t
// for stable wire transport: 0 = INTERNAL, 1 = WLED_REALTIME, 2 = ARTNET.
// runtimeCancelStream() forces an immediate return to internal rendering —
// used when the customer taps a pattern tile during a stream.
bool runtimeIsStreaming();
uint8_t runtimeFrameSource();
void runtimeCancelStream();

uint8_t runtimeOutputRequestedBrightnessByte();
uint8_t runtimeOutputBrightnessByte();
float runtimeOutputBrightnessScale();
bool runtimeOutputPowerLimited();
const char* runtimeOutputSourceClass();

// Read back the output-color settings configured in the physical output
// pipeline, rather than merely echoing request JSON.
bool runtimeOutputGammaEnabled();
float runtimeOutputGammaValue();
float runtimeOutputCalibrationRed();
float runtimeOutputCalibrationGreen();
float runtimeOutputCalibrationBlue();
uint16_t runtimeOutputMeasuredFps();
bool runtimeOutputDithering();
