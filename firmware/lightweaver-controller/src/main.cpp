#include <Arduino.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <SD.h>
#include <SPI.h>

#include "LightweaverTypes.h"
#include "LightweaverColorPipeline.h"
#include "LightweaverStorage.h"
#include "LightweaverPatterns.h"
#include "LightweaverControls.h"
#include "LightweaverWeb.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverFrameSource.h"
#include "LightweaverOutputPolicy.h"
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

#ifndef LW_FIRMWARE_VERSION
#define LW_FIRMWARE_VERSION "1.0.0"
#endif
#ifndef LW_BUILD_ID
#define LW_BUILD_ID "dev"
#endif
#ifndef LW_CONFIG_SCHEMA_VERSION
#define LW_CONFIG_SCHEMA_VERSION 1
#endif
#ifndef LW_CAPABILITIES_VERSION
#define LW_CAPABILITIES_VERSION 1
#endif

constexpr const char* LW_FACTORY_CONFIG_PATH = "/lightweaver.json";
constexpr const char* LW_FACTORY_RESET_RECOVERY_PATH = "/lightweaver.reset-recovery.json";

CRGB leds[LW_MAX_PIXELS];
CRGB physicalLeds[LW_MAX_PIXELS];
uint8_t frameBuffer[LW_MAX_PIXELS * 3];

constexpr uint8_t LW_DISCOVERY_STEP_COUNT = LW_APPROVED_OUTPUT_GPIO_COUNT;
constexpr uint16_t LW_DISCOVERY_PIXELS_PER_OUTPUT = LW_FACTORY_BEACON_PIXEL_LIMIT;
constexpr uint8_t LW_DISCOVERY_BRIGHTNESS = LW_FACTORY_BEACON_BRIGHTNESS_LIMIT;

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
uint32_t ledMaxMilliamps = LW_DEFAULT_MAX_MILLIAMPS;
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
bool ledOutputsReady = false;
bool wiringProbationActive = false;
uint32_t wiringProbationDeadlineMs = 0;
bool safeDiscoveryMode = false;
uint8_t safeDiscoveryBatchIndex = 0;
bool factoryBeaconMode = false;
uint32_t safeDiscoveryStartedAtMs = 0;
bool runtimeSafeMode = false;
bool webRuntimeServing = false;
bool restartTransitionPending = false;
bool wifiTransitionPending = false;
String bootId;
uint32_t cardStateRevision = 0;
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
bool setupFactoryBeaconOutputs();
bool setupSafeDiscoveryOutputs(uint8_t stepIndex);
void showFactoryBeaconFrame();
void showSafeDiscoveryFrame();
bool discoveryPinAvailable(uint8_t pin);
bool addLedsForPin(uint8_t pin, CRGB* start, uint16_t count);
void handleControlEvent(ControlEventType event);
void selectLook(int index);
bool selectLookInstant(int index);
bool startLook(uint8_t index);
void closeSequence();
bool openSequence(const String& path);
bool canOpenSequence(const String& path);
bool isLoadedLookRenderable(const LookConfig& look, bool zoneTargeted);
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
void startWiringProbation(bool bootedCandidate);
void rollbackCandidateBeforeRestart(const char* reason);
void initializeBootIdentity();

template<uint8_t DATA_PIN>
bool addLedsForOrder(CRGB* start, uint16_t count) {
  FastLED.addLeds<WS2812B, DATA_PIN, RGB>(start, count);
  return true;
}

