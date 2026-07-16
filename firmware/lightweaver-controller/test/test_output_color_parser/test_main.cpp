#include <ArduinoJson.h>
#include <unity.h>

#include "LightweaverOutputColorParser.h"

namespace {
OutputColorConfig sentinelConfig() {
  OutputColorConfig config;
  config.gammaEnabled = true;
  config.gammaValue = 1.75f;
  config.red = 0.11f;
  config.green = 0.22f;
  config.blue = 0.33f;
  return config;
}

void assertSentinel(const OutputColorConfig& config) {
  TEST_ASSERT_TRUE(config.gammaEnabled);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 1.75f, config.gammaValue);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.11f, config.red);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.22f, config.green);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.33f, config.blue);
}

bool parseFixture(
    const char* json,
    OutputColorConfig& destination,
    const char*& errorPath,
    const char*& errorReason) {
  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, json);
  TEST_ASSERT_FALSE_MESSAGE(error, error.c_str());
  return parseOutputColorConfig(doc["led"], destination, errorPath, errorReason);
}

void expectRejected(const char* json, const char* expectedPath) {
  OutputColorConfig destination = sentinelConfig();
  const char* errorPath = nullptr;
  const char* errorReason = nullptr;
  TEST_ASSERT_FALSE(parseFixture(json, destination, errorPath, errorReason));
  TEST_ASSERT_EQUAL_STRING(expectedPath, errorPath);
  TEST_ASSERT_NOT_NULL(errorReason);
  assertSentinel(destination);
}
}

void test_missing_fields_use_neutral_defaults() {
  for (const char* json : {"{}", "{\"led\":{}}", "{\"led\":{\"calibration\":{}}}"}) {
    OutputColorConfig destination = sentinelConfig();
    const char* errorPath = nullptr;
    const char* errorReason = nullptr;
    TEST_ASSERT_TRUE(parseFixture(json, destination, errorPath, errorReason));
    TEST_ASSERT_FALSE(destination.gammaEnabled);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, 2.2f, destination.gammaValue);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, 1.0f, destination.red);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, 1.0f, destination.green);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, 1.0f, destination.blue);
    TEST_ASSERT_NULL(errorPath);
    TEST_ASSERT_NULL(errorReason);
  }
}

void test_integer_and_float_values_parse() {
  OutputColorConfig integers;
  const char* errorPath = nullptr;
  const char* errorReason = nullptr;
  TEST_ASSERT_TRUE(parseFixture(
      "{\"led\":{\"outputGammaEnabled\":true,\"outputGammaValue\":2,\"calibration\":{\"red\":0,\"green\":1,\"blue\":1}}}",
      integers,
      errorPath,
      errorReason));
  TEST_ASSERT_TRUE(integers.gammaEnabled);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 2.0f, integers.gammaValue);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.0f, integers.red);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 1.0f, integers.green);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 1.0f, integers.blue);

  OutputColorConfig decimals;
  TEST_ASSERT_TRUE(parseFixture(
      "{\"led\":{\"outputGammaValue\":2.25,\"calibration\":{\"red\":0.25,\"green\":0.5,\"blue\":0.75}}}",
      decimals,
      errorPath,
      errorReason));
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 2.25f, decimals.gammaValue);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.25f, decimals.red);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.5f, decimals.green);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.75f, decimals.blue);
}

void test_range_boundaries_parse() {
  OutputColorConfig lower;
  const char* errorPath = nullptr;
  const char* errorReason = nullptr;
  TEST_ASSERT_TRUE(parseFixture(
      "{\"led\":{\"outputGammaValue\":1,\"calibration\":{\"red\":0,\"green\":0,\"blue\":0}}}",
      lower,
      errorPath,
      errorReason));
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 1.0f, lower.gammaValue);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.0f, lower.red);

  OutputColorConfig upper;
  TEST_ASSERT_TRUE(parseFixture(
      "{\"led\":{\"outputGammaValue\":3,\"calibration\":{\"red\":1,\"green\":1,\"blue\":1}}}",
      upper,
      errorPath,
      errorReason));
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 3.0f, upper.gammaValue);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 1.0f, upper.blue);
}

void test_wrong_types_reject_without_mutation() {
  expectRejected("{\"led\":[]}", "led");
  expectRejected("{\"led\":{\"outputGammaEnabled\":\"true\"}}", "led.outputGammaEnabled");
  expectRejected("{\"led\":{\"outputGammaEnabled\":null}}", "led.outputGammaEnabled");
  expectRejected("{\"led\":{\"outputGammaValue\":\"2.2\"}}", "led.outputGammaValue");
  expectRejected("{\"led\":{\"outputGammaValue\":null}}", "led.outputGammaValue");
  expectRejected("{\"led\":{\"calibration\":[]}}", "led.calibration");
  expectRejected("{\"led\":{\"calibration\":null}}", "led.calibration");
  expectRejected("{\"led\":{\"calibration\":{\"red\":false}}}", "led.calibration.red");
  expectRejected("{\"led\":{\"calibration\":{\"red\":null}}}", "led.calibration.red");
  expectRejected("{\"led\":{\"calibration\":{\"green\":{}}}}", "led.calibration.green");
  expectRejected("{\"led\":{\"calibration\":{\"blue\":\"1\"}}}", "led.calibration.blue");
}

void test_out_of_range_values_reject_without_mutation() {
  expectRejected("{\"led\":{\"outputGammaValue\":0.99}}", "led.outputGammaValue");
  expectRejected("{\"led\":{\"outputGammaValue\":3.01}}", "led.outputGammaValue");
  expectRejected("{\"led\":{\"calibration\":{\"red\":-0.01}}}", "led.calibration.red");
  expectRejected("{\"led\":{\"calibration\":{\"green\":1.01}}}", "led.calibration.green");
  expectRejected("{\"led\":{\"calibration\":{\"blue\":-1}}}", "led.calibration.blue");
}

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;
  UNITY_BEGIN();
  RUN_TEST(test_missing_fields_use_neutral_defaults);
  RUN_TEST(test_integer_and_float_values_parse);
  RUN_TEST(test_range_boundaries_parse);
  RUN_TEST(test_wrong_types_reject_without_mutation);
  RUN_TEST(test_out_of_range_values_reject_without_mutation);
  return UNITY_END();
}
