#pragma once

#include <FastLED.h>

#include "LightweaverOutputColorConfig.h"

class LightweaverColorPipeline {
 public:
  void configure(const OutputColorConfig& config);
  CRGB transform(const CRGB& logical, uint8_t colorOrderCode) const;

  bool gammaEnabled() const;
  float gammaValue() const;
  float redBalance() const;
  float greenBalance() const;
  float blueBalance() const;

 private:
  uint8_t gammaLut_[256] = {};
  uint8_t redScale_ = 255;
  uint8_t greenScale_ = 255;
  uint8_t blueScale_ = 255;
  bool gammaEnabled_ = false;
  float gammaValue_ = 2.2f;
  float redBalance_ = 1.0f;
  float greenBalance_ = 1.0f;
  float blueBalance_ = 1.0f;
};
