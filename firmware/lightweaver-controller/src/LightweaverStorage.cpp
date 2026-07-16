#include "LightweaverStorage.h"
#include "LightweaverRuntimeApi.h"
#include <new>
#include <esp_system.h>

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

namespace {
constexpr const char* NVS_NAMESPACE = "lightweaver";
constexpr const char* NVS_LEGACY_CONFIG_KEY = "config";
constexpr const char* NVS_KNOWN_GOOD_CONFIG_KEY = "knownGoodConfig";
constexpr const char* NVS_CANDIDATE_CONFIG_KEY = "candidateConfig";
constexpr const char* NVS_CANDIDATE_STATE_KEY = "candidateState";
constexpr const char* NVS_CANDIDATE_ID_KEY = "candidateId";
constexpr const char* NVS_CONFIRMED_ID_KEY = "confirmedId";
constexpr const char* NVS_PREVIOUS_KNOWN_GOOD_KEY = "previousKnown";
constexpr const char* NVS_PROMOTION_ARMED_KEY = "promotionArmed";
constexpr const char* NVS_NO_PREVIOUS_KNOWN_GOOD = "__lightweaver_none__";
constexpr const char* NVS_DISCOVERY_ACTIVE_KEY = "discoveryActive";
constexpr const char* NVS_DISCOVERY_BATCH_KEY = "discoveryBatch";
constexpr const char* NVS_RECOVERY_PENDING_KEY = "recoveryPending";
constexpr const char* NVS_WIFI_KEY = "wifi";
constexpr size_t NVS_STRING_LIMIT = 3968;

uint16_t clampPixels(int value) {
  if (value < 1) return 1;
  if (value > LW_MAX_PIXELS) return LW_MAX_PIXELS;
  return static_cast<uint16_t>(value);
}

uint16_t clampOutputPixelsForRemaining(int value, uint16_t used) {
  if (value < 1 || used >= LW_MAX_PIXELS) return 0;
  uint16_t pixels = clampPixels(value);
  uint16_t remaining = LW_MAX_PIXELS - used;
  if (pixels > remaining) return remaining;
  return pixels;
}

uint16_t clampRangeStart(int value, uint16_t totalPixels) {
  if (value < 0 || totalPixels == 0) return 0;
  if (value >= totalPixels) return totalPixels;
  return static_cast<uint16_t>(value);
}

uint16_t clampRangeCount(int value, uint16_t start, uint16_t totalPixels) {
  if (value <= 0 || start >= totalPixels) return 0;
  uint16_t count = static_cast<uint16_t>(value > LW_MAX_PIXELS ? LW_MAX_PIXELS : value);
  uint16_t remaining = totalPixels - start;
  if (count > remaining) return remaining;
  return count;
}

float clampUnit(float value) {
  if (value < 0.0f) return 0.0f;
  if (value > 1.0f) return 1.0f;
  return value;
}

float clampSpeed(float value) {
  if (value < 0.05f) return 0.05f;
  if (value > 3.0f) return 3.0f;
  return value;
}

int16_t clampHueShift(int value) {
  if (value < -128) return -128;
  if (value > 128) return 128;
  return static_cast<int16_t>(value);
}

uint8_t clampByte(int value, uint8_t fallback) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return static_cast<uint8_t>(value);
}

uint32_t clampMilliamps(long value) {
  if (value < 0) return 0;
  if (value > static_cast<long>(LW_MAX_MILLIAMPS)) return LW_MAX_MILLIAMPS;
  return static_cast<uint32_t>(value);
}

void resetOutput(OutputConfig& output) {
  output.id = "";
  output.name = "";
  output.pin = 0;
  output.pixels = 0;
  output.start = 0;
  output.enabled = false;
}

void resetControls(ControlsConfig& controls) {
  controls.encoderA = 4;
  controls.encoderB = 5;
  controls.encoderPress = 0;
  controls.encoderPressAlt = 6;
  controls.previous = 7;
  controls.next = 8;
  controls.blackout = 9;
  controls.brightness = -1;
  controls.statusLed = DEFAULT_STATUS_LED_PIN;
  controls.rotateDirection = "clockwise-brighter";
  controls.brightnessStep = 18;
}

void resetLookZone(LookZoneConfig& zone) {
  zone.id = "";
  zone.label = "";
  zone.patternId = "aurora";
  zone.brightness = 1.0f;
  zone.speed = 1.0f;
  zone.hueShift = 0;
  zone.customHue = 32;
  zone.customSaturation = 230;
  zone.customBreathe = false;
  zone.customDrift = false;
  zone.blackout = false;
}

void resetLook(LookConfig& look) {
  look.id = "";
  look.label = "";
  look.mode = "";
  look.file = "";
  look.preset = "";
  look.fps = 24;
  look.loop = true;
  look.fadeOutMs = 320;
  look.fadeInMs = 420;
  look.brightness = 0.65f;
  for (uint8_t i = 0; i < LW_MAX_ZONES; i++) resetLookZone(look.zones[i]);
  look.zoneCount = 0;
  look.hasZoneLooks = false;
}

void resetWifi(WifiConfig& wifi) {
  wifi.ssid = "";
  wifi.password = "";
  wifi.hostname = "lightweaver";
}

