#include "LightweaverPatterns.h"

#include <cmath>

static inline uint32_t scaleTime(uint32_t now, float speed) {
  if (speed <= 0.0f) return now;
  // Fixed-point Q10 scaling. The previous float path (`float(now) * speed`)
  // degraded with uptime: a 24-bit mantissa quantizes animation time into
  // visible steps after days of millis(), and float->uint32 conversion
  // overflows (UB) at speed > 1 once now * speed exceeds 2^32. The 64-bit
  // integer multiply is exact and truncating to 32 bits wraps modularly,
  // which is safe because callers only use t in modulo / phase arithmetic.
  uint32_t speedQ10 = static_cast<uint32_t>(speed * 1024.0f + 0.5f);
  if (speedQ10 == 0) speedQ10 = 1;
  return static_cast<uint32_t>((static_cast<uint64_t>(now) * speedQ10) >> 10);
}

// Breathe-style patterns derive a beatsin8 BPM from the speed modifier.
// uint8_t truncation makes anything below 1 BPM freeze the animation (the UI
// speed floor is 0.05x, so e.g. 8 * 0.05 = 0.4 truncated to 0). Clamp to at
// least 1 BPM so slow speeds stay visibly alive.
static inline uint8_t speedBpm(uint8_t baseBpm, float speed) {
  float bpm = float(baseBpm) * speed;
  if (bpm < 1.0f) return 1;
  if (bpm > 255.0f) return 255;
  return static_cast<uint8_t>(bpm);
}

static inline uint8_t shiftHue(uint8_t base, int16_t shift) {
  int16_t v = int16_t(base) + shift;
  while (v < 0) v += 256;
  while (v > 255) v -= 256;
  return static_cast<uint8_t>(v);
}

static constexpr uint8_t LW_DEFAULT_CUSTOM_HUE = 32;
static constexpr uint8_t LW_DEFAULT_CUSTOM_SATURATION = 230;

static uint8_t resolveDriftHue(uint32_t t, const PatternModifiers& mods) {
  uint8_t lo = mods.driftHueMin;
  uint8_t hi = mods.driftHueMax;
  uint16_t span;
  if (hi >= lo) span = uint16_t(hi - lo);
  else span = uint16_t(255 - lo + hi + 1);
  if (span == 0) return lo;

  uint32_t period = max<uint32_t>(2000, span * 80);
  uint32_t phase = t % (period * 2);
  uint16_t step;
  if (phase < period) step = uint16_t((uint32_t(phase) * span) / period);
  else step = uint16_t(span - ((uint32_t(phase - period) * span) / period));
  if (hi >= lo) return lo + uint8_t(step);
  return uint8_t((uint16_t(lo) + step) & 0xff);
}

void applyGlobalColorModifiers(CRGB* leds, uint16_t totalPixels, uint32_t t, const PatternModifiers& mods) {
  int16_t hueShift = int16_t(mods.customHue) - int16_t(LW_DEFAULT_CUSTOM_HUE);
  if (mods.customDrift) {
    hueShift += int16_t(resolveDriftHue(t, mods)) - int16_t(mods.customHue);
  }
  const bool shiftsHue = hueShift != 0;
  const bool changesSaturation = mods.customSaturation != LW_DEFAULT_CUSTOM_SATURATION;
  const uint8_t breatheScale = mods.customBreathe
    ? uint8_t(86 + scale8(sin8(uint8_t(t / 14)), 169))
    : 255;
  if (!shiftsHue && !changesSaturation && breatheScale >= 255) return;

  for (uint16_t i = 0; i < totalPixels; i++) {
    if (!(leds[i].r || leds[i].g || leds[i].b)) continue;
    if (shiftsHue || changesSaturation) {
      CHSV hsv = rgb2hsv_approximate(leds[i]);
      if (shiftsHue) hsv.hue = shiftHue(hsv.hue, hueShift);
      if (changesSaturation) {
        uint16_t sat = (uint16_t(hsv.saturation) * mods.customSaturation + (LW_DEFAULT_CUSTOM_SATURATION / 2)) / LW_DEFAULT_CUSTOM_SATURATION;
        hsv.saturation = uint8_t(sat > 255 ? 255 : sat);
      }
      leds[i] = hsv;
    }
    if (breatheScale < 255) leds[i].nscale8(breatheScale);
  }
}

