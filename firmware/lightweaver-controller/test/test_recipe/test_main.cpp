#include <ArduinoJson.h>
#include <unity.h>

#include <cmath>
#include <cstring>

#include "LightweaverRecipe.h"

namespace {

using lightweaver::NativeRecipe;
using lightweaver::RecipeParseError;
using lightweaver::RecipeParseErrorCode;

const char* kValidRecipe = R"json({
  "version": 1,
  "id": "native-dawn",
  "seed": 42,
  "palette": ["#12051f", "#ff6b35", "#ffe7a0"],
  "estimates": {"operationsPerFrame": 4200, "stateBytes": 96},
  "requirements": [{"capability": "time", "required": true}],
  "layers": [{
    "source": {"node": "wave", "frequency": 2.5, "speed": 0.2, "phase": 0.1},
    "transforms": [
      {"node": "scale", "amount": 1.5},
      {"node": "offset", "amount": 0.1},
      {"node": "repeat", "count": 3},
      {"node": "mirror"}
    ],
    "mask": {"node": "radial-mask", "center": 0.5, "radius": 0.45, "softness": 0.1},
    "threshold": 0.15,
    "blend": "add",
    "opacity": 0.8,
    "modulators": [
      {"node": "lfo", "seed": 7, "rate": 0.08, "depth": 0.3, "offset": 0.5},
      {"node": "noise-clock", "seed": 9, "rate": 0.03, "depth": 0.2, "offset": 0.4}
    ]
  }]
})json";

bool parseText(const char* json, NativeRecipe& destination, RecipeParseError& error,
               size_t reportedBytes = 0) {
  JsonDocument doc;
  const DeserializationError jsonError = deserializeJson(doc, json);
  TEST_ASSERT_FALSE_MESSAGE(jsonError, jsonError.c_str());
  return lightweaver::parseNativeRecipeV1(
      doc.as<JsonVariantConst>(),
      reportedBytes == 0 ? measureJson(doc) : reportedBytes,
      destination,
      error);
}

void expectRejected(const char* json, RecipeParseErrorCode code, const char* path) {
  NativeRecipe destination;
  destination.version = 99;
  destination.seed = 0xdeadbeef;
  RecipeParseError error;
  TEST_ASSERT_FALSE(parseText(json, destination, error));
  TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(code), static_cast<uint8_t>(error.code));
  TEST_ASSERT_EQUAL_STRING(path, error.path);
  TEST_ASSERT_EQUAL_UINT8(99, destination.version);
  TEST_ASSERT_EQUAL_UINT32(0xdeadbeef, destination.seed);
}

}  // namespace

void test_parses_complete_bounded_v1_recipe() {
  NativeRecipe recipe;
  RecipeParseError error;
  TEST_ASSERT_TRUE(parseText(kValidRecipe, recipe, error));
  TEST_ASSERT_EQUAL_UINT8(1, recipe.version);
  TEST_ASSERT_EQUAL_STRING("native-dawn", recipe.id);
  TEST_ASSERT_EQUAL_UINT32(42, recipe.seed);
  TEST_ASSERT_EQUAL_UINT8(3, recipe.paletteCount);
  TEST_ASSERT_EQUAL_UINT8(1, recipe.layerCount);
  TEST_ASSERT_EQUAL_UINT8(4, recipe.layers[0].transformCount);
  TEST_ASSERT_EQUAL_UINT8(2, recipe.layers[0].modulatorCount);
  TEST_ASSERT_EQUAL_UINT32(4200, recipe.estimatedOperationsPerFrame);
  TEST_ASSERT_EQUAL_UINT16(96, recipe.estimatedStateBytes);
  TEST_ASSERT_EQUAL_UINT8(
      static_cast<uint8_t>(lightweaver::RecipeSourceNode::Wave),
      static_cast<uint8_t>(recipe.layers[0].source));
  TEST_ASSERT_EQUAL_UINT8(
      static_cast<uint8_t>(lightweaver::RecipeBlendMode::Add),
      static_cast<uint8_t>(recipe.layers[0].blend));
  TEST_ASSERT_EQUAL_UINT8(
      static_cast<uint8_t>(lightweaver::RecipeMaskNode::Radial),
      static_cast<uint8_t>(recipe.layers[0].mask));
  TEST_ASSERT_EQUAL_UINT8(
      static_cast<uint8_t>(RecipeParseErrorCode::None),
      static_cast<uint8_t>(error.code));
}