void resetZone(ZoneConfig& zone) {
  zone.id = "";
  zone.label = "";
  for (uint8_t i = 0; i < LW_MAX_RANGES_PER_ZONE; i++) {
    zone.ranges[i].start = 0;
    zone.ranges[i].count = 0;
  }
  zone.rangeCount = 0;
  zone.patternId = "aurora";
  zone.brightness = 1.0f;
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

void resetConfig(RuntimeConfig& config) {
  config.mode = "factory-flash";
  config.source = SOURCE_DEFAULTS;
  config.pieceId = "";
  config.pieceName = "Lightweaver";
  config.projectRevision = 0;
  config.projectFingerprint = "";
  config.productionJobId = "";
  config.productionJobDigest = "";
  config.startupLookId = "aurora";
  config.ledColorOrder = "RGB";
  config.brightnessLimit = 0.65f;
  for (uint8_t i = 0; i < LW_MAX_OUTPUTS; i++) resetOutput(config.outputs[i]);
  config.outputCount = 0;
  for (uint8_t i = 0; i < LW_MAX_LOOKS; i++) resetLook(config.looks[i]);
  config.lookCount = 0;
  resetControls(config.controls);
  resetWifi(config.wifi);
  config.activeTransport = WIFI_TRANSPORT_AP;
  config.activeIp = "";
  config.activeHostname = "";
  for (uint8_t i = 0; i < LW_MAX_ZONES; i++) resetZone(config.zones[i]);
  config.zoneCount = 0;
  config.syncZones = true;
}

void applyJsonToConfig(JsonDocument& doc, RuntimeConfig& config, RuntimeSource source) {
  resetConfig(config);
  config.source = source;
  config.mode = String(doc["mode"] | (source == SOURCE_SD ? "sd-sequence" : "website-flash"));
  config.pieceId = String(doc["piece"]["id"] | "");
  config.pieceName = String(doc["piece"]["name"] | "Lightweaver");
  config.projectRevision = doc["projectRevision"] | 0U;
  config.projectFingerprint = String(doc["projectFingerprint"] | "");
  config.productionJobId = String(doc["productionJobId"] | "");
  config.productionJobDigest = String(doc["productionJobDigest"] | "");
  config.startupLookId = String(doc["startupPatternId"] | doc["startupLook"] | "aurora");

  JsonObject led = doc["led"].as<JsonObject>();
  config.ledColorOrder = String(led["colorOrder"] | "RGB");
  config.brightnessLimit = clampUnit(led["brightnessLimit"] | 0.65f);
  config.maxMilliamps = clampMilliamps(led["maxMilliamps"] | 0L);

  JsonObject controlsJson = doc["controls"].as<JsonObject>();
  JsonObject encoder = controlsJson["encoder"].as<JsonObject>();
  config.controls.encoderA = encoder["a"] | 4;
  config.controls.encoderB = encoder["b"] | 5;
  config.controls.encoderPress = encoder["press"] | 0;
  config.controls.encoderPressAlt = encoder["alternatePress"] | 6;
  config.controls.rotateDirection = String(encoder["rotateDirection"] | "clockwise-brighter");
  config.controls.brightnessStep = encoder["brightnessStep"] | 18;
  config.controls.previous = controlsJson["previous"] | 7;
  config.controls.next = controlsJson["next"] | 8;
  config.controls.blackout = controlsJson["blackout"] | 9;
  config.controls.brightness = controlsJson["brightness"] | -1;
  config.controls.statusLed = controlsJson["statusLed"] | DEFAULT_STATUS_LED_PIN;

  JsonObject wifi = doc["wifi"].as<JsonObject>();
  if (!wifi.isNull()) {
    config.wifi.ssid = String(wifi["ssid"] | "");
    config.wifi.password = String(wifi["password"] | "");
    config.wifi.hostname = String(wifi["hostname"] | "lightweaver");
  }

  uint16_t totalPixels = 0;
  JsonArray outputs = doc["led"]["outputs"].as<JsonArray>();
  if (outputs.isNull()) outputs = doc["outputs"].as<JsonArray>();
  for (JsonVariant outputValue : outputs) {
    if (config.outputCount >= LW_MAX_OUTPUTS) break;
    JsonObject output = outputValue.as<JsonObject>();
    uint16_t pixels = clampOutputPixelsForRemaining(output["pixels"] | 0, totalPixels);
    if (pixels == 0) continue;
    OutputConfig& next = config.outputs[config.outputCount];
    next.id = String(output["id"] | "");
    next.name = String(output["name"] | next.id.c_str());
    next.pin = output["pin"] | 16;
    next.pixels = pixels;
    next.start = totalPixels;
    next.enabled = true;
    totalPixels += next.pixels;
    config.outputCount++;
  }

  JsonArray looks = doc["looks"].as<JsonArray>();
  if (looks.isNull()) looks = doc["patterns"].as<JsonArray>();
  for (JsonVariant lookValue : looks) {
    if (config.lookCount >= LW_MAX_LOOKS) break;
    JsonObject lookJson = lookValue.as<JsonObject>();
    LookConfig& look = config.looks[config.lookCount];
    look.id = String(lookJson["id"] | "look");
    look.label = String(lookJson["label"] | look.id.c_str());
    look.mode = String(lookJson["mode"] | (config.mode == "sd-sequence" ? "sequence" : "procedural"));
    look.file = String(lookJson["file"] | "");
    look.preset = String(lookJson["preset"] | look.id.c_str());
    look.fps = lookJson["fps"] | 24;
    look.loop = lookJson["loop"] | true;
    look.fadeOutMs = lookJson["fadeOutMs"] | 320;
    look.fadeInMs = lookJson["fadeInMs"] | 420;
    look.brightness = clampUnit(lookJson["brightness"] | 0.65f);
    JsonArray lookZones = lookJson["zones"].as<JsonArray>();
    if (!lookZones.isNull()) {
      for (JsonVariant lookZoneValue : lookZones) {
        if (look.zoneCount >= LW_MAX_ZONES) break;
        JsonObject zoneJson = lookZoneValue.as<JsonObject>();
        LookZoneConfig& zone = look.zones[look.zoneCount];
        zone.id = String(zoneJson["id"] | "");
        zone.label = String(zoneJson["label"] | zone.id.c_str());
        zone.patternId = String(zoneJson["patternId"] | "aurora");
        zone.brightness = clampUnit(zoneJson["brightness"] | 1.0f);
        zone.speed = clampSpeed(zoneJson["speed"] | 1.0f);
        zone.hueShift = clampHueShift(zoneJson["hueShift"] | 0);
        zone.customHue = clampByte(zoneJson["customHue"] | 32, 32);
        zone.customSaturation = clampByte(zoneJson["customSaturation"] | 230, 230);
        zone.customBreathe = zoneJson["customBreathe"] | false;
        zone.customDrift = zoneJson["customDrift"] | false;
        zone.blackout = zoneJson["blackout"] | false;
        if (zone.id.length() > 0 && zone.patternId.length() > 0) look.zoneCount++;
      }
    }
    look.hasZoneLooks = look.zoneCount > 0;
    config.lookCount++;
  }

  // Zones — optional. If absent the caller falls back to the single-zone
  // default after this function returns.
  config.zoneCount = 0;
  JsonArray zones = doc["zones"].as<JsonArray>();
  if (!zones.isNull()) {
    config.syncZones = doc["syncZones"] | true;
    for (JsonVariant zoneValue : zones) {
      if (config.zoneCount >= LW_MAX_ZONES) break;
      JsonObject zoneJson = zoneValue.as<JsonObject>();
      ZoneConfig& zone = config.zones[config.zoneCount];
      zone.id = String(zoneJson["id"] | "");
      zone.label = String(zoneJson["label"] | zone.id.c_str());
      zone.patternId = String(zoneJson["patternId"] | "aurora");
      zone.brightness = clampUnit(zoneJson["brightness"] | 1.0f);
      zone.speed = clampSpeed(zoneJson["speed"] | 1.0f);
      zone.hueShift = clampHueShift(zoneJson["hueShift"] | 0);
      zone.customHue = clampByte(zoneJson["customHue"] | 32, 32);
      zone.customSaturation = clampByte(zoneJson["customSaturation"] | 230, 230);
      zone.customBreathe = zoneJson["customBreathe"] | false;
      zone.customDrift = zoneJson["customDrift"] | false;
      zone.driftHueMin = zoneJson["driftHueMin"] | 0;
      zone.driftHueMax = zoneJson["driftHueMax"] | 255;
      zone.blackout = zoneJson["blackout"] | false;
      zone.rangeCount = 0;
      JsonArray ranges = zoneJson["ranges"].as<JsonArray>();
      if (!ranges.isNull()) {
        for (JsonVariant rangeValue : ranges) {
          if (zone.rangeCount >= LW_MAX_RANGES_PER_ZONE) break;
          JsonObject rangeJson = rangeValue.as<JsonObject>();
          zone.ranges[zone.rangeCount].start = clampRangeStart(rangeJson["start"] | 0, totalPixels);
          zone.ranges[zone.rangeCount].count = clampRangeCount(rangeJson["count"] | 0, zone.ranges[zone.rangeCount].start, totalPixels);
          if (zone.ranges[zone.rangeCount].count > 0) zone.rangeCount++;
        }
      }
      if (zone.rangeCount > 0) config.zoneCount++;
    }
  }
}

bool loadJsonString(const String& json, RuntimeConfig& config, RuntimeSource source, String& message) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, json);
  if (error) {
    message = String("json parse failed: ") + error.c_str();
    return false;
  }
  applyJsonToConfig(doc, config, source);
  if (config.outputCount == 0 || config.lookCount == 0) {
    message = "config missing outputs or looks";
    return false;
  }
  message = "config loaded";
  return true;
}

bool supportedOutputPin(int pin) {
  return pin == 16 || pin == 17 || pin == 18 || pin == 21 ||
         pin == 38 || pin == 39 || pin == 40 || pin == 48;
}

