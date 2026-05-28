#include "LightweaverStorage.h"

namespace {
constexpr const char* NVS_NAMESPACE = "lightweaver";
constexpr const char* NVS_CONFIG_KEY = "config";
constexpr const char* NVS_WIFI_KEY = "wifi";

uint16_t clampPixels(int value) {
  if (value < 1) return 1;
  if (value > LW_MAX_PIXELS) return LW_MAX_PIXELS;
  return static_cast<uint16_t>(value);
}

float clampUnit(float value) {
  if (value < 0.0f) return 0.0f;
  if (value > 1.0f) return 1.0f;
  return value;
}

void resetConfig(RuntimeConfig& config) {
  config = RuntimeConfig();
}

void applyJsonToConfig(JsonDocument& doc, RuntimeConfig& config, RuntimeSource source) {
  resetConfig(config);
  config.source = source;
  config.mode = String(doc["mode"] | (source == SOURCE_SD ? "sd-sequence" : "website-flash"));
  config.pieceName = String(doc["piece"]["name"] | "Lightweaver");
  config.startupLookId = String(doc["startupPatternId"] | doc["startupLook"] | "aurora");

  JsonObject led = doc["led"].as<JsonObject>();
  config.ledColorOrder = String(led["colorOrder"] | "RGB");
  config.brightnessLimit = clampUnit(led["brightnessLimit"] | 0.65f);

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
    int pixels = output["pixels"] | 0;
    if (pixels <= 0) continue;
    OutputConfig& next = config.outputs[config.outputCount];
    next.id = String(output["id"] | "");
    next.name = String(output["name"] | next.id.c_str());
    next.pin = output["pin"] | 16;
    next.pixels = clampPixels(pixels);
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
      zone.speed = zoneJson["speed"] | 1.0f;
      if (zone.speed < 0.05f) zone.speed = 0.05f;
      if (zone.speed > 3.0f) zone.speed = 3.0f;
      zone.hueShift = zoneJson["hueShift"] | 0;
      zone.customHue = zoneJson["customHue"] | 32;
      zone.customSaturation = zoneJson["customSaturation"] | 230;
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
          zone.ranges[zone.rangeCount].start = rangeJson["start"] | 0;
          zone.ranges[zone.rangeCount].count = rangeJson["count"] | 0;
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

bool loadNvsConfig(RuntimeConfig& config, String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, true)) {
    message = "nvs unavailable";
    return false;
  }
  String json = prefs.getString(NVS_CONFIG_KEY, "");
  prefs.end();
  if (!json.length()) {
    message = "nvs empty";
    return false;
  }
  return loadJsonString(json, config, SOURCE_NVS, message);
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

  const char* ids[] = {"aurora", "ember", "rainbow", "breathe", "scanner", "sunset", "twinkle", "wave", "custom-color"};
  const char* labels[] = {"Aurora", "Ember", "Rainbow", "Breathe", "Scanner", "Sunset", "Twinkle", "Wave", "Color"};
  for (uint8_t i = 0; i < 9; i++) {
    config.looks[i].id = ids[i];
    config.looks[i].label = labels[i];
    config.looks[i].mode = "procedural";
    config.looks[i].preset = ids[i];
    config.looks[i].brightness = 0.65f;
  }
  config.lookCount = 9;

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
  if (loadSdConfig(config, message)) {
    overlayNvsWifi(config);
    ensureDefaultZone(config);
    result.ok = true;
    result.source = SOURCE_SD;
    result.message = message;
    return result;
  }
  if (loadNvsConfig(config, message)) {
    overlayNvsWifi(config);
    ensureDefaultZone(config);
    result.ok = true;
    result.source = SOURCE_NVS;
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
  RuntimeConfig parsed;
  if (!loadJsonString(json, parsed, SOURCE_NVS, message)) return false;
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs write open failed";
    return false;
  }
  bool ok = prefs.putString(NVS_CONFIG_KEY, json) > 0;
  prefs.end();
  if (!ok) {
    message = "nvs write failed";
    return false;
  }
  WifiConfig preservedWifi = config.wifi;
  WifiTransport preservedTransport = config.activeTransport;
  String preservedIp = config.activeIp;
  String preservedHostname = config.activeHostname;
  config = parsed;
  config.wifi = preservedWifi;
  config.activeTransport = preservedTransport;
  config.activeIp = preservedIp;
  config.activeHostname = preservedHostname;
  message = "saved to internal flash";
  return true;
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
  doc["ok"] = errorCode == ERROR_NONE;
  doc["errorCode"] = uint8_t(errorCode);
  doc["mode"] = config.mode;
  doc["source"] = config.source == SOURCE_SD ? "sd" : config.source == SOURCE_NVS ? "internal-flash" : "defaults";
  doc["piece"]["name"] = config.pieceName;
  doc["led"]["pixels"] = totalPixels;
  doc["led"]["colorOrder"] = config.ledColorOrder;
  doc["currentLookIndex"] = currentLookIndex;
  doc["currentLookId"] = config.lookCount ? config.looks[currentLookIndex].id : "";
  doc["piece"]["hostname"] = config.activeHostname;
  doc["wifi"]["transport"] = config.activeTransport == WIFI_TRANSPORT_STATION ? "station" : "ap";
  doc["wifi"]["ssid"] = config.activeTransport == WIFI_TRANSPORT_STATION ? config.wifi.ssid : "";
  doc["wifi"]["hostname"] = config.activeHostname;
  doc["wifi"]["ip"] = config.activeIp;
  doc["wifi"]["configured"] = config.wifi.ssid.length() > 0;
  String output;
  serializeJson(doc, output);
  return output;
}
