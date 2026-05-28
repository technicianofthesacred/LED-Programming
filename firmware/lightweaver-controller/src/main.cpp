#include <Arduino.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <SD.h>
#include <SPI.h>

#include "LightweaverTypes.h"
#include "LightweaverStorage.h"
#include "LightweaverPatterns.h"
#include "LightweaverControls.h"
#include "LightweaverWeb.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverArtnet.h"
#if __has_include("LightweaverFrameSource.h")
  #include "LightweaverFrameSource.h"
#endif
#include <Preferences.h>

#ifndef LW_SD_CS
#define LW_SD_CS 10
#endif

#ifndef LW_SPI_MOSI
#define LW_SPI_MOSI 11
#endif

#ifndef LW_SPI_SCK
#define LW_SPI_SCK 12
#endif

#ifndef LW_SPI_MISO
#define LW_SPI_MISO 13
#endif

CRGB leds[LW_MAX_PIXELS];
uint8_t frameBuffer[LW_MAX_PIXELS * 3];

constexpr uint8_t MIRROR_OUTPUT_PINS[] = {16, 17, 18, 21, 38, 39, 40, 48};
constexpr uint8_t MIRROR_OUTPUT_PIN_COUNT = sizeof(MIRROR_OUTPUT_PINS) / sizeof(MIRROR_OUTPUT_PINS[0]);

OutputConfig outputs[LW_MAX_OUTPUTS];
ControlsConfig controls;
LookConfig looks[LW_MAX_LOOKS];

RuntimeConfig runtimeConfig;

String pieceName = "Lightweaver";
String runtimeMode = "sequence";
String startupLookId;
String ledColorOrder = "GRB";

uint8_t outputCount = 0;
uint8_t lookCount = 0;
uint16_t totalPixels = 0;
float brightnessLimit = 0.45f;
float fadeScale = 1.0f;

uint8_t currentLookIndex = 0;
bool blackedOut = false;
ErrorCode errorCode = ERROR_NONE;

File sequenceFile;
bool sequenceOpen = false;
uint32_t sequenceFrameCount = 0;
uint32_t sequenceFrameIndex = 0;
uint32_t sequenceFrameBytes = 0;
uint16_t sequenceFps = 24;
uint32_t nextSequenceFrameAt = 0;

ControlState controlState;
float manualBrightness = 1.0f;
float manualSpeed = 1.0f;
int16_t manualHueShift = 0;
bool identifyActive = false;
uint32_t identifyStartedAt = 0;

// Custom-color (Color tile) state
uint8_t customHue = 32;          // 0..255 (FastLED hue space)
uint8_t customSaturation = 230;  // 0..255
bool customBreathe = false;
bool customDrift = false;
uint8_t driftHueMin = 0;
uint8_t driftHueMax = 255;

void applyRuntimeConfig(const RuntimeConfig& config);
bool loadProfile();
bool setupLedOutputs();
bool addLedsForPin(uint8_t pin, CRGB* start, uint16_t count);
void handleControlEvent(ControlEventType event);
void selectLook(int index);
bool startLook(uint8_t index);
void closeSequence();
bool openSequence(const String& path);
bool renderCurrentLook();
bool renderSequenceFrame(bool force = false);
bool renderProceduralFrame(const String& preset);
bool renderPresetFrame(const String& preset);
CRGB colorForPreset(const String& preset);
void fadeTo(float target, uint16_t durationMs);
uint8_t computeBrightnessByte();
float readBrightnessKnob();
uint8_t findStartupLook();
void fail(ErrorCode code, const char* message);
void blinkError();
uint16_t readLe16(const uint8_t* bytes);
uint32_t readLe32(const uint8_t* bytes);
uint16_t clampPixels(int value);
float clampUnit(float value);