bool isLowerHex(const String& value) {
  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

bool isSafeProductionJobId(const String& value) {
  if (!value.length() || value.length() > LW_PRODUCTION_JOB_ID_MAX_LENGTH) return false;
  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    bool alphanumeric = (c >= '0' && c <= '9') ||
                        (c >= 'A' && c <= 'Z') ||
                        (c >= 'a' && c <= 'z');
    if (!alphanumeric && c != '.' && c != '_' && c != ':' && c != '-') return false;
    if (i == 0 && !alphanumeric) return false;
  }
  return true;
}

bool validateRuntimeConfigJsonStrict(const String& json, RuntimeConfig& parsed, String& message) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, json);
  if (error) {
    message = String("json parse failed: ") + error.c_str();
    return false;
  }

  JsonVariant revision = doc["projectRevision"];
  String fingerprint = String(doc["projectFingerprint"] | "");
  if (!revision.isNull() && !revision.is<uint32_t>()) {
    message = "project revision must be a non-negative integer";
    return false;
  }
  if ((!revision.isNull() || fingerprint.length()) &&
      (fingerprint.length() < 16 || fingerprint.length() > LW_PROJECT_FINGERPRINT_MAX_LENGTH ||
       !isLowerHex(fingerprint))) {
    message = "project fingerprint must be 16 to 64 lowercase hex characters";
    return false;
  }
  if (fingerprint.length() && revision.isNull()) {
    message = "project fingerprint requires a project revision";
    return false;
  }
  String productionJobId = String(doc["productionJobId"] | "");
  if (productionJobId.length() && !isSafeProductionJobId(productionJobId)) {
    message = "production job id must use 1 to 96 safe characters";
    return false;
  }
  String productionJobDigest = String(doc["productionJobDigest"] | "");
  if (productionJobDigest.length() &&
      (productionJobDigest.length() != LW_PRODUCTION_JOB_DIGEST_LENGTH || !isLowerHex(productionJobDigest))) {
    message = "production job digest must be 64 lowercase hex characters";
    return false;
  }
  if (static_cast<bool>(productionJobId.length()) !=
      static_cast<bool>(productionJobDigest.length())) {
    message = "production job id and digest must be provided together";
    return false;
  }

  JsonArray outputJson = doc["led"]["outputs"].as<JsonArray>();
  if (outputJson.isNull()) outputJson = doc["outputs"].as<JsonArray>();
  if (outputJson.isNull() || outputJson.size() == 0) {
    message = "config missing outputs";
    return false;
  }
  if (outputJson.size() > LW_MAX_OUTPUTS) {
    message = "more than 4 outputs are not supported";
    return false;
  }

  long maxMilliamps = doc["led"]["maxMilliamps"] | 0L;
  if (maxMilliamps < 0 || maxMilliamps > static_cast<long>(LW_MAX_MILLIAMPS)) {
    message = "unsafe LED current limit";
    return false;
  }
  float brightnessLimit = doc["led"]["brightnessLimit"] | 0.65f;
  if (brightnessLimit < 0.0f || brightnessLimit > 1.0f) {
    message = "brightness limit must be between 0 and 1";
    return false;
  }

  int controlPins[] = {
    doc["controls"]["encoder"]["a"] | 4,
    doc["controls"]["encoder"]["b"] | 5,
    doc["controls"]["encoder"]["press"] | 0,
    doc["controls"]["encoder"]["alternatePress"] | 6,
    doc["controls"]["previous"] | 7,
    doc["controls"]["next"] | 8,
    doc["controls"]["blackout"] | 9,
    doc["controls"]["brightness"] | -1,
    doc["controls"]["statusLed"] | int(DEFAULT_STATUS_LED_PIN),
  };
  uint8_t outputPins[LW_MAX_OUTPUTS] = {};
  String outputIds[LW_MAX_OUTPUTS];
  uint32_t totalPixels = 0;
  uint8_t outputIndex = 0;
  for (JsonVariant value : outputJson) {
    JsonObject output = value.as<JsonObject>();
    int pin = output["pin"] | 16;
    int pixels = output["pixels"] | 0;
    String id = String(output["id"] | "");
    if (!supportedOutputPin(pin)) {
      message = String("unsupported output pin ") + pin;
      return false;
    }
    for (uint8_t i = 0; i < outputIndex; i++) {
      if (outputPins[i] == pin) {
        message = String("duplicate output pin ") + pin;
        return false;
      }
      if (id.length() && outputIds[i] == id) {
        message = String("duplicate output id ") + id;
        return false;
      }
    }
    for (int controlPin : controlPins) {
      if (controlPin >= 0 && pin == controlPin) {
        message = String("output pin conflicts with controls: ") + pin;
        return false;
      }
    }
    if (pixels <= 0) {
      message = "output pixel count must be positive";
      return false;
    }
    totalPixels += static_cast<uint32_t>(pixels);
    if (totalPixels > LW_MAX_PIXELS) {
      message = String("pixel total exceeds ") + LW_MAX_PIXELS;
      return false;
    }
    outputPins[outputIndex] = static_cast<uint8_t>(pin);
    outputIds[outputIndex] = id;
    outputIndex++;
  }

  JsonArray looks = doc["looks"].as<JsonArray>();
  if (looks.isNull()) looks = doc["patterns"].as<JsonArray>();
  if (looks.isNull() || looks.size() == 0 || looks.size() > LW_MAX_LOOKS) {
    message = "config missing looks or exceeds look limit";
    return false;
  }
  String lookIds[LW_MAX_LOOKS];
  uint8_t lookCount = 0;
  for (JsonVariant value : looks) {
    JsonObject look = value.as<JsonObject>();
    String id = String(look["id"] | "");
    String preset = String(look["preset"] | id.c_str());
    if (!id.length()) {
      message = "look id missing";
      return false;
    }
    for (uint8_t i = 0; i < lookCount; i++) {
      if (lookIds[i] == id) {
        message = String("duplicate look id ") + id;
        return false;
      }
    }
    lookIds[lookCount++] = id;
    (void)preset;
  }
  String startup = String(doc["startupPatternId"] | doc["startupLook"] | "aurora");
  bool startupFound = false;
  for (JsonVariant value : looks) {
    JsonObject look = value.as<JsonObject>();
    String id = String(look["id"] | "");
    String preset = String(look["preset"] | id.c_str());
    if (startup == id || startup == preset) startupFound = true;
  }
  if (!startupFound) {
    message = String("unknown startup look ") + startup;
    return false;
  }

  String zoneIds[LW_MAX_ZONES];
  uint8_t zoneCount = 0;
  JsonArray zones = doc["zones"].as<JsonArray>();
  if (!zones.isNull()) {
    if (zones.size() > LW_MAX_ZONES) {
      message = "zone count exceeds limit";
      return false;
    }
    for (JsonVariant value : zones) {
      JsonObject zone = value.as<JsonObject>();
      String id = String(zone["id"] | "");
      if (!id.length()) {
        message = "zone id missing";
        return false;
      }
      for (uint8_t i = 0; i < zoneCount; i++) {
        if (zoneIds[i] == id) {
          message = String("duplicate zone id ") + id;
          return false;
        }
      }
      zoneIds[zoneCount++] = id;
      JsonArray ranges = zone["ranges"].as<JsonArray>();
      if (ranges.isNull() || ranges.size() == 0 || ranges.size() > LW_MAX_RANGES_PER_ZONE) {
        message = String("invalid ranges for zone ") + id;
        return false;
      }
      for (JsonVariant rangeValue : ranges) {
        JsonObject range = rangeValue.as<JsonObject>();
        int start = range["start"] | -1;
        int count = range["count"] | 0;
        if (start < 0 || count <= 0 || uint32_t(start) + uint32_t(count) > totalPixels) {
          message = String("zone range exceeds pixel total for ") + id;
          return false;
        }
      }
    }
  }

  for (JsonVariant value : looks) {
    JsonArray lookZones = value["zones"].as<JsonArray>();
    for (JsonVariant zoneValue : lookZones) {
      String id = String(zoneValue["id"] | "");
      bool found = false;
      for (uint8_t i = 0; i < zoneCount; i++) if (zoneIds[i] == id) found = true;
      if (!found) {
        message = String("unknown zone reference ") + id;
        return false;
      }
    }
  }

  return loadJsonString(json, parsed, SOURCE_NVS, message);
}

