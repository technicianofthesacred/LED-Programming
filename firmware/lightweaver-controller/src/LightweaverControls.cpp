#include "LightweaverControls.h"

namespace {
bool validPin(int pin) {
  return pin >= 0;
}

bool readPressed(int pin) {
  return validPin(pin) && digitalRead(pin) == LOW;
}

bool buttonPressed(
  int pin,
  bool& debouncedDown,
  bool& rawDown,
  uint32_t& changedAt,
  uint32_t& lastAt
) {
  if (!validPin(pin)) return false;
  bool isDown = readPressed(pin);
  uint32_t now = millis();
  if (isDown != rawDown) {
    rawDown = isDown;
    changedAt = now;
  }

  bool stable = now - changedAt >= BUTTON_DEBOUNCE_MS;
  bool pressed = stable && rawDown && !debouncedDown && now - lastAt > BUTTON_DEBOUNCE_MS;
  if (stable) debouncedDown = rawDown;
  if (pressed) lastAt = now;
  return pressed;
}

uint8_t readEncoderState(const ControlsConfig& controls) {
  uint8_t a = digitalRead(controls.encoderA) == LOW ? 1 : 0;
  uint8_t b = digitalRead(controls.encoderB) == LOW ? 1 : 0;
  return static_cast<uint8_t>((a << 1) | b);
}

int8_t quadratureDelta(uint8_t previous, uint8_t current) {
  switch ((previous << 2) | current) {
    case 0b0001:
    case 0b0111:
    case 0b1110:
    case 0b1000:
      return 1;
    case 0b0010:
    case 0b1011:
    case 0b1101:
    case 0b0100:
      return -1;
    default:
      return 0;
  }
}
}

void setupLightweaverControls(const ControlsConfig& controls, ControlState& state) {
  if (validPin(controls.statusLed)) pinMode(controls.statusLed, OUTPUT);
  if (validPin(controls.encoderA)) pinMode(controls.encoderA, INPUT_PULLUP);
  if (validPin(controls.encoderB)) pinMode(controls.encoderB, INPUT_PULLUP);
  if (validPin(controls.encoderPress)) pinMode(controls.encoderPress, INPUT_PULLUP);
  if (validPin(controls.encoderPressAlt)) pinMode(controls.encoderPressAlt, INPUT_PULLUP);
  if (validPin(controls.previous)) pinMode(controls.previous, INPUT_PULLUP);
  if (validPin(controls.next)) pinMode(controls.next, INPUT_PULLUP);
  if (validPin(controls.blackout)) pinMode(controls.blackout, INPUT_PULLUP);
  state.encoderLastState = readEncoderState(controls);
  uint32_t now = millis();
  state.prevRawDown = state.prevDown = readPressed(controls.previous);
  state.nextRawDown = state.nextDown = readPressed(controls.next);
  state.pressRawDown = state.pressDown = readPressed(controls.encoderPress);
  state.pressAltRawDown = state.pressAltDown = readPressed(controls.encoderPressAlt);
  state.blackoutRawDown = state.blackoutDown = readPressed(controls.blackout);
  state.prevChangedAt = now;
  state.nextChangedAt = now;
  state.pressChangedAt = now;
  state.pressAltChangedAt = now;
  state.blackoutChangedAt = now;
}

ControlEventType pollLightweaverControls(const ControlsConfig& controls, ControlState& state) {
  if (buttonPressed(controls.next, state.nextDown, state.nextRawDown, state.nextChangedAt, state.lastNextAt) ||
      buttonPressed(controls.encoderPress, state.pressDown, state.pressRawDown, state.pressChangedAt, state.lastPressAt) ||
      buttonPressed(controls.encoderPressAlt, state.pressAltDown, state.pressAltRawDown, state.pressAltChangedAt, state.lastPressAltAt)) {
    return CONTROL_NEXT_LOOK;
  }

  if (buttonPressed(controls.previous, state.prevDown, state.prevRawDown, state.prevChangedAt, state.lastPrevAt)) {
    return CONTROL_PREVIOUS_LOOK;
  }

  if (buttonPressed(controls.blackout, state.blackoutDown, state.blackoutRawDown, state.blackoutChangedAt, state.lastBlackoutAt)) {
    return CONTROL_BLACKOUT;
  }

  uint8_t nextState = readEncoderState(controls);
  if (nextState != state.encoderLastState) {
    int8_t delta = quadratureDelta(state.encoderLastState, nextState);
    state.encoderLastState = nextState;
    if (delta != 0) {
      state.encoderDelta += delta;
      if (state.encoderDelta >= 4) {
        state.encoderDelta = 0;
        return controls.rotateDirection == "clockwise-dimmer" ? CONTROL_BRIGHTER : CONTROL_DIMMER;
      }
      if (state.encoderDelta <= -4) {
        state.encoderDelta = 0;
        return controls.rotateDirection == "clockwise-dimmer" ? CONTROL_DIMMER : CONTROL_BRIGHTER;
      }
    }
  }

  return CONTROL_NONE;
}

float applyRotaryBrightness(float currentBrightness, ControlEventType event, uint8_t step) {
  float amount = float(step) / 255.0f;
  if (event == CONTROL_DIMMER) return max(0.02f, currentBrightness - amount);
  if (event == CONTROL_BRIGHTER) return min(1.0f, currentBrightness + amount);
  return currentBrightness;
}