template<uint8_t DATA_PIN>
bool addLedsForOrder(CRGB* start, uint16_t count) {
  if (ledColorOrder == "RGB") {
    FastLED.addLeds<WS2812B, DATA_PIN, RGB>(start, count);
  } else if (ledColorOrder == "BRG") {
    FastLED.addLeds<WS2812B, DATA_PIN, BRG>(start, count);
  } else {
    FastLED.addLeds<WS2812B, DATA_PIN, GRB>(start, count);
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  uint32_t serialWaitStart = millis();
  while (!Serial && millis() - serialWaitStart < 2000) {
    delay(10);
  }
  delay(200);
  pinMode(DEFAULT_STATUS_LED_PIN, OUTPUT);
  digitalWrite(DEFAULT_STATUS_LED_PIN, LOW);

  Serial.println();
  Serial.println("Lightweaver standalone controller booting");
  SPI.begin(LW_SPI_SCK, LW_SPI_MISO, LW_SPI_MOSI, LW_SD_CS);
  RuntimeLoadResult loadResult = loadRuntimeConfig(runtimeConfig);
  Serial.print("Runtime source: ");
  Serial.print(loadResult.source == SOURCE_SD ? "sd" : loadResult.source == SOURCE_NVS ? "internal-flash" : "defaults");
  Serial.print(" / ");
  Serial.println(loadResult.message);
  if (!loadResult.ok) {
    fail(ERROR_CONFIG, loadResult.message.c_str());
    return;
  }
  applyRuntimeConfig(runtimeConfig);
  setupLightweaverControls(controls, controlState);
  setupLightweaverWeb(runtimeConfig, errorCode, totalPixels, currentLookIndex);

  if (!setupLedOutputs()) return;
  currentLookIndex = findStartupLook();
  fadeScale = 0.0f;

  if (!startLook(currentLookIndex)) return;
  fadeTo(1.0f, looks[currentLookIndex].fadeInMs);

  setupArtnet(leds, totalPixels);

  Serial.print("Ready: ");
  Serial.print(pieceName);
  Serial.print(" / ");
  Serial.print(totalPixels);
  Serial.println(" pixels");
}

void loop() {
  handleArtnet();
  handleLightweaverWeb();

  if (errorCode != ERROR_NONE) {
    FastLED.clear(true);
    blinkError();
    delay(5);
    return;
  }

  handleControlEvent(pollLightweaverControls(controls, controlState));

  if (identifyActive) {
    uint32_t elapsed = millis() - identifyStartedAt;
    uint32_t cycle = elapsed % 300;
    if (elapsed > 1500) {
      identifyActive = false;
    } else {
      fill_solid(leds, totalPixels, cycle < 150 ? CRGB::White : CRGB::Black);
      FastLED.setBrightness(220);
      FastLED.show();
      delay(10);
      return;
    }
  }

  // Recovery indicator: when the card has saved WiFi but couldn't join,
  // it's now broadcasting Lightweaver-XXXX waiting for someone to fix it.
  // Pulse the strip in warm white so a homeowner can see "something's up"
  // without having to think about networks. Skipped on truly fresh cards
  // (no WiFi configured yet) because those are following first-boot setup.
  if (runtimeConfig.activeTransport == WIFI_TRANSPORT_AP &&
      runtimeConfig.wifi.ssid.length() > 0) {
    uint8_t pulse = beatsin8(8, 30, 200); // 8 BPM gentle pulse
    fill_solid(leds, totalPixels, CHSV(28, 180, pulse));
    FastLED.setBrightness(uint8_t(clampUnit(brightnessLimit) * 255.0f));
    FastLED.show();
    delay(20);
    return;
  }

  if (blackedOut) {
    delay(10);
    return;
  }

  if (renderCurrentLook()) {
    FastLED.setBrightness(computeBrightnessByte());
    FastLED.show();
  } else {
    delay(1);
  }
}

void applyRuntimeConfig(const RuntimeConfig& config) {
  pieceName = config.pieceName;
  runtimeMode = config.mode;
  startupLookId = config.startupLookId;
  ledColorOrder = config.ledColorOrder;
  brightnessLimit = config.brightnessLimit;
  outputCount = config.outputCount;
  totalPixels = 0;
  for (uint8_t i = 0; i < outputCount; i++) {
    outputs[i] = config.outputs[i];
    outputs[i].start = totalPixels;
    totalPixels += outputs[i].pixels;
  }
  controls = config.controls;
  lookCount = config.lookCount;
  for (uint8_t i = 0; i < lookCount; i++) {
    looks[i] = config.looks[i];
  }
}

bool loadProfile() {
  File profileFile = SD.open("/lightweaver.json", FILE_READ);
  if (!profileFile) {
    fail(ERROR_PROFILE, "missing /lightweaver.json");
    return false;
  }

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, profileFile);
  profileFile.close();
  if (error) {
    fail(ERROR_PROFILE, error.c_str());
    return false;
  }

  pieceName = String(doc["piece"]["name"] | "Lightweaver");
  runtimeMode = String(doc["runtimeMode"] | "sequence");
  startupLookId = String(doc["startupLook"] | "");

  JsonObject led = doc["led"].as<JsonObject>();
  if (!led.isNull()) {
    ledColorOrder = String(led["colorOrder"] | "GRB");
    brightnessLimit = clampUnit(led["brightnessLimit"] | 0.45f);
  }

  JsonObject controlsJson = doc["controls"].as<JsonObject>();
  if (!controlsJson.isNull()) {
    JsonObject encoder = controlsJson["encoder"].as<JsonObject>();
    if (!encoder.isNull()) {
      controls.encoderA = encoder["a"] | controls.encoderA;
      controls.encoderB = encoder["b"] | controls.encoderB;
      controls.encoderPress = encoder["press"] | controls.encoderPress;
    }
    controls.previous = controlsJson["previous"] | controls.previous;
    controls.next = controlsJson["next"] | controls.next;
    controls.blackout = controlsJson["blackout"] | controls.blackout;
    controls.brightness = controlsJson["brightness"] | controls.brightness;
    controls.statusLed = controlsJson["statusLed"] | controls.statusLed;
  }

  JsonArray outputArray = doc["outputs"].as<JsonArray>();
  for (JsonVariant outputValue : outputArray) {
    if (outputCount >= LW_MAX_OUTPUTS) break;
    JsonObject output = outputValue.as<JsonObject>();
    int pixels = output["pixels"] | 0;
    if (pixels <= 0) continue;

    OutputConfig& config = outputs[outputCount];
    config.id = String(output["id"] | "");
    config.name = String(output["name"] | config.id.c_str());
    config.pin = output["pin"] | 0;
    config.pixels = clampPixels(pixels);
    config.start = totalPixels;
    config.enabled = true;
    totalPixels += config.pixels;
    outputCount++;
  }

  if (outputCount == 0 || totalPixels == 0 || totalPixels > LW_MAX_PIXELS) {
    fail(ERROR_PIXELS, "profile pixel count is empty or too large");
    return false;
  }

  JsonArray lookArray = doc["looks"].as<JsonArray>();
  for (JsonVariant lookValue : lookArray) {
    if (lookCount >= LW_MAX_LOOKS) break;
    JsonObject lookJson = lookValue.as<JsonObject>();
    LookConfig& look = looks[lookCount];
    look.id = String(lookJson["id"] | "look");
    look.label = String(lookJson["label"] | look.id.c_str());
    look.mode = String(lookJson["mode"] | runtimeMode.c_str());
    look.file = String(lookJson["file"] | "");
    look.preset = String(lookJson["preset"] | look.id.c_str());
    look.fps = lookJson["fps"] | 24;
    look.loop = lookJson["loop"] | true;
    look.fadeOutMs = lookJson["fadeOutMs"] | 800;
    look.fadeInMs = lookJson["fadeInMs"] | 1200;
    look.brightness = clampUnit(lookJson["brightness"] | 0.35f);
    lookCount++;
  }

  if (lookCount == 0) {
    LookConfig& look = looks[0];
    look.id = runtimeMode == "preset" ? "warm-white" : "aurora";
    look.label = look.id;
    look.mode = runtimeMode == "sequence" ? "preset" : runtimeMode;
    look.preset = look.id;
    lookCount = 1;
  }

  return true;
}