bool loadSdConfig(RuntimeConfig& config, String& message) {
  if (!SD.begin(LW_SD_CS)) {
    message = "sd unavailable";
    return false;
  }
  File profileFile = SD.open("/lightweaver.json", FILE_READ);
  if (!profileFile) {
    message = "sd missing /lightweaver.json";
    return false;
  }
  String json = profileFile.readString();
  profileFile.close();
  return loadJsonString(json, config, SOURCE_SD, message);
}

bool loadNvsConfigKey(const char* key, RuntimeConfig& config, String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, true)) {
    message = "nvs unavailable";
    return false;
  }
  String json = prefs.getString(key, "");
  prefs.end();
  if (!json.length()) {
    message = "nvs empty";
    return false;
  }
  return loadJsonString(json, config, SOURCE_NVS, message);
}

bool loadNvsConfigKeyStrict(const char* key, RuntimeConfig& config, String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, true)) {
    message = "nvs unavailable";
    return false;
  }
  String json = prefs.getString(key, "");
  prefs.end();
  if (!json.length()) {
    message = "nvs empty";
    return false;
  }
  return validateRuntimeConfigJsonStrict(json, config, message);
}

bool nvsConfigKeyHasValue(const char* key) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, true)) return false;
  bool present = prefs.getString(key, "").length() > 0;
  prefs.end();
  return present;
}

WiringCandidateState readCandidateState(Preferences& prefs) {
  uint8_t raw = prefs.getUChar(NVS_CANDIDATE_STATE_KEY, WIRING_CANDIDATE_NONE);
  return static_cast<WiringCandidateState>(raw);
}

bool writeCandidateState(Preferences& prefs, WiringCandidateState state) {
  return prefs.putUChar(NVS_CANDIDATE_STATE_KEY, static_cast<uint8_t>(state)) > 0;
}

bool candidateIdMatches(Preferences& prefs, const String& activationId) {
  return activationId.length() > 0 &&
         prefs.getString(NVS_CANDIDATE_ID_KEY, "") == activationId;
}

bool restorePreviousKnownGood(Preferences& prefs) {
  if (!prefs.getBool(NVS_PROMOTION_ARMED_KEY, false)) {
    return !prefs.isKey(NVS_PREVIOUS_KNOWN_GOOD_KEY) ||
           prefs.remove(NVS_PREVIOUS_KNOWN_GOOD_KEY);
  }
  if (!prefs.isKey(NVS_PREVIOUS_KNOWN_GOOD_KEY)) return false;
  String previous = prefs.getString(NVS_PREVIOUS_KNOWN_GOOD_KEY, "");
  bool restored = previous == NVS_NO_PREVIOUS_KNOWN_GOOD
    ? (!prefs.isKey(NVS_KNOWN_GOOD_CONFIG_KEY) || prefs.remove(NVS_KNOWN_GOOD_CONFIG_KEY))
    : previous.length()
    ? prefs.putString(NVS_KNOWN_GOOD_CONFIG_KEY, previous) == previous.length()
    : false;
  if (!restored) return false;
  bool disarmed = prefs.putBool(NVS_PROMOTION_ARMED_KEY, false) > 0 ||
                  !prefs.getBool(NVS_PROMOTION_ARMED_KEY, false);
  if (!disarmed) return false;
  prefs.remove(NVS_PREVIOUS_KNOWN_GOOD_KEY);
  return true;
}

bool finalizeCommittedPromotion(Preferences& prefs) {
  if (readCandidateState(prefs) != WIRING_CANDIDATE_NONE) return false;
  String knownGood = prefs.getString(NVS_KNOWN_GOOD_CONFIG_KEY, "");
  String candidate = prefs.getString(NVS_CANDIDATE_CONFIG_KEY, "");
  String candidateId = prefs.getString(NVS_CANDIDATE_ID_KEY, "");
  String confirmedId = prefs.getString(NVS_CONFIRMED_ID_KEY, "");
  bool rollbackResidue = (candidate.length() && knownGood != candidate) ||
                         (!candidate.length() && candidateId.length() &&
                          confirmedId.length() && confirmedId != candidateId);
  bool disarmed = prefs.putBool(NVS_PROMOTION_ARMED_KEY, false) > 0 ||
                  !prefs.getBool(NVS_PROMOTION_ARMED_KEY, false);
  if (!disarmed) return false;
  bool confirmationCleared = !rollbackResidue || !prefs.isKey(NVS_CONFIRMED_ID_KEY) ||
                             prefs.remove(NVS_CONFIRMED_ID_KEY);
  if (!confirmationCleared) return false;
  bool previousCleared = !prefs.isKey(NVS_PREVIOUS_KNOWN_GOOD_KEY) ||
                         prefs.remove(NVS_PREVIOUS_KNOWN_GOOD_KEY);
  bool candidateCleared = !prefs.isKey(NVS_CANDIDATE_CONFIG_KEY) ||
                          prefs.remove(NVS_CANDIDATE_CONFIG_KEY);
  bool candidateIdCleared = !prefs.isKey(NVS_CANDIDATE_ID_KEY) ||
                            prefs.remove(NVS_CANDIDATE_ID_KEY);
  return previousCleared && candidateCleared && candidateIdCleared;
}