void setup() {
  initializeBootIdentity();
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
  runtimeSafeMode = loadResult.safeMode;
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
  WiringSafetyStatus wiringSafety = getRuntimeWiringSafetyStatus();
  safeDiscoveryMode = wiringSafety.discoveryActive;
  safeDiscoveryBatchIndex = wiringSafety.discoveryBatchIndex;
  setupLightweaverControls(controls, controlState);
  setupLightweaverWeb(runtimeConfig, errorCode, totalPixels, currentLookIndex);
  webRuntimeServing = true;

  if (safeDiscoveryMode) {
    if (!setupSafeDiscoveryOutputs(wiringSafety.discoveryBatchIndex)) {
      String clearMessage;
      clearRuntimeWiringDiscovery(clearMessage);
      safeDiscoveryMode = false;
      fail(ERROR_PIN, "safe discovery output setup failed");
      return;
    }
  } else if (runtimeConfig.runtimePhase == ProvisioningPhase::Factory) {
    if (runtimeRecoveryAfterRestartPending()) {
      String recoveryMessage;
      if (!clearRuntimeRecoveryAfterRestart(recoveryMessage)) {
        fail(ERROR_CONFIG, "factory recovery marker clear failed");
        return;
      }
    }
    factoryBeaconMode = true;
    if (!setupFactoryBeaconOutputs()) {
      factoryBeaconMode = false;
      fail(ERROR_PIN, "factory beacon output setup failed");
      return;
    }
  } else {
    setupWledRealtime(leds, totalPixels);
    if (!setupLedOutputs()) {
      if (loadResult.bootedCandidate) rollbackCandidateBeforeRestart("candidate LED output setup failed");
      return;
    }
    currentLookIndex = findStartupLook();
    fadeScale = 0.0f;

    if (!startLook(currentLookIndex)) {
      if (loadResult.bootedCandidate) rollbackCandidateBeforeRestart("candidate startup frame failed");
      return;
    }
    fadeTo(1.0f, looks[currentLookIndex].fadeInMs);
    startWiringProbation(loadResult.bootedCandidate);

    setupArtnet(leds, totalPixels);
    setupWledWebSocket();

    if (runtimeRecoveryAfterRestartPending()) {
      runtimeRecoverLights("warm-white", 0.65f, true);
      String recoveryMessage;
      clearRuntimeRecoveryAfterRestart(recoveryMessage);
    }
  }

  // If the previous boot ended in a crash/brownout/watchdog reset, come up in
  // the visible low-brightness known-good state instead of silently re-entering
  // whatever failed — a homeowner sees the piece is alive and can recover it.
  esp_reset_reason_t resetReason = esp_reset_reason();
  if (!safeDiscoveryMode && !factoryBeaconMode &&
      (resetReason == ESP_RST_BROWNOUT || resetReason == ESP_RST_PANIC ||
      resetReason == ESP_RST_TASK_WDT || resetReason == ESP_RST_INT_WDT ||
      resetReason == ESP_RST_WDT)) {
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
  // A web request can arm recovery inside handleLightweaverWeb(). Re-read the
  // deadline in this same loop tick so no stale stream/error/AP frame can
  // overwrite the recovery frame before the user sees it.
  recoveryHoldActive = int32_t(recoveryHoldUntilMs - millis()) > 0;

  if (safeDiscoveryMode) {
    showSafeDiscoveryFrame();
    delay(10);
    return;
  }

  if (factoryBeaconMode) {
    showFactoryBeaconFrame();
    delay(10);
    return;
  }

  if (wiringProbationActive && int32_t(millis() - wiringProbationDeadlineMs) >= 0) {
    rollbackCandidateBeforeRestart("candidate confirmation timed out");
    return;
  }

  if (recoveryHoldActive && ledOutputsReady) {
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

  handleWledRealtime();
  handleArtnet();
  handleWledWebSocket();
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
    config.segmentCount = 1;
    config.segments[0].id = config.id + "-full";
    config.segments[0].count = config.pixels;
    config.segments[0].reversed = false;
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
  ledOutputsReady = false;
  FastLED.setCorrection(TypicalLEDStrip);
  // FastLED owns one controller group, so this ceiling applies to the combined
  // draw of every output registered below rather than independently per GPIO.
  // Runtime parsing guarantees a conservative nonzero fallback, and production
  // packages cannot pass strict validation without an explicit safe value.
  FastLED.setMaxPowerInVoltsAndMilliamps(5, ledMaxMilliamps);
  uint8_t addedPins[LW_MAX_OUTPUTS] = {};
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

  ledOutputsReady = true;
  FastLED.setDither(false);
  clearPhysicalLeds();
  return true;
}

bool setupFactoryBeaconOutputs() {
  ledOutputsReady = false;
  FastLED.setDither(false);
  FastLED.setCorrection(TypicalLEDStrip);
  FastLED.setMaxPowerInVoltsAndMilliamps(5, LW_FACTORY_BEACON_MAX_MILLIAMPS);
  for (uint8_t i = 0; i < LW_APPROVED_OUTPUT_GPIO_COUNT; i++) {
    if (!discoveryPinAvailable(LW_APPROVED_OUTPUT_GPIOS[i])) continue;
    uint16_t bufferStart = uint16_t(i) * LW_FACTORY_BEACON_PIXEL_LIMIT;
    if (!addLedsForPin(LW_APPROVED_OUTPUT_GPIOS[i], physicalLeds + bufferStart,
                       LW_FACTORY_BEACON_PIXEL_LIMIT)) {
      return false;
    }
  }
  FastLED.clear(false);
  ledOutputsReady = true;
  clearPhysicalLeds();
  return true;
}

bool setupSafeDiscoveryOutputs(uint8_t stepIndex) {
  ledOutputsReady = false;
  if (stepIndex >= LW_DISCOVERY_STEP_COUNT) return false;
  uint8_t pin = factoryBeaconPinForStep(stepIndex);
  if (!discoveryPinAvailable(pin)) return false;

  FastLED.setDither(false);
  FastLED.setCorrection(TypicalLEDStrip);
  FastLED.setMaxPowerInVoltsAndMilliamps(5, LW_FACTORY_BEACON_MAX_MILLIAMPS);
  if (!addLedsForPin(pin, physicalLeds, LW_FACTORY_BEACON_PIXEL_LIMIT)) {
    return false;
  }
  FastLED.clear(false);
  ledOutputsReady = true;
  safeDiscoveryStartedAtMs = millis();
  clearPhysicalLeds();
  showSafeDiscoveryFrame();
  return true;
}

void showFactoryBeaconFrame() {
  static uint8_t lastStep = UINT8_MAX;
  static bool lastPulseOn = false;
  static bool blackHeld = false;
  static uint32_t lastSafetyPollAtMs = 0;
  static WiringSafetyStatus safety;
  uint32_t now = millis();
  if (lastSafetyPollAtMs == 0 ||
      uint32_t(now - lastSafetyPollAtMs) >= LW_FACTORY_BEACON_SAFETY_POLL_MS) {
    safety = getRuntimeWiringSafetyStatus();
    lastSafetyPollAtMs = now;
  }
  FactoryBeaconOwnershipInputs ownership;
  ownership.phase = runtimeConfig.runtimePhase;
  ownership.outputReady = ledOutputsReady;
  ownership.commandActivity = frameSourceIsStreaming() || identifyActive;
  ownership.wifiTransition = restartTransitionPending;
  ownership.candidateActive = safety.candidateState != WIRING_CANDIDATE_NONE || safety.hasCandidate;
  ownership.discoveryActive = safety.discoveryActive;
  ownership.recoveryActive = int32_t(recoveryHoldUntilMs - now) > 0;
  if (!factoryBeaconMayOwnOutput(ownership)) {
    if (!blackHeld) clearPhysicalLeds();
    blackHeld = true;
    return;
  }
  blackHeld = false;

  uint8_t step = uint8_t((now / LW_FACTORY_BEACON_STEP_MS) % LW_APPROVED_OUTPUT_GPIO_COUNT);
  uint32_t elapsedInStep = now % LW_FACTORY_BEACON_STEP_MS;
  bool pulseOn = factoryBeaconPulseOn(elapsedInStep);
  uint8_t activePin = factoryBeaconPinForStep(step);
  (void)activePin;
  if (step != lastStep) {
    // FastLED cannot unregister controllers. Electrically retire the previous
    // approved output by transmitting black to every registered controller
    // before any data is placed in the next pin's private buffer slice.
    clearPhysicalLeds();
    lastStep = step;
    lastPulseOn = false;
  }
  if (pulseOn == lastPulseOn) return;
  fill_solid(physicalLeds, LW_APPROVED_OUTPUT_GPIO_COUNT * LW_FACTORY_BEACON_PIXEL_LIMIT,
             CRGB::Black);
  if (pulseOn) {
    uint16_t bufferStart = uint16_t(step) * LW_FACTORY_BEACON_PIXEL_LIMIT;
    fill_solid(physicalLeds + bufferStart, LW_FACTORY_BEACON_PIXEL_LIMIT,
               CRGB(255, 96, 24));
  }
  transmitPhysicalLeds(LW_FACTORY_BEACON_BRIGHTNESS_LIMIT, OUTPUT_LOCAL);
  lastPulseOn = pulseOn;
}

void showSafeDiscoveryFrame() {
  static bool lastPulseOn = false;
  if (!ledOutputsReady) return;
  bool pulseOn = factoryBeaconPulseOn(millis() - safeDiscoveryStartedAtMs);
  if (pulseOn == lastPulseOn) return;
  fill_solid(physicalLeds, LW_FACTORY_BEACON_PIXEL_LIMIT, CRGB::Black);
  if (pulseOn) {
    fill_solid(physicalLeds, LW_FACTORY_BEACON_PIXEL_LIMIT, CRGB(255, 96, 24));
  }
  transmitPhysicalLeds(LW_DISCOVERY_BRIGHTNESS, OUTPUT_LOCAL);
  lastPulseOn = pulseOn;
}

bool discoveryPinAvailable(uint8_t pin) {
  const int controlPins[] = {
    controls.encoderA, controls.encoderB, controls.encoderPress,
    controls.encoderPressAlt, controls.previous, controls.next,
    controls.blackout, controls.brightness, controls.statusLed,
  };
  for (int controlPin : controlPins) {
    if (controlPin >= 0 && pin == controlPin) return false;
  }
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
  if (!isLoadedLookRenderable(looks[nextIndex], false)) return;

  fadeTo(0.0f, looks[currentLookIndex].fadeOutMs);
  closeSequence();
  currentLookIndex = nextIndex;
  blackedOut = false;
  if (!startLook(currentLookIndex)) return;
  fadeTo(1.0f, looks[currentLookIndex].fadeInMs);
}

bool selectLookInstant(int index) {
  if (lookCount == 0) return false;
  uint8_t nextIndex = ((index % lookCount) + lookCount) % lookCount;
  if (!isLoadedLookRenderable(looks[nextIndex], false)) return false;

  closeSequence();
  currentLookIndex = nextIndex;
  blackedOut = false;
  fadeScale = 1.0f;
  if (!startLook(currentLookIndex)) return false;
  showLeds();
  return true;
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

  if (look.mode == "sequence") {
    if (!openSequence(look.file)) {
      fail(ERROR_SEQUENCE, "sequence open failed");
      return false;
    }
    applyLookToRuntimeZones(look);
    return renderSequenceFrame(true);
  }

  applyLookToRuntimeZones(look);
  return renderCurrentLook(true);
}

void closeSequence() {
  if (sequenceOpen) {
    sequenceFile.close();
    sequenceOpen = false;
  }
}

bool readSequenceMetadata(File& file, uint32_t& frameCount, uint16_t& fps, uint32_t& frameBytes) {
  uint8_t header[LWSEQ_HEADER_BYTES];
  if (file.read(header, LWSEQ_HEADER_BYTES) != LWSEQ_HEADER_BYTES) return false;
  if (memcmp(header, "LWSEQ1", 6) != 0) return false;

  uint16_t version = readLe16(header + 8);
  uint16_t channels = readLe16(header + 22);
  uint32_t pixelCount = readLe32(header + 12);
  frameCount = readLe32(header + 16);
  fps = readLe16(header + 20);
  frameBytes = pixelCount * channels;

  if (version != 1 || channels != 3 || pixelCount != totalPixels ||
      frameBytes > sizeof(frameBuffer) || frameCount == 0 || fps == 0) return false;
  uint64_t requiredBytes = uint64_t(LWSEQ_HEADER_BYTES) + uint64_t(frameCount) * frameBytes;
  if (requiredBytes > file.size()) return false;
  return true;
}

bool canOpenSequence(const String& path) {
  if (path.length() == 0) return false;
  File candidate = SD.open(path.c_str(), FILE_READ);
  if (!candidate) return false;
  uint32_t frameCount = 0;
  uint16_t fps = 0;
  uint32_t frameBytes = 0;
  bool valid = readSequenceMetadata(candidate, frameCount, fps, frameBytes);
  candidate.close();
  return valid;
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

  if (!readSequenceMetadata(sequenceFile, sequenceFrameCount, sequenceFps, sequenceFrameBytes)) {
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
const LookConfig* findLookByExactId(const String& id) {
  for (uint8_t i = 0; i < lookCount; i++) {
    if (looks[i].id == id) return &looks[i];
  }
  return nullptr;
}

const LookConfig* findLookByPresetAlias(const String& preset) {
  for (uint8_t i = 0; i < lookCount; i++) {
    if (looks[i].preset == preset) return &looks[i];
  }
  return nullptr;
}

const LookConfig* findLookById(const String& id) {
  if (id.length() == 0) return lookCount ? &looks[currentLookIndex] : nullptr;
  const LookConfig* exact = findLookByExactId(id);
  return exact ? exact : findLookByPresetAlias(id);
}

bool isLoadedLookRenderable(const LookConfig& look, bool zoneTargeted) {
  if (look.mode == "combo") {
    if (zoneTargeted) return false;
    if (!look.hasZoneLooks || look.zoneCount == 0) return false;
    for (uint8_t i = 0; i < look.zoneCount; i++) {
      if (!isSupportedCompiledPattern(look.zones[i].patternId)) return false;
    }
    return true;
  }
  if (look.hasZoneLooks) return false;
  if (look.mode == "procedural") return isSupportedProceduralPattern(look.preset);
  if (look.mode == "preset") return isSupportedPresetPattern(look.preset);
  if (look.mode == "sequence") {
    if (zoneTargeted) return false;
    return canOpenSequence(look.file);
  }
  return false;
}

bool renderZone(const ZoneConfig& zone, uint32_t now) {
  if (zone.rangeCount == 0) return false;
  const LookConfig* look = isSupportedCompiledPattern(zone.patternId) ? nullptr : findLookById(zone.patternId);

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
    lastOutputBrightnessByte = calculate_max_brightness_for_power_mW(
      brightnessByte, 5UL * ledMaxMilliamps);
  }
  outputPowerLimited = lastOutputBrightnessByte < lastRequestedOutputBrightnessByte;
  lastOutputSourceClass = sourceClass;
  outputDithering = FastLED.getFPS() >= 100;
  FastLED.setDither(outputDithering);
  FastLED.show();
  recordPhysicalShow();
}

void clearPhysicalLeds() {
  // Clear the complete fixed buffer, including factory-beacon slices which
  // are intentionally separate from the zero-output project runtime.
  fill_solid(physicalLeds, LW_MAX_PIXELS, CRGB::Black);
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
  for (uint8_t outputIndex = 0; outputIndex < outputCount; outputIndex++) {
    const OutputConfig& output = outputs[outputIndex];
    uint16_t segmentStart = output.start;
    for (uint8_t segmentIndex = 0; segmentIndex < output.segmentCount; segmentIndex++) {
      const OutputSegmentConfig& segment = output.segments[segmentIndex];
      for (uint16_t offset = 0; offset < segment.count && segmentStart + offset < limit; offset++) {
        const uint16_t logicalIndex = segmentStart + offset;
        const uint16_t physicalIndex = segment.reversed
          ? segmentStart + segment.count - 1 - offset
          : logicalIndex;
        physicalLeds[physicalIndex] = outputColorPipeline.transform(leds[logicalIndex], ledColorOrderCode);
      }
      segmentStart += segment.count;
    }
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

void startWiringProbation(bool bootedCandidate) {
  if (!bootedCandidate || !ledOutputsReady) return;
  wiringProbationActive = true;
  wiringProbationDeadlineMs = millis() + LW_WIRING_PROBATION_MS;
}

void rollbackCandidateBeforeRestart(const char* reason) {
  WiringSafetyStatus status = getRuntimeWiringSafetyStatus();
  String message;
  if (!rollbackCandidateRuntimeConfig(status.activationId, message)) {
    wiringProbationActive = false;
    fail(ERROR_CONFIG, message.c_str());
    return;
  }
  wiringProbationActive = false;
  if (Serial) {
    Serial.print("Wiring candidate rolled back: ");
    Serial.println(reason);
  }
  delay(150);
  ESP.restart();
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

bool runtimeControlTargetExists(const String& targetId) {
  if (targetId.length() == 0) return runtimeConfig.zoneCount > 0;
  for (uint8_t index = 0; index < runtimeConfig.zoneCount; index++) {
    if (runtimeConfig.zones[index].id == targetId) return true;
  }
  return false;
}

bool zoneAffectsOutput(const ZoneConfig& zone, const OutputConfig& output) {
  uint32_t outputStart = output.start;
  uint32_t outputEnd = outputStart + output.pixels;
  for (uint8_t rangeIndex = 0; rangeIndex < zone.rangeCount; rangeIndex++) {
    uint32_t rangeStart = zone.ranges[rangeIndex].start;
    uint32_t rangeEnd = rangeStart + zone.ranges[rangeIndex].count;
    if (rangeStart < outputEnd && outputStart < rangeEnd) return true;
  }
  return false;
}

bool runtimeOutputAffectedByCommand(uint8_t outputIndex,
                                    const String& targetId,
                                    bool syncZones,
                                    ProvisioningOutputScope scope) {
  if (outputIndex >= outputCount || outputs[outputIndex].pixels == 0 ||
      scope == ProvisioningOutputScope::None) return false;
  if (scope == ProvisioningOutputScope::AllOutputs) return true;
  bool targetSpecified = targetId.length() > 0;
  uint8_t targetZoneIndex = 0;
  bool targetFound = !targetSpecified;
  for (uint8_t index = 0; index < runtimeConfig.zoneCount; index++) {
    if (runtimeConfig.zones[index].id == targetId) {
      targetZoneIndex = index;
      targetFound = true;
      break;
    }
  }
  if (!targetFound) return false;
  for (uint8_t zoneIndex = 0; zoneIndex < runtimeConfig.zoneCount; zoneIndex++) {
    if (provisioningZoneSelected(
            zoneIndex, targetSpecified, targetZoneIndex, syncZones) &&
        zoneAffectsOutput(runtimeConfig.zones[zoneIndex], outputs[outputIndex])) {
      return true;
    }
  }
  return false;
}

uint8_t runtimeAffectedOutputCount(const String& targetId,
                                   bool syncZones,
                                   ProvisioningOutputScope scope) {
  uint8_t affected = 0;
  for (uint8_t outputIndex = 0; outputIndex < outputCount; outputIndex++) {
    if (runtimeOutputAffectedByCommand(outputIndex, targetId, syncZones, scope)) affected++;
  }
  return affected;
}

String runtimeAffectedOutputId(const String& targetId,
                               bool syncZones,
                               ProvisioningOutputScope scope,
                               uint8_t affectedIndex) {
  uint8_t found = 0;
  for (uint8_t outputIndex = 0; outputIndex < outputCount; outputIndex++) {
    if (runtimeOutputAffectedByCommand(outputIndex, targetId, syncZones, scope) &&
        found++ == affectedIndex) return outputs[outputIndex].id;
  }
  return String("");
}

uint32_t runtimeAdvanceStateRevision() {
  cardStateRevision = cardStateRevision == UINT32_MAX ? 1 : cardStateRevision + 1;
  return cardStateRevision;
}

uint32_t runtimeStateRevision() { return cardStateRevision; }

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

bool runtimeCanStepPattern(int8_t direction) {
  if (!provisioningLookStepChangesSelection(lookCount, currentLookIndex, direction)) return false;
  uint8_t targetIndex = direction > 0
      ? (currentLookIndex + 1) % lookCount
      : (currentLookIndex + lookCount - 1) % lookCount;
  return isLoadedLookRenderable(looks[targetIndex], false);
}

void runtimeNextPattern() {
  selectLook(currentLookIndex + 1);
}

void runtimePreviousPattern() {
  selectLook(currentLookIndex == 0 ? lookCount - 1 : currentLookIndex - 1);
}

bool runtimeSelectPatternById(const String& id) {
  const LookConfig* look = findLookByExactId(id);
  if (look) {
    if (!isLoadedLookRenderable(*look, false)) return false;
    return selectLookInstant(static_cast<int>(look - looks));
  }
  if (isSupportedCompiledPattern(id)) {
    applyToZones("", [&](ZoneConfig& z) { z.patternId = id; });
    return true;
  }
  look = findLookByPresetAlias(id);
  if (!look || !isLoadedLookRenderable(*look, false)) return false;
  return selectLookInstant(static_cast<int>(look - looks));
}

// Validate the complete pattern target without changing visible state. The web
// control transaction calls this before applying sync, color, or brightness so
// a section removed by a newer wiring config cannot leave a partial preview.
bool runtimeCanSelectPatternByIdZ(const String& targetId, const String& patternId) {
  if (patternId.length() == 0 || runtimeConfig.zoneCount == 0) return false;
  bool zoneTargeted = targetId.length() > 0;
  const LookConfig* look = zoneTargeted && isSupportedCompiledPattern(patternId)
    ? nullptr
    : findLookByExactId(patternId);
  if (!look && !isSupportedCompiledPattern(patternId) && !zoneTargeted) {
    look = findLookByPresetAlias(patternId);
  }
  if (look) {
    if (!isLoadedLookRenderable(*look, zoneTargeted)) return false;
  } else if (!isSupportedCompiledPattern(patternId)) {
    return false;
  }
  if (targetId.length() == 0) return true;
  for (uint8_t i = 0; i < runtimeConfig.zoneCount; i++) {
    if (runtimeConfig.zones[i].id == targetId) return true;
  }
  return false;
}

bool runtimePatternAffectsAllOutputs(const String& targetId, const String& patternId) {
  if (targetId.length() > 0) return false;
  const LookConfig* look = findLookByExactId(patternId);
  if (look && isLoadedLookRenderable(*look, false)) return true;
  if (isSupportedCompiledPattern(patternId)) return false;
  look = findLookByPresetAlias(patternId);
  return look && isLoadedLookRenderable(*look, false);
}

// Zone-targeted pattern selection. Used by the per-zone designer flow.
bool runtimeSelectPatternByIdZ(const String& targetId, const String& patternId) {
  if (!runtimeCanSelectPatternByIdZ(targetId, patternId)) return false;
  if (targetId.length() == 0) return runtimeSelectPatternById(patternId);
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

uint32_t runtimeWiringProbationRemainingMs() {
  if (!wiringProbationActive) return 0;
  int32_t remaining = int32_t(wiringProbationDeadlineMs - millis());
  return remaining > 0 ? static_cast<uint32_t>(remaining) : 0;
}

void initializeBootIdentity() {
  char value[32] = {};
  snprintf(value, sizeof(value), "boot-%08lx-%012llx",
           static_cast<unsigned long>(esp_random()),
           static_cast<unsigned long long>(ESP.getEfuseMac() & 0xFFFFFFFFFFFFULL));
  bootId = value;
}

String runtimeCardId() {
  char cardId[16] = {};
  snprintf(cardId, sizeof(cardId), "lw-%012llx",
           static_cast<unsigned long long>(ESP.getEfuseMac() & 0xFFFFFFFFFFFFULL));
  return String(cardId);
}

String runtimeBootId() { return bootId; }

bool runtimeTransitionPending() {
  if (restartTransitionPending || wifiTransitionPending || runtimeSafeMode || safeDiscoveryMode ||
      wiringProbationActive || runtimeRecoveryAfterRestartPending()) {
    return true;
  }
  WiringSafetyStatus safety = getRuntimeWiringSafetyStatus();
  return safety.discoveryActive ||
         safety.candidateState == WIRING_CANDIDATE_BOOTING ||
         safety.candidateState == WIRING_CANDIDATE_AWAITING_CONFIRMATION;
}

ProvisioningPhase runtimeReportedProvisioningPhase() {
  if (errorCode != ERROR_NONE || runtimeTransitionPending()) {
    return ProvisioningPhase::Recovering;
  }
  return runtimeConfig.runtimePhase;
}

const char* runtimeProvisioningPhase() {
  return provisioningPhaseLabel(runtimeReportedProvisioningPhase());
}

bool runtimeOutputReady() { return ledOutputsReady; }
bool runtimeConfigValid() { return runtimeConfig.configValid; }
bool runtimeKnownGoodProject() { return runtimeConfig.knownGoodProject; }

bool runtimeCommandReady() {
  bool transitionPending = runtimeTransitionPending() || errorCode != ERROR_NONE;
  ProvisioningReadinessInputs inputs;
  inputs.phase = transitionPending
      ? ProvisioningPhase::Recovering
      : runtimeConfig.runtimePhase;
  inputs.configValid = runtimeConfig.configValid;
  inputs.knownGoodProject = runtimeConfig.knownGoodProject;
  inputs.webServing = webRuntimeServing;
  inputs.outputReady = ledOutputsReady;
  inputs.transitionPending = transitionPending;
  return provisioningCommandReady(inputs);
}

void runtimeMarkRestartPending() {
  restartTransitionPending = true;
  if (ledOutputsReady) clearPhysicalLeds();
}

void runtimeSetWifiTransitionPending(bool pending) {
  wifiTransitionPending = pending;
}

String runtimeFirmwareInfo() {
  JsonDocument doc;
  doc["app"] = "Lightweaver";
  doc["cardId"] = runtimeCardId();
  doc["firmwareVersion"] = LW_FIRMWARE_VERSION;
  doc["buildId"] = LW_BUILD_ID;
  doc["bootId"] = runtimeBootId();
  doc["uptimeMs"] = millis();
  doc["provisioningContractVersion"] = LW_PROVISIONING_CONTRACT_VERSION;
  doc["runtimePhase"] = runtimeProvisioningPhase();
  doc["commandReady"] = runtimeCommandReady();
  doc["outputReady"] = runtimeOutputReady();
  doc["configValid"] = runtimeConfigValid();
  doc["knownGoodProject"] = runtimeKnownGoodProject();
  doc["configSchemaVersion"] = LW_CONFIG_SCHEMA_VERSION;
  doc["capabilitiesVersion"] = LW_CAPABILITIES_VERSION;
  doc["build"] = __DATE__ " " __TIME__;
  doc["pixels"] = totalPixels;
  doc["piece"]["id"] = runtimeConfig.pieceId;
  doc["piece"]["name"] = runtimeConfig.pieceName;
  doc["projectRevision"] = runtimeConfig.projectRevision;
  doc["projectFingerprint"] = runtimeConfig.projectFingerprint;
  doc["productionJobId"] = runtimeConfig.productionJobId;
  doc["productionJobDigest"] = runtimeConfig.productionJobDigest;
  doc["wiringRevision"] = runtimeConfig.wiringRevision;
  doc["wiringDigest"] = runtimeConfig.wiringDigest;
  doc["maxMilliamps"] = runtimeConfig.maxMilliamps;
  doc["estimatedFullWhiteMilliamps"] = lightweaverFullWhiteMilliamps(totalPixels);
  doc["limitedFullWhiteMilliamps"] =
      lightweaverLimitedMilliamps(totalPixels, runtimeConfig.maxMilliamps);
  doc["lookCount"] = lookCount;
  doc["runtimeSource"] = runtimeConfig.source == SOURCE_SD ? "sd" : runtimeConfig.source == SOURCE_NVS ? "internal-flash" : "defaults";
  doc["resetReason"] = static_cast<uint8_t>(esp_reset_reason());
  doc["wiringProbation"]["active"] = wiringProbationActive;
  doc["wiringProbation"]["remainingMs"] = runtimeWiringProbationRemainingMs();
  doc["limits"]["pixels"] = LW_MAX_PIXELS;
  doc["limits"]["outputs"] = LW_MAX_OUTPUTS;
  doc["limits"]["looks"] = LW_MAX_LOOKS;
  doc["limits"]["zones"] = LW_MAX_ZONES;
  doc["limits"]["rangesPerZone"] = LW_MAX_RANGES_PER_ZONE;
  doc["limits"]["configStorageBytes"] = 3968;
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
    JsonArray segments = output["segments"].to<JsonArray>();
    for (uint8_t segmentIndex = 0; segmentIndex < outputs[i].segmentCount; segmentIndex++) {
      JsonObject segment = segments.add<JsonObject>();
      segment["id"] = outputs[i].segments[segmentIndex].id;
      segment["count"] = outputs[i].segments[segmentIndex].count;
      segment["direction"] = outputs[i].segments[segmentIndex].reversed ? "reverse" : "forward";
    }
    output["gpio"] = outputs[i].pin;
    output["count"] = outputs[i].pixels;
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
  doc["outputColor"]["colorOrder"] = ledColorOrder;
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

FactoryResetResult runtimeFactoryReset() {
  FactoryResetResult result;
  runtimeMarkRestartPending();
  bool sdMounted = SD.begin(LW_SD_CS);
  if (!sdMounted) {
    restartTransitionPending = false;
    result.message = "sd unavailable; remove card or retry; factory reset not completed";
    return result;
  }

  bool sdConfigExists = SD.exists(LW_FACTORY_CONFIG_PATH);
  bool staleRecoveryExists = SD.exists(LW_FACTORY_RESET_RECOVERY_PATH);
  bool sdConfigStaged = false;
  if (staleRecoveryExists && sdConfigExists) {
    if (!SD.remove(LW_FACTORY_RESET_RECOVERY_PATH)) {
      restartTransitionPending = false;
      result.message = "sd stale reset recovery cleanup failed; remove /lightweaver.reset-recovery.json or retry";
      return result;
    }
  } else if (staleRecoveryExists) {
    // A power loss may leave the only recoverable project under the inert
    // backup name. Keep it staged so an NVS failure can restore active boot.
    sdConfigStaged = true;
    sdConfigExists = true;
  }

  if (sdConfigExists && !sdConfigStaged) {
    sdConfigStaged = SD.rename(
        LW_FACTORY_CONFIG_PATH, LW_FACTORY_RESET_RECOVERY_PATH);
    if (!sdConfigStaged) {
      restartTransitionPending = false;
      result.message = "sd config staging rename failed; factory reset not started";
      return result;
    }
  }

  Preferences prefs;
  bool nvsCleared = false;
  if (prefs.begin("lightweaver", false)) {
    nvsCleared = prefs.clear();
    prefs.end();
  }
  if (!nvsCleared) {
    bool sdRestored = !sdConfigStaged || SD.rename(
        LW_FACTORY_RESET_RECOVERY_PATH, LW_FACTORY_CONFIG_PATH);
    restartTransitionPending = false;
    result.message = sdRestored
        ? "nvs erase failed; sd config restored; factory reset not completed"
        : "nvs erase failed and sd restore failed; config remains at /lightweaver.reset-recovery.json; recover manually";
    return result;
  }

  bool sdConfigRemoved = !sdConfigStaged || SD.remove(LW_FACTORY_RESET_RECOVERY_PATH);
  if (!sdConfigRemoved) {
    restartTransitionPending = false;
    result.message = "nvs erased; sd recovery backup remains at /lightweaver.reset-recovery.json and is not auto-loaded; remove manually; factory reset incomplete";
    return result;
  }
  if (!provisioningFactoryResetMayComplete(
          sdMounted, sdConfigExists, sdConfigRemoved, nvsCleared)) {
    restartTransitionPending = false;
    result.message = "factory reset verification failed after storage cleanup";
    return result;
  }
  result.accepted = true;
  result.pendingVerification = true;
  result.message = "factory storage erased; reboot pending verification";
  return result;
}

bool runtimeFinalizeFactoryResetRadio(String& message) {
  bool credentialsErased = WiFi.eraseAP();
  bool radioDisabled = WiFi.mode(WIFI_OFF);
  bool ok = credentialsErased && radioDisabled;
  message = ok
      ? "sdk wifi erased and radio disabled"
      : "sdk wifi erase or radio shutdown failed; reboot status must verify reset";
  return ok;
}

// Wipe only the WiFi key. Keeps piece name, hostname, and pattern config.
// Card reboots into AP setup mode for new WiFi credentials.
void runtimeResetWifi() {
  runtimeMarkRestartPending();
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
bool runtimeCanSetLedColorOrder(const String& order) {
  String normalized = order;
  normalized.toUpperCase();
  return isValidLedColorOrder(normalized);
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

String runtimeWiringSafetyStatus() {
  String stored = runtimeWiringSafetyStatusJson();
  JsonDocument doc;
  if (deserializeJson(doc, stored)) doc["ok"] = false;
  WiringSafetyStatus safety = getRuntimeWiringSafetyStatus();
  const char* state = runtimeSafeMode
      ? "safe-mode"
      : runtimeConfig.runtimePhase == ProvisioningPhase::Factory ? "factory" : "known-good";
  const char* nextStep = "stage-candidate";
  if (safety.candidateState == WIRING_CANDIDATE_STAGED) {
    state = "staged";
    nextStep = "activate";
  } else if (safety.candidateState == WIRING_CANDIDATE_BOOTING ||
             safety.candidateState == WIRING_CANDIDATE_AWAITING_CONFIRMATION) {
    state = "testing";
    nextStep = "confirm-or-rollback";
  }
  if (safety.discoveryActive) nextStep = "confirm-observed-pin-or-request-next-step";
  doc["state"] = state;
  doc["cardId"] = runtimeCardId();
  doc["firmwareVersion"] = LW_FIRMWARE_VERSION;
  doc["buildId"] = LW_BUILD_ID;
  if (!safety.hasCandidate) {
    doc["projectRevision"] = runtimeConfig.projectRevision;
    doc["projectFingerprint"] = runtimeConfig.projectFingerprint;
    doc["productionJobId"] = runtimeConfig.productionJobId;
    doc["productionJobDigest"] = runtimeConfig.productionJobDigest;
    doc["wiringRevision"] = runtimeConfig.wiringRevision;
    doc["wiringDigest"] = runtimeConfig.wiringDigest;
    doc["maxMilliamps"] = runtimeConfig.maxMilliamps;
    doc["colorOrder"] = ledColorOrder;
  }
  doc["currentWiringRevision"] = runtimeConfig.wiringRevision;
  doc["currentWiringDigest"] = runtimeConfig.wiringDigest;
  doc["currentMaxMilliamps"] = runtimeConfig.maxMilliamps;
  doc["estimatedFullWhiteMilliamps"] = lightweaverFullWhiteMilliamps(totalPixels);
  doc["limitedFullWhiteMilliamps"] =
      lightweaverLimitedMilliamps(totalPixels, runtimeConfig.maxMilliamps);
  doc["testing"] = wiringProbationActive;
  uint32_t remaining = 0;
  if (wiringProbationActive && int32_t(wiringProbationDeadlineMs - millis()) > 0) {
    remaining = wiringProbationDeadlineMs - millis();
  }
  doc["remainingProbationMs"] = remaining;
  doc["nextStep"] = nextStep;
  doc["outputsReady"] = ledOutputsReady;
  JsonArray currentOutputs = doc["currentOutputs"].to<JsonArray>();
  for (uint8_t i = 0; i < outputCount; i++) {
    JsonObject output = currentOutputs.add<JsonObject>();
    output["id"] = outputs[i].id;
    output["pin"] = outputs[i].pin;
    output["pixels"] = outputs[i].pixels;
    JsonArray segments = output["segments"].to<JsonArray>();
    for (uint8_t segmentIndex = 0; segmentIndex < outputs[i].segmentCount; segmentIndex++) {
      JsonObject segment = segments.add<JsonObject>();
      segment["id"] = outputs[i].segments[segmentIndex].id;
      segment["count"] = outputs[i].segments[segmentIndex].count;
      segment["direction"] = outputs[i].segments[segmentIndex].reversed ? "reverse" : "forward";
    }
  }
  if (safety.discoveryActive) {
    JsonObject discovery = doc["discovery"].to<JsonObject>();
    discovery["active"] = true;
    discovery["pin"] = factoryBeaconPinForStep(safety.discoveryBatchIndex);
    discovery["step"] = safety.discoveryBatchIndex;
    discovery["stepCount"] = LW_DISCOVERY_STEP_COUNT;
    discovery["brightnessLimit"] = LW_DISCOVERY_BRIGHTNESS;
    discovery["pixelLimit"] = LW_DISCOVERY_PIXELS_PER_OUTPUT;
    discovery["nextStep"] = (safety.discoveryBatchIndex + 1) % LW_DISCOVERY_STEP_COUNT;
  }
  String out;
  serializeJson(doc, out);
  return out;
}

bool runtimeActivateWiringCandidate(const String& activationId, String& message) {
  bool activated = activateStagedRuntimeConfig(activationId, message);
  if (activated) runtimeMarkRestartPending();
  return activated;
}

bool runtimeConfirmWiringCandidate(const String& activationId, String& message) {
  bool confirmed = confirmCandidateRuntimeConfig(activationId, message);
  if (confirmed) {
    wiringProbationActive = false;
    wiringProbationDeadlineMs = 0;
    runtimeConfig.configValid = true;
    runtimeConfig.knownGoodProject = true;
    runtimeConfig.runtimePhase = ProvisioningPhase::Ready;
  }
  return confirmed;
}

bool runtimeRollbackWiringCandidate(const String& activationId, String& message) {
  bool rolledBack = rollbackCandidateRuntimeConfig(activationId, message);
  if (rolledBack) {
    wiringProbationActive = false;
    wiringProbationDeadlineMs = 0;
  }
  return rolledBack;
}

String runtimeSafeDiscoveryOutput(uint8_t stepIndex) {
  JsonDocument doc;
  if (stepIndex >= LW_DISCOVERY_STEP_COUNT) {
    doc["ok"] = false;
    doc["error"] = "discovery step out of range";
  } else if (wiringProbationActive) {
    doc["ok"] = false;
    doc["error"] = "confirm or roll back the wiring candidate before discovery";
  } else {
    WiringSafetyStatus safety = getRuntimeWiringSafetyStatus();
    uint8_t pin = factoryBeaconPinForStep(stepIndex);
    if (safety.candidateState != WIRING_CANDIDATE_NONE || safety.hasCandidate) {
      doc["ok"] = false;
      doc["error"] = "confirm or roll back the wiring candidate before discovery";
    } else if (!discoveryPinAvailable(pin)) {
      doc["ok"] = false;
      doc["error"] = "the GPIO for this discovery step is assigned to a control";
    } else {
      String message;
      if (!setRuntimeWiringDiscoveryBatch(stepIndex, message)) {
        doc["ok"] = false;
        doc["error"] = message;
      } else {
        runtimeMarkRestartPending();
        doc["ok"] = true;
        doc["state"] = "rebooting-for-discovery";
        doc["pin"] = pin;
        doc["step"] = stepIndex;
        doc["stepCount"] = LW_DISCOVERY_STEP_COUNT;
        doc["brightnessLimit"] = LW_DISCOVERY_BRIGHTNESS;
        doc["pixelLimit"] = LW_DISCOVERY_PIXELS_PER_OUTPUT;
        doc["nextStep"] = (stepIndex + 1) % LW_DISCOVERY_STEP_COUNT;
        doc["requiresReboot"] = true;
        doc["requiresConfirmation"] = true;
        doc["persistsWiring"] = false;
      }
    }
    if (!(doc["ok"] | false)) {
      String out;
      serializeJson(doc, out);
      return out;
    }
  }
  String out;
  serializeJson(doc, out);
  return out;
}

bool runtimeStopSafeDiscovery(String& message) {
  bool stopped = clearRuntimeWiringDiscovery(message);
  if (stopped) runtimeMarkRestartPending();
  return stopped;
}

String runtimeRecoverLights(const String& patternId, float brightness, bool syncZones) {
  if (factoryBeaconMode) clearPhysicalLeds();
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
  if (ledOutputsReady) showLeds(brightnessByte);

  uint16_t nonBlackPixels = 0;
  for (uint16_t i = 0; i < totalPixels && i < LW_MAX_PIXELS; i++) {
    if (leds[i].r || leds[i].g || leds[i].b) nonBlackPixels++;
  }

  JsonDocument doc;
  doc["ok"] = true;
  // FastLED exposes no electrical acknowledgement from the strip. Report
  // exactly what firmware can prove: the command was accepted and a visible
  // frame was prepared/submitted to the configured output controllers.
  doc["accepted"] = true;
  doc["patternId"] = id;
  JsonObject diagnostics = doc["diagnostics"].to<JsonObject>();
  diagnostics["rendered"] = rendered;
  diagnostics["framePrepared"] = totalPixels > 0;
  diagnostics["frameSubmitted"] = ledOutputsReady;
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
