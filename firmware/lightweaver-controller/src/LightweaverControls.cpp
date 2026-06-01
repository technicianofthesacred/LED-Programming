#include "LightweaverControls.h"

namespace {
constexpr int8_t ENCODER_EVENT_DELTA = 4;
constexpr uint8_t MIN_VISIBLE_BRIGHTNESS_STEP = 18;

#ifndef LIGHTWEAVER_CONTROL_TEST
volatile int8_t encoderInterruptDelta = 0;
volatile uint8_t encoderInterruptLastState = 0;
int encoderInterruptPinA = -1;
int encoderInterruptPinB = -1;
#endif

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

#ifndef LIGHTWEAVER_CONTROL_TEST
uint8_t readEncoderInterruptState() {
  uint8_t a = digitalRead(encoderInterruptPinA) == LOW ? 1 : 0;
  uint8_t b = digitalRead(encoderInterruptPinB) == LOW ? 1 : 0;
  return static_cast<uint8_t>((a << 1) | b);
}
#endif

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

ControlEventType consumeEncoderDelta(const ControlsConfig& controls, ControlState& state, int8_t delta) {
  if (delta == 0) return CONTROL_NONE;
  state.encoderDelta += delta;
  if (state.encoderDelta >= ENCODER_EVENT_DELTA) {
    state.encoderDelta -= ENCODER_EVENT_DELTA;
    return controls.rotateDirection == "clockwise-dimmer" ? CONTROL_BRIGHTER : CONTROL_DIMMER;
  }
  if (state.encoderDelta <= -ENCODER_EVENT_DELTA) {
    state.encoderDelta += ENCODER_EVENT_DELTA;
    return controls.rotateDirection == "clockwise-dimmer" ? CONTROL_DIMMER : CONTROL_BRIGHTER;
  }
  return CONTROL_NONE;
}

#ifndef LIGHTWEAVER_CONTROL_TEST
void IRAM_ATTR handleEncoderInterrupt() {
  if (!validPin(encoderInterruptPinA) || !validPin(encoderInterruptPinB)) return;
  uint8_t current = readEncoderInterruptState();
  int8_t delta = quadratureDelta(encoderInterruptLastState, current);
  encoderInterruptLastState = current;
  if (delta == 0) return;
  int16_t nextDelta = int16_t(encoderInterruptDelta) + delta;
  if (nextDelta > 48) nextDelta = 48;
  if (nextDelta < -48) nextDelta = -48;
  encoderInterruptDelta = int8_t(nextDelta);
}

void setupEncoderInterrupts(const ControlsConfig& controls, ControlState& state) {
  if (validPin(encoderInterruptPinA)) detachInterrupt(digitalPinToInterrupt(encoderInterruptPinA));
  if (validPin(encoderInterruptPinB) && encoderInterruptPinB != encoderInterruptPinA) {
    detachInterrupt(digitalPinToInterrupt(encoderInterruptPinB));
  }
  encoderInterruptPinA = controls.encoderA;
  encoderInterruptPinB = controls.encoderB;
  encoderInterruptLastState = state.encoderLastState;
  encoderInterruptDelta = 0;
  if (!validPin(encoderInterruptPinA) || !validPin(encoderInterruptPinB)) return;
  attachInterrupt(digitalPinToInterrupt(encoderInterruptPinA), handleEncoderInterrupt, CHANGE);
  if (encoderInterruptPinB != encoderInterruptPinA) {
    attachInterrupt(digitalPinToInterrupt(encoderInterruptPinB), handleEncoderInterrupt, CHANGE);
  }
}

int8_t takeEncoderInterruptDelta() {
  noInterrupts();
  int8_t delta = encoderInterruptDelta;
  encoderInterruptDelta = 0;
  interrupts();
  return delta;
}
#endif
}

int effectiveEncoderPressAltPin(const ControlsConfig& controls) {
  if (controls.encoderPressAlt >= 0 && controls.encoderPressAlt != controls.encoderPress) return controls.encoderPressAlt;
  if (controls.encoderPress >= 0 && controls.encoderPress != 0) return 0;
  return -1;
}

void setupLightweaverControls(const ControlsConfig& controls, ControlState& state) {
  int altPress = effectiveEncoderPressAltPin(controls);
  if (validPin(controls.statusLed)) pinMode(controls.statusLed, OUTPUT);
  if (validPin(controls.encoderA)) pinMode(controls.encoderA, INPUT_PULLUP);
  if (validPin(controls.encoderB)) pinMode(controls.encoderB, INPUT_PULLUP);
  if (validPin(controls.encoderPress)) pinMode(controls.encoderPress, INPUT_PULLUP);
  if (validPin(altPress)) pinMode(altPress, INPUT_PULLUP);
  if (validPin(controls.previous)) pinMode(controls.previous, INPUT_PULLUP);
  if (validPin(controls.next)) pinMode(controls.next, INPUT_PULLUP);
  if (validPin(controls.blackout)) pinMode(controls.blackout, INPUT_PULLUP);
  state.encoderLastState = readEncoderState(controls);
  uint32_t now = millis();
  state.prevRawDown = state.prevDown = readPressed(controls.previous);
  state.nextRawDown = state.nextDown = readPressed(controls.next);
  state.pressRawDown = state.pressDown = readPressed(controls.encoderPress);
  state.pressAltRawDown = state.pressAltDown = readPressed(altPress);
  state.blackoutRawDown = state.blackoutDown = readPressed(controls.blackout);
  state.prevChangedAt = now;
  state.nextChangedAt = now;
  state.pressChangedAt = now;
  state.pressAltChangedAt = now;
  state.blackoutChangedAt = now;
#ifndef LIGHTWEAVER_CONTROL_TEST
  setupEncoderInterrupts(controls, state);
#endif
}

ControlEventType pollLightweaverControls(const ControlsConfig& controls, ControlState& state) {
  int altPress = effectiveEncoderPressAltPin(controls);

#ifndef LIGHTWEAVER_CONTROL_TEST
  ControlEventType interruptEvent = consumeEncoderDelta(controls, state, takeEncoderInterruptDelta());
  if (interruptEvent != CONTROL_NONE) return interruptEvent;
#endif

  if (buttonPressed(controls.next, state.nextDown, state.nextRawDown, state.nextChangedAt, state.lastNextAt) ||
      buttonPressed(controls.encoderPress, state.pressDown, state.pressRawDown, state.pressChangedAt, state.lastPressAt) ||
      buttonPressed(altPress, state.pressAltDown, state.pressAltRawDown, state.pressAltChangedAt, state.lastPressAltAt)) {
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
      return consumeEncoderDelta(controls, state, delta);
    }
  }

  return CONTROL_NONE;
}

float applyRotaryBrightness(float currentBrightness, ControlEventType event, uint8_t step) {
  uint8_t visibleStep = step < MIN_VISIBLE_BRIGHTNESS_STEP ? MIN_VISIBLE_BRIGHTNESS_STEP : step;
  float amount = float(visibleStep) / 255.0f;
  if (event == CONTROL_DIMMER) return max(0.02f, currentBrightness - amount);
  if (event == CONTROL_BRIGHTER) return min(1.0f, currentBrightness + amount);
  return currentBrightness;
}
