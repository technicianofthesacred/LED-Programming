#pragma once

#include <ArduinoJson.h>

#include "LightweaverOutputColorConfig.h"

bool parseOutputColorConfig(
    JsonVariantConst ledValue,
    OutputColorConfig& destination,
    const char*& errorPath,
    const char*& errorReason);
