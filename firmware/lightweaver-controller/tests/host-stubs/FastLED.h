#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

struct CHSV {
  union { uint8_t hue; uint8_t h; };
  union { uint8_t saturation; uint8_t s; };
  union { uint8_t value; uint8_t v; };
  CHSV(uint8_t hueValue = 0, uint8_t saturationValue = 0, uint8_t valueValue = 0)
      : hue(hueValue), saturation(saturationValue), value(valueValue) {}
};

struct CRGB {
  uint8_t r = 0;
  uint8_t g = 0;
  uint8_t b = 0;
  CRGB() = default;
  CRGB(uint8_t red, uint8_t green, uint8_t blue) : r(red), g(green), b(blue) {}
  CRGB(const CHSV& hsv) { *this = hsv; }
  CRGB& operator=(const CHSV& hsv) {
    const uint8_t region = hsv.hue / 43U;
    const uint8_t remainder = static_cast<uint8_t>((hsv.hue - region * 43U) * 6U);
    const uint8_t p = static_cast<uint8_t>((uint16_t(hsv.value) * (255U - hsv.saturation)) / 255U);
    const uint8_t q = static_cast<uint8_t>((uint16_t(hsv.value) * (255U - (uint16_t(hsv.saturation) * remainder) / 255U)) / 255U);
    const uint8_t t = static_cast<uint8_t>((uint16_t(hsv.value) * (255U - (uint16_t(hsv.saturation) * (255U - remainder)) / 255U)) / 255U);
    switch (region) {
      case 0: r = hsv.value; g = t; b = p; break;
      case 1: r = q; g = hsv.value; b = p; break;
      case 2: r = p; g = hsv.value; b = t; break;
      case 3: r = p; g = q; b = hsv.value; break;
      case 4: r = t; g = p; b = hsv.value; break;
      default: r = hsv.value; g = p; b = q; break;
    }
    return *this;
  }
  void nscale8(uint8_t scale) {
    r = static_cast<uint8_t>((uint16_t(r) * scale) / 255U);
    g = static_cast<uint8_t>((uint16_t(g) * scale) / 255U);
    b = static_cast<uint8_t>((uint16_t(b) * scale) / 255U);
  }
  bool operator==(const CRGB& other) const { return r == other.r && g == other.g && b == other.b; }
  bool operator!=(const CRGB& other) const { return !(*this == other); }
  static const CRGB Black;
  static const CRGB Red;
  static const CRGB Green;
  static const CRGB Blue;
  static const CRGB White;
};

inline const CRGB CRGB::Black{0, 0, 0};
inline const CRGB CRGB::Red{255, 0, 0};
inline const CRGB CRGB::Green{0, 255, 0};
inline const CRGB CRGB::Blue{0, 0, 255};
inline const CRGB CRGB::White{255, 255, 255};

inline uint8_t sin8(uint8_t phase) {
  return static_cast<uint8_t>(std::lround((std::sin(double(phase) * 6.283185307179586 / 256.0) + 1.0) * 127.5));
}
inline uint8_t inoise8(uint16_t x, uint16_t y = 0) {
  uint32_t value = uint32_t(x) * 1103515245U + uint32_t(y) * 12345U + 0x9e3779b9U;
  value ^= value >> 16;
  return static_cast<uint8_t>(value >> 8);
}
inline uint8_t qadd8(uint8_t a, uint8_t b) { return uint16_t(a) + b > 255U ? 255U : uint8_t(a + b); }
inline uint8_t qsub8(uint8_t a, uint8_t b) { return a > b ? uint8_t(a - b) : 0; }
inline uint8_t scale8(uint8_t value, uint8_t scale) { return uint8_t((uint16_t(value) * scale) / 255U); }
inline CRGB blend(const CRGB& a, const CRGB& b, uint8_t amount) {
  return CRGB(
      uint8_t((uint16_t(a.r) * (255U - amount) + uint16_t(b.r) * amount) / 255U),
      uint8_t((uint16_t(a.g) * (255U - amount) + uint16_t(b.g) * amount) / 255U),
      uint8_t((uint16_t(a.b) * (255U - amount) + uint16_t(b.b) * amount) / 255U));
}
inline CHSV rgb2hsv_approximate(const CRGB& rgb) { return CHSV(rgb.r, rgb.g, std::max({rgb.r, rgb.g, rgb.b})); }
inline void fill_solid(CRGB* leds, uint16_t count, const CRGB& color) {
  for (uint16_t index = 0; index < count; index++) leds[index] = color;
}
inline void fill_solid(CRGB* leds, uint16_t count, const CHSV& color) {
  fill_solid(leds, count, CRGB(color));
}