bool setupLedOutputs() {
  FastLED.setDither(false);
  FastLED.setCorrection(TypicalLEDStrip);
  uint8_t addedPins[LW_MAX_OUTPUTS + MIRROR_OUTPUT_PIN_COUNT] = {};
  uint8_t addedPinCount = 0;
  auto wasAdded = [&](uint8_t pin) {
    for (uint8_t j = 0; j < addedPinCount; j++) {
      if (addedPins[j] == pin) return true;
    }
    return false;
  };
  auto markAdded = [&](uint8_t pin) {
    if (addedPinCount < sizeof(addedPins)) addedPins[addedPinCount++] = pin;
  };

  for (uint8_t i = 0; i < outputCount; i++) {
    OutputConfig& output = outputs[i];
    if (!addLedsForPin(output.pin, leds + output.start, output.pixels)) {
      Serial.print("Unsupported LED output pin: ");
      Serial.println(output.pin);
      fail(ERROR_PIN, "unsupported LED output pin");
      return false;
    }
    markAdded(output.pin);
    Serial.print("LED output ");
    Serial.print(output.id);
    Serial.print(" -> GPIO ");
    Serial.print(output.pin);
    Serial.print(" / ");
    Serial.print(output.pixels);
    Serial.println(" px");
  }

  if (outputCount == 1) {
    OutputConfig& output = outputs[0];
    for (uint8_t i = 0; i < MIRROR_OUTPUT_PIN_COUNT; i++) {
      uint8_t pin = MIRROR_OUTPUT_PINS[i];
      if (wasAdded(pin)) continue;
      if (!addLedsForPin(pin, leds + output.start, output.pixels)) continue;
      markAdded(pin);
      Serial.print("Mirroring LED frame on GPIO ");
      Serial.println(pin);
    }
  }

  FastLED.setBrightness(0);
  FastLED.clear(true);
  return true;
}

bool addLedsForPin(uint8_t pin, CRGB* start, uint16_t count) {
  switch (pin) {
    case 16:
      return addLedsForOrder<16>(start, count);
    case 17:
      return addLedsForOrder<17>(start, count);
    case 18:
      return addLedsForOrder<18>(start, count);
    case 21:
      return addLedsForOrder<21>(start, count);
    case 38:
      return addLedsForOrder<38>(start, count);
    case 39:
      return addLedsForOrder<39>(start, count);
    case 40:
      return addLedsForOrder<40>(start, count);
    case 48:
      return addLedsForOrder<48>(start, count);
    default:
      return false;
  }
}

