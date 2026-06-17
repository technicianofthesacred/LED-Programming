#pragma once

#include <Arduino.h>
#include <FastLED.h>
#include <SD.h>

#ifndef LW_MAX_PIXELS
#define LW_MAX_PIXELS 1024
#endif

constexpr uint8_t LW_MAX_OUTPUTS = 4;
constexpr uint8_t LW_MAX_LOOKS = 32;
constexpr uint8_t LW_MAX_PATTERN_IDS = 32;
constexpr uint8_t LW_MAX_ZONES = 10;
constexpr uint8_t LW_MAX_RANGES_PER_ZONE = 4;
constexpr uint8_t LW_MAX_ARTNET_UNIVERSES = 8;

// Upper clamp for the FastLED power limiter ceiling (5V rail, milliamps). A
// single ESP32-S3 LED card runs off a modest PSU; 20A / 100W is a generous
// ceiling for one card. Clamping a config-supplied value here stops a bad
// (or hostile) maxMilliamps from disabling the brownout-protection limiter
// or implying a draw the wiring can't carry.
constexpr uint32_t LW_MAX_MILLIAMPS = 20000;

// One Art-Net universe → contiguous pixel range mapping. A single Madrix
// patch typically streams several universes back-to-back; the card decodes
// each into the global leds[] buffer at the configured offset.
struct ArtnetUniverseConfig {
  uint16_t universe = 0;     // 0..255 (net=0, subnet=0 assumed)
  uint16_t pixelStart = 0;   // first pixel index in leds[]
  uint16_t pixelCount = 0;   // number of RGB pixels, max 170 per universe
};
constexpr uint16_t LWSEQ_HEADER_BYTES = 64;
constexpr uint8_t DEFAULT_STATUS_LED_PIN = 2;
constexpr uint16_t DEFAULT_RENDER_FPS = 30;
constexpr uint16_t BUTTON_DEBOUNCE_MS = 45;

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

struct LookZoneConfig {
  String id;
  String label;
  String patternId = "aurora";
  float brightness = 1.0f;
  float speed = 1.0f;
  int16_t hueShift = 0;
  uint8_t customHue = 32;
  uint8_t customSaturation = 230;
  bool customBreathe = false;
  bool customDrift = false;
  bool blackout = false;
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
  LookZoneConfig zones[LW_MAX_ZONES];
  uint8_t zoneCount = 0;
  bool hasZoneLooks = false;
};

struct WifiConfig {
  String ssid;
  String password;
  String hostname = "lightweaver";
};

// A contiguous run of pixels on the global LED buffer.
// Multiple ranges per zone let a single zone span discontinuous segments
// (e.g. two physical strips chained behind one logical "outer ring").
struct PixelRange {
  uint16_t start = 0;
  uint16_t count = 0;
};

// One controllable area of LEDs. Has its own pattern + appearance state,
// so each zone can play something independent. The card-side default is
// a single zone covering all pixels named "all"; the website's design
// surface is what splits a card into multiple zones.
struct ZoneConfig {
  String id;
  String label;
  PixelRange ranges[LW_MAX_RANGES_PER_ZONE];
  uint8_t rangeCount = 0;
  String patternId = "aurora";
  float brightness = 1.0f;
  float speed = 1.0f;
  int16_t hueShift = 0;
  uint8_t customHue = 32;
  uint8_t customSaturation = 230;
  bool customBreathe = false;
  bool customDrift = false;
  // Drift palette bounds. Default 0..255 = full rainbow. Warm = 0..60,
  // Cool = 130..200. Custom lets the owner pick any range.
  uint8_t driftHueMin = 0;
  uint8_t driftHueMax = 255;
  bool blackout = false;
};

struct RuntimeConfig {
  String mode = "factory-flash";
  RuntimeSource source = SOURCE_DEFAULTS;
  String pieceId;
  String pieceName = "Lightweaver";
  String startupLookId = "aurora";
  String ledColorOrder = "RGB";
  float brightnessLimit = 0.65f;
  // Optional total current ceiling (5V rail, milliamps) for FastLED's automatic
  // power limiter. 0 = disabled (no cap). Set to the PSU rating to prevent
  // full-white brownout resets.
  uint32_t maxMilliamps = 0;
  OutputConfig outputs[LW_MAX_OUTPUTS];
  uint8_t outputCount = 0;
  LookConfig looks[LW_MAX_LOOKS];
  uint8_t lookCount = 0;
  ControlsConfig controls;
  WifiConfig wifi;
  WifiTransport activeTransport = WIFI_TRANSPORT_AP;
  String activeIp;
  String activeHostname;
  ZoneConfig zones[LW_MAX_ZONES];
  uint8_t zoneCount = 0;
  // When true (default), control writes apply to every zone identically — the
  // card looks single-zone to the casual visitor. When false, controls target
  // a specific zone, exposing the multi-zone capability.
  bool syncZones = true;
};
