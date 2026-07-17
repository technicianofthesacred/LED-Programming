#include "LightweaverColorPipeline.h"

#include <cmath>

namespace {
float clampBalance(float value) {
  if (!std::isfinite(value) || value <= 0.0f) return 0.0f;
  return value >= 1.0f ? 1.0f : value;
}

uint8_t balanceScale(float balance) {
  return static_cast<uint8_t>(std::lround(clampBalance(balance) * 255.0f));
}
}

void LightweaverColorPipeline::configure(const OutputColorConfig& config) {
  gammaEnabled_ = config.gammaEnabled;
  gammaValue_ = std::isfinite(config.gammaValue) && config.gammaValue >= 1.0f && config.gammaValue <= 3.0f
      ? config.gammaValue
      : 2.2f;
  redBalance_ = clampBalance(config.red);
  greenBalance_ = clampBalance(config.green);
  blueBalance_ = clampBalance(config.blue);
  redScale_ = balanceScale(redBalance_);
  greenScale_ = balanceScale(greenBalance_);
  blueScale_ = balanceScale(blueBalance_);

  for (uint16_t value = 0; value < 256; value++) {
    gammaLut_[value] = applyGamma_video(static_cast<uint8_t>(value), gammaValue_);
  }
}

CRGB LightweaverColorPipeline::transform(const CRGB& logical, uint8_t colorOrderCode) const {
  CRGB calibrated(
      scale8_video(logical.r, redScale_),
      scale8_video(logical.g, greenScale_),
      scale8_video(logical.b, blueScale_));

  if (gammaEnabled_) {
    calibrated.r = gammaLut_[calibrated.r];
    calibrated.g = gammaLut_[calibrated.g];
    calibrated.b = gammaLut_[calibrated.b];
  }

  switch (colorOrderCode) {
    case 1: return CRGB(calibrated.g, calibrated.r, calibrated.b);
    case 2: return CRGB(calibrated.b, calibrated.r, calibrated.g);
    case 3: return CRGB(calibrated.b, calibrated.g, calibrated.r);
    case 4: return CRGB(calibrated.r, calibrated.b, calibrated.g);
    case 5: return CRGB(calibrated.g, calibrated.b, calibrated.r);
    default: return calibrated;
  }
}

bool LightweaverColorPipeline::gammaEnabled() const { return gammaEnabled_; }
float LightweaverColorPipeline::gammaValue() const { return gammaValue_; }
float LightweaverColorPipeline::redBalance() const { return redBalance_; }
float LightweaverColorPipeline::greenBalance() const { return greenBalance_; }
float LightweaverColorPipeline::blueBalance() const { return blueBalance_; }