void handleControlEvent(ControlEventType event) {
  if (event == CONTROL_NEXT_LOOK) {
    selectLook(currentLookIndex + 1);
  } else if (event == CONTROL_PREVIOUS_LOOK) {
    selectLook(currentLookIndex == 0 ? lookCount - 1 : currentLookIndex - 1);
  } else if (event == CONTROL_BLACKOUT) {
    if (blackedOut) {
      blackedOut = false;
      fadeTo(1.0f, looks[currentLookIndex].fadeInMs);
    } else {
      fadeTo(0.0f, looks[currentLookIndex].fadeOutMs);
      FastLED.clear(true);
      blackedOut = true;
    }
  } else if (event == CONTROL_BRIGHTER || event == CONTROL_DIMMER) {
    manualBrightness = applyRotaryBrightness(manualBrightness, event, controls.brightnessStep);
  }
}

void selectLook(int index) {
  if (lookCount == 0) return;
  uint8_t nextIndex = ((index % lookCount) + lookCount) % lookCount;
  if (nextIndex == currentLookIndex && !blackedOut) return;

  fadeTo(0.0f, looks[currentLookIndex].fadeOutMs);
  closeSequence();
  currentLookIndex = nextIndex;
  blackedOut = false;
  if (!startLook(currentLookIndex)) return;
  fadeTo(1.0f, looks[currentLookIndex].fadeInMs);
}

bool startLook(uint8_t index) {
  LookConfig& look = looks[index];
  Serial.print("Starting look: ");
  Serial.print(look.label);
  Serial.print(" (");
  Serial.print(look.mode);
  Serial.println(")");

  if (look.mode == "sequence") {
    if (!openSequence(look.file)) {
      fail(ERROR_SEQUENCE, "sequence open failed");
      return false;
    }
    return renderSequenceFrame(true);
  }

  if (look.mode == "procedural") {
    return renderProceduralFrame(look.preset);
  }

  return renderPresetFrame(look.preset);
}

void closeSequence() {
  if (sequenceOpen) {
    sequenceFile.close();
    sequenceOpen = false;
  }
}

bool openSequence(const String& path) {
  if (path.length() == 0) return false;

  sequenceFile = SD.open(path.c_str(), FILE_READ);
  if (!sequenceFile) {
    Serial.print("Missing sequence file: ");
    Serial.println(path);
    return false;
  }

  uint8_t header[LWSEQ_HEADER_BYTES];
  if (sequenceFile.read(header, LWSEQ_HEADER_BYTES) != LWSEQ_HEADER_BYTES) {
    sequenceFile.close();
    return false;
  }

  if (memcmp(header, "LWSEQ1", 6) != 0) {
    sequenceFile.close();
    return false;
  }

  uint16_t version = readLe16(header + 8);
  uint16_t channels = readLe16(header + 22);
  uint32_t pixelCount = readLe32(header + 12);
  sequenceFrameCount = readLe32(header + 16);
  sequenceFps = readLe16(header + 20);
  sequenceFrameBytes = pixelCount * channels;

  if (version != 1 || channels != 3 || pixelCount != totalPixels ||
      sequenceFrameBytes > sizeof(frameBuffer) || sequenceFrameCount == 0 || sequenceFps == 0) {
    sequenceFile.close();
    return false;
  }

  sequenceOpen = true;
  sequenceFrameIndex = 0;
  nextSequenceFrameAt = 0;
  return true;
}

// Find a look by id in the loaded bank. Falls back to the current index.
const LookConfig* findLookById(const String& id) {
  if (id.length() == 0) return lookCount ? &looks[currentLookIndex] : nullptr;
  for (uint8_t i = 0; i < lookCount; i++) {
    if (looks[i].id == id) return &looks[i];
  }
  return lookCount ? &looks[currentLookIndex] : nullptr;
}

