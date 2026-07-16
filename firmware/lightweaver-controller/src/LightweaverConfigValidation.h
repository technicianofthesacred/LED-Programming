#pragma once

#include <cmath>

enum class ConfigNumberValidation {
  MISSING,
  VALID,
  INVALID_TYPE,
  NON_FINITE,
  BELOW_MINIMUM,
  ABOVE_MAXIMUM,
};

template <typename Number>
inline ConfigNumberValidation validateOptionalConfigNumber(
    bool present,
    bool numeric,
    Number value,
    float minimum,
    float maximum) {
  if (!present) return ConfigNumberValidation::MISSING;
  if (!numeric) return ConfigNumberValidation::INVALID_TYPE;
  const float numericValue = static_cast<float>(value);
  if (!std::isfinite(numericValue)) return ConfigNumberValidation::NON_FINITE;
  if (numericValue < minimum) return ConfigNumberValidation::BELOW_MINIMUM;
  if (numericValue > maximum) return ConfigNumberValidation::ABOVE_MAXIMUM;
  return ConfigNumberValidation::VALID;
}