static inline uint8_t hash8(uint16_t value, uint16_t salt = 0) {
  uint16_t x = value;
  x ^= salt * 109u;
  x ^= x >> 7;
  x *= 251u;
  x ^= x >> 9;
  return uint8_t(x & 0xff);
}

static float recipeFract(float value) {
  return value - floorf(value);
}

static CRGB recipeColor(const lightweaver::RecipeColor& color) {
  return CRGB(color.red, color.green, color.blue);
}

static CRGB sampleRecipePalette(const lightweaver::NativeRecipe& recipe, float position) {
  if (recipe.paletteCount == 0) return CRGB::Black;
  if (recipe.paletteCount == 1) return recipeColor(recipe.palette[0]);
  float normalized = recipeFract(position);
  float scaled = normalized * float(recipe.paletteCount - 1);
  uint8_t lower = static_cast<uint8_t>(scaled);
  uint8_t upper = min<uint8_t>(recipe.paletteCount - 1, lower + 1);
  uint8_t amount = static_cast<uint8_t>((scaled - float(lower)) * 255.0f);
  return blend(recipeColor(recipe.palette[lower]), recipeColor(recipe.palette[upper]), amount);
}

static float transformedRecipeCoordinate(
    float coordinate, const lightweaver::NativeRecipeLayer& layer) {
  float value = coordinate;
  for (uint8_t index = 0; index < layer.transformCount; index++) {
    const lightweaver::RecipeTransform& transform = layer.transforms[index];
    if (transform.node == lightweaver::RecipeTransformNode::Scale) {
      value *= transform.amount;
    } else if (transform.node == lightweaver::RecipeTransformNode::Offset) {
      value += transform.amount;
    } else if (transform.node == lightweaver::RecipeTransformNode::Repeat) {
      value = recipeFract(value * transform.amount);
    } else if (transform.node == lightweaver::RecipeTransformNode::Mirror) {
      float folded = recipeFract(value * 0.5f) * 2.0f;
      value = folded <= 1.0f ? folded : 2.0f - folded;
    }
  }
  return recipeFract(value);
}

static float recipeModulation(const lightweaver::NativeRecipeLayer& layer,
                              uint32_t now) {
  float result = 0.0f;
  for (uint8_t index = 0; index < layer.modulatorCount; index++) {
    const lightweaver::RecipeModulator& modulator = layer.modulators[index];
    uint32_t rateQ16 = static_cast<uint32_t>(modulator.rate * 65536.0f);
    uint8_t phase = static_cast<uint8_t>(
        ((static_cast<uint64_t>(now) * rateQ16) / 1000U +
         (modulator.seed & 0xffffU)) >> 8);
    float sampled = 0.0f;
    if (modulator.node == lightweaver::RecipeModulatorNode::Lfo) {
      sampled = float(sin8(phase)) / 255.0f;
    } else {
      sampled = float(inoise8(uint16_t(phase) << 8,
                              uint16_t(modulator.seed & 0xffffU))) / 255.0f;
    }
    result += modulator.offset + ((sampled * 2.0f - 1.0f) * modulator.depth);
  }
  return result;
}

static float recipeMaskAlpha(float coordinate,
                             const lightweaver::NativeRecipeLayer& layer) {
  if (layer.mask == lightweaver::RecipeMaskNode::None) return 1.0f;
  if (layer.mask == lightweaver::RecipeMaskNode::Radial) {
    float distance = fabsf(coordinate - layer.maskCenter);
    if (distance <= layer.maskRadius - layer.maskSoftness) return 1.0f;
    if (distance >= layer.maskRadius) return 0.0f;
    if (layer.maskSoftness <= 0.0f) return 0.0f;
    return (layer.maskRadius - distance) / layer.maskSoftness;
  }
  if (coordinate < layer.maskStart || coordinate > layer.maskEnd) return 0.0f;
  if (layer.maskSoftness <= 0.0f) return 1.0f;
  float leading = (coordinate - layer.maskStart) / layer.maskSoftness;
  float trailing = (layer.maskEnd - coordinate) / layer.maskSoftness;
  return min(1.0f, max(0.0f, min(leading, trailing)));
}