bool validateCandidateMetadataForBoot(Preferences& prefs, WiringCandidateState state,
                                      String& message) {
  for (const char* key : {NVS_CANDIDATE_CONFIG_KEY, NVS_CANDIDATE_ID_KEY,
                          NVS_CONFIRMED_ID_KEY, NVS_PREVIOUS_KNOWN_GOOD_KEY}) {
    if (prefs.isKey(key) && prefs.getType(key) != PT_STR) {
      message = "candidate metadata corrupt: invalid string metadata type";
      return false;
    }
  }
  if ((prefs.isKey(NVS_CANDIDATE_STATE_KEY) && prefs.getType(NVS_CANDIDATE_STATE_KEY) != PT_U8) ||
      (prefs.isKey(NVS_PROMOTION_ARMED_KEY) && prefs.getType(NVS_PROMOTION_ARMED_KEY) != PT_U8)) {
    message = "candidate metadata corrupt: invalid state metadata type";
    return false;
  }
  if (static_cast<uint8_t>(state) > WIRING_CANDIDATE_AWAITING_CONFIRMATION) {
    message = "candidate metadata corrupt: invalid state";
    return false;
  }
  bool armedKeyPresent = prefs.isKey(NVS_PROMOTION_ARMED_KEY);
  bool armed = prefs.getBool(NVS_PROMOTION_ARMED_KEY, false);
  bool journalPresent = prefs.isKey(NVS_PREVIOUS_KNOWN_GOOD_KEY);
  String knownGood = prefs.getString(NVS_KNOWN_GOOD_CONFIG_KEY, "");
  String candidate = prefs.getString(NVS_CANDIDATE_CONFIG_KEY, "");
  String candidateId = prefs.getString(NVS_CANDIDATE_ID_KEY, "");
  String confirmedId = prefs.getString(NVS_CONFIRMED_ID_KEY, "");

  if (state == WIRING_CANDIDATE_AWAITING_CONFIRMATION) {
    if (!armedKeyPresent || !candidate.length() || !candidateId.length() ||
        (armed && !journalPresent) || (!armed && knownGood == candidate)) {
      message = "candidate metadata corrupt: unsafe awaiting-confirmation tuple";
      return false;
    }
    return true;
  }
  if (state == WIRING_CANDIDATE_STAGED || state == WIRING_CANDIDATE_BOOTING) {
    if (!armedKeyPresent || armed || !candidate.length() || !candidateId.length()) {
      message = "candidate metadata corrupt: incomplete staged tuple";
      return false;
    }
    return true;
  }
  if (armed) {
    if (!journalPresent || !candidate.length() || !candidateId.length() ||
        confirmedId != candidateId || knownGood != candidate) {
      message = "candidate metadata corrupt: incomplete committed promotion";
      return false;
    }
  } else if (state == WIRING_CANDIDATE_NONE) {
    // A journal can remain after committed cleanup disarms, but rollback
    // removes its journal before marking NONE. Therefore a disarmed journal is
    // valid only with the complete, identity-bound committed tuple.
    if (journalPresent &&
        (!candidate.length() || !candidateId.length() ||
         confirmedId != candidateId || knownGood != candidate)) {
      message = "candidate metadata corrupt: inconsistent committed cleanup";
      return false;
    }
    if (candidate.length() && knownGood == candidate &&
        (!candidateId.length() || confirmedId != candidateId)) {
      message = "candidate metadata corrupt: inconsistent committed cleanup";
      return false;
    }
  }
  return true;
}

String makeActivationId() {
  char id[18];
  snprintf(id, sizeof(id), "%08lx%08lx",
           static_cast<unsigned long>(esp_random()),
           static_cast<unsigned long>(esp_random()));
  return String(id);
}

bool migrateLegacyKnownGood(String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs migration open failed";
    return false;
  }
  String knownGood = prefs.getString(NVS_KNOWN_GOOD_CONFIG_KEY, "");
  if (knownGood.length()) {
    prefs.end();
    return true;
  }
  String legacy = prefs.getString(NVS_LEGACY_CONFIG_KEY, "");
  if (!legacy.length()) {
    prefs.end();
    return true;
  }
  bool ok = prefs.putString(NVS_KNOWN_GOOD_CONFIG_KEY, legacy) == legacy.length();
  prefs.end();
  if (!ok) message = "known-good migration failed; legacy config preserved";
  return ok;
}

const char* candidateStateLabel(WiringCandidateState state) {
  switch (state) {
    case WIRING_CANDIDATE_STAGED: return "staged";
    case WIRING_CANDIDATE_BOOTING: return "booting";
    case WIRING_CANDIDATE_AWAITING_CONFIRMATION: return "awaiting-confirmation";
    case WIRING_CANDIDATE_NONE:
      return "none";
    default: return "invalid";
  }
}

void overlayNvsWifi(RuntimeConfig& config) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, true)) return;
  String json = prefs.getString(NVS_WIFI_KEY, "");
  prefs.end();
  if (!json.length()) return;
  JsonDocument doc;
  if (deserializeJson(doc, json)) return;
  config.wifi.ssid = String(doc["ssid"] | config.wifi.ssid.c_str());
  config.wifi.password = String(doc["password"] | config.wifi.password.c_str());
  config.wifi.hostname = String(doc["hostname"] | config.wifi.hostname.c_str());
}
}

void applyDefaultRuntimeConfig(RuntimeConfig& config) {
  resetConfig(config);
  config.source = SOURCE_DEFAULTS;
  config.mode = "factory-flash";
  config.pieceName = "Lightweaver";
  config.startupLookId = "aurora";
  config.ledColorOrder = "RGB";
  config.brightnessLimit = 0.65f;
  config.outputCount = 1;
  config.outputs[0].id = "out1";
  config.outputs[0].name = "Output 1";
  config.outputs[0].pin = 16;
  config.outputs[0].pixels = 44;
  config.outputs[0].start = 0;
  config.outputs[0].enabled = true;

  const char* ids[] = {
    "aurora", "plasma", "fire", "ocean", "ripple", "lava",
    "rainbow", "sparkle", "twinkle", "meteor", "chase", "scanner",
    "breathe", "candle", "ember", "lightning", "neon", "matrix",
    "heartbeat", "stained", "confetti", "warp", "pulse-ring", "blocks",
    "bloom", "calm", "drift", "wave", "sunset", "warm-white"
  };
  const char* labels[] = {
    "Aurora", "Plasma", "Fire", "Ocean", "Ripple", "Lava Lamp",
    "Rainbow", "Sparkle", "Twinkle", "Meteor", "Color Chase", "Scanner",
    "Breathe", "Candle", "Ember", "Lightning", "Neon", "Digital Rain",
    "Heartbeat", "Stained Glass", "Confetti", "Warp Speed", "Pulse Ring", "Color Blocks",
    "Bloom", "Calm", "Drift", "Wave", "Sunset", "Warm White"
  };
  for (uint8_t i = 0; i < 30; i++) {
    config.looks[i].id = ids[i];
    config.looks[i].label = labels[i];
    config.looks[i].mode = String(ids[i]) == "warm-white" ? "preset" : "procedural";
    config.looks[i].preset = ids[i];
    config.looks[i].brightness = 0.65f;
  }
  config.lookCount = 30;

  ensureDefaultZone(config);
}

void ensureDefaultZone(RuntimeConfig& config) {
  if (config.zoneCount > 0) return;
  // Default zone: one zone "all" covering every pixel on every output.
  // This keeps single-strip cards behaving exactly as before; the multi-zone
  // capability only surfaces when someone splits or adds a second output.
  config.zoneCount = 1;
  ZoneConfig& z = config.zones[0];
  z.id = "all";
  z.label = "All";
  z.rangeCount = 1;
  z.ranges[0].start = 0;
  uint16_t total = 0;
  for (uint8_t i = 0; i < config.outputCount; i++) total += config.outputs[i].pixels;
  if (total == 0) total = 44;
  z.ranges[0].count = total;
  z.patternId = "aurora";
  z.brightness = 1.0f;
  z.speed = 1.0f;
  z.hueShift = 0;
  z.customHue = 32;
  z.customSaturation = 230;
  z.customBreathe = false;
  z.customDrift = false;
  z.blackout = false;
  config.syncZones = true;
}