bool renderZone(const ZoneConfig& zone, uint32_t now) {
  if (zone.rangeCount == 0) return false;
  const LookConfig* look = findLookById(zone.patternId);
  if (!look) return false;

  // First range only for now — multi-range support is a follow-up.
  const PixelRange& range = zone.ranges[0];
  if (range.count == 0) return false;
  if (range.start + range.count > totalPixels) return false;

  CRGB* zoneLeds = leds + range.start;
  uint16_t zonePixels = range.count;

  if (zone.blackout) {
    fill_solid(zoneLeds, zonePixels, CRGB::Black);
    return true;
  }

  PatternModifiers mods;
  mods.speed = zone.speed;
  mods.hueShift = zone.hueShift;
  mods.customHue = zone.customHue;
  mods.customSaturation = zone.customSaturation;
  mods.customBreathe = zone.customBreathe;
  mods.customDrift = zone.customDrift;
  mods.driftHueMin = zone.driftHueMin;
  mods.driftHueMax = zone.driftHueMax;

  bool rendered = false;
  if (look->mode == "procedural") {
    rendered = renderProceduralPattern(look->preset, zoneLeds, zonePixels, now, mods);
  } else if (look->mode == "preset") {
    rendered = renderPresetPattern(look->preset, zoneLeds, zonePixels, mods);
  }
  if (!rendered) return false;

  // Per-zone brightness scaling. The global FastLED.setBrightness() still
  // applies on top of this — it represents the legacy "master" knob plus
  // the brightnessLimit safety ceiling — so per-zone brightness multiplies
  // into the final value.
  uint8_t scale = uint8_t(constrain(int(zone.brightness * 255.0f), 0, 255));
  if (scale < 255) {
    for (uint16_t i = 0; i < zonePixels; i++) zoneLeds[i].nscale8(scale);
  }
  return true;
}

bool renderCurrentLook() {
  // Legacy sequence path: only when zone 0 holds the entire strip and the
  // selected look is a frame sequence. Sequences predate zones; they take
  // over the whole canvas.
  if (lookCount && looks[currentLookIndex].mode == "sequence") {
    return renderSequenceFrame();
  }

  static uint32_t nextProceduralAt = 0;
  uint32_t now = millis();
  if (now < nextProceduralAt) return false;
  nextProceduralAt = now + (1000 / DEFAULT_RENDER_FPS);

  if (runtimeConfig.zoneCount == 0) return false;

  bool anyRendered = false;
  for (uint8_t i = 0; i < runtimeConfig.zoneCount; i++) {
    if (renderZone(runtimeConfig.zones[i], now)) anyRendered = true;
  }
  return anyRendered;
}

bool renderSequenceFrame(bool force) {
  if (!sequenceOpen) return false;

  uint32_t now = millis();
  if (!force && now < nextSequenceFrameAt) return false;

  if (sequenceFrameIndex >= sequenceFrameCount) {
    if (!looks[currentLookIndex].loop) return false;
    sequenceFile.seek(LWSEQ_HEADER_BYTES);
    sequenceFrameIndex = 0;
  }

  if (sequenceFile.read(frameBuffer, sequenceFrameBytes) != sequenceFrameBytes) {
    if (!looks[currentLookIndex].loop) return false;
    sequenceFile.seek(LWSEQ_HEADER_BYTES);
    sequenceFrameIndex = 0;
    if (sequenceFile.read(frameBuffer, sequenceFrameBytes) != sequenceFrameBytes) {
      fail(ERROR_SEQUENCE, "sequence read failed");
      return false;
    }
  }

  uint32_t cursor = 0;
  for (uint16_t i = 0; i < totalPixels; i++) {
    leds[i].r = frameBuffer[cursor++];
    leds[i].g = frameBuffer[cursor++];
    leds[i].b = frameBuffer[cursor++];
  }

  sequenceFrameIndex++;
  nextSequenceFrameAt = now + (1000 / sequenceFps);
  return true;
}

bool renderProceduralFrame(const String& preset) {
  PatternModifiers mods;
  mods.speed = manualSpeed;
  mods.hueShift = manualHueShift;
  mods.customHue = customHue;
  mods.customSaturation = customSaturation;
  mods.customBreathe = customBreathe;
  mods.customDrift = customDrift;
  mods.driftHueMin = driftHueMin;
  mods.driftHueMax = driftHueMax;
  return renderProceduralPattern(preset, leds, totalPixels, millis(), mods);
}

bool renderPresetFrame(const String& preset) {
  PatternModifiers mods;
  mods.speed = manualSpeed;
  mods.hueShift = manualHueShift;
  mods.customHue = customHue;
  mods.customSaturation = customSaturation;
  mods.customBreathe = customBreathe;
  mods.customDrift = customDrift;
  return renderPresetPattern(preset, leds, totalPixels, mods);
}

CRGB colorForPreset(const String& preset) {
  if (preset == "blackout" || preset == "off") return CRGB::Black;
  if (preset == "test-red" || preset == "red") return CRGB::Red;
  if (preset == "test-green" || preset == "green") return CRGB::Green;
  if (preset == "test-blue" || preset == "blue") return CRGB::Blue;
  if (preset == "cool-white") return CRGB(190, 210, 255);
  if (preset == "photo-white") return CRGB(255, 238, 210);
  return CRGB(255, 170, 92);
}