static void compositeRecipeLayer(CRGB& destination, CRGB source, float alpha,
                                 lightweaver::RecipeBlendMode blendMode,
                                 bool firstLayer) {
  uint8_t amount = static_cast<uint8_t>(constrain(int(alpha * 255.0f), 0, 255));
  if (blendMode == lightweaver::RecipeBlendMode::Crossfade) {
    destination = blend(destination, source, amount);
    return;
  }
  source.nscale8(amount);
  if (blendMode == lightweaver::RecipeBlendMode::Add) {
    destination.r = qadd8(destination.r, source.r);
    destination.g = qadd8(destination.g, source.g);
    destination.b = qadd8(destination.b, source.b);
  } else if (blendMode == lightweaver::RecipeBlendMode::Max) {
    destination.r = max(destination.r, source.r);
    destination.g = max(destination.g, source.g);
    destination.b = max(destination.b, source.b);
  } else if (firstLayer) {
    destination = source;
  } else {
    destination.r = scale8(destination.r, source.r);
    destination.g = scale8(destination.g, source.g);
    destination.b = scale8(destination.b, source.b);
  }
}

bool renderNativeRecipe(const lightweaver::NativeRecipe& recipe, CRGB* leds,
                        uint16_t totalPixels, uint32_t now,
                        const PatternModifiers& mods) {
  if (!leds || totalPixels == 0 || recipe.version != lightweaver::LW_RECIPE_SCHEMA_VERSION ||
      recipe.paletteCount < lightweaver::LW_RECIPE_MIN_PALETTE_COLORS ||
      recipe.layerCount > lightweaver::LW_RECIPE_MAX_LAYERS) return false;
  const uint32_t recipeNow = scaleTime(now, mods.speed);
  const uint16_t denominator = totalPixels > 1 ? totalPixels - 1 : 1;
  for (uint16_t pixel = 0; pixel < totalPixels; pixel++) {
    float coordinate = float(pixel) / float(denominator);
    CRGB composed = CRGB::Black;
    for (uint8_t layerIndex = 0; layerIndex < recipe.layerCount; layerIndex++) {
      const lightweaver::NativeRecipeLayer& layer = recipe.layers[layerIndex];
      float x = transformedRecipeCoordinate(coordinate, layer);
      float modulation = recipeModulation(layer, recipeNow);
      float timePhase = (float(recipeNow % 3600000U) / 1000.0f) * layer.speed;
      float samplePosition = x * layer.frequency + layer.phase + timePhase + modulation;
      float intensity = 1.0f;
      CRGB color;
      if (layer.source == lightweaver::RecipeSourceNode::Solid) {
        color = recipeColor(recipe.palette[layer.colorIndex % recipe.paletteCount]);
      } else if (layer.source == lightweaver::RecipeSourceNode::Palette) {
        color = sampleRecipePalette(recipe, samplePosition);
      } else if (layer.source == lightweaver::RecipeSourceNode::Wave) {
        uint8_t wave = sin8(static_cast<uint8_t>(recipeFract(samplePosition) * 255.0f));
        intensity = float(wave) / 255.0f;
        color = sampleRecipePalette(recipe, intensity);
      } else if (layer.source == lightweaver::RecipeSourceNode::FastLedNoise) {
        uint16_t noiseX = static_cast<uint16_t>(recipeFract(x * layer.scale) * 65535.0f);
        uint16_t noiseT = static_cast<uint16_t>((recipeNow / 8U) + recipe.seed + layerIndex * 977U);
        uint8_t noise = inoise8(noiseX, noiseT);
        intensity = float(noise) / 255.0f;
        color = sampleRecipePalette(recipe, intensity);
      } else {
        uint16_t frame = static_cast<uint16_t>(recipeNow / 50U);
        uint8_t sparkle = hash8(pixel ^ uint16_t(recipe.seed), frame + layerIndex * 61U);
        intensity = layer.density <= 0.0f ? 0.0f
            : layer.density >= 1.0f ? 1.0f
            : sparkle >= static_cast<uint8_t>((1.0f - layer.density) * 255.0f)
                ? 1.0f : 0.0f;
        color = intensity > 0.0f
            ? recipeColor(recipe.palette[recipe.paletteCount - 1])
            : recipeColor(recipe.palette[0]);
      }
      if (layer.thresholdEnabled && intensity < layer.threshold) intensity = 0.0f;
      float alpha = constrain(layer.opacity * layer.brightness * intensity *
                              recipeMaskAlpha(x, layer), 0.0f, 1.0f);
      compositeRecipeLayer(composed, color, alpha, layer.blend, layerIndex == 0);
    }
    leds[pixel] = composed;
    if (mods.hueShift != 0 && (leds[pixel].r || leds[pixel].g || leds[pixel].b)) {
      CHSV hsv = rgb2hsv_approximate(leds[pixel]);
      hsv.hue = shiftHue(hsv.hue, mods.hueShift);
      leds[pixel] = hsv;
    }
  }
  applyGlobalColorModifiers(leds, totalPixels, recipeNow, mods);
  return true;
}

