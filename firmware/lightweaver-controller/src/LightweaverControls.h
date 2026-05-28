#pragma once

#include <Arduino.h>
#include "LightweaverTypes.h"

struct ControlState {
  bool prevDown = false;
  bool nextDown = false;
  bool pressDown = false;
  bool pressAltDown = false;
  bool blackoutDown = false;
  uint32_t lastPrevAt = 0;
  uint32_t lastNextAt = 0;
  uint32_t lastPressAt = 0;
  uint32_t lastPressAltAt = 0;
  uint32_t lastBlackoutAt = 0;
  uint8_t encoderLastState = 0;
  int8_t encoderDelta = 0;
};

enum ControlEventType : uint8_t {
  CONTROL_NONE = 0,
  CONTROL_NEXT_LOOK = 1,
  CONTROL_PREVIOUS_LOOK = 2,
  CONTROL_BLACKOUT = 3,
  CONTROL_BRIGHTER = 4,
  CONTROL_DIMMER = 5
};

void setupLightweaverControls(const ControlsConfig& controls, ControlState& state);
ControlEventType pollLightweaverControls(const ControlsConfig& controls, ControlState& state);
float applyRotaryBrightness(float currentBrightness, ControlEventType event, uint8_t step);
