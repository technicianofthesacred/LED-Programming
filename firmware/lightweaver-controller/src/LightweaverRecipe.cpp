#include <ArduinoJson.h>

#include "LightweaverRecipe.h"

#include <cmath>
#include <cstring>

namespace lightweaver {
namespace {

struct RegisteredRecipe {
  bool occupied = false;
  char routeId[LW_RECIPE_MAX_ID_BYTES + 1] = {};
  NativeRecipe recipe;
};

RegisteredRecipe registry[LW_RECIPE_REGISTRY_SIZE];

bool fail(RecipeParseError& error, RecipeParseErrorCode code,
          const char* path, const char* message) {
  error.code = code;
  error.path = path;
  error.message = message;
  return false;
}

bool hasField(JsonObjectConst object, const char* key) {
  for (JsonPairConst field : object) {
    if (std::strcmp(field.key().c_str(), key) == 0) return true;
  }
  return false;
}

bool readFloat(JsonObjectConst object, const char* key, const char* path,
               float minimum, float maximum, float& destination,
               RecipeParseError& error) {
  if (!hasField(object, key)) return true;
  JsonVariantConst value = object[key];
  if (!value.is<float>()) {
    return fail(error, RecipeParseErrorCode::InvalidType, path, "must be a number");
  }
  const float parsed = value.as<float>();
  if (!std::isfinite(parsed) || parsed < minimum || parsed > maximum) {
    return fail(error, RecipeParseErrorCode::InvalidValue, path,
                "must be finite and inside the supported range");
  }
  destination = parsed;
  return true;
}

bool readUint32(JsonObjectConst object, const char* key, const char* path,
                uint32_t maximum, uint32_t& destination,
                RecipeParseErrorCode overflowCode, RecipeParseError& error) {
  if (!hasField(object, key)) return true;
  JsonVariantConst value = object[key];
  if (!value.is<uint32_t>()) {
    return fail(error, RecipeParseErrorCode::InvalidType, path,
                "must be a non-negative integer");
  }
  const uint32_t parsed = value.as<uint32_t>();
  if (parsed > maximum) {
    return fail(error, overflowCode, path, "exceeds the supported limit");
  }
  destination = parsed;
  return true;
}

int hexNibble(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return 10 + value - 'a';
  if (value >= 'A' && value <= 'F') return 10 + value - 'A';
  return -1;
}

bool parseColor(const char* text, RecipeColor& color) {
  if (!text || std::strlen(text) != 7 || text[0] != '#') return false;
  int values[6];
  for (uint8_t index = 0; index < 6; index++) {
    values[index] = hexNibble(text[index + 1]);
    if (values[index] < 0) return false;
  }
  color.red = static_cast<uint8_t>((values[0] << 4) | values[1]);
  color.green = static_cast<uint8_t>((values[2] << 4) | values[3]);
  color.blue = static_cast<uint8_t>((values[4] << 4) | values[5]);
  return true;
}

bool parseSourceNode(const char* node, RecipeSourceNode& parsed,
                     RecipeParseError& error) {
  if (std::strcmp(node, "solid") == 0) parsed = RecipeSourceNode::Solid;
  else if (std::strcmp(node, "palette") == 0) parsed = RecipeSourceNode::Palette;
  else if (std::strcmp(node, "wave") == 0) parsed = RecipeSourceNode::Wave;
  else if (std::strcmp(node, "fastled-noise") == 0) parsed = RecipeSourceNode::FastLedNoise;
  else if (std::strcmp(node, "hash-sparkle") == 0) parsed = RecipeSourceNode::HashSparkle;
  else if (std::strcmp(node, "particles") == 0 ||
           std::strcmp(node, "reaction-diffusion") == 0 ||
           std::strcmp(node, "graph") == 0 ||
           std::strcmp(node, "shader") == 0 ||
           std::strcmp(node, "audio") == 0) {
    return fail(error, RecipeParseErrorCode::BakeOnly,
                "recipe.layers[].source.node",
                "stateful, graph, shader, and audio sources are bake-only");
  } else {
    return fail(error, RecipeParseErrorCode::UnsupportedNode,
                "recipe.layers[].source.node", "unsupported source node");
  }
  return true;
}

bool parseBlend(const char* blend, RecipeBlendMode& parsed,
                RecipeParseError& error) {
  if (std::strcmp(blend, "add") == 0) parsed = RecipeBlendMode::Add;
  else if (std::strcmp(blend, "max") == 0) parsed = RecipeBlendMode::Max;
  else if (std::strcmp(blend, "multiply") == 0) parsed = RecipeBlendMode::Multiply;
  else if (std::strcmp(blend, "crossfade") == 0) parsed = RecipeBlendMode::Crossfade;
  else return fail(error, RecipeParseErrorCode::UnsupportedNode,
                   "recipe.layers[].blend", "unsupported blend mode");
  return true;
}

bool parseTransform(JsonVariantConst value, RecipeTransform& transform,
                    RecipeParseError& error) {
  if (!value.is<JsonObjectConst>()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[].transforms[]", "must be an object");
  }
  JsonObjectConst object = value.as<JsonObjectConst>();
  if (!object["node"].is<const char*>()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[].transforms[].node", "must be a string");
  }
  const char* node = object["node"].as<const char*>();
  if (std::strcmp(node, "scale") == 0) {
    transform.node = RecipeTransformNode::Scale;
    transform.amount = 1.0f;
    return readFloat(object, "amount", "recipe.layers[].transforms[].amount",
                     0.125f, 8.0f, transform.amount, error);
  }
  if (std::strcmp(node, "offset") == 0) {
    transform.node = RecipeTransformNode::Offset;
    transform.amount = 0.0f;
    return readFloat(object, "amount", "recipe.layers[].transforms[].amount",
                     -8.0f, 8.0f, transform.amount, error);
  }
  if (std::strcmp(node, "repeat") == 0) {
    transform.node = RecipeTransformNode::Repeat;
    if (!object["count"].is<uint8_t>()) {
      return fail(error, RecipeParseErrorCode::InvalidType,
                  "recipe.layers[].transforms[].count", "must be an integer");
    }
    const uint8_t count = object["count"].as<uint8_t>();
    if (count < 1 || count > 16) {
      return fail(error, RecipeParseErrorCode::InvalidValue,
                  "recipe.layers[].transforms[].count", "must be between 1 and 16");
    }
    transform.amount = static_cast<float>(count);
    return true;
  }
  if (std::strcmp(node, "mirror") == 0) {
    transform.node = RecipeTransformNode::Mirror;
    transform.amount = 1.0f;
    return true;
  }
  return fail(error, RecipeParseErrorCode::UnsupportedNode,
              "recipe.layers[].transforms[].node", "unsupported transform node");
}

bool parseMask(JsonVariantConst value, NativeRecipeLayer& layer,
               RecipeParseError& error) {
  if (value.isNull()) return true;
  if (!value.is<JsonObjectConst>()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[].mask", "must be an object");
  }
  JsonObjectConst object = value.as<JsonObjectConst>();
  if (!object["node"].is<const char*>()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[].mask.node", "must be a string");
  }
  const char* node = object["node"].as<const char*>();
  if (std::strcmp(node, "radial-mask") == 0) {
    layer.mask = RecipeMaskNode::Radial;
    return readFloat(object, "center", "recipe.layers[].mask.center",
                     0.0f, 1.0f, layer.maskCenter, error) &&
           readFloat(object, "radius", "recipe.layers[].mask.radius",
                     0.001f, 1.0f, layer.maskRadius, error) &&
           readFloat(object, "softness", "recipe.layers[].mask.softness",
                     0.0f, 1.0f, layer.maskSoftness, error);
  }
  if (std::strcmp(node, "linear-mask") == 0) {
    layer.mask = RecipeMaskNode::Linear;
    if (!readFloat(object, "start", "recipe.layers[].mask.start",
                   0.0f, 1.0f, layer.maskStart, error) ||
        !readFloat(object, "end", "recipe.layers[].mask.end",
                   0.0f, 1.0f, layer.maskEnd, error) ||
        !readFloat(object, "softness", "recipe.layers[].mask.softness",
                   0.0f, 1.0f, layer.maskSoftness, error)) return false;
    if (layer.maskEnd <= layer.maskStart) {
      return fail(error, RecipeParseErrorCode::InvalidValue,
                  "recipe.layers[].mask", "linear mask end must exceed start");
    }
    return true;
  }
  return fail(error, RecipeParseErrorCode::UnsupportedNode,
              "recipe.layers[].mask.node", "unsupported mask node");
}

bool parseModulator(JsonVariantConst value, RecipeModulator& modulator,
                    RecipeParseError& error) {
  if (!value.is<JsonObjectConst>()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[].modulators[]", "must be an object");
  }
  JsonObjectConst object = value.as<JsonObjectConst>();
  if (!object["node"].is<const char*>()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[].modulators[].node", "must be a string");
  }
  const char* node = object["node"].as<const char*>();
  if (std::strcmp(node, "lfo") == 0) modulator.node = RecipeModulatorNode::Lfo;
  else if (std::strcmp(node, "noise-clock") == 0) modulator.node = RecipeModulatorNode::NoiseClock;
  else return fail(error, RecipeParseErrorCode::UnsupportedNode,
                   "recipe.layers[].modulators[].node", "unsupported modulator node");

  uint32_t seed = modulator.seed;
  if (!readUint32(object, "seed", "recipe.layers[].modulators[].seed",
                  UINT32_MAX, seed, RecipeParseErrorCode::InvalidValue, error)) return false;
  modulator.seed = seed;
  return readFloat(object, "rate", "recipe.layers[].modulators[].rate",
                   0.001f, 8.0f, modulator.rate, error) &&
         readFloat(object, "depth", "recipe.layers[].modulators[].depth",
                   0.0f, 1.0f, modulator.depth, error) &&
         readFloat(object, "offset", "recipe.layers[].modulators[].offset",
                   0.0f, 1.0f, modulator.offset, error);
}

bool parseLayer(JsonVariantConst value, uint8_t paletteCount,
                NativeRecipeLayer& layer, RecipeParseError& error) {
  if (!value.is<JsonObjectConst>()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[]", "must be an object");
  }
  JsonObjectConst object = value.as<JsonObjectConst>();
  JsonVariantConst sourceValue = object["source"];
  if (!sourceValue.is<JsonObjectConst>()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[].source", "must be an object");
  }
  JsonObjectConst source = sourceValue.as<JsonObjectConst>();
  if (!source["node"].is<const char*>()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[].source.node", "must be a string");
  }
  if (!parseSourceNode(source["node"].as<const char*>(), layer.source, error)) return false;

  uint32_t colorIndex = layer.colorIndex;
  if (!readUint32(source, "colorIndex", "recipe.layers[].source.colorIndex",
                  paletteCount - 1, colorIndex, RecipeParseErrorCode::InvalidValue, error)) return false;
  layer.colorIndex = static_cast<uint8_t>(colorIndex);
  if (!readFloat(source, "frequency", "recipe.layers[].source.frequency",
                 0.01f, 32.0f, layer.frequency, error) ||
      !readFloat(source, "speed", "recipe.layers[].source.speed",
                 -8.0f, 8.0f, layer.speed, error) ||
      !readFloat(source, "phase", "recipe.layers[].source.phase",
                 -8.0f, 8.0f, layer.phase, error) ||
      !readFloat(source, "scale", "recipe.layers[].source.scale",
                 0.01f, 32.0f, layer.scale, error) ||
      !readFloat(source, "density", "recipe.layers[].source.density",
                 0.0f, 1.0f, layer.density, error) ||
      !readFloat(source, "brightness", "recipe.layers[].source.brightness",
                 0.0f, 1.0f, layer.brightness, error)) return false;

  if (hasField(object, "blend")) {
    if (!object["blend"].is<const char*>()) {
      return fail(error, RecipeParseErrorCode::InvalidType,
                  "recipe.layers[].blend", "must be a string");
    }
    if (!parseBlend(object["blend"].as<const char*>(), layer.blend, error)) return false;
  }
  if (!readFloat(object, "opacity", "recipe.layers[].opacity",
                 0.0f, 1.0f, layer.opacity, error)) return false;
  if (hasField(object, "threshold")) {
    layer.thresholdEnabled = true;
    if (!readFloat(object, "threshold", "recipe.layers[].threshold",
                   0.0f, 1.0f, layer.threshold, error)) return false;
  }

  JsonArrayConst transforms = object["transforms"].as<JsonArrayConst>();
  if (!object["transforms"].isNull() && transforms.isNull()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[].transforms", "must be an array");
  }
  if (transforms.size() > LW_RECIPE_MAX_TRANSFORMS) {
    return fail(error, RecipeParseErrorCode::LimitExceeded,
                "recipe.layers[].transforms", "too many transforms");
  }
  for (JsonVariantConst transform : transforms) {
    if (!parseTransform(transform, layer.transforms[layer.transformCount], error)) return false;
    layer.transformCount++;
  }
  if (!parseMask(object["mask"], layer, error)) return false;

  JsonArrayConst modulators = object["modulators"].as<JsonArrayConst>();
  if (!object["modulators"].isNull() && modulators.isNull()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers[].modulators", "must be an array");
  }
  if (modulators.size() > LW_RECIPE_MAX_MODULATORS) {
    return fail(error, RecipeParseErrorCode::LimitExceeded,
                "recipe.layers[].modulators", "too many modulators");
  }
  for (JsonVariantConst modulator : modulators) {
    if (!parseModulator(modulator, layer.modulators[layer.modulatorCount], error)) return false;
    layer.modulatorCount++;
  }
  return true;
}

}  // namespace

bool parseNativeRecipeV1(JsonVariantConst value, size_t serializedBytes,
                         NativeRecipe& destination, RecipeParseError& error) {
  error = RecipeParseError{};
  if (serializedBytes > LW_RECIPE_MAX_CONFIG_BYTES) {
    return fail(error, RecipeParseErrorCode::LimitExceeded, "recipe",
                "serialized recipe exceeds card storage limit");
  }
  if (!value.is<JsonObjectConst>()) {
    return fail(error, RecipeParseErrorCode::InvalidType, "recipe",
                "must be an object");
  }
  JsonObjectConst object = value.as<JsonObjectConst>();
  if (!object["version"].is<uint8_t>() ||
      object["version"].as<uint8_t>() != LW_RECIPE_SCHEMA_VERSION) {
    return fail(error, RecipeParseErrorCode::UnsupportedVersion,
                "recipe.version", "only recipe schema v1 is supported");
  }

  NativeRecipe parsed;
  parsed.version = LW_RECIPE_SCHEMA_VERSION;
  if (!object["id"].is<const char*>()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.id", "must be a string");
  }
  const char* id = object["id"].as<const char*>();
  const size_t idLength = std::strlen(id);
  if (idLength == 0 || idLength > LW_RECIPE_MAX_ID_BYTES) {
    return fail(error, RecipeParseErrorCode::InvalidValue,
                "recipe.id", "must contain 1 to 64 bytes");
  }
  std::memcpy(parsed.id, id, idLength + 1);
  if (!readUint32(object, "seed", "recipe.seed", UINT32_MAX, parsed.seed,
                  RecipeParseErrorCode::InvalidValue, error)) return false;

  JsonArrayConst palette = object["palette"].as<JsonArrayConst>();
  if (palette.isNull() || palette.size() < LW_RECIPE_MIN_PALETTE_COLORS ||
      palette.size() > LW_RECIPE_MAX_PALETTE_COLORS) {
    return fail(error, RecipeParseErrorCode::InvalidValue,
                "recipe.palette", "must contain 2 to 8 colors");
  }
  for (JsonVariantConst value : palette) {
    if (!value.is<const char*>() ||
        !parseColor(value.as<const char*>(), parsed.palette[parsed.paletteCount])) {
      return fail(error, RecipeParseErrorCode::InvalidValue,
                  "recipe.palette[]", "must be a #RRGGBB color");
    }
    parsed.paletteCount++;
  }

  JsonObjectConst estimates = object["estimates"].as<JsonObjectConst>();
  if (!object["estimates"].isNull() && estimates.isNull()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.estimates", "must be an object");
  }
  if (!estimates.isNull()) {
    if (!readUint32(estimates, "operationsPerFrame",
                    "recipe.estimates.operationsPerFrame",
                    LW_RECIPE_MAX_OPERATIONS_PER_FRAME,
                    parsed.estimatedOperationsPerFrame,
                    RecipeParseErrorCode::LimitExceeded, error)) return false;
    uint32_t stateBytes = parsed.estimatedStateBytes;
    if (!readUint32(estimates, "stateBytes", "recipe.estimates.stateBytes",
                    LW_RECIPE_MAX_STATE_BYTES, stateBytes,
                    RecipeParseErrorCode::LimitExceeded, error)) return false;
    parsed.estimatedStateBytes = static_cast<uint16_t>(stateBytes);
  }

  JsonArrayConst requirements = object["requirements"].as<JsonArrayConst>();
  if (!object["requirements"].isNull() && requirements.isNull()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.requirements", "must be an array");
  }
  for (JsonVariantConst requirementValue : requirements) {
    if (!requirementValue.is<JsonObjectConst>()) {
      return fail(error, RecipeParseErrorCode::InvalidType,
                  "recipe.requirements[]", "must be an object");
    }
    JsonObjectConst requirement = requirementValue.as<JsonObjectConst>();
    if (!requirement["capability"].is<const char*>()) {
      return fail(error, RecipeParseErrorCode::InvalidType,
                  "recipe.requirements[].capability", "must be a string");
    }
    if (!requirement["required"].isNull() && !requirement["required"].is<bool>()) {
      return fail(error, RecipeParseErrorCode::InvalidType,
                  "recipe.requirements[].required", "must be a boolean");
    }
    const char* capability = requirement["capability"].as<const char*>();
    const bool required = requirement["required"] | true;
    if (required && std::strcmp(capability, "time") != 0) {
      return fail(error, RecipeParseErrorCode::UnsupportedLiveInput,
                  "recipe.requirements[].capability",
                  "required capability is not available to native recipes");
    }
  }

  JsonArrayConst layers = object["layers"].as<JsonArrayConst>();
  if (layers.isNull()) {
    return fail(error, RecipeParseErrorCode::InvalidType,
                "recipe.layers", "must be an array");
  }
  if (layers.size() > LW_RECIPE_MAX_LAYERS) {
    return fail(error, RecipeParseErrorCode::LimitExceeded,
                "recipe.layers", "more than three layers are not supported");
  }
  for (JsonVariantConst layer : layers) {
    if (!parseLayer(layer, parsed.paletteCount, parsed.layers[parsed.layerCount], error)) {
      return false;
    }
    parsed.layerCount++;
  }
  if (parsed.estimatedOperationsPerFrame == 0) {
    // The parser does not know the installed pixel count. Report the
    // conservative maximum-card estimate rather than a per-pixel cost.
    parsed.estimatedOperationsPerFrame =
        24U + 48U * parsed.layerCount * 1024U;
  }
  if (parsed.estimatedStateBytes == 0) {
    parsed.estimatedStateBytes = static_cast<uint16_t>(
        16U + parsed.layerCount * sizeof(NativeRecipeLayer));
  }
  if (parsed.estimatedStateBytes > LW_RECIPE_MAX_STATE_BYTES) {
    return fail(error, RecipeParseErrorCode::LimitExceeded,
                "recipe.estimates.stateBytes", "estimated state exceeds the supported limit");
  }

  destination = parsed;
  return true;
}

void clearNativeRecipes() {
  for (RegisteredRecipe& entry : registry) entry = RegisteredRecipe{};
}

bool registerNativeRecipe(const char* routeId, const NativeRecipe& recipe) {
  if (!routeId) return false;
  const size_t length = std::strlen(routeId);
  if (length == 0 || length > LW_RECIPE_MAX_ID_BYTES) return false;
  RegisteredRecipe* available = nullptr;
  for (RegisteredRecipe& entry : registry) {
    if (entry.occupied && std::strcmp(entry.routeId, routeId) == 0) {
      available = &entry;
      break;
    }
    if (!entry.occupied && !available) available = &entry;
  }
  if (!available) return false;
  *available = RegisteredRecipe{};
  available->occupied = true;
  std::memcpy(available->routeId, routeId, length + 1);
  available->recipe = recipe;
  return true;
}

const NativeRecipe* findNativeRecipe(const char* routeId) {
  if (!routeId) return nullptr;
  for (const RegisteredRecipe& entry : registry) {
    if (entry.occupied && std::strcmp(entry.routeId, routeId) == 0) {
      return &entry.recipe;
    }
  }
  return nullptr;
}

void writeNativeRecipeCapabilities(JsonObject destination,
                                   const char* firmwareVersion,
                                   const char* buildId) {
  destination["version"] = 1;
  destination["firmwareVersion"] = firmwareVersion;
  destination["buildId"] = buildId;
  JsonArray schemaVersions = destination["schemaVersions"].to<JsonArray>();
  schemaVersions.add(LW_RECIPE_SCHEMA_VERSION);

  JsonArray supportedNodes = destination["supportedNodes"].to<JsonArray>();
  for (const char* node : {
           "solid", "palette", "wave", "fastled-noise", "hash-sparkle",
           "scale", "offset", "repeat", "mirror", "radial-mask",
           "linear-mask", "threshold"}) {
    supportedNodes.add(node);
  }
  JsonArray supportedBlends = destination["supportedBlends"].to<JsonArray>();
  for (const char* blend : {"add", "max", "multiply", "crossfade"}) {
    supportedBlends.add(blend);
  }
  JsonArray supportedModulators = destination["supportedModulators"].to<JsonArray>();
  for (const char* modulator : {"lfo", "noise-clock"}) {
    supportedModulators.add(modulator);
  }
  JsonArray bakeOnly = destination["bakeOnlyNodes"].to<JsonArray>();
  for (const char* node : {
           "particles", "reaction-diffusion", "graph", "shader", "audio"}) {
    bakeOnly.add(node);
  }
  destination["maxLayers"] = LW_RECIPE_MAX_LAYERS;
  destination["maxConfigBytes"] = LW_RECIPE_MAX_CONFIG_BYTES;
  destination["maxOperationsPerFrame"] = LW_RECIPE_MAX_OPERATIONS_PER_FRAME;
  destination["maxEstimatedStateBytes"] = LW_RECIPE_MAX_STATE_BYTES;
  destination["physicalParityVerified"] = false;
}

}  // namespace lightweaver
