#pragma once

#include <Arduino.h>

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
bool runtimeGetCustomDrift();

// Zone-targeted setters. Empty targetId broadcasts under sync rules.
void runtimeSetBrightnessZ(const String& targetId, float value01);
void runtimeSetSpeedZ(const String& targetId, float speed);
void runtimeSetHueShiftZ(const String& targetId, int16_t shift);
void runtimeSetBlackoutZ(const String& targetId, bool on);
void runtimeSetCustomHueZ(const String& targetId, uint8_t hue);
void runtimeSetCustomSaturationZ(const String& targetId, uint8_t sat);
void runtimeSetCustomBreatheZ(const String& targetId, bool on);
void runtimeSetCustomDriftZ(const String& targetId, bool on);
bool runtimeSelectPatternByIdZ(const String& targetId, const String& patternId);

void runtimeSetSyncZones(bool on);
bool runtimeGetSyncZones();
String runtimeZonesJson();

// Drift palette (min/max hue bounds for custom-color drift)
void runtimeSetDriftRange(uint8_t lo, uint8_t hi);
void runtimeSetDriftRangeZ(const String& targetId, uint8_t lo, uint8_t hi);
uint8_t runtimeGetDriftHueMin();
uint8_t runtimeGetDriftHueMax();
float runtimeGetBrightness();
float runtimeGetSpeed();
int16_t runtimeGetHueShift();
bool runtimeIsBlackedOut();
String runtimeFirmwareInfo();
void runtimeFactoryReset();
void runtimeResetWifi();
bool runtimeRename(const String& pieceName, const String& hostname, String& message);

// Frame-source state for the web/runtime layer. `runtimeIsStreaming()` tells
// callers whether an external frame producer (WLED realtime UDP, Art-Net) is
// currently driving the canvas. `runtimeFrameSource()` returns the enum
// (cast to uint8_t for stable wire transport). `runtimeCancelStream()`
// forces an immediate return to internal pattern rendering — used when the
// customer taps a pattern tile during a stream.
bool runtimeIsStreaming();
uint8_t runtimeFrameSource();
void runtimeCancelStream();