bool isSupportedProceduralPattern(const String& patternId) {
  return lightweaver::findNativeRecipe(patternId.c_str()) != nullptr ||
         patternId == "aurora" ||
         patternId == "custom-color" ||
         patternId == "ember" ||
         patternId == "plasma" ||
         patternId == "fire" ||
         patternId == "ocean" ||
         patternId == "ripple" ||
         patternId == "lava" ||
         patternId == "rainbow" ||
         patternId == "sparkle" ||
         patternId == "breathe" ||
         patternId == "meteor" ||
         patternId == "chase" ||
         patternId == "scanner" ||
         patternId == "candle" ||
         patternId == "lightning" ||
         patternId == "neon" ||
         patternId == "matrix" ||
         patternId == "heartbeat" ||
         patternId == "stained" ||
         patternId == "confetti" ||
         patternId == "warp" ||
         patternId == "pulse-ring" ||
         patternId == "blocks" ||
         patternId == "bloom" ||
         patternId == "calm" ||
         patternId == "drift" ||
         patternId == "sunset" ||
         patternId == "twinkle" ||
         patternId == "wave";
}

bool isSupportedPresetPattern(const String& patternId) {
  return patternId == "warm-white" ||
         patternId == "cool-white" ||
         patternId == "photo-white" ||
         patternId == "blackout" ||
         patternId == "off" ||
         patternId == "test-red" ||
         patternId == "red" ||
         patternId == "test-green" ||
         patternId == "green" ||
         patternId == "test-blue" ||
         patternId == "blue" ||
         patternId == "test-white" ||
         patternId == "white";
}

bool isSupportedCompiledPattern(const String& patternId) {
  return isSupportedProceduralPattern(patternId) || isSupportedPresetPattern(patternId);
}

