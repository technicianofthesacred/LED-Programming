#include "LightweaverOutputColorParser.h"

#include <cstring>

#include "LightweaverConfigValidation.h"

namespace {
bool hasField(JsonObjectConst object, const char* key) {
  for (JsonPairConst field : object) {
    if (std::strcmp(field.key().c_str(), key) == 0) return true;
  }
  return false;
}

bool validateNumberField(
    JsonObjectConst object,
    const char* key,
    const char* path,
    float minimum,
    float maximum,
    const char*& errorPath,
    const char*& errorReason) {
  JsonVariantConst field = object[key];
  const ConfigNumberValidation validation = validateOptionalConfigNumber(
      hasField(object, key),
      field.is<float>(),
      field.as<float>(),
      minimum,
      maximum);
  switch (validation) {
    case ConfigNumberValidation::MISSING:
    case ConfigNumberValidation::VALID:
      return true;
    case ConfigNumberValidation::INVALID_TYPE:
      errorReason = "must be a number";
      break;
    case ConfigNumberValidation::NON_FINITE:
      errorReason = "must be finite";
      break;
    case ConfigNumberValidation::BELOW_MINIMUM:
    case ConfigNumberValidation::ABOVE_MAXIMUM:
      errorReason = "is outside the supported range";
      break;
  }
  errorPath = path;
  return false;
}
}

bool parseOutputColorConfig(
    JsonVariantConst ledValue,
    OutputColorConfig& destination,
    const char*& errorPath,
    const char*& errorReason) {
  errorPath = nullptr;
  errorReason = nullptr;
  OutputColorConfig parsed;

  if (ledValue.isNull()) {
    destination = parsed;
    return true;
  }
  if (!ledValue.is<JsonObjectConst>()) {
    errorPath = "led";
    errorReason = "must be an object";
    return false;
  }

  JsonObjectConst led = ledValue.as<JsonObjectConst>();
  if (hasField(led, "outputGammaEnabled")) {
    JsonVariantConst gammaEnabled = led["outputGammaEnabled"];
    if (!gammaEnabled.is<bool>()) {
      errorPath = "led.outputGammaEnabled";
      errorReason = "must be a boolean";
      return false;
    }
    parsed.gammaEnabled = gammaEnabled.as<bool>();
  }

  if (!validateNumberField(
          led,
          "outputGammaValue",
          "led.outputGammaValue",
          1.0f,
          3.0f,
          errorPath,
          errorReason)) {
    return false;
  }
  if (hasField(led, "outputGammaValue")) {
    parsed.gammaValue = led["outputGammaValue"].as<float>();
  }

  if (hasField(led, "calibration")) {
    JsonVariantConst calibrationValue = led["calibration"];
    if (!calibrationValue.is<JsonObjectConst>()) {
      errorPath = "led.calibration";
      errorReason = "must be an object";
      return false;
    }
    JsonObjectConst calibration = calibrationValue.as<JsonObjectConst>();
    if (!validateNumberField(calibration, "red", "led.calibration.red", 0.0f, 1.0f, errorPath, errorReason) ||
        !validateNumberField(calibration, "green", "led.calibration.green", 0.0f, 1.0f, errorPath, errorReason) ||
        !validateNumberField(calibration, "blue", "led.calibration.blue", 0.0f, 1.0f, errorPath, errorReason)) {
      return false;
    }
    if (hasField(calibration, "red")) parsed.red = calibration["red"].as<float>();
    if (hasField(calibration, "green")) parsed.green = calibration["green"].as<float>();
    if (hasField(calibration, "blue")) parsed.blue = calibration["blue"].as<float>();
  }

  destination = parsed;
  return true;
}
