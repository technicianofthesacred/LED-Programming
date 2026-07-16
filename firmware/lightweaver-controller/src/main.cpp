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
#include "LightweaverFrameSource.h"
#include "LightweaverOutputPolicy.h"
#include "LightweaverColorPipeline.h"
#include "LightweaverWledRealtime.h"
#include "LightweaverArtnet.h"
#include "LightweaverWledWebSocket.h"
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <esp_system.h>

// Task watchdog timeout. Must exceed the longest blocking call in the loop
// task — the look-change fade (fadeOutMs + fadeInMs, ~2s default) and SD reads.
#ifndef LW_WDT_TIMEOUT_S
#define LW_WDT_TIMEOUT_S 8
#endif

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
CRGB physicalLeds[LW_MAX_PIXELS];
uint8_t frameBuffer[LW_MAX_PIXELS * 3];

constexpr uint8_t MIRROR_OUTPUT_PINS[] = {16, 17, 18, 21, 38, 39, 40, 48};
constexpr uint8_t MIRROR_OUTPUT_PIN_COUNT = sizeof(MIRROR_OUTPUT_PINS) / sizeof(MIRROR_OUTPUT_PINS[0]);

OutputConfig outputs[LW_MAX_OUTPUTS];
ControlsConfig controls;
LookConfig looks[LW_MAX_LOOKS];

RuntimeConfig runtimeConfig;
LightweaverColorPipeline outputColorPipeline;

String pieceName = "Lightweaver";
String runtimeMode = "sequence";
String startupLookId;
String ledColorOrder = "GRB";

uint8_t outputCount = 0;
uint8_t lookCount = 0;
uint16_t totalPixels = 0;
float brightnessLimit = 0.45f;
uint32_t ledMaxMilliamps = 0;
// Cached numeric form of ledColorOrder, refreshed once per frame so the
// per-pixel remap is a switch instead of 5 String compares (0=RGB passthrough,
// 1=GRB, 2=BRG, 3=BGR, 4=RBG, 5=GBR).
uint8_t ledColorOrderCode = 1;
float fadeScale = 1.0f;
uint8_t lastRequestedOutputBrightnessByte = 0;
uint8_t lastOutputBrightnessByte = 0;
bool outputPowerLimited = false;
OutputSourceClass lastOutputSourceClass = OUTPUT_LOCAL;
uint32_t outputShowCount = 0;
uint32_t outputFpsWindowStartedAt = 0;
uint16_t measuredOutputFps = 0;
bool outputDithering = false;

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
uint32_t controlEventCounts[6] = {0, 0, 0, 0, 0, 0};
ControlEventType lastControlEvent = CONTROL_NONE;
uint32_t lastControlEventAt = 0;
float manualBrightness = 1.0f;
float manualSpeed = 1.0f;
int16_t manualHueShift = 0;
bool identifyActive = false;
uint32_t identifyStartedAt = 0;
uint32_t recoveryHoldUntilMs = 0;
uint32_t recoveryBrightnessBypassUntilMs = 0;
String recoveryPatternId = "warm-white";

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
void selectLookInstant(int index);
bool startLook(uint8_t index);
void closeSequence();
bool openSequence(const String& path);
bool renderCurrentLook(bool force = false);
bool renderSequenceFrame(bool force = false);
bool renderProceduralFrame(const String& preset);
bool renderPresetFrame(const String& preset);
bool isRecoveryPresetPattern(const String& id);
bool renderRecoveryPattern(const String& id, CRGB* target, uint16_t count, uint32_t now, const PatternModifiers& mods);
void applyLookToRuntimeZones(const LookConfig& look);
void applyLookZoneToRuntimeZone(ZoneConfig& zone, const LookZoneConfig& lookZone);
CRGB colorForPreset(const String& preset);
void showLeds();
void showLeds(uint8_t brightnessByte);
void pushPhysicalLeds(uint8_t brightnessByte, OutputSourceClass sourceClass);
void transmitPhysicalLeds(uint8_t brightnessByte, OutputSourceClass sourceClass);
void clearPhysicalLeds();
void recordPhysicalShow();
void updateOutputTelemetry(uint32_t now);
void copyLogicalToPhysicalLeds();
bool isValidLedColorOrder(const String& order);
uint8_t computeColorOrderCode(const String& order);
void fadeTo(float target, uint16_t durationMs);
uint8_t computeBrightnessByte();
float readBrightnessKnob();
bool pinIsPressed(int pin);
const char* controlEventLabel(ControlEventType event);
uint8_t findStartupLook();
void fail(ErrorCode code, const char* message);
void blinkError();
uint16_t readLe16(const uint8_t* bytes);
uint32_t readLe32(const uint8_t* bytes);
uint16_t clampPixels(int value);
float clampUnit(float value);

