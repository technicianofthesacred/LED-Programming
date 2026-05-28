#pragma once

#include <Arduino.h>
#include <FastLED.h>
#include <SD.h>

#ifndef LW_MAX_PIXELS
#define LW_MAX_PIXELS 1024
#endif

constexpr uint8_t LW_MAX_OUTPUTS = 4;
constexpr uint8_t LW_MAX_LOOKS = 12;
constexpr uint8_t LW_MAX_PATTERN_IDS = 12;
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
  ERROR_SEQUENCE = 5,
  ERROR_CONFIG = 6
};

enum RuntimeSource : uint8_t {
  SOURCE_DEFAULTS = 0,
  SOURCE_NVS = 1,
  SOURCE_SD = 2
};

enum WifiTransport : uint8_t {
  WIFI_TRANSPORT_AP = 0,
  WIFI_TRANSPORT_STATION = 1
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
  int encoderPress = 0;
  int encoderPressAlt = 6;
  int previous = 7;
  int next = 8;
  int blackout = 9;
  int brightness = -1;
  int statusLed = DEFAULT_STATUS_LED_PIN;
  String rotateDirection = "clockwise-brighter";
  uint8_t brightnessStep = 18;
};

struct LookConfig {
  String id;
  String label;
  String mode;
  String file;
  String preset;
  uint16_t fps = 24;
  bool loop = true;
  uint16_t fadeOutMs = 320;
  uint16_t fadeInMs = 420;
  float brightness = 0.65f;
};

struct WifiConfig {
  String ssid;
  String password;
  String hostname = "lightweaver";
};

struct RuntimeConfig {
  String mode = "factory-flash";
  RuntimeSource source = SOURCE_DEFAULTS;
  String pieceName = "Lightweaver";
  String startupLookId = "aurora";
  String ledColorOrder = "RGB";
  float brightnessLimit = 0.65f;
  OutputConfig outputs[LW_MAX_OUTPUTS];
  uint8_t outputCount = 0;
  LookConfig looks[LW_MAX_LOOKS];
  uint8_t lookCount = 0;
  ControlsConfig controls;
  WifiConfig wifi;
  WifiTransport activeTransport = WIFI_TRANSPORT_AP;
  String activeIp;
  String activeHostname;
};
