#include <Arduino.h>
#include <FastLED.h>

#ifndef LW_MAX_PIXELS
#define LW_MAX_PIXELS 300
#endif

constexpr uint32_t BAUD = 115200;
constexpr uint8_t DEFAULT_BRIGHTNESS = 40;
constexpr uint16_t DEFAULT_ACTIVE_PIXELS = 60;
constexpr uint16_t MAX_COMMAND_LENGTH = (LW_MAX_PIXELS * 6) + 16;

CRGB leds[LW_MAX_PIXELS];
uint16_t activePixels = DEFAULT_ACTIVE_PIXELS;
uint8_t brightness = DEFAULT_BRIGHTNESS;
String colorOrder = "RGB";
String line;
bool lineOverflow = false;

void printReady();
void printHelp();
void handleCommand(String command);
void showSolid(uint8_t r, uint8_t g, uint8_t b);
void showChase(uint8_t r, uint8_t g, uint8_t b, uint16_t waitMs = 25);
bool showFrame(const String& hex);
CRGB orderedColor(uint8_t r, uint8_t g, uint8_t b);
void runTestCycle();
uint8_t parseByte(const String& value, uint8_t fallback = 0);
uint16_t parseCount(const String& value);
String tokenAt(const String& command, uint8_t index);
bool isValidColorOrder(const String& value);
int8_t parseHexNibble(char c);
uint8_t parseHexByte(const String& hex, uint16_t offset);

void setup() {
  Serial.begin(BAUD);
  delay(500);

  FastLED.addLeds<WS2812B, 16, RGB>(leds, LW_MAX_PIXELS);
  FastLED.addLeds<WS2812B, 17, RGB>(leds, LW_MAX_PIXELS);
  FastLED.addLeds<WS2812B, 18, RGB>(leds, LW_MAX_PIXELS);
  FastLED.addLeds<WS2812B, 21, RGB>(leds, LW_MAX_PIXELS);
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
      if (lineOverflow) {
        Serial.println("LWUSB ERR command-too-long");
      } else if (line.length()) {
        handleCommand(line);
      }
      line = "";
      lineOverflow = false;
      continue;
    }
    if (line.length() < MAX_COMMAND_LENGTH) {
      line += c;
    } else {
      lineOverflow = true;
    }
  }
}

void printReady() {
  Serial.println();
  Serial.print("LWUSB READY firmware=lightweaver-usb-led-test version=2 pins=16,17,18,21 colorOrder=");
  Serial.println(colorOrder);
  Serial.print("LWUSB CONFIG pixels=");
  Serial.print(activePixels);
  Serial.print(" brightness=");
  Serial.print(brightness);
  Serial.print(" colorOrder=");
  Serial.print(colorOrder);
  Serial.print(" maxPixels=");
  Serial.println(LW_MAX_PIXELS);
}

void printHelp() {
  Serial.println("LWUSB HELP ID? HELP CLEAR WARM TEST BRI <0-255> COUNT <1-max> ORDER <RGB|GRB|BRG|BGR|RBG|GBR> SOLID <r> <g> <b> CHASE <r> <g> <b> FRAME <rrggbb...>");
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
  if (op == "ORDER") {
    String nextOrder = tokenAt(command, 1);
    nextOrder.toUpperCase();
    if (!isValidColorOrder(nextOrder)) {
      Serial.println("LWUSB ERR invalid-color-order");
      return;
    }
    colorOrder = nextOrder;
    Serial.print("LWUSB OK colorOrder=");
    Serial.println(colorOrder);
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
  if (op == "FRAME") {
    String hex = tokenAt(command, 1);
    if (!showFrame(hex)) {
      Serial.println("LWUSB ERR invalid-frame");
      return;
    }
    Serial.print("LWUSB OK frame pixels=");
    Serial.println(hex.length() / 6);
    return;
  }

  Serial.print("LWUSB ERR unknown-command ");
  Serial.println(command);
}

void showSolid(uint8_t r, uint8_t g, uint8_t b) {
  for (uint16_t i = 0; i < LW_MAX_PIXELS; i++) {
    leds[i] = i < activePixels ? orderedColor(r, g, b) : CRGB::Black;
  }
  FastLED.setBrightness(brightness);
  FastLED.show();
}

void showChase(uint8_t r, uint8_t g, uint8_t b, uint16_t waitMs) {
  for (uint16_t head = 0; head < activePixels; head++) {
    fill_solid(leds, LW_MAX_PIXELS, CRGB::Black);
    for (uint8_t tail = 0; tail < 6; tail++) {
      if (head >= tail) leds[head - tail] = orderedColor(r / (tail + 1), g / (tail + 1), b / (tail + 1));
    }
    FastLED.show();
    delay(waitMs);
  }
}

bool showFrame(const String& hex) {
  if (!hex.length() || (hex.length() % 6) != 0) return false;
  uint16_t framePixels = hex.length() / 6;
  if (framePixels > activePixels || framePixels > LW_MAX_PIXELS) return false;

  for (uint16_t i = 0; i < LW_MAX_PIXELS; i++) leds[i] = CRGB::Black;
  for (uint16_t i = 0; i < framePixels; i++) {
    uint16_t offset = i * 6;
    if (
      parseHexNibble(hex[offset]) < 0 ||
      parseHexNibble(hex[offset + 1]) < 0 ||
      parseHexNibble(hex[offset + 2]) < 0 ||
      parseHexNibble(hex[offset + 3]) < 0 ||
      parseHexNibble(hex[offset + 4]) < 0 ||
      parseHexNibble(hex[offset + 5]) < 0
    ) {
      return false;
    }
    leds[i] = orderedColor(
      parseHexByte(hex, offset),
      parseHexByte(hex, offset + 2),
      parseHexByte(hex, offset + 4)
    );
  }
  FastLED.setBrightness(brightness);
  FastLED.show();
  return true;
}

CRGB orderedColor(uint8_t r, uint8_t g, uint8_t b) {
  if (colorOrder == "GRB") return CRGB(g, r, b);
  if (colorOrder == "BRG") return CRGB(b, r, g);
  if (colorOrder == "BGR") return CRGB(b, g, r);
  if (colorOrder == "RBG") return CRGB(r, b, g);
  if (colorOrder == "GBR") return CRGB(g, b, r);
  return CRGB(r, g, b);
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

bool isValidColorOrder(const String& value) {
  return value == "RGB" || value == "GRB" || value == "BRG" || value == "BGR" || value == "RBG" || value == "GBR";
}

int8_t parseHexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

uint8_t parseHexByte(const String& hex, uint16_t offset) {
  int8_t hi = parseHexNibble(hex[offset]);
  int8_t lo = parseHexNibble(hex[offset + 1]);
  if (hi < 0 || lo < 0) return 0;
  return static_cast<uint8_t>((hi << 4) | lo);
}