template<uint8_t DATA_PIN>
bool addLedsForOrder(CRGB* start, uint16_t count) {
  FastLED.addLeds<WS2812B, DATA_PIN, RGB>(start, count);
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

  if (Serial) {
    Serial.println();
    Serial.println("Lightweaver standalone controller booting");
  }
  SPI.begin(LW_SPI_SCK, LW_SPI_MISO, LW_SPI_MOSI, LW_SD_CS);
  RuntimeLoadResult loadResult = loadRuntimeConfig(runtimeConfig);
  if (Serial) {
    Serial.print("Runtime source: ");
    Serial.print(loadResult.source == SOURCE_SD ? "sd" : loadResult.source == SOURCE_NVS ? "internal-flash" : "defaults");
    Serial.print(" / ");
    Serial.println(loadResult.message);
  }
  if (!loadResult.ok) {
    fail(ERROR_CONFIG, loadResult.message.c_str());
    return;
  }
  applyRuntimeConfig(runtimeConfig);
  setupLightweaverControls(controls, controlState);
  setupLightweaverWeb(runtimeConfig, errorCode, totalPixels, currentLookIndex);
  setupWledRealtime(leds, totalPixels);

  if (!setupLedOutputs()) return;
  currentLookIndex = findStartupLook();
  fadeScale = 0.0f;

  if (!startLook(currentLookIndex)) return;
  fadeTo(1.0f, looks[currentLookIndex].fadeInMs);

  setupArtnet(leds, totalPixels);
  setupWledWebSocket();

  // If the previous boot ended in a crash/brownout/watchdog reset, come up in
  // the visible low-brightness known-good state instead of silently re-entering
  // whatever failed — a homeowner sees the piece is alive and can recover it.
  esp_reset_reason_t resetReason = esp_reset_reason();
  if (resetReason == ESP_RST_BROWNOUT || resetReason == ESP_RST_PANIC ||
      resetReason == ESP_RST_TASK_WDT || resetReason == ESP_RST_INT_WDT ||
      resetReason == ESP_RST_WDT) {
    if (Serial) {
      Serial.print("Recovering after abnormal reset (reason ");
      Serial.print((int)resetReason);
      Serial.println(")");
    }
    runtimeRecoverLights("warm-white", 0.65f, true);
  }

  // Task watchdog: reboot if the loop task ever wedges (hung handler, blocked
  // SD read). The Arduino-ESP32 core pre-initializes the TWDT, so reconfigure
  // the timeout on IDF 5.x rather than re-initializing.
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t wdtConfig = {};
  wdtConfig.timeout_ms = LW_WDT_TIMEOUT_S * 1000;
  wdtConfig.idle_core_mask = 0;
  wdtConfig.trigger_panic = true;
  esp_task_wdt_reconfigure(&wdtConfig);
#else
  esp_task_wdt_init(LW_WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);

  if (Serial) {
    Serial.print("Ready: ");
    Serial.print(pieceName);
    Serial.print(" / ");
    Serial.print(totalPixels);
    Serial.println(" pixels");
  }
}

void loop() {
  uint32_t now = millis();
  esp_task_wdt_reset();  // pet the watchdog every iteration, before any early return
  bool recoveryHoldActive = int32_t(recoveryHoldUntilMs - now) > 0;
  handleLightweaverWeb();
  if (!recoveryHoldActive) {
    handleWledRealtime();
    handleArtnet();
    handleWledWebSocket();
  }
  frameSourceTick();
  updateOutputTelemetry(now);

  if (errorCode != ERROR_NONE) {
    clearPhysicalLeds();
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
      showLeds(220);
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
    showLeds(uint8_t(clampUnit(brightnessLimit) * 255.0f));
    delay(20);
    return;
  }

  if (blackedOut) {
    delay(10);
    return;
  }

  if (recoveryHoldActive) {
    PatternModifiers mods;
    mods.speed = 1.0f;
    mods.customHue = 32;
    mods.customSaturation = 230;
    bool rendered = renderRecoveryPattern(recoveryPatternId, leds, totalPixels, millis(), mods);
    if (!rendered && totalPixels > 0) fill_solid(leds, totalPixels, CRGB(255, 220, 170));
    showLeds();
    delay(10);
    return;
  }

  if (frameSourceIsStreaming()) {
    // An external producer (WLED realtime / Art-Net) has already written
    // pixels into leds[] this tick. Skip the internal pattern renderer
    // entirely, but still apply the customer's master brightness ceiling
    // and push the frame to the strip so the dimmer knob still works
    // during streaming.
    showLeds();
  } else if (renderCurrentLook()) {
    showLeds();
  } else {
    delay(1);
  }
}