void test_rejects_unknown_version_and_nodes() {
  expectRejected(
      R"({"version":2,"id":"future","palette":["#000000","#ffffff"],"layers":[]})",
      RecipeParseErrorCode::UnsupportedVersion,
      "recipe.version");
  expectRejected(
      R"({"version":1,"id":"bad-source","palette":["#000000","#ffffff"],"layers":[{"source":{"node":"voronoi"}}]})",
      RecipeParseErrorCode::UnsupportedNode,
      "recipe.layers[].source.node");
  expectRejected(
      R"({"version":1,"id":"bad-transform","palette":["#000000","#ffffff"],"layers":[{"source":{"node":"solid"},"transforms":[{"node":"rotate"}]}]})",
      RecipeParseErrorCode::UnsupportedNode,
      "recipe.layers[].transforms[].node");
  expectRejected(
      R"({"version":1,"id":"bad-mask","palette":["#000000","#ffffff"],"layers":[{"source":{"node":"solid"},"mask":{"node":"path-distance"}}]})",
      RecipeParseErrorCode::UnsupportedNode,
      "recipe.layers[].mask.node");
  expectRejected(
      R"({"version":1,"id":"bad-mod","palette":["#000000","#ffffff"],"layers":[{"source":{"node":"solid"},"modulators":[{"node":"beat"}]}]})",
      RecipeParseErrorCode::UnsupportedNode,
      "recipe.layers[].modulators[].node");
}

void test_rejects_resource_limit_violations() {
  expectRejected(
      R"({"version":1,"id":"layers","palette":["#000000","#ffffff"],"layers":[{"source":{"node":"solid"}},{"source":{"node":"solid"}},{"source":{"node":"solid"}},{"source":{"node":"solid"}}]})",
      RecipeParseErrorCode::LimitExceeded,
      "recipe.layers");
  expectRejected(
      R"({"version":1,"id":"ops","palette":["#000000","#ffffff"],"estimates":{"operationsPerFrame":250001},"layers":[]})",
      RecipeParseErrorCode::LimitExceeded,
      "recipe.estimates.operationsPerFrame");
  expectRejected(
      R"({"version":1,"id":"state","palette":["#000000","#ffffff"],"estimates":{"stateBytes":2049},"layers":[]})",
      RecipeParseErrorCode::LimitExceeded,
      "recipe.estimates.stateBytes");

  NativeRecipe destination;
  destination.version = 77;
  RecipeParseError error;
  TEST_ASSERT_FALSE(parseText(kValidRecipe, destination, error,
                              lightweaver::LW_RECIPE_MAX_CONFIG_BYTES + 1));
  TEST_ASSERT_EQUAL_UINT8(
      static_cast<uint8_t>(RecipeParseErrorCode::LimitExceeded),
      static_cast<uint8_t>(error.code));
  TEST_ASSERT_EQUAL_STRING("recipe", error.path);
  TEST_ASSERT_EQUAL_UINT8(77, destination.version);
}

void test_rejects_invalid_palette_sizes_and_colors() {
  expectRejected(
      R"({"version":1,"id":"one","palette":["#000000"],"layers":[]})",
      RecipeParseErrorCode::InvalidValue,
      "recipe.palette");
  expectRejected(
      R"({"version":1,"id":"nine","palette":["#000000","#111111","#222222","#333333","#444444","#555555","#666666","#777777","#888888"],"layers":[]})",
      RecipeParseErrorCode::InvalidValue,
      "recipe.palette");
  expectRejected(
      R"({"version":1,"id":"color","palette":["#000000","red"],"layers":[]})",
      RecipeParseErrorCode::InvalidValue,
      "recipe.palette[]");
}