RuntimeLoadResult loadRuntimeConfig(RuntimeConfig& config) {
  String message;
  RuntimeLoadResult result;

  // Upgrade in place: copy the legacy config before consulting candidate
  // state. The legacy key is intentionally retained as a downgrade fallback.
  if (!migrateLegacyKnownGood(message)) {
    result.message = message;
  }

  WiringCandidateState state = WIRING_CANDIDATE_NONE;
  {
    Preferences prefs;
    if (prefs.begin(NVS_NAMESPACE, true)) {
      state = readCandidateState(prefs);
      if (!validateCandidateMetadataForBoot(prefs, state, message)) {
        prefs.end();
        applyDefaultRuntimeConfig(config);
        ensureDefaultZone(config);
        result.ok = true;
        result.safeMode = true;
        result.source = SOURCE_DEFAULTS;
        result.message = message + "; safe defaults loaded";
        return result;
      }
      prefs.end();
    }
  }

  if (state == WIRING_CANDIDATE_NONE) {
    Preferences prefs;
    if (prefs.begin(NVS_NAMESPACE, false)) {
      bool cleaned = finalizeCommittedPromotion(prefs);
      prefs.end();
      if (!cleaned) {
        applyDefaultRuntimeConfig(config);
        ensureDefaultZone(config);
        result.ok = true;
        result.safeMode = true;
        result.source = SOURCE_DEFAULTS;
        result.message = "candidate metadata corrupt: committed cleanup failed; safe defaults loaded";
        return result;
      }
    }
  }

  if (state == WIRING_CANDIDATE_BOOTING) {
    if (loadNvsConfigKeyStrict(NVS_CANDIDATE_CONFIG_KEY, config, message)) {
      Preferences prefs;
      bool marked = prefs.begin(NVS_NAMESPACE, false) &&
                    writeCandidateState(prefs, WIRING_CANDIDATE_AWAITING_CONFIRMATION);
      prefs.end();
      if (marked) {
        overlayNvsWifi(config);
        ensureDefaultZone(config);
        result.ok = true;
        result.source = SOURCE_NVS;
        result.bootedCandidate = true;
        result.message = "candidate loaded for wiring probation";
        return result;
      }
      message = "candidate probation marker write failed";
    }
    String rollbackMessage;
    WiringSafetyStatus status = getRuntimeWiringSafetyStatus();
    if (!rollbackCandidateRuntimeConfig(status.activationId, rollbackMessage)) {
      applyDefaultRuntimeConfig(config);
      ensureDefaultZone(config);
      result.ok = true;
      result.safeMode = true;
      result.source = SOURCE_DEFAULTS;
      result.message = "candidate rollback failed; safe defaults loaded: " + rollbackMessage;
      return result;
    }
  } else if (state == WIRING_CANDIDATE_AWAITING_CONFIRMATION) {
    // A reset during probation is itself a failed trial. Persist rollback
    // before loading so this candidate can never arm again in a reboot loop.
    WiringSafetyStatus status = getRuntimeWiringSafetyStatus();
    if (!rollbackCandidateRuntimeConfig(status.activationId, message)) {
      applyDefaultRuntimeConfig(config);
      ensureDefaultZone(config);
      result.ok = true;
      result.safeMode = true;
      result.source = SOURCE_DEFAULTS;
      result.message = "candidate rollback failed; safe defaults loaded: " + message;
      return result;
    }
  }

  bool knownGoodPresent = nvsConfigKeyHasValue(NVS_KNOWN_GOOD_CONFIG_KEY);
  if (loadNvsConfigKeyStrict(NVS_KNOWN_GOOD_CONFIG_KEY, config, message)) {
    overlayNvsWifi(config);
    ensureDefaultZone(config);
    result.ok = true;
    result.source = SOURCE_NVS;
    result.message = "known-good config loaded";
    return result;
  }

  if (knownGoodPresent) {
    // A present-but-invalid canonical slot is corruption, not absence. Do not
    // silently boot SD or reconnect using saved WiFi: use compiled-safe wiring
    // and the setup AP so recovery remains local and deterministic.
    applyDefaultRuntimeConfig(config);
    ensureDefaultZone(config);
    result.ok = true;
    result.safeMode = true;
    result.source = SOURCE_DEFAULTS;
    result.message = String("malformed known-good; safe defaults loaded: ") + message;
    return result;
  }

  if (loadSdConfig(config, message)) {
    overlayNvsWifi(config);
    ensureDefaultZone(config);
    result.ok = true;
    result.source = SOURCE_SD;
    result.message = message;
    return result;
  }
  applyDefaultRuntimeConfig(config);
  overlayNvsWifi(config);
  ensureDefaultZone(config);
  result.ok = true;
  result.source = SOURCE_DEFAULTS;
  result.message = "compiled defaults loaded";
  return result;
}

bool saveRuntimeConfigJson(const String& json, RuntimeConfig& config, String& message) {
  // ESP-IDF NVS caps a single string entry at ~4000 bytes. A large playlist
  // pushed from the Studio would otherwise fail deep in putString with an
  // opaque "nvs write failed" — reject it up front, before any deserialize or
  // heap allocation, with an actionable error.
  if (json.length() > NVS_STRING_LIMIT) {
    message = String("config too large for card storage (") + json.length() +
              " bytes, max " + NVS_STRING_LIMIT + ") — remove some looks or zones";
    return false;
  }
  RuntimeConfig* parsed = new (std::nothrow) RuntimeConfig();
  if (!parsed) {
    message = "runtime config allocation failed";
    return false;
  }
  if (!validateRuntimeConfigJsonStrict(json, *parsed, message)) {
    delete parsed;
    return false;
  }
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    delete parsed;
    message = "nvs write open failed";
    return false;
  }
  if (readCandidateState(prefs) != WIRING_CANDIDATE_NONE) {
    prefs.end();
    delete parsed;
    message = "wiring transaction is active; confirm or roll back before saving";
    return false;
  }
  if (!finalizeCommittedPromotion(prefs)) {
    prefs.end();
    delete parsed;
    message = "prior promotion cleanup failed";
    return false;
  }
  // Fence replay of the prior activation before replacing its acknowledged
  // config. A power cut may lose idempotent replay, but can never make an old
  // activation acknowledge a newer same-wiring save.
  bool confirmationCleared = !prefs.isKey(NVS_CONFIRMED_ID_KEY) ||
                             prefs.remove(NVS_CONFIRMED_ID_KEY);
  if (!confirmationCleared) {
    prefs.end();
    delete parsed;
    message = "prior confirmation fence failed";
    return false;
  }
  bool ok = prefs.putString(NVS_KNOWN_GOOD_CONFIG_KEY, json) == json.length();
  if (ok) {
    // Keep the old key as a downgrade fallback, but only after the canonical
    // known-good write succeeds.
    prefs.putString(NVS_LEGACY_CONFIG_KEY, json);
    writeCandidateState(prefs, WIRING_CANDIDATE_NONE);
    prefs.remove(NVS_CANDIDATE_CONFIG_KEY);
    prefs.remove(NVS_CANDIDATE_ID_KEY);
  }
  prefs.end();
  if (!ok) {
    delete parsed;
    message = "nvs write failed";
    return false;
  }
  WifiConfig preservedWifi = config.wifi;
  WifiTransport preservedTransport = config.activeTransport;
  String preservedIp = config.activeIp;
  String preservedHostname = config.activeHostname;
  config = *parsed;
  delete parsed;
  config.wifi = preservedWifi;
  config.activeTransport = preservedTransport;
  config.activeIp = preservedIp;
  config.activeHostname = preservedHostname;
  message = "saved to internal flash";
  return true;
}