void applyRuntimeConfig(const RuntimeConfig& config) {
  pieceName = config.pieceName;
  runtimeMode = config.mode;
  startupLookId = config.startupLookId;
  ledColorOrder = config.ledColorOrder;
  outputColorPipeline.configure(config.outputColor);
  brightnessLimit = config.brightnessLimit;
  ledMaxMilliamps = config.maxMilliamps;
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
  FastLED.setCorrection(TypicalLEDStrip);
  // Automatic brightness limiter: when a current ceiling is configured, FastLED
  // scales all pixels down uniformly to keep total draw under budget, which
  // prevents full-white inrush from sagging the rail into a brownout reset.
  // 0 = disabled, preserving existing behavior for installs that haven't set it.
  if (ledMaxMilliamps > 0) {
    FastLED.setMaxPowerInVoltsAndMilliamps(5, ledMaxMilliamps);
  }
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
    if (!addLedsForPin(output.pin, physicalLeds + output.start, output.pixels)) {
      if (Serial) {
        Serial.print("Unsupported LED output pin: ");
        Serial.println(output.pin);
      }
      fail(ERROR_PIN, "unsupported LED output pin");
      return false;
    }
    markAdded(output.pin);
    if (Serial) {
      Serial.print("LED output ");
      Serial.print(output.id);
      Serial.print(" -> GPIO ");
      Serial.print(output.pin);
      Serial.print(" / ");
      Serial.print(output.pixels);
      Serial.println(" px");
    }
  }

  if (outputCount == 1) {
    OutputConfig& output = outputs[0];
    for (uint8_t i = 0; i < MIRROR_OUTPUT_PIN_COUNT; i++) {
      uint8_t pin = MIRROR_OUTPUT_PINS[i];
      if (wasAdded(pin)) continue;
      if (!addLedsForPin(pin, physicalLeds + output.start, output.pixels)) continue;
      markAdded(pin);
      if (Serial) {
        Serial.print("Mirroring LED frame on GPIO ");
        Serial.println(pin);
      }
    }
  }

  // ESP32-S3 has 4 RMT TX channels; FastLED drives each WS2812 output on one.
  // Driving more parallel outputs than channels can silently drop outputs or
  // fall back to a bit-bang path that disables interrupts during show() (which
  // can cost encoder edges on long strips). Warn so a bench operator can catch
  // an over-subscribed config rather than chasing a mystery later.
  if (Serial && addedPinCount > 4) {
    Serial.print("WARNING: ");
    Serial.print(addedPinCount);
    Serial.println(" LED outputs exceed the 4 RMT channels on ESP32-S3; verify "
                   "every strip drives and that show() timing stays stable.");
  }

  // CFastLED::setDither() walks the registered controller list, so this must
  // happen after every output (including mirrors) has been added.
  FastLED.setDither(false);
  clearPhysicalLeds();
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
  if (event != CONTROL_NONE) {
    uint8_t eventIndex = static_cast<uint8_t>(event);
    if (eventIndex < 6) controlEventCounts[eventIndex]++;
    lastControlEvent = event;
    lastControlEventAt = millis();
  }
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
      clearPhysicalLeds();
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

void selectLookInstant(int index) {
  if (lookCount == 0) return;
  uint8_t nextIndex = ((index % lookCount) + lookCount) % lookCount;
  if (nextIndex == currentLookIndex && !blackedOut) return;

  closeSequence();
  currentLookIndex = nextIndex;
  blackedOut = false;
  fadeScale = 1.0f;
  if (!startLook(currentLookIndex)) return;
  showLeds();
}