void fadeTo(float target, uint16_t durationMs) {
  float start = fadeScale;
  uint32_t startMs = millis();
  if (durationMs == 0) {
    fadeScale = target;
    FastLED.setBrightness(computeBrightnessByte());
    FastLED.show();
    return;
  }

  while (millis() - startMs < durationMs) {
    float t = float(millis() - startMs) / float(durationMs);
    fadeScale = start + ((target - start) * t);
    FastLED.setBrightness(computeBrightnessByte());
    FastLED.show();
    delay(16);
  }

  fadeScale = target;
  FastLED.setBrightness(computeBrightnessByte());
  FastLED.show();
}

uint8_t computeBrightnessByte() {
  if (blackedOut) return 0;
  float lookBrightness = lookCount ? looks[currentLookIndex].brightness : 0.35f;
  float brightness = clampUnit(brightnessLimit) * clampUnit(lookBrightness) * clampUnit(fadeScale) * readBrightnessKnob() * clampUnit(manualBrightness);
  return uint8_t(roundf(clampUnit(brightness) * 255.0f));
}

float readBrightnessKnob() {
  if (controls.brightness < 0) return 1.0f;
  int raw = analogRead(controls.brightness);
  return clampUnit(float(raw) / 4095.0f);
}

uint8_t findStartupLook() {
  if (startupLookId.length() == 0) return 0;
  for (uint8_t i = 0; i < lookCount; i++) {
    if (looks[i].id == startupLookId) return i;
  }
  return 0;
}

void fail(ErrorCode code, const char* message) {
  errorCode = code;
  Serial.print("ERROR ");
  Serial.print(uint8_t(code));
  Serial.print(": ");
  Serial.println(message);
}

void blinkError() {
  uint8_t pin = controls.statusLed > 0 ? controls.statusLed : DEFAULT_STATUS_LED_PIN;
  pinMode(pin, OUTPUT);
  uint32_t phase = millis() % (1200 + (uint32_t(errorCode) * 260));
  bool on = phase < uint32_t(errorCode) * 260 && (phase % 260) < 100;
  digitalWrite(pin, on ? HIGH : LOW);
}

uint16_t readLe16(const uint8_t* bytes) {
  return uint16_t(bytes[0]) | (uint16_t(bytes[1]) << 8);
}

uint32_t readLe32(const uint8_t* bytes) {
  return uint32_t(bytes[0]) |
         (uint32_t(bytes[1]) << 8) |
         (uint32_t(bytes[2]) << 16) |
         (uint32_t(bytes[3]) << 24);
}

uint16_t clampPixels(int value) {
  if (value <= 0) return 0;
  if (value > LW_MAX_PIXELS) return LW_MAX_PIXELS;
  return uint16_t(value);
}

float clampUnit(float value) {
  if (isnan(value)) return 0.0f;
  if (value < 0.0f) return 0.0f;
  if (value > 1.0f) return 1.0f;
  return value;
}

// ---- Runtime control API (called by LightweaverWeb endpoints) ----

// Apply a closure to one zone (when targetId matches) or all zones (when
// targetId is empty AND syncZones is true, OR when there's only one zone).
// Returns the number of zones actually touched.
template <typename Fn>
uint8_t applyToZones(const String& targetId, Fn fn) {
  uint8_t touched = 0;
  if (targetId.length() > 0) {
    for (uint8_t i = 0; i < runtimeConfig.zoneCount; i++) {
      if (runtimeConfig.zones[i].id == targetId) {
        fn(runtimeConfig.zones[i]);
        touched++;
        break;
      }
    }
    return touched;
  }
  // No target: when sync is on, broadcast. When sync is off, only zone 0.
  if (runtimeConfig.syncZones || runtimeConfig.zoneCount == 1) {
    for (uint8_t i = 0; i < runtimeConfig.zoneCount; i++) {
      fn(runtimeConfig.zones[i]);
      touched++;
    }
  } else if (runtimeConfig.zoneCount > 0) {
    fn(runtimeConfig.zones[0]);
    touched = 1;
  }
  return touched;
}

void runtimeSetBrightness(float value01) {
  if (value01 < 0.02f) value01 = 0.02f;
  if (value01 > 1.0f) value01 = 1.0f;
  manualBrightness = value01;
  applyToZones("", [&](ZoneConfig& z) { z.brightness = value01; });
}

void runtimeSetSpeed(float speed) {
  if (speed < 0.05f) speed = 0.05f;
  if (speed > 3.0f) speed = 3.0f;
  manualSpeed = speed;
  applyToZones("", [&](ZoneConfig& z) { z.speed = speed; });
}

void runtimeSetHueShift(int16_t shift) {
  if (shift < -128) shift = -128;
  if (shift > 128) shift = 128;
  manualHueShift = shift;
  applyToZones("", [&](ZoneConfig& z) { z.hueShift = shift; });
}

