#include <Arduino.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <SD.h>
#include <SPI.h>

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

#ifndef LW_MAX_PIXELS
#define LW_MAX_PIXELS 1024
#endif

constexpr uint8_t MAX_OUTPUTS = 4;
constexpr uint8_t MAX_LOOKS = 12;
constexpr uint16_t LWSEQ_HEADER_BYTES = 64;
constexpr uint8_t DEFAULT_STATUS_LED_PIN = 2;
constexpr uint16_t DEFAULT_RENDER_FPS = 30;
constexpr uint16_t BUTTON_DEBOUNCE_MS = 180;

enum ErrorCode : uint8_t {
  ERROR_NONE = 0,
  ERROR_SD = 1,
  ERROR_PROFILE = 2,
  ERROR_PIXELS = 3,
  ERROR_PIN = 4,
  ERROR_SEQUENCE = 5
};

struct OutputConfig {
  String id;
  String name;
  uint8_t pin = 0;
  uint16_t pixels = 0;
  uint16_t start = 0;
  bool enabled = false;
};

struct ControlsConfig {
  int encoderA = 4;
  int encoderB = 5;
  int encoderPress = 6;
  int previous = 7;
  int next = 8;
  int blackout = 9;
  int brightness = 1;
  int statusLed = DEFAULT_STATUS_LED_PIN;
};

struct LookConfig {
  String id;
  String label;
  String mode;
  String file;
  String preset;
  uint16_t fps = 24;
  bool loop = true;
  uint16_t fadeOutMs = 800;
  uint16_t fadeInMs = 1200;
  float brightness = 0.35f;
};

CRGB leds[LW_MAX_PIXELS];
uint8_t frameBuffer[LW_MAX_PIXELS * 3];

OutputConfig outputs[MAX_OUTPUTS];
ControlsConfig controls;
LookConfig looks[MAX_LOOKS];

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

bool prevDown = false;
bool nextDown = false;
bool pressDown = false;
bool blackoutDown = false;
uint32_t lastPrevAt = 0;
uint32_t lastNextAt = 0;
uint32_t lastPressAt = 0;
uint32_t lastBlackoutAt = 0;
int lastEncoderA = HIGH;

bool loadProfile();
bool setupLedOutputs();
bool addLedsForPin(uint8_t pin, CRGB* start, uint16_t count);
void setupControlPins();
void handleControls();
bool buttonPressed(int pin, bool& wasDown, uint32_t& lastAt);
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
  delay(300);
  pinMode(DEFAULT_STATUS_LED_PIN, OUTPUT);
  digitalWrite(DEFAULT_STATUS_LED_PIN, LOW);

  Serial.println();
  Serial.println("Lightweaver standalone controller booting");
  SPI.begin(LW_SPI_SCK, LW_SPI_MISO, LW_SPI_MOSI, LW_SD_CS);
  if (!SD.begin(LW_SD_CS, SPI)) {
    fail(ERROR_SD, "microSD mount failed");
    return;
  }

  if (!loadProfile()) return;
  setupControlPins();

  if (!setupLedOutputs()) return;
  currentLookIndex = findStartupLook();
  fadeScale = 0.0f;

  if (!startLook(currentLookIndex)) return;
  fadeTo(1.0f, looks[currentLookIndex].fadeInMs);

  Serial.print("Ready: ");
  Serial.print(pieceName);
  Serial.print(" / ");
  Serial.print(totalPixels);
  Serial.println(" pixels");
}