bool stageRuntimeConfigJson(const String& json, String& activationId, String& message) {
  if (json.length() > NVS_STRING_LIMIT) {
    message = String("config too large for card storage (") + json.length() +
              " bytes, max " + NVS_STRING_LIMIT + ")";
    return false;
  }
  RuntimeConfig* parsed = new (std::nothrow) RuntimeConfig();
  if (!parsed) {
    message = "runtime config allocation failed";
    return false;
  }
  bool valid = validateRuntimeConfigJsonStrict(json, *parsed, message);
  delete parsed;
  if (!valid) return false;

  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs write open failed";
    return false;
  }
  WiringCandidateState priorState = readCandidateState(prefs);
  if (!validateCandidateMetadataForBoot(prefs, priorState, message)) {
    prefs.end();
    return false;
  }
  if (!finalizeCommittedPromotion(prefs)) {
    prefs.end();
    message = "prior promotion cleanup failed";
    return false;
  }
  activationId = makeActivationId();
  bool stored = prefs.putString(NVS_CANDIDATE_CONFIG_KEY, json) == json.length();
  bool idStored = stored && prefs.putString(NVS_CANDIDATE_ID_KEY, activationId) == activationId.length();
  bool confirmationCleared = idStored &&
    (!prefs.isKey(NVS_CONFIRMED_ID_KEY) || prefs.remove(NVS_CONFIRMED_ID_KEY));
  bool marked = confirmationCleared && writeCandidateState(prefs, WIRING_CANDIDATE_STAGED);
  if (!marked) {
    prefs.remove(NVS_CANDIDATE_CONFIG_KEY);
    prefs.remove(NVS_CANDIDATE_ID_KEY);
    writeCandidateState(prefs, WIRING_CANDIDATE_NONE);
  }
  prefs.end();
  message = marked ? "wiring candidate staged" : "candidate storage failed";
  return marked;
}

bool activateStagedRuntimeConfig(const String& activationId, String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs write open failed";
    return false;
  }
  String candidate = prefs.getString(NVS_CANDIDATE_CONFIG_KEY, "");
  WiringCandidateState state = readCandidateState(prefs);
  if (!candidate.length() || state != WIRING_CANDIDATE_STAGED ||
      !candidateIdMatches(prefs, activationId)) {
    prefs.end();
    message = "no staged wiring candidate";
    return false;
  }
  // Candidate boot owns the LED controllers. Clear discovery before arming it
  // so the following reboot can never register both topologies.
  bool discoveryCleared = prefs.putBool(NVS_DISCOVERY_ACTIVE_KEY, false) > 0;
  bool ok = discoveryCleared && writeCandidateState(prefs, WIRING_CANDIDATE_BOOTING);
  prefs.end();
  message = ok ? "candidate ready to boot" : "candidate activation failed";
  return ok;
}

bool confirmCandidateRuntimeConfig(const String& activationId, String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs write open failed";
    return false;
  }
  WiringCandidateState state = readCandidateState(prefs);
  if (!validateCandidateMetadataForBoot(prefs, state, message)) {
    prefs.end();
    return false;
  }
  String candidate = prefs.getString(NVS_CANDIDATE_CONFIG_KEY, "");
  if (state == WIRING_CANDIDATE_NONE &&
      activationId.length() > 0 &&
      prefs.getString(NVS_CONFIRMED_ID_KEY, "") == activationId) {
    bool cleaned = finalizeCommittedPromotion(prefs);
    prefs.end();
    message = cleaned ? "candidate already confirmed as known-good" : "candidate confirmed; cleanup failed";
    return cleaned;
  }
  if (state != WIRING_CANDIDATE_AWAITING_CONFIRMATION || !candidate.length() ||
      !candidateIdMatches(prefs, activationId)) {
    prefs.end();
    message = "no candidate awaiting confirmation";
    return false;
  }
  String previous = prefs.getString(NVS_KNOWN_GOOD_CONFIG_KEY, "");
  bool journaled = previous.length()
    ? prefs.putString(NVS_PREVIOUS_KNOWN_GOOD_KEY, previous) == previous.length()
    : prefs.putString(NVS_PREVIOUS_KNOWN_GOOD_KEY, NVS_NO_PREVIOUS_KNOWN_GOOD) ==
        strlen(NVS_NO_PREVIOUS_KNOWN_GOOD);
  bool armed = journaled && prefs.putBool(NVS_PROMOTION_ARMED_KEY, true) > 0;
  bool promoted = armed && prefs.putString(NVS_KNOWN_GOOD_CONFIG_KEY, candidate) == candidate.length();
  bool confirmed = promoted && prefs.putString(NVS_CONFIRMED_ID_KEY, activationId) == activationId.length();
  promoted = confirmed && writeCandidateState(prefs, WIRING_CANDIDATE_NONE);
  if (promoted) {
    prefs.putString(NVS_LEGACY_CONFIG_KEY, candidate);
    finalizeCommittedPromotion(prefs);
  } else {
    restorePreviousKnownGood(prefs);
    prefs.remove(NVS_CONFIRMED_ID_KEY);
  }
  prefs.end();
  message = promoted ? "candidate confirmed as known-good" : "candidate confirmation failed";
  return promoted;
}

bool rollbackCandidateRuntimeConfig(const String& activationId, String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs rollback open failed";
    return false;
  }
  if (!candidateIdMatches(prefs, activationId)) {
    prefs.end();
    message = "candidate activation id mismatch";
    return false;
  }
  WiringCandidateState state = readCandidateState(prefs);
  if (!validateCandidateMetadataForBoot(prefs, state, message)) {
    prefs.end();
    return false;
  }
  if (!restorePreviousKnownGood(prefs)) {
    prefs.end();
    message = "prior known-good restoration failed";
    return false;
  }
  // Clear the bootable marker first. A power loss after this write can leave
  // stale candidate bytes, but those bytes can no longer be selected at boot.
  bool safe = writeCandidateState(prefs, WIRING_CANDIDATE_NONE);
  if (safe) {
    prefs.remove(NVS_CONFIRMED_ID_KEY);
    prefs.remove(NVS_CANDIDATE_CONFIG_KEY);
    prefs.remove(NVS_CANDIDATE_ID_KEY);
  }
  prefs.end();
  message = safe ? "candidate rolled back" : "candidate rollback failed";
  return safe;
}

WiringSafetyStatus getRuntimeWiringSafetyStatus() {
  WiringSafetyStatus status;
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, true)) return status;
  status.candidateState = readCandidateState(prefs);
  status.hasKnownGood = prefs.getString(NVS_KNOWN_GOOD_CONFIG_KEY, "").length() > 0;
  status.hasCandidate = prefs.getString(NVS_CANDIDATE_CONFIG_KEY, "").length() > 0;
  if (status.hasCandidate) status.activationId = prefs.getString(NVS_CANDIDATE_ID_KEY, "");
  status.bootedCandidate = status.candidateState == WIRING_CANDIDATE_AWAITING_CONFIRMATION;
  status.discoveryActive = prefs.getBool(NVS_DISCOVERY_ACTIVE_KEY, false);
  status.discoveryBatchIndex = prefs.getUChar(NVS_DISCOVERY_BATCH_KEY, 0);
  prefs.end();
  return status;
}

String runtimeWiringSafetyStatusJson() {
  WiringSafetyStatus status = getRuntimeWiringSafetyStatus();
  JsonDocument doc;
  doc["app"] = "Lightweaver";
  doc["ok"] = true;
  doc["candidateState"] = candidateStateLabel(status.candidateState);
  doc["state"] = candidateStateLabel(status.candidateState);
  if (status.hasCandidate) doc["activationId"] = status.activationId;
  doc["hasKnownGood"] = status.hasKnownGood;
  doc["hasCandidate"] = status.hasCandidate;
  doc["bootedCandidate"] = status.bootedCandidate;
  doc["discoveryActive"] = status.discoveryActive;
  if (status.discoveryActive) doc["discoveryBatchIndex"] = status.discoveryBatchIndex;
  doc["probationMs"] = LW_WIRING_PROBATION_MS;
  if (status.hasCandidate && status.activationId.length()) {
    Preferences prefs;
    if (prefs.begin(NVS_NAMESPACE, true)) {
      String candidate = prefs.getString(NVS_CANDIDATE_CONFIG_KEY, "");
      prefs.end();
      JsonDocument candidateDoc;
      if (candidate.length() && !deserializeJson(candidateDoc, candidate)) {
        doc["cardId"] = runtimeCardId();
        doc["firmwareVersion"] = LW_FIRMWARE_VERSION;
        doc["buildId"] = LW_BUILD_ID;
        doc["projectRevision"] = candidateDoc["projectRevision"] | 0U;
        doc["projectFingerprint"] = String(candidateDoc["projectFingerprint"] | "");
        doc["productionJobId"] = String(candidateDoc["productionJobId"] | "");
        doc["productionJobDigest"] = String(candidateDoc["productionJobDigest"] | "");
      }
    }
  }
  String out;
  serializeJson(doc, out);
  return out;
}