void runtimeSetBlackout(bool on) {
  if (on == blackedOut) {
    applyToZones("", [&](ZoneConfig& z) { z.blackout = on; });
    return;
  }
  if (on) {
    fadeTo(0.0f, looks[currentLookIndex].fadeOutMs);
    FastLED.clear(true);
    blackedOut = true;
  } else {
    blackedOut = false;
    fadeTo(1.0f, looks[currentLookIndex].fadeInMs);
  }
  applyToZones("", [&](ZoneConfig& z) { z.blackout = on; });
}

// Zone-targeted variants. Empty targetId broadcasts under sync rules.
void runtimeSetBrightnessZ(const String& targetId, float value01) {
  if (value01 < 0.02f) value01 = 0.02f;
  if (value01 > 1.0f) value01 = 1.0f;
  if (targetId.length() == 0) manualBrightness = value01;
  applyToZones(targetId, [&](ZoneConfig& z) { z.brightness = value01; });
}

void runtimeSetSpeedZ(const String& targetId, float speed) {
  if (speed < 0.05f) speed = 0.05f;
  if (speed > 3.0f) speed = 3.0f;
  if (targetId.length() == 0) manualSpeed = speed;
  applyToZones(targetId, [&](ZoneConfig& z) { z.speed = speed; });
}

void runtimeSetHueShiftZ(const String& targetId, int16_t shift) {
  if (shift < -128) shift = -128;
  if (shift > 128) shift = 128;
  if (targetId.length() == 0) manualHueShift = shift;
  applyToZones(targetId, [&](ZoneConfig& z) { z.hueShift = shift; });
}

void runtimeSetBlackoutZ(const String& targetId, bool on) {
  if (targetId.length() == 0) {
    runtimeSetBlackout(on);
    return;
  }
  applyToZones(targetId, [&](ZoneConfig& z) { z.blackout = on; });
}

void runtimeNextPattern() {
  selectLook(currentLookIndex + 1);
}

void runtimePreviousPattern() {
  selectLook(currentLookIndex == 0 ? lookCount - 1 : currentLookIndex - 1);
}

bool runtimeSelectPatternById(const String& id) {
  for (uint8_t i = 0; i < lookCount; i++) {
    if (looks[i].id == id) {
      selectLook(i);
      applyToZones("", [&](ZoneConfig& z) { z.patternId = id; });
      return true;
    }
  }
  return false;
}

// Zone-targeted pattern selection. Used by the per-zone designer flow.
bool runtimeSelectPatternByIdZ(const String& targetId, const String& patternId) {
  if (targetId.length() == 0) return runtimeSelectPatternById(patternId);
  // Verify the pattern exists in the bank
  bool exists = false;
  for (uint8_t i = 0; i < lookCount; i++) if (looks[i].id == patternId) { exists = true; break; }
  if (!exists) return false;
  uint8_t touched = applyToZones(targetId, [&](ZoneConfig& z) { z.patternId = patternId; });
  return touched > 0;
}

void runtimeTriggerIdentify() {
  identifyActive = true;
  identifyStartedAt = millis();
}

float runtimeGetBrightness() { return manualBrightness; }
float runtimeGetSpeed() { return manualSpeed; }
int16_t runtimeGetHueShift() { return manualHueShift; }
bool runtimeIsBlackedOut() { return blackedOut; }

String runtimeFirmwareInfo() {
  JsonDocument doc;
  doc["build"] = __DATE__ " " __TIME__;
  doc["pixels"] = totalPixels;
  doc["lookCount"] = lookCount;
  doc["uptimeMs"] = millis();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["rssi"] = WiFi.RSSI();
  JsonArray outputArray = doc["outputs"].to<JsonArray>();
  for (uint8_t i = 0; i < outputCount; i++) {
    JsonObject output = outputArray.add<JsonObject>();
    output["id"] = outputs[i].id;
    output["pin"] = outputs[i].pin;
    output["pixels"] = outputs[i].pixels;
  }
  JsonArray mirrors = doc["mirrorPins"].to<JsonArray>();
  if (outputCount == 1) {
    for (uint8_t i = 0; i < MIRROR_OUTPUT_PIN_COUNT; i++) mirrors.add(MIRROR_OUTPUT_PINS[i]);
  }
  String out;
  serializeJson(doc, out);
  return out;
}

void runtimeFactoryReset() {
  Preferences prefs;
  if (prefs.begin("lightweaver", false)) {
    prefs.clear();
    prefs.end();
  }
  delay(200);
  ESP.restart();
}

// Wipe only the WiFi key. Keeps piece name, hostname, and pattern config.
// Card reboots into AP mode for re-pairing.
void runtimeResetWifi() {
  Preferences prefs;
  if (prefs.begin("lightweaver", false)) {
    prefs.remove("wifi");
    prefs.end();
  }
  delay(200);
  ESP.restart();
}

