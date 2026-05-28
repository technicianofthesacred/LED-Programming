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
float runtimeGetBrightness();
float runtimeGetSpeed();
int16_t runtimeGetHueShift();
bool runtimeIsBlackedOut();
String runtimeFirmwareInfo();
void runtimeFactoryReset();
bool runtimeRename(const String& pieceName, const String& hostname, String& message);