bool renderProceduralPattern(const String& preset, CRGB* leds, uint16_t totalPixels, uint32_t now, const PatternModifiers& mods) {
  if (!isSupportedProceduralPattern(preset)) return false;
  const lightweaver::NativeRecipe* recipe = lightweaver::findNativeRecipe(preset.c_str());
  if (recipe) return renderNativeRecipe(*recipe, leds, totalPixels, now, mods);
  uint32_t t = scaleTime(now, mods.speed);
  if (preset == "custom-color") {
    uint8_t hue = mods.customHue;
    if (mods.customDrift) {
      // Drift through a palette window: walk a triangle wave between min/max
      // so the drift always stays inside the chosen colors. If min==max the
      // hue is fixed (effectively disables drift). If min>max we wrap around
      // the color wheel (e.g. min=240,max=20 covers magenta→red→orange).
      uint8_t lo = mods.driftHueMin;
      uint8_t hi = mods.driftHueMax;
      uint16_t span;
      if (hi >= lo) span = uint16_t(hi - lo);
      else span = uint16_t(255 - lo + hi + 1);
      if (span == 0) {
        hue = lo;
      } else {
        // Triangle wave 0..span..0 with period proportional to span.
        // Slow palette traversal: ~10 seconds end-to-end at speed=1.
        uint32_t period = max<uint32_t>(2000, span * 80);
        uint32_t phase = t % (period * 2);
        uint16_t step;
        if (phase < period) step = uint16_t((uint32_t(phase) * span) / period);
        else step = uint16_t(span - ((uint32_t(phase - period) * span) / period));
        if (hi >= lo) hue = lo + uint8_t(step);
        else hue = uint8_t((uint16_t(lo) + step) & 0xff);
      }
    }
    uint8_t value = 220;
    if (mods.customBreathe) {
      uint8_t b = beatsin8(speedBpm(8, mods.speed), 60, 230);
      value = b;
    }
    CHSV color(hue, mods.customSaturation, value);
    fill_solid(leds, totalPixels, color);
    return true;
  }
  for (uint16_t i = 0; i < totalPixels; i++) {
    uint16_t count = max<uint16_t>(1, totalPixels);
    uint8_t pos = uint8_t((uint32_t(i) * 255u) / count);
    if (preset == "ember") {
      uint8_t flicker = inoise8(i * 18, t / 7);
      CHSV color(shiftHue(8, mods.hueShift), 220, 120 + (flicker / 2));
      leds[i] = color;
    } else if (preset == "plasma") {
      uint8_t a = sin8(i * 9 + t / 12);
      uint8_t b = sin8(i * 5 - t / 17);
      uint8_t hue = shiftHue(uint8_t((uint16_t(a) + b) / 2), mods.hueShift);
      leds[i] = CHSV(hue, 210, 165 + (sin8(a + b) / 4));
    } else if (preset == "fire") {
      uint8_t heat = qadd8(inoise8(i * 24, t / 5), sin8(pos + t / 10) / 5);
      uint8_t hue = shiftHue(uint8_t(2 + heat / 9), mods.hueShift);
      leds[i] = CHSV(hue, 245, uint8_t(70 + (uint16_t(heat) * 2) / 3));
    } else if (preset == "ocean") {
      uint8_t w1 = sin8(i * 6 + t / 18);
      uint8_t w2 = sin8(i * 3 - t / 25);
      uint8_t wave = uint8_t((uint16_t(w1) + w2) / 2);
      leds[i] = CHSV(shiftHue(135 + wave / 8, mods.hueShift), 190, 70 + wave / 2);
    } else if (preset == "ripple") {
      int mid = int(totalPixels) / 2;
      uint8_t dist = uint8_t(min(255, abs(int(i) - mid) * 510 / max<int>(1, totalPixels)));
      uint8_t ring = sin8(dist * 4 - t / 8);
      uint8_t level = ring > 150 ? uint8_t((ring - 150) * 2) : uint8_t(ring / 8);
      leds[i] = CHSV(shiftHue(145, mods.hueShift), 190, level);
    } else if (preset == "lava") {
      uint8_t blob = inoise8(i * 11 + sin8(t / 24), t / 18);
      uint8_t hue = shiftHue(250 + blob / 14, mods.hueShift);
      leds[i] = CHSV(hue, 235, 58 + blob / 2);
    } else if (preset == "rainbow") {
      leds[i] = CHSV(shiftHue((i * 4 + t / 22) & 0xff, mods.hueShift), 190, 220);
    } else if (preset == "sparkle") {
      uint16_t frame = uint16_t(t / 70);
      uint8_t spark = hash8(i * 19u, frame);
      if (spark > 242) leds[i] = CRGB::White;
      else leds[i] = CHSV(shiftHue(160, mods.hueShift), 150, 18 + inoise8(i * 12, t / 30) / 10);
    } else if (preset == "breathe") {
      uint8_t level = beatsin8(speedBpm(12, mods.speed), 45, 190);
      leds[i] = CHSV(shiftHue(32, mods.hueShift), 90, level);
    } else if (preset == "meteor") {
      uint16_t head = (t / 18) % count;
      uint16_t forward = (i + count - head) % count;
      uint8_t tail = forward > 18 ? 0 : uint8_t(230 - forward * 12);
      leds[i] = CHSV(shiftHue(165, mods.hueShift), tail > 190 ? 40 : 150, tail);
    } else if (preset == "chase") {
      uint16_t head = (t / 16) % count;
      uint16_t distance = min<uint16_t>((i + count - head) % count, (head + count - i) % count);
      uint8_t level = distance > 6 ? 8 : uint8_t(230 - distance * 30);
      leds[i] = CHSV(shiftHue(uint8_t(t / 28), mods.hueShift), 230, level);
    } else if (preset == "scanner") {
      uint16_t head = (t / 28) % max<uint16_t>(1, totalPixels);
      uint16_t distance = abs(int(i) - int(head));
      uint8_t level = distance > 8 ? 0 : 220 - (distance * 24);
      CHSV color(shiftHue(16, mods.hueShift), 200, level);
      leds[i] = color;
    } else if (preset == "candle") {
      uint8_t flicker = qadd8(inoise8(i * 17, t / 4) / 2, inoise8(i * 31 + 80, t / 7) / 3);
      leds[i] = CHSV(shiftHue(22 + flicker / 24, mods.hueShift), 210, 70 + flicker / 2);
    } else if (preset == "lightning") {
      uint16_t frame = uint16_t(t / 110);
      bool strike = hash8(frame, 77) > 218;
      uint8_t bolt = hash8(i * 23u, frame);
      if (strike && bolt > 116) leds[i] = CHSV(shiftHue(164, mods.hueShift), bolt > 224 ? 20 : 80, bolt);
      else leds[i] = CRGB::Black;
    } else if (preset == "neon") {
      uint8_t seg = uint8_t((uint32_t(i) * 7u) / count);
      uint8_t flicker = hash8(seg * 31u, uint16_t(t / 90));
      uint8_t level = flicker > 18 ? 220 : 30;
      leds[i] = CHSV(shiftHue(seg * 36 + t / 80, mods.hueShift), 240, level);
    } else if (preset == "matrix") {
      uint8_t stream = uint8_t((i * 13 + t / 9) % 48);
      uint8_t level = stream < 8 ? uint8_t(230 - stream * 24) : 8;
      leds[i] = CHSV(shiftHue(96, mods.hueShift), stream < 2 ? 40 : 240, level);
    } else if (preset == "heartbeat") {
      uint8_t phase = uint8_t((t / 5) & 0xff);
      uint8_t p1 = phase < 26 ? uint8_t(230 - phase * 7) : 0;
      uint8_t p2 = phase > 42 && phase < 68 ? uint8_t(170 - (phase - 42) * 5) : 0;
      leds[i] = CHSV(shiftHue(252, mods.hueShift), 240, max<uint8_t>(18, max<uint8_t>(p1, p2)));
    } else if (preset == "stained") {
      uint8_t cell = inoise8(i * 42, 12);
      uint8_t vein = abs(int(cell) - 128) < 18 ? 24 : 180;
      leds[i] = CHSV(shiftHue(cell + t / 90, mods.hueShift), 220, vein);
    } else if (preset == "confetti") {
      uint16_t frame = uint16_t(t / 85);
      uint8_t seed = hash8(i * 29u, frame);
      if (seed > 232) leds[i] = CHSV(shiftHue(hash8(i * 9u, frame + 31), mods.hueShift), 230, 230);
      else leds[i] = CRGB::Black;
    } else if (preset == "warp") {
      int mid = int(totalPixels) / 2;
      uint8_t dist = uint8_t(min(255, abs(int(i) - mid) * 510 / max<int>(1, totalPixels)));
      uint8_t streak = sin8(dist * 5 - t / 5);
      uint8_t level = streak > 185 ? uint8_t((streak - 185) * 3) : uint8_t(streak / 12);
      leds[i] = CHSV(shiftHue(166, mods.hueShift), level > 180 ? 30 : 120, level);
    } else if (preset == "pulse-ring") {
      int mid = int(totalPixels) / 2;
      uint8_t dist = uint8_t(min(255, abs(int(i) - mid) * 510 / max<int>(1, totalPixels)));
      uint8_t pulse = sin8(dist * 3 - t / 7);
      uint8_t level = pulse > 145 ? uint8_t((pulse - 145) * 2) : 8;
      leds[i] = CHSV(shiftHue(218, mods.hueShift), 220, level);
    } else if (preset == "blocks") {
      uint8_t block = uint8_t((i / 6 + t / 360) % 6);
      leds[i] = CHSV(shiftHue(block * 42, mods.hueShift), 220, 180);
    } else if (preset == "bloom") {
      int mid = int(totalPixels) / 2;
      uint8_t dist = uint8_t(min(255, abs(int(i) - mid) * 510 / max<int>(1, totalPixels)));
      uint8_t bloom = qsub8(255, dist);
      uint8_t pulse = sin8(t / 16);
      leds[i] = CHSV(shiftHue(226 + bloom / 12, mods.hueShift), 155, 42 + scale8(bloom, pulse));
    } else if (preset == "calm") {
      uint8_t level = beatsin8(5, 38, 150);
      uint8_t wave = sin8(i * 5 + t / 32);
      leds[i] = CHSV(shiftHue(132 + wave / 10, mods.hueShift), 110, level);
    } else if (preset == "drift") {
      uint8_t hue = shiftHue(uint8_t(pos + t / 80), mods.hueShift);
      uint8_t level = 105 + sin8(i * 4 + t / 30) / 3;
      leds[i] = CHSV(hue, 105, level);
    } else if (preset == "sunset") {
      // Slow gradient that drifts through warm hues: deep magenta to
      // orange to gold. Position-dependent base, time-dependent drift.
      uint8_t drift = uint8_t(t / 60);
      uint8_t pos = uint8_t((i * 256 / max<uint16_t>(1, totalPixels)) + drift);
      // Map 0..255 onto 220..32 (magenta through red/orange to gold)
      uint8_t hue = 220 - uint8_t((uint16_t(pos) * 188) / 255);
      uint8_t sat = 210 + (sin8(pos * 2) / 16);
      uint8_t val = 140 + (sin8(pos) / 4);
      leds[i] = CHSV(shiftHue(hue, mods.hueShift), sat, val);
    } else if (preset == "twinkle") {
      // Dim warm base with random sparkles. Each pixel has a pseudo-random
      // time offset that periodically peaks. Reads like a fireplace.
      uint8_t baseHue = shiftHue(24, mods.hueShift);
      uint8_t base = 36 + (inoise8(i * 30, t / 12) / 8);
      uint8_t sparkPhase = uint8_t((t / 6) + (i * 47));
      uint8_t sparkle = sin8(sparkPhase);
      uint8_t boost = sparkle > 200 ? uint8_t((sparkle - 200) * 3) : 0;
      leds[i] = CHSV(baseHue, 220, qadd8(base, boost));
    } else if (preset == "wave") {
      // Structured sinusoidal motion: clean palette ride, no chaos.
      uint8_t phase = uint8_t(i * 8 + t / 14);
      uint8_t wave = sin8(phase);
      uint8_t hue = shiftHue(140 + (wave / 4), mods.hueShift);
      leds[i] = CHSV(hue, 180, 90 + (wave / 2));
    } else {
      // Default / aurora — teal wave.
      uint8_t wave = sin8(i * 6 + t / 18);
      uint8_t hue = shiftHue(118 + (wave / 5), mods.hueShift);
      leds[i] = CHSV(hue, 135 + (wave / 5), 120 + (wave / 3));
    }
  }
  applyGlobalColorModifiers(leds, totalPixels, t, mods);
  return true;
}