bool runtimeRename(const String& newPieceName, const String& newHostname, String& message) {
  Preferences prefs;
  if (!prefs.begin("lightweaver", false)) {
    message = "nvs unavailable";
    return false;
  }
  if (newPieceName.length()) {
    runtimeConfig.pieceName = newPieceName;
    pieceName = newPieceName;
    prefs.putString("pieceName", newPieceName);
  }
  if (newHostname.length()) {
    runtimeConfig.wifi.hostname = newHostname;
    // Persist via the wifi JSON path so it sticks across reboots
    JsonDocument doc;
    doc["ssid"] = runtimeConfig.wifi.ssid;
    doc["password"] = runtimeConfig.wifi.password;
    doc["hostname"] = newHostname;
    String serialized;
    serializeJson(doc, serialized);
    prefs.putString("wifi", serialized);
  }
  prefs.end();
  message = "saved";
  return true;
}

void runtimeSetCustomHue(uint8_t hue) {
  customHue = hue;
  applyToZones("", [&](ZoneConfig& z) { z.customHue = hue; });
}
void runtimeSetCustomSaturation(uint8_t sat) {
  customSaturation = sat;
  applyToZones("", [&](ZoneConfig& z) { z.customSaturation = sat; });
}
void runtimeSetCustomBreathe(bool on) {
  customBreathe = on;
  applyToZones("", [&](ZoneConfig& z) { z.customBreathe = on; });
}
void runtimeSetCustomDrift(bool on) {
  customDrift = on;
  applyToZones("", [&](ZoneConfig& z) { z.customDrift = on; });
}
void runtimeSetCustomHueZ(const String& targetId, uint8_t hue) {
  if (targetId.length() == 0) customHue = hue;
  applyToZones(targetId, [&](ZoneConfig& z) { z.customHue = hue; });
}
void runtimeSetCustomSaturationZ(const String& targetId, uint8_t sat) {
  if (targetId.length() == 0) customSaturation = sat;
  applyToZones(targetId, [&](ZoneConfig& z) { z.customSaturation = sat; });
}
void runtimeSetCustomBreatheZ(const String& targetId, bool on) {
  if (targetId.length() == 0) customBreathe = on;
  applyToZones(targetId, [&](ZoneConfig& z) { z.customBreathe = on; });
}
void runtimeSetCustomDriftZ(const String& targetId, bool on) {
  if (targetId.length() == 0) customDrift = on;
  applyToZones(targetId, [&](ZoneConfig& z) { z.customDrift = on; });
}
uint8_t runtimeGetCustomHue() { return customHue; }
uint8_t runtimeGetCustomSaturation() { return customSaturation; }
bool runtimeGetCustomBreathe() { return customBreathe; }
bool runtimeGetCustomDrift() { return customDrift; }

void runtimeSetSyncZones(bool on) { runtimeConfig.syncZones = on; }
bool runtimeGetSyncZones() { return runtimeConfig.syncZones; }

void runtimeSetDriftRange(uint8_t lo, uint8_t hi) {
  driftHueMin = lo;
  driftHueMax = hi;
  applyToZones("", [&](ZoneConfig& z) { z.driftHueMin = lo; z.driftHueMax = hi; });
}
void runtimeSetDriftRangeZ(const String& targetId, uint8_t lo, uint8_t hi) {
  if (targetId.length() == 0) { driftHueMin = lo; driftHueMax = hi; }
  applyToZones(targetId, [&](ZoneConfig& z) { z.driftHueMin = lo; z.driftHueMax = hi; });
}
uint8_t runtimeGetDriftHueMin() { return driftHueMin; }
uint8_t runtimeGetDriftHueMax() { return driftHueMax; }

String runtimeZonesJson() {
  JsonDocument doc;
  doc["syncZones"] = runtimeConfig.syncZones;
  JsonArray arr = doc["zones"].to<JsonArray>();
  for (uint8_t i = 0; i < runtimeConfig.zoneCount; i++) {
    const ZoneConfig& z = runtimeConfig.zones[i];
    JsonObject obj = arr.add<JsonObject>();
    obj["id"] = z.id;
    obj["label"] = z.label;
    obj["patternId"] = z.patternId;
    obj["brightness"] = z.brightness;
    obj["speed"] = z.speed;
    obj["hueShift"] = z.hueShift;
    obj["customHue"] = z.customHue;
    obj["customSaturation"] = z.customSaturation;
    obj["customBreathe"] = z.customBreathe;
    obj["customDrift"] = z.customDrift;
    obj["driftHueMin"] = z.driftHueMin;
    obj["driftHueMax"] = z.driftHueMax;
    obj["blackout"] = z.blackout;
    JsonArray ranges = obj["ranges"].to<JsonArray>();
    for (uint8_t r = 0; r < z.rangeCount; r++) {
      JsonObject rng = ranges.add<JsonObject>();
      rng["start"] = z.ranges[r].start;
      rng["count"] = z.ranges[r].count;
    }
  }
  String out;
  serializeJson(doc, out);
  return out;
}