bool runtimeConfigJsonChangesWiring(const String& json, const RuntimeConfig& current,
                                    bool& changes, String& message) {
  changes = false;
  RuntimeConfig* parsed = new (std::nothrow) RuntimeConfig();
  if (!parsed) {
    message = "runtime config allocation failed";
    return false;
  }
  bool valid = validateRuntimeConfigJsonStrict(json, *parsed, message);
  if (!valid) {
    delete parsed;
    return false;
  }
  changes = parsed->outputCount != current.outputCount;
  for (uint8_t i = 0; !changes && i < parsed->outputCount; i++) {
    const OutputConfig& next = parsed->outputs[i];
    const OutputConfig& active = current.outputs[i];
    changes = next.id != active.id || next.pin != active.pin ||
              next.pixels != active.pixels;
  }
  delete parsed;
  message = changes ? "physical wiring changed" : "physical wiring unchanged";
  return true;
}

bool setRuntimeWiringDiscoveryBatch(uint8_t batchIndex, String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs discovery open failed";
    return false;
  }
  bool batchStored = prefs.putUChar(NVS_DISCOVERY_BATCH_KEY, batchIndex) > 0;
  bool activeStored = batchStored && prefs.putBool(NVS_DISCOVERY_ACTIVE_KEY, true) > 0;
  if (!activeStored) prefs.putBool(NVS_DISCOVERY_ACTIVE_KEY, false);
  prefs.end();
  message = activeStored ? "discovery batch ready to boot" : "discovery state write failed";
  return activeStored;
}

bool clearRuntimeWiringDiscovery(String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs discovery open failed";
    return false;
  }
  // Clear the boot marker first. The remembered batch is inert without it.
  bool cleared = prefs.putBool(NVS_DISCOVERY_ACTIVE_KEY, false) > 0;
  prefs.end();
  message = cleared ? "discovery stopped" : "discovery state clear failed";
  return cleared;
}

bool armRuntimeRecoveryAfterRestart(String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs recovery open failed";
    return false;
  }
  bool armed = prefs.putBool(NVS_RECOVERY_PENDING_KEY, true) > 0;
  prefs.end();
  message = armed ? "recovery armed for restart" : "recovery intent write failed";
  return armed;
}

bool runtimeRecoveryAfterRestartPending() {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, true)) return false;
  bool pending = prefs.getBool(NVS_RECOVERY_PENDING_KEY, false);
  prefs.end();
  return pending;
}

bool clearRuntimeRecoveryAfterRestart(String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs recovery open failed";
    return false;
  }
  bool cleared = prefs.putBool(NVS_RECOVERY_PENDING_KEY, false) > 0;
  prefs.end();
  message = cleared ? "recovery intent completed" : "recovery intent clear failed";
  return cleared;
}

bool saveWifiConfigJson(const String& json, RuntimeConfig& config, String& message) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    message = String("json parse failed: ") + err.c_str();
    return false;
  }
  String ssid = String(doc["ssid"] | "");
  if (!ssid.length()) {
    message = "wifi ssid missing";
    return false;
  }
  String password = String(doc["password"] | "");
  String hostname = String(doc["hostname"] | "lightweaver");
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs write open failed";
    return false;
  }
  JsonDocument out;
  out["ssid"] = ssid;
  out["password"] = password;
  out["hostname"] = hostname;
  String serialized;
  serializeJson(out, serialized);
  bool ok = prefs.putString(NVS_WIFI_KEY, serialized) > 0;
  prefs.end();
  if (!ok) {
    message = "nvs write failed";
    return false;
  }
  config.wifi.ssid = ssid;
  config.wifi.password = password;
  config.wifi.hostname = hostname;
  message = "wifi credentials saved";
  return true;
}

String runtimeStatusJson(const RuntimeConfig& config, ErrorCode errorCode, uint16_t totalPixels, uint8_t currentLookIndex) {
  JsonDocument doc;
  char cardId[16] = {};
  snprintf(cardId, sizeof(cardId), "lw-%012llx",
           static_cast<unsigned long long>(ESP.getEfuseMac() & 0xFFFFFFFFFFFFULL));
  doc["cardId"] = cardId;
  doc["firmwareVersion"] = LW_FIRMWARE_VERSION;
  doc["buildId"] = LW_BUILD_ID;
  doc["configSchemaVersion"] = LW_CONFIG_SCHEMA_VERSION;
  doc["capabilitiesVersion"] = LW_CAPABILITIES_VERSION;
  doc["ok"] = errorCode == ERROR_NONE;
  doc["errorCode"] = uint8_t(errorCode);
  doc["mode"] = config.mode;
  doc["source"] = config.source == SOURCE_SD ? "sd" : config.source == SOURCE_NVS ? "internal-flash" : "defaults";
  doc["runtimeSource"] = config.source == SOURCE_SD ? "sd" : config.source == SOURCE_NVS ? "internal-flash" : "defaults";
  doc["resetReason"] = static_cast<uint8_t>(esp_reset_reason());
  uint32_t remainingProbationMs = runtimeWiringProbationRemainingMs();
  doc["wiringProbation"]["active"] = remainingProbationMs > 0;
  doc["wiringProbation"]["remainingMs"] = remainingProbationMs;
  doc["limits"]["pixels"] = LW_MAX_PIXELS;
  doc["limits"]["outputs"] = LW_MAX_OUTPUTS;
  doc["limits"]["looks"] = LW_MAX_LOOKS;
  doc["limits"]["zones"] = LW_MAX_ZONES;
  doc["limits"]["rangesPerZone"] = LW_MAX_RANGES_PER_ZONE;
  doc["limits"]["configStorageBytes"] = NVS_STRING_LIMIT;
  doc["piece"]["name"] = config.pieceName;
  doc["led"]["pixels"] = totalPixels;
  doc["led"]["colorOrder"] = config.ledColorOrder;
  doc["led"]["maxMilliamps"] = config.maxMilliamps;
  doc["currentLookIndex"] = currentLookIndex;
  doc["currentLookId"] = config.lookCount ? config.looks[currentLookIndex].id : "";
  doc["piece"]["hostname"] = config.activeHostname;
  JsonArray outputArray = doc["outputs"].to<JsonArray>();
  for (uint8_t i = 0; i < config.outputCount; i++) {
    JsonObject output = outputArray.add<JsonObject>();
    output["id"] = config.outputs[i].id;
    output["pin"] = config.outputs[i].pin;
    output["pixels"] = config.outputs[i].pixels;
    output["gpio"] = config.outputs[i].pin;
    output["count"] = config.outputs[i].pixels;
  }
  doc["wifi"]["transport"] = config.activeTransport == WIFI_TRANSPORT_STATION ? "station" : "ap";
  doc["wifi"]["hostname"] = config.activeHostname;
  doc["wifi"]["ip"] = config.activeIp;
  doc["wifi"]["configured"] = config.wifi.ssid.length() > 0;
  String output;
  serializeJson(doc, output);
  return output;
}