bool renderPresetPattern(const String& preset, CRGB* leds, uint16_t totalPixels, const PatternModifiers& mods) {
  if (!isSupportedPresetPattern(preset)) return false;
  if (preset == "blackout" || preset == "off") {
    fill_solid(leds, totalPixels, CRGB::Black);
    return true;
  }
  if (preset == "test-red" || preset == "red") {
    fill_solid(leds, totalPixels, CRGB::Red);
    return true;
  }
  if (preset == "test-green" || preset == "green") {
    fill_solid(leds, totalPixels, CRGB::Green);
    return true;
  }
  if (preset == "test-blue" || preset == "blue") {
    fill_solid(leds, totalPixels, CRGB::Blue);
    return true;
  }
  if (preset == "test-white" || preset == "white") {
    fill_solid(leds, totalPixels, CRGB::White);
    return true;
  }
  // Hue-shifted whites: warm-white at hue 32, cool-white at hue 160, photo-white at hue 28
  uint8_t baseHue = 32;
  uint8_t saturation = 80;
  uint8_t value = 220;
  if (preset == "cool-white") { baseHue = 160; saturation = 90; }
  else if (preset == "photo-white") { baseHue = 28; saturation = 60; }
  CHSV color(shiftHue(baseHue, mods.hueShift), saturation, value);
  fill_solid(leds, totalPixels, color);
  applyGlobalColorModifiers(leds, totalPixels, millis(), mods);
  return true;
}
