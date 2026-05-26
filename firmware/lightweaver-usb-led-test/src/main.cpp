#include <Arduino.h>
#include <FastLED.h>

#ifndef LW_MAX_PIXELS
#define LW_MAX_PIXELS 300
#endif

constexpr uint32_t BAUD = 115200;
constexpr uint8_t DEFAULT_BRIGHTNESS = 40;
constexpr uint16_t DEFAULT_ACTIVE_PIXELS = 60;

CRGB leds[LW_MAX_PIXELS];
uint16_t activePixels = DEFAULT_ACTIVE_PIXELS;
uint8_t brightness = DEFAULT_BRIGHTNESS;
String line;

void printReady();
void printHelp();
void handleCommand(String command);
void showSolid(uint8_t r, uint8_t g, uint8_t b);
void showChase(uint8_t r, uint8_t g, uint8_t b, uint16_t waitMs = 25);
void runTestCycle();
uint8_t parseByte(const String& value, uint8_t fallback = 0);
uint16_t parseCount(const String& value);
String tokenAt(const String& command, uint8_t index);

void setup() {
  Serial.begin(BAUD);
  delay(500);

  FastLED.addLeds<WS2812B, 16, GRB>(leds, LW_MAX_PIXELS);
  FastLED.addLeds<WS2812B, 17, GRB>(leds, LW_MAX_PIXELS);
  FastLED.addLeds<WS2812B, 18, GRB>(leds, LW_MAX_PIXELS);
  FastLED.addLeds<WS2812B, 21, GRB>(leds, LW_MAX_PIXELS);
  FastLED.setBrightness(brightness);
  FastLED.setDither(false);
  FastLED.clear(true);

  printReady();
  runTestCycle();
  showSolid(255, 160, 0);
}

void loop() {
  while (Serial.available()) {
    char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      line.trim();
      if (line.length()) handleCommand(line);
      line = "";
      continue;
    }
    if (line.length() < 96) line += c;
  }
}

void printReady() {
  Serial.println();
  Serial.println("LWUSB READY firmware=lightweaver-usb-led-test version=1 pins=16,17,18,21 colorOrder=GRB");
  Serial.print("LWUSB CONFIG pixels=");
  Serial.print(activePixels);
  Serial.print(" brightness=");
  Serial.print(brightness);
  Serial.print(" maxPixels=");
  Serial.println(LW_MAX_PIXELS);
}

void printHelp() {
  Serial.println("LWUSB HELP ID? HELP CLEAR WARM TEST BRI <0-255> COUNT <1-max> SOLID <r> <g> <b> CHASE <r> <g> <b>");
}

void handleCommand(String command) {
  String op = tokenAt(command, 0);
  op.toUpperCase();

  if (op == "HELP") {
    printHelp();
    return;
  }
  if (op == "ID?") {
    printReady();
    return;
  }
  if (op == "CLEAR") {
    FastLED.clear(true);
    Serial.println("LWUSB OK clear");
    return;
  }
  if (op == "WARM") {
    showSolid(255, 160, 0);
    Serial.println("LWUSB OK warm");
    return;
  }
  if (op == "TEST") {
    runTestCycle();
    Serial.println("LWUSB OK test");
    return;
  }
  if (op == "BRI") {
    brightness = parseByte(tokenAt(command, 1), brightness);
    FastLED.setBrightness(brightness);
    FastLED.show();
    Serial.print("LWUSB OK brightness=");
    Serial.println(brightness);
    return;
  }
  if (op == "COUNT") {
    activePixels = parseCount(tokenAt(command, 1));
    showSolid(255, 160, 0);
    Serial.print("LWUSB OK pixels=");
    Serial.println(activePixels);
    return;
  }
  if (op == "SOLID") {
    showSolid(
      parseByte(tokenAt(command, 1)),
      parseByte(tokenAt(command, 2)),
      parseByte(tokenAt(command, 3))
    );
    Serial.println("LWUSB OK solid");
    return;
  }
  if (op == "CHASE") {
    showChase(
      parseByte(tokenAt(command, 1), 255),
      parseByte(tokenAt(command, 2), 160),
      parseByte(tokenAt(command, 3), 0)
    );
    Serial.println("LWUSB OK chase");
    return;
  }

  Serial.print("LWUSB ERR unknown-command ");
  Serial.println(command);
}

void showSolid(uint8_t r, uint8_t g, uint8_t b) {
  for (uint16_t i = 0; i < LW_MAX_PIXELS; i++) {
    leds[i] = i < activePixels ? CRGB(r, g, b) : CRGB::Black;
  }
  FastLED.setBrightness(brightness);
  FastLED.show();
}

void showChase(uint8_t r, uint8_t g, uint8_t b, uint16_t waitMs) {
  for (uint16_t head = 0; head < activePixels; head++) {
    fill_solid(leds, LW_MAX_PIXELS, CRGB::Black);
    for (uint8_t tail = 0; tail < 6; tail++) {
      if (head >= tail) leds[head - tail] = CRGB(r / (tail + 1), g / (tail + 1), b / (tail + 1));
    }
    FastLED.show();
    delay(waitMs);
  }
}

void runTestCycle() {
  showSolid(255, 0, 0);
  delay(450);
  showSolid(0, 255, 0);
  delay(450);
  showSolid(0, 0, 255);
  delay(450);
  showSolid(255, 255, 255);
  delay(450);
  FastLED.clear(true);
  delay(150);
}

uint8_t parseByte(const String& value, uint8_t fallback) {
  if (!value.length()) return fallback;
  int parsed = value.toInt();
  if (parsed < 0) return 0;
  if (parsed > 255) return 255;
  return static_cast<uint8_t>(parsed);
}

uint16_t parseCount(const String& value) {
  int parsed = value.toInt();
  if (parsed < 1) parsed = 1;
  if (parsed > LW_MAX_PIXELS) parsed = LW_MAX_PIXELS;
  return static_cast<uint16_t>(parsed);
}

String tokenAt(const String& command, uint8_t index) {
  uint8_t current = 0;
  int start = -1;
  for (int i = 0; i <= command.length(); i++) {
    bool atEnd = i == command.length();
    bool isSpace = !atEnd && isspace(static_cast<unsigned char>(command[i]));
    if (!atEnd && !isSpace && start < 0) start = i;
    if ((atEnd || isSpace) && start >= 0) {
      if (current == index) return command.substring(start, i);
      current++;
      start = -1;
    }
  }
  return "";
}