bool startLook(uint8_t index) {
  LookConfig& look = looks[index];
  if (Serial) {
    Serial.print("Starting look: ");
    Serial.print(look.label);
    Serial.print(" (");
    Serial.print(look.mode);
    Serial.println(")");
  }

  applyLookToRuntimeZones(look);

  if (look.mode == "sequence") {
    if (!openSequence(look.file)) {
      fail(ERROR_SEQUENCE, "sequence open failed");
      return false;
    }
    return renderSequenceFrame(true);
  }

  return renderCurrentLook(true);
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
    if (Serial) {
      Serial.print("Missing sequence file: ");
      Serial.println(path);
    }
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

void applyLookZoneToRuntimeZone(ZoneConfig& zone, const LookZoneConfig& lookZone) {
  zone.patternId = lookZone.patternId;
  zone.brightness = lookZone.brightness;
  zone.speed = lookZone.speed;
  zone.hueShift = lookZone.hueShift;
  zone.customHue = lookZone.customHue;
  zone.customSaturation = lookZone.customSaturation;
  zone.customBreathe = lookZone.customBreathe;
  zone.customDrift = lookZone.customDrift;
  zone.blackout = lookZone.blackout;
}

void applyLookToRuntimeZones(const LookConfig& look) {
  if (runtimeConfig.zoneCount == 0) return;

  if (look.hasZoneLooks && look.zoneCount > 0) {
    runtimeConfig.syncZones = false;
    bool touched[LW_MAX_ZONES] = {};
    for (uint8_t lookZoneIndex = 0; lookZoneIndex < look.zoneCount; lookZoneIndex++) {
      const LookZoneConfig& lookZone = look.zones[lookZoneIndex];
      bool matched = false;
      for (uint8_t zoneIndex = 0; zoneIndex < runtimeConfig.zoneCount; zoneIndex++) {
        if (runtimeConfig.zones[zoneIndex].id == lookZone.id) {
          applyLookZoneToRuntimeZone(runtimeConfig.zones[zoneIndex], lookZone);
          touched[zoneIndex] = true;
          matched = true;
          break;
        }
      }
      if (!matched && lookZoneIndex < runtimeConfig.zoneCount && !touched[lookZoneIndex]) {
        applyLookZoneToRuntimeZone(runtimeConfig.zones[lookZoneIndex], lookZone);
        touched[lookZoneIndex] = true;
      }
    }
    return;
  }

  String patternId = look.preset.length() > 0 ? look.preset : look.id;
  for (uint8_t i = 0; i < runtimeConfig.zoneCount; i++) {
    runtimeConfig.zones[i].patternId = patternId;
    runtimeConfig.zones[i].blackout = false;
  }
}

// Find a look by id or preset in the loaded playlist. Missing ids fall back
// to the compiled procedural pattern renderer inside renderZone().
const LookConfig* findLookById(const String& id) {
  if (id.length() == 0) return lookCount ? &looks[currentLookIndex] : nullptr;
  for (uint8_t i = 0; i < lookCount; i++) {
    if (looks[i].id == id || looks[i].preset == id) return &looks[i];
  }
  return nullptr;
}

bool renderZone(const ZoneConfig& zone, uint32_t now) {
  if (zone.rangeCount == 0) return false;
  const LookConfig* look = findLookById(zone.patternId);

  PatternModifiers mods;
  mods.speed = zone.speed;
  mods.hueShift = zone.hueShift;
  mods.customHue = zone.customHue;
  mods.customSaturation = zone.customSaturation;
  mods.customBreathe = zone.customBreathe;
  mods.customDrift = zone.customDrift;
  mods.driftHueMin = zone.driftHueMin;
  mods.driftHueMax = zone.driftHueMax;

  // Render every range the zone declares. Storage parses up to
  // LW_MAX_RANGES_PER_ZONE ranges and /api/zones reports them all, so split
  // zones must not silently leave their later ranges dark. Each range runs
  // the pattern from its own pixel 0 — visually each segment of a split zone
  // breathes/waves in step rather than continuing one long strip.
  bool any = false;
  for (uint8_t r = 0; r < zone.rangeCount; r++) {
    const PixelRange& range = zone.ranges[r];
    if (range.count == 0) continue;
    if (range.start + range.count > totalPixels) continue;

    CRGB* zoneLeds = leds + range.start;
    uint16_t zonePixels = range.count;

    if (zone.blackout) {
      fill_solid(zoneLeds, zonePixels, CRGB::Black);
      any = true;
      continue;
    }

    bool rendered = false;
    if (!look) {
      rendered = renderProceduralPattern(zone.patternId, zoneLeds, zonePixels, now, mods);
      if (!rendered) rendered = renderPresetPattern(zone.patternId, zoneLeds, zonePixels, mods);
    } else if (look->mode == "procedural") {
      rendered = renderProceduralPattern(look->preset, zoneLeds, zonePixels, now, mods);
    } else if (look->mode == "preset") {
      rendered = renderPresetPattern(look->preset, zoneLeds, zonePixels, mods);
    }
    if (!rendered) continue;

    // Per-zone brightness scaling. The global FastLED.setBrightness() still
    // applies on top of this — it represents the legacy "master" knob plus
    // the brightnessLimit safety ceiling — so per-zone brightness multiplies
    // into the final value.
    uint8_t scale = uint8_t(constrain(int(zone.brightness * 255.0f), 0, 255));
    if (scale < 255) {
      for (uint16_t i = 0; i < zonePixels; i++) zoneLeds[i].nscale8(scale);
    }
    any = true;
  }
  return any;
}

bool renderCurrentLook(bool force) {
  // Legacy sequence path: only when zone 0 holds the entire strip and the
  // selected look is a frame sequence. Sequences predate zones; they take
  // over the whole canvas.
  if (lookCount && looks[currentLookIndex].mode == "sequence") {
    return renderSequenceFrame();
  }

  static uint32_t nextProceduralAt = 0;
  uint32_t now = millis();
  if (!force && now < nextProceduralAt) return false;
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

bool isRecoveryPresetPattern(const String& id) {
  return id == "warm-white" ||
         id == "cool-white" ||
         id == "photo-white" ||
         id == "blackout" ||
         id == "off" ||
         id == "test-red" ||
         id == "red" ||
         id == "test-green" ||
         id == "green" ||
         id == "test-blue" ||
         id == "blue" ||
         id == "test-white" ||
         id == "white";
}

bool renderRecoveryPattern(const String& id, CRGB* target, uint16_t count, uint32_t now, const PatternModifiers& mods) {
  if (isRecoveryPresetPattern(id)) return renderPresetPattern(id, target, count, mods);
  bool rendered = renderProceduralPattern(id, target, count, now, mods);
  if (!rendered) rendered = renderPresetPattern(id, target, count, mods);
  return rendered;
}

CRGB colorForPreset(const String& preset) {
  if (preset == "blackout" || preset == "off") return CRGB::Black;
  if (preset == "test-red" || preset == "red") return CRGB::Red;
  if (preset == "test-green" || preset == "green") return CRGB::Green;
  if (preset == "test-blue" || preset == "blue") return CRGB::Blue;
  if (preset == "test-white" || preset == "white") return CRGB::White;
  if (preset == "cool-white") return CRGB(190, 210, 255);
  if (preset == "photo-white") return CRGB(255, 238, 210);
  return CRGB(255, 170, 92);
}

void fadeTo(float target, uint16_t durationMs) {
  float start = fadeScale;
  uint32_t startMs = millis();
  if (durationMs == 0) {
    fadeScale = target;
    showLeds();
    return;
  }

  while (millis() - startMs < durationMs) {
    float t = float(millis() - startMs) / float(durationMs);
    fadeScale = start + ((target - start) * t);
    showLeds();
    esp_task_wdt_reset();  // fades block the loop task; keep the WDT fed
    delay(16);
  }

  fadeScale = target;
  showLeds();
}

void showLeds() {
  OutputSourceClass sourceClass = frameSourceIsStreaming() ? OUTPUT_EXTERNAL : OUTPUT_LOCAL;
  pushPhysicalLeds(computeBrightnessByte(), sourceClass);
}

void showLeds(uint8_t brightnessByte) {
  pushPhysicalLeds(brightnessByte, OUTPUT_LOCAL);
}

void pushPhysicalLeds(uint8_t brightnessByte, OutputSourceClass sourceClass) {
  copyLogicalToPhysicalLeds();
  transmitPhysicalLeds(brightnessByte, sourceClass);
}

void transmitPhysicalLeds(uint8_t brightnessByte, OutputSourceClass sourceClass) {
  FastLED.setBrightness(brightnessByte);
  lastRequestedOutputBrightnessByte = brightnessByte;
  lastOutputBrightnessByte = brightnessByte;
  if (ledMaxMilliamps > 0) {
    // FastLED.show() applies this same controller-wide power callback. Mirror
    // controllers are deliberately included so diagnostics match the byte that
    // FastLED passes to every physical controller exactly.
    lastOutputBrightnessByte = calculate_max_brightness_for_power_mW(
      brightnessByte, 5UL * ledMaxMilliamps);
  }
  outputPowerLimited = lastOutputBrightnessByte < lastRequestedOutputBrightnessByte;
  lastOutputSourceClass = sourceClass;

  // FastLED 3.10 disables controller dithering inside show() below 100 FPS.
  // Apply that same threshold immediately before transmission so this cached
  // value describes the state used by the last physical frame.
  outputDithering = FastLED.getFPS() >= 100;
  FastLED.setDither(outputDithering);
  FastLED.show();
  recordPhysicalShow();
}

void clearPhysicalLeds() {
  uint16_t limit = totalPixels > LW_MAX_PIXELS ? LW_MAX_PIXELS : totalPixels;
  fill_solid(physicalLeds, limit, CRGB::Black);
  transmitPhysicalLeds(0, OUTPUT_LOCAL);
}

void recordPhysicalShow() {
  outputShowCount++;
  updateOutputTelemetry(millis());
}

void updateOutputTelemetry(uint32_t now) {
  if (outputFpsWindowStartedAt == 0) {
    outputFpsWindowStartedAt = now;
    return;
  }
  uint32_t elapsed = now - outputFpsWindowStartedAt;
  if (elapsed < 1000) return;

  uint32_t fps = (outputShowCount * 1000UL) / elapsed;
  measuredOutputFps = fps > UINT16_MAX ? UINT16_MAX : uint16_t(fps);
  outputShowCount = 0;
  outputFpsWindowStartedAt = now;

}

void copyLogicalToPhysicalLeds() {
  // Resolve the color order once per frame, not once per pixel.
  ledColorOrderCode = computeColorOrderCode(ledColorOrder);
  uint16_t limit = totalPixels > LW_MAX_PIXELS ? LW_MAX_PIXELS : totalPixels;
  for (uint16_t i = 0; i < limit; i++) {
    physicalLeds[i] = outputColorPipeline.transform(leds[i], ledColorOrderCode);
  }
}

uint8_t computeColorOrderCode(const String& order) {
  if (order == "GRB") return 1;
  if (order == "BRG") return 2;
  if (order == "BGR") return 3;
  if (order == "RBG") return 4;
  if (order == "GBR") return 5;
  return 0;  // RGB / unknown → passthrough
}

bool isValidLedColorOrder(const String& order) {
  return order == "RGB" || order == "GRB" || order == "BRG" ||
         order == "BGR" || order == "RBG" || order == "GBR";
}

uint8_t computeBrightnessByte() {
  OutputBrightnessInputs input{};
  input.brightnessLimit = brightnessLimit;
  input.lookBrightness = lookCount ? looks[currentLookIndex].brightness : 0.35f;
  input.fadeScale = fadeScale;
  input.knob = int32_t(recoveryBrightnessBypassUntilMs - millis()) > 0 ? 1.0f : readBrightnessKnob();
  input.manualBrightness = manualBrightness;
  input.blackedOut = blackedOut;
  return composeOutputBrightness(
      input,
      frameSourceIsStreaming() ? OUTPUT_EXTERNAL : OUTPUT_LOCAL);
}

float readBrightnessKnob() {
  if (controls.brightness < 0) return 1.0f;
  int raw = analogRead(controls.brightness);
  return clampUnit(float(raw) / 4095.0f);
}

bool pinIsPressed(int pin) {
  return pin >= 0 && digitalRead(pin) == LOW;
}

const char* controlEventLabel(ControlEventType event) {
  switch (event) {
    case CONTROL_NEXT_LOOK:
      return "next";
    case CONTROL_PREVIOUS_LOOK:
      return "previous";
    case CONTROL_BLACKOUT:
      return "blackout";
    case CONTROL_BRIGHTER:
      return "brighter";
    case CONTROL_DIMMER:
      return "dimmer";
    case CONTROL_NONE:
    default:
      return "none";
  }
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
  if (Serial) {
    Serial.print("ERROR ");
    Serial.print(uint8_t(code));
    Serial.print(": ");
    Serial.println(message);
  }
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
    clearPhysicalLeds();
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
    if (looks[i].id == id || looks[i].preset == id) {
      selectLookInstant(i);
      return true;
    }
  }
  if (id.length() == 0) return false;
  applyToZones("", [&](ZoneConfig& z) { z.patternId = id; });
  return true;
}

// Zone-targeted pattern selection. Used by the per-zone designer flow.
bool runtimeSelectPatternByIdZ(const String& targetId, const String& patternId) {
  if (targetId.length() == 0) return runtimeSelectPatternById(patternId);
  if (patternId.length() == 0) return false;
  uint8_t touched = applyToZones(targetId, [&](ZoneConfig& z) { z.patternId = patternId; });
  return touched > 0;
}

void runtimeTriggerIdentify() {
  identifyActive = true;
  identifyStartedAt = millis();
}

float runtimeGetBrightness() { return manualBrightness; }
float runtimeGetBrightnessZ(const String& targetId) {
  if (runtimeConfig.zoneCount == 0) return manualBrightness;
  if (targetId.length() > 0) {
    for (uint8_t i = 0; i < runtimeConfig.zoneCount; i++) {
      if (runtimeConfig.zones[i].id == targetId) return runtimeConfig.zones[i].brightness;
    }
  }
  return runtimeConfig.zones[0].brightness;
}
float runtimeGetSpeed() { return manualSpeed; }
int16_t runtimeGetHueShift() { return manualHueShift; }
bool runtimeIsBlackedOut() { return blackedOut; }

String runtimeFirmwareInfo() {
  JsonDocument doc;
  doc["build"] = __DATE__ " " __TIME__;
  doc["pixels"] = totalPixels;
  doc["piece"]["id"] = runtimeConfig.pieceId;
  doc["piece"]["name"] = runtimeConfig.pieceName;
  doc["lookCount"] = lookCount;
  doc["uptimeMs"] = millis();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["rssi"] = WiFi.RSSI();
  doc["wifi"]["ip"] = runtimeConfig.activeIp;
  doc["wifi"]["hostname"] = runtimeConfig.activeHostname;
  doc["wifi"]["transport"] =
      runtimeConfig.activeTransport == WIFI_TRANSPORT_STATION ? "station" : "ap";
  // Never serialize the WiFi password into this (unauthenticated) response —
  // only a boolean hint that credentials exist.
  doc["wifi"]["configured"] = runtimeConfig.wifi.ssid.length() > 0;
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
  int altPress = effectiveEncoderPressAltPin(controls);
  doc["controls"]["encoder"]["a"] = controls.encoderA;
  doc["controls"]["encoder"]["b"] = controls.encoderB;
  doc["controls"]["encoder"]["press"] = controls.encoderPress;
  doc["controls"]["encoder"]["configuredAlternatePress"] = controls.encoderPressAlt;
  doc["controls"]["encoder"]["effectiveAlternatePress"] = effectiveEncoderPressAltPin(controls);
  doc["controls"]["encoder"]["rotateDirection"] = controls.rotateDirection;
  doc["controls"]["encoder"]["brightnessStep"] = controls.brightnessStep;
  doc["controls"]["encoder"]["aLow"] = pinIsPressed(controls.encoderA);
  doc["controls"]["encoder"]["bLow"] = pinIsPressed(controls.encoderB);
  doc["controls"]["encoder"]["pressPressed"] = pinIsPressed(controls.encoderPress);
  doc["controls"]["encoder"]["alternatePressPressed"] = pinIsPressed(altPress);
  doc["controls"]["previous"] = controls.previous;
  doc["controls"]["next"] = controls.next;
  doc["controls"]["blackout"] = controls.blackout;
  doc["controls"]["previousPressed"] = pinIsPressed(controls.previous);
  doc["controls"]["nextPressed"] = pinIsPressed(controls.next);
  doc["controls"]["blackoutPressed"] = pinIsPressed(controls.blackout);
  doc["controls"]["brightnessAnalog"] = controls.brightness;
  doc["controls"]["manualBrightness"] = manualBrightness;
  doc["controls"]["lastEvent"] = controlEventLabel(lastControlEvent);
  doc["controls"]["lastEventAtMs"] = lastControlEventAt;
  JsonObject counts = doc["controls"]["eventCounts"].to<JsonObject>();
  counts["next"] = controlEventCounts[CONTROL_NEXT_LOOK];
  counts["previous"] = controlEventCounts[CONTROL_PREVIOUS_LOOK];
  counts["blackout"] = controlEventCounts[CONTROL_BLACKOUT];
  counts["brighter"] = controlEventCounts[CONTROL_BRIGHTER];
  counts["dimmer"] = controlEventCounts[CONTROL_DIMMER];
  doc["capabilities"]["outputColor"] = 1;
  doc["outputColor"]["contract"] = 1;
  doc["outputColor"]["gammaEnabled"] = outputColorPipeline.gammaEnabled();
  doc["outputColor"]["gammaValue"] = outputColorPipeline.gammaValue();
  doc["outputColor"]["calibration"]["red"] = outputColorPipeline.redBalance();
  doc["outputColor"]["calibration"]["green"] = outputColorPipeline.greenBalance();
  doc["outputColor"]["calibration"]["blue"] = outputColorPipeline.blueBalance();
  JsonObject lwOutput = doc["lwOutput"].to<JsonObject>();
  lwOutput["contract"] = 1;
  lwOutput["sourceClass"] = runtimeOutputSourceClass();
  lwOutput["requestedBrightnessByte"] = runtimeOutputRequestedBrightnessByte();
  lwOutput["brightnessByte"] = runtimeOutputBrightnessByte();
  lwOutput["brightnessScale"] = runtimeOutputBrightnessScale();
  lwOutput["powerLimited"] = runtimeOutputPowerLimited();
  lwOutput["gammaEnabled"] = runtimeOutputGammaEnabled();
  lwOutput["gammaValue"] = runtimeOutputGammaValue();
  lwOutput["calibration"]["red"] = runtimeOutputCalibrationRed();
  lwOutput["calibration"]["green"] = runtimeOutputCalibrationGreen();
  lwOutput["calibration"]["blue"] = runtimeOutputCalibrationBlue();
  lwOutput["measuredFps"] = runtimeOutputMeasuredFps();
  lwOutput["dithering"] = runtimeOutputDithering();
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
// Card reboots into AP setup mode for new WiFi credentials.
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

void runtimeSetLedColorOrder(const String& order) {
  String normalized = order;
  normalized.toUpperCase();
  if (!isValidLedColorOrder(normalized)) return;
  ledColorOrder = normalized;
  runtimeConfig.ledColorOrder = normalized;
}
String runtimeGetLedColorOrder() { return ledColorOrder; }

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

// ---- Frame-source state surfaced to the web/runtime layer ----
bool runtimeIsStreaming() { return frameSourceIsStreaming(); }
uint8_t runtimeFrameSource() { return uint8_t(frameSourceActive()); }
void runtimeCancelStream() { frameSourceCancelStream(); }
uint8_t runtimeOutputRequestedBrightnessByte() { return lastRequestedOutputBrightnessByte; }
uint8_t runtimeOutputBrightnessByte() { return lastOutputBrightnessByte; }
float runtimeOutputBrightnessScale() { return float(lastOutputBrightnessByte) / 255.0f; }
bool runtimeOutputPowerLimited() { return outputPowerLimited; }
const char* runtimeOutputSourceClass() {
  return lastOutputSourceClass == OUTPUT_EXTERNAL ? "external" : "local";
}
bool runtimeOutputGammaEnabled() { return outputColorPipeline.gammaEnabled(); }
float runtimeOutputGammaValue() { return outputColorPipeline.gammaValue(); }
float runtimeOutputCalibrationRed() { return outputColorPipeline.redBalance(); }
float runtimeOutputCalibrationGreen() { return outputColorPipeline.greenBalance(); }
float runtimeOutputCalibrationBlue() { return outputColorPipeline.blueBalance(); }
uint16_t runtimeOutputMeasuredFps() { return measuredOutputFps; }
bool runtimeOutputDithering() { return outputDithering; }

String runtimeRecoverLights(const String& patternId, float brightness, bool syncZones) {
  String id = patternId.length() ? patternId : String("warm-white");
  bool isWhiteTestRecovery = id == "test-white" || id == "white";
  float visibleBrightness = brightness;
  if (!isWhiteTestRecovery && visibleBrightness < 0.65f) visibleBrightness = 0.65f;
  if (isWhiteTestRecovery && visibleBrightness < 0.20f) visibleBrightness = 0.20f;
  if (visibleBrightness > 1.0f) visibleBrightness = 1.0f;
  if (!isWhiteTestRecovery && brightnessLimit < 0.65f) brightnessLimit = 0.65f;

  recoveryPatternId = id;
  recoveryHoldUntilMs = millis() + 5000;
  recoveryBrightnessBypassUntilMs = millis() + 5000;
  frameSourceCancelStream();
  blackedOut = false;
  fadeScale = 1.0f;
  manualBrightness = visibleBrightness;
  manualSpeed = 1.0f;
  manualHueShift = 0;
  customBreathe = false;
  customDrift = false;
  runtimeConfig.syncZones = syncZones;

  if (lookCount) {
    looks[currentLookIndex].brightness = visibleBrightness;
  }

  for (uint8_t i = 0; i < runtimeConfig.zoneCount; i++) {
    ZoneConfig& zone = runtimeConfig.zones[i];
    zone.patternId = id;
    zone.brightness = visibleBrightness;
    zone.speed = 1.0f;
    zone.hueShift = 0;
    zone.customHue = 32;
    zone.customSaturation = 230;
    zone.customBreathe = false;
    zone.customDrift = false;
    zone.driftHueMin = 0;
    zone.driftHueMax = 255;
    zone.blackout = false;
  }

  PatternModifiers mods;
  mods.speed = 1.0f;
  mods.customHue = 32;
  mods.customSaturation = 230;
  bool rendered = renderRecoveryPattern(id, leds, totalPixels, millis(), mods);
  if (!rendered && totalPixels > 0) {
    fill_solid(leds, totalPixels, CRGB(255, 220, 170));
  }

  uint8_t brightnessByte = computeBrightnessByte();
  if (!isWhiteTestRecovery && brightnessByte < 140) {
    brightnessLimit = 0.65f;
    manualBrightness = 1.0f;
    if (lookCount) looks[currentLookIndex].brightness = 1.0f;
    brightnessByte = computeBrightnessByte();
  }
  showLeds();

  uint16_t nonBlackPixels = 0;
  for (uint16_t i = 0; i < totalPixels && i < LW_MAX_PIXELS; i++) {
    if (leds[i].r || leds[i].g || leds[i].b) nonBlackPixels++;
  }

  JsonDocument doc;
  doc["ok"] = true;
  doc["recovered"] = true;
  doc["patternId"] = id;
  JsonObject diagnostics = doc["diagnostics"].to<JsonObject>();
  diagnostics["rendered"] = rendered;
  diagnostics["pixels"] = totalPixels;
  diagnostics["nonBlackPixels"] = nonBlackPixels;
  diagnostics["brightnessByte"] = brightnessByte;
  diagnostics["brightnessLimit"] = brightnessLimit;
  diagnostics["lookBrightness"] = lookCount ? looks[currentLookIndex].brightness : 0.0f;
  diagnostics["manualBrightness"] = manualBrightness;
  diagnostics["fadeScale"] = fadeScale;
  diagnostics["blackout"] = blackedOut;
  diagnostics["streaming"] = frameSourceIsStreaming();
  diagnostics["syncZones"] = runtimeConfig.syncZones;
  diagnostics["recoveryHoldMs"] = int32_t(recoveryHoldUntilMs - millis()) > 0 ? recoveryHoldUntilMs - millis() : 0;
  diagnostics["brightnessBypassMs"] = int32_t(recoveryBrightnessBypassUntilMs - millis()) > 0 ? recoveryBrightnessBypassUntilMs - millis() : 0;
  diagnostics["brightnessKnobPin"] = controls.brightness;
  diagnostics["brightnessKnob"] = readBrightnessKnob();
  JsonObject logical = diagnostics["firstLogicalPixel"].to<JsonObject>();
  logical["r"] = totalPixels ? leds[0].r : 0;
  logical["g"] = totalPixels ? leds[0].g : 0;
  logical["b"] = totalPixels ? leds[0].b : 0;
  JsonObject physical = diagnostics["firstPhysicalPixel"].to<JsonObject>();
  physical["r"] = totalPixels ? physicalLeds[0].r : 0;
  physical["g"] = totalPixels ? physicalLeds[0].g : 0;
  physical["b"] = totalPixels ? physicalLeds[0].b : 0;
  JsonArray outputArray = diagnostics["outputs"].to<JsonArray>();
  for (uint8_t i = 0; i < outputCount; i++) {
    JsonObject output = outputArray.add<JsonObject>();
    output["id"] = outputs[i].id;
    output["pin"] = outputs[i].pin;
    output["pixels"] = outputs[i].pixels;
  }
  JsonArray mirrors = diagnostics["mirrorPins"].to<JsonArray>();
  if (outputCount == 1) {
    for (uint8_t i = 0; i < MIRROR_OUTPUT_PIN_COUNT; i++) mirrors.add(MIRROR_OUTPUT_PINS[i]);
  }
  String out;
  serializeJson(doc, out);
  return out;
}

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