void test_rejects_non_finite_and_out_of_range_parameters() {
  expectRejected(
      R"({"version":1,"id":"range","palette":["#000000","#ffffff"],"layers":[{"source":{"node":"wave","frequency":33}}]})",
      RecipeParseErrorCode::InvalidValue,
      "recipe.layers[].source.frequency");

  JsonDocument doc;
  TEST_ASSERT_FALSE(deserializeJson(
      doc,
      R"({"version":1,"id":"nan","palette":["#000000","#ffffff"],"layers":[{"source":{"node":"wave"}}]})"));
  doc["layers"][0]["source"]["frequency"] = NAN;
  NativeRecipe destination;
  destination.version = 55;
  RecipeParseError error;
  TEST_ASSERT_FALSE(lightweaver::parseNativeRecipeV1(
      doc.as<JsonVariantConst>(), measureJson(doc), destination, error));
  TEST_ASSERT_EQUAL_UINT8(
      static_cast<uint8_t>(RecipeParseErrorCode::InvalidValue),
      static_cast<uint8_t>(error.code));
  TEST_ASSERT_EQUAL_STRING("recipe.layers[].source.frequency", error.path);
  TEST_ASSERT_EQUAL_UINT8(55, destination.version);
}

void test_rejects_bake_only_and_live_inputs() {
  for (const char* node : {"particles", "reaction-diffusion", "graph", "shader", "audio"}) {
    JsonDocument doc;
    doc["version"] = 1;
    doc["id"] = "bake-only";
    doc["palette"].add("#000000");
    doc["palette"].add("#ffffff");
    doc["layers"][0]["source"]["node"] = node;
    NativeRecipe recipe;
    RecipeParseError error;
    TEST_ASSERT_FALSE(lightweaver::parseNativeRecipeV1(
        doc.as<JsonVariantConst>(), measureJson(doc), recipe, error));
    TEST_ASSERT_EQUAL_UINT8(
        static_cast<uint8_t>(RecipeParseErrorCode::BakeOnly),
        static_cast<uint8_t>(error.code));
  }
  expectRejected(
      R"({"version":1,"id":"live","palette":["#000000","#ffffff"],"requirements":[{"capability":"live-audio","required":true}],"layers":[]})",
      RecipeParseErrorCode::UnsupportedLiveInput,
      "recipe.requirements[].capability");
  expectRejected(
      R"({"version":1,"id":"unknown","palette":["#000000","#ffffff"],"requirements":[{"capability":"future-sensor","required":true}],"layers":[]})",
      RecipeParseErrorCode::UnsupportedLiveInput,
      "recipe.requirements[].capability");
  expectRejected(
      R"({"version":1,"id":"malformed","palette":["#000000","#ffffff"],"requirements":[{"required":true}],"layers":[]})",
      RecipeParseErrorCode::InvalidType,
      "recipe.requirements[].capability");
  expectRejected(
      R"({"version":1,"id":"malformed-required","palette":["#000000","#ffffff"],"requirements":[{"capability":"time","required":"yes"}],"layers":[]})",
      RecipeParseErrorCode::InvalidType,
      "recipe.requirements[].required");
}

void test_capability_descriptor_is_versioned_and_bounded() {
  JsonDocument doc;
  lightweaver::writeNativeRecipeCapabilities(
      doc.to<JsonObject>(), "1.2.3", "build-abc");
  TEST_ASSERT_EQUAL_UINT8(1, doc["version"].as<uint8_t>());
  TEST_ASSERT_EQUAL_UINT8(1, doc["schemaVersions"][0].as<uint8_t>());
  TEST_ASSERT_EQUAL_STRING("1.2.3", doc["firmwareVersion"].as<const char*>());
  TEST_ASSERT_EQUAL_STRING("build-abc", doc["buildId"].as<const char*>());
  TEST_ASSERT_EQUAL_UINT8(lightweaver::LW_RECIPE_MAX_LAYERS,
                          doc["maxLayers"].as<uint8_t>());
  TEST_ASSERT_EQUAL_UINT32(lightweaver::LW_RECIPE_MAX_CONFIG_BYTES,
                           doc["maxConfigBytes"].as<uint32_t>());
  TEST_ASSERT_EQUAL_UINT32(lightweaver::LW_RECIPE_MAX_OPERATIONS_PER_FRAME,
                           doc["maxOperationsPerFrame"].as<uint32_t>());
  TEST_ASSERT_EQUAL_UINT16(lightweaver::LW_RECIPE_MAX_STATE_BYTES,
                           doc["maxEstimatedStateBytes"].as<uint16_t>());
  TEST_ASSERT_FALSE(doc["physicalParityVerified"].as<bool>());
  TEST_ASSERT_EQUAL_UINT8(12, doc["supportedNodes"].size());
  TEST_ASSERT_EQUAL_UINT8(4, doc["supportedBlends"].size());
  TEST_ASSERT_EQUAL_UINT8(2, doc["supportedModulators"].size());
}

void test_registry_is_additive_bounded_and_resettable() {
  NativeRecipe recipe;
  RecipeParseError error;
  TEST_ASSERT_TRUE(parseText(kValidRecipe, recipe, error));
  lightweaver::clearNativeRecipes();
  TEST_ASSERT_NULL(lightweaver::findNativeRecipe("aurora"));
  TEST_ASSERT_TRUE(lightweaver::registerNativeRecipe("native-dawn", recipe));
  const NativeRecipe* found = lightweaver::findNativeRecipe("native-dawn");
  TEST_ASSERT_NOT_NULL(found);
  TEST_ASSERT_EQUAL_UINT32(42, found->seed);
  TEST_ASSERT_NULL(lightweaver::findNativeRecipe("not-registered"));
  lightweaver::clearNativeRecipes();
  TEST_ASSERT_NULL(lightweaver::findNativeRecipe("native-dawn"));
}

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;
  UNITY_BEGIN();
  RUN_TEST(test_parses_complete_bounded_v1_recipe);
  RUN_TEST(test_rejects_unknown_version_and_nodes);
  RUN_TEST(test_rejects_resource_limit_violations);
  RUN_TEST(test_rejects_invalid_palette_sizes_and_colors);
  RUN_TEST(test_rejects_non_finite_and_out_of_range_parameters);
  RUN_TEST(test_rejects_bake_only_and_live_inputs);
  RUN_TEST(test_capability_descriptor_is_versioned_and_bounded);
  RUN_TEST(test_registry_is_additive_bounded_and_resettable);
  return UNITY_END();
}
