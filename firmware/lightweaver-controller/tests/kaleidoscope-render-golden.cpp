#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>

#include "LightweaverPatterns.h"
#include "LightweaverSequencePlayback.h"
#include "LightweaverWledRealtimePolicy.h"

static uint16_t hostOrderedPoints[4] = {};

KaleidoscopeSample sampleKaleidoscope(
    const KaleidoscopeMappingConfig* mapping, uint16_t sourceLed) {
  return mapping ? ::sampleKaleidoscope(
      mapping->pixelCount, hostOrderedPoints, mapping->pointCount, sourceLed)
      : KaleidoscopeSample{};
}

namespace lightweaver {
const NativeRecipe* findNativeRecipe(const char*) { return nullptr; }
}

static uint64_t hashFrame(const CRGB* frame, uint16_t count) {
  uint64_t hash = 1469598103934665603ULL;
  for (uint16_t index = 0; index < count; index++) {
    for (uint8_t value : {frame[index].r, frame[index].g, frame[index].b}) {
      hash ^= value;
      hash *= 1099511628211ULL;
    }
  }
  return hash;
}

static void expectExactRgb(const CRGB* frame, const std::array<uint8_t, 24>& bytes) {
  for (uint16_t index = 0; index < 8; index++) {
    assert(frame[index] == CRGB(
        bytes[index * 3], bytes[index * 3 + 1], bytes[index * 3 + 2]));
  }
}

static void expectMappedGolden(const char* pattern, uint64_t expectedHash) {
  int16_t offsets[4] = {0, 0, 0, 0};
  assert(deriveKaleidoscopePoints(8, 4, 0, offsets, hostOrderedPoints));
  KaleidoscopeMappingConfig mapping;
  mapping.pixelCount = 8;
  mapping.pointCount = 4;
  mapping.pointPoolStart = 0;
  mapping.spanCount = 1;
  mapping.spans[0] = {0, 8, 0, 1};
  PatternCoordinateContext context{8, 0, 1, &mapping};
  PatternModifiers modifiers;
  CRGB ordinary[8] = {};
  CRGB mapped[8] = {};
  assert(renderProceduralPattern(String(pattern), ordinary, 8, 424242U, modifiers));
  assert(renderProceduralPattern(String(pattern), mapped, 8, 424242U, modifiers, &context));
  assert(hashFrame(mapped, 8) == expectedHash);
  assert(hashFrame(mapped, 8) != hashFrame(ordinary, 8));
  assert(mapped[1] == mapped[3] && mapped[3] == mapped[5] && mapped[5] == mapped[7]);
  assert(mapped[0] == mapped[4]);
  assert(mapped[2] == mapped[6]);
}

int main() {
  expectMappedGolden("aurora", 14590350668864282915ULL);
  expectMappedGolden("rainbow", 5726778342822066755ULL);
  expectMappedGolden("wave", 15468222897152753459ULL);

  int16_t offsets[4] = {0, 0, 0, 0};
  assert(deriveKaleidoscopePoints(8, 4, 0, offsets, hostOrderedPoints));
  KaleidoscopeMappingConfig mapping;
  mapping.pixelCount = 8;
  mapping.pointCount = 4;
  mapping.pointPoolStart = 0;
  mapping.spanCount = 1;
  mapping.spans[0] = {0, 8, 0, 1};
  PatternCoordinateContext context{8, 0, 1, &mapping};
  lightweaver::NativeRecipe recipe;
  recipe.paletteCount = 2;
  recipe.palette[0] = {255, 0, 0};
  recipe.palette[1] = {0, 0, 255};
  recipe.layerCount = 1;
  recipe.layers[0].source = lightweaver::RecipeSourceNode::Palette;
  recipe.layers[0].blend = lightweaver::RecipeBlendMode::Crossfade;
  recipe.layers[0].opacity = 1.0f;
  CRGB recipeFrame[8] = {};
  PatternModifiers modifiers;
  assert(renderNativeRecipe(recipe, recipeFrame, 8, 424242U, modifiers, &context));
  assert(hashFrame(recipeFrame, 8) == 966627400615423963ULL);
  assert(recipeFrame[1] == recipeFrame[3] && recipeFrame[3] == recipeFrame[5] && recipeFrame[5] == recipeFrame[7]);

  // A mapped runtime must not fold externally supplied RGB or .lwseq frames.
  // Invoke the same public decode/apply seams used by the production handlers
  // and prove deliberately asymmetric bytes survive pixel-for-pixel.
  const std::array<uint8_t, 24> streamedRgb = {
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24};
  CRGB streamedFrame[8] = {};
  applyWledRealtimeDrgb(
      streamedFrame, 8, streamedRgb.data(), 8, true);
  expectExactRgb(streamedFrame, streamedRgb);
  assert(streamedFrame[1] != streamedFrame[3]);
  assert(streamedFrame[3] != streamedFrame[5]);

  const std::array<uint8_t, 24> sequenceBytes = {
      24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13,
      12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1};
  CRGB sequenceFrame[8] = {};
  assert(applySequenceRgbFrame(
      sequenceFrame, 8, sequenceBytes.data(), sequenceBytes.size()));
  expectExactRgb(sequenceFrame, sequenceBytes);
  assert(sequenceFrame[1] != sequenceFrame[3]);
  assert(sequenceFrame[3] != sequenceFrame[5]);
  return 0;
}