void loop() {
  if (errorCode != ERROR_NONE) {
    FastLED.clear(true);
    blinkError();
    delay(5);
    return;
  }

  handleControls();
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
    if (outputCount >= MAX_OUTPUTS) break;
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
    if (lookCount >= MAX_LOOKS) break;
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

  for (uint8_t i = 0; i < outputCount; i++) {
    OutputConfig& output = outputs[i];
    if (!addLedsForPin(output.pin, leds + output.start, output.pixels)) {
      Serial.print("Unsupported LED output pin: ");
      Serial.println(output.pin);
      fail(ERROR_PIN, "unsupported LED output pin");
      return false;
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
    default:
      return false;
  }
}

void setupControlPins() {
  pinMode(controls.statusLed, OUTPUT);
  digitalWrite(controls.statusLed, HIGH);
  pinMode(controls.encoderA, INPUT_PULLUP);
  pinMode(controls.encoderB, INPUT_PULLUP);
  pinMode(controls.encoderPress, INPUT_PULLUP);
  pinMode(controls.previous, INPUT_PULLUP);
  pinMode(controls.next, INPUT_PULLUP);
  pinMode(controls.blackout, INPUT_PULLUP);
  lastEncoderA = digitalRead(controls.encoderA);
}

void handleControls() {
  if (buttonPressed(controls.next, nextDown, lastNextAt) ||
      buttonPressed(controls.encoderPress, pressDown, lastPressAt)) {
    selectLook(currentLookIndex + 1);
  }

  if (buttonPressed(controls.previous, prevDown, lastPrevAt)) {
    selectLook(currentLookIndex == 0 ? lookCount - 1 : currentLookIndex - 1);
  }

  if (buttonPressed(controls.blackout, blackoutDown, lastBlackoutAt)) {
    if (blackedOut) {
      blackedOut = false;
      fadeTo(1.0f, looks[currentLookIndex].fadeInMs);
    } else {
      fadeTo(0.0f, looks[currentLookIndex].fadeOutMs);
      FastLED.clear(true);
      blackedOut = true;
    }
  }

  int encoderA = digitalRead(controls.encoderA);
  if (encoderA != lastEncoderA && encoderA == LOW) {
    int encoderB = digitalRead(controls.encoderB);
    if (encoderB == HIGH) {
      selectLook(currentLookIndex + 1);
    } else {
      selectLook(currentLookIndex == 0 ? lookCount - 1 : currentLookIndex - 1);
    }
  }
  lastEncoderA = encoderA;
}

bool buttonPressed(int pin, bool& wasDown, uint32_t& lastAt) {
  bool isDown = digitalRead(pin) == LOW;
  uint32_t now = millis();
  bool pressed = isDown && !wasDown && now - lastAt > BUTTON_DEBOUNCE_MS;
  wasDown = isDown;
  if (pressed) lastAt = now;
  return pressed;
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

bool renderCurrentLook() {
  LookConfig& look = looks[currentLookIndex];
  if (look.mode == "sequence") return renderSequenceFrame();

  static uint32_t nextProceduralAt = 0;
  uint32_t now = millis();
  if (now < nextProceduralAt) return false;
  nextProceduralAt = now + (1000 / DEFAULT_RENDER_FPS);

  if (look.mode == "procedural") return renderProceduralFrame(look.preset);
  return renderPresetFrame(look.preset);
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
  uint32_t now = millis();
  for (uint16_t i = 0; i < totalPixels; i++) {
    if (preset == "ember") {
      uint8_t flicker = inoise8(i * 18, now / 7);
      CRGB color = CRGB(190, 48, 8);
      color.nscale8(120 + (flicker / 2));
      leds[i] = color;
    } else if (preset == "rainbow") {
      leds[i] = CHSV((i * 4 + now / 22) & 0xff, 190, 220);
    } else {
      uint8_t wave = sin8(i * 6 + now / 18);
      uint8_t hue = 118 + (wave / 5);
      leds[i] = CHSV(hue, 135 + (wave / 5), 120 + (wave / 3));
    }
  }
  return true;
}

bool renderPresetFrame(const String& preset) {
  fill_solid(leds, totalPixels, colorForPreset(preset));
  return true;
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
  float brightness = clampUnit(brightnessLimit) * clampUnit(lookBrightness) * clampUnit(fadeScale) * readBrightnessKnob();
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
