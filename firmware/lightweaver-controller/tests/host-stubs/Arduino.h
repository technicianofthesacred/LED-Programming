#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <string>

class String {
 public:
  String() = default;
  String(const char* value) : value_(value ? value : "") {}
  String(const std::string& value) : value_(value) {}
  const char* c_str() const { return value_.c_str(); }
  size_t length() const { return value_.length(); }
  bool operator==(const char* other) const { return value_ == (other ? other : ""); }
  bool operator!=(const char* other) const { return !(*this == other); }
 private:
  std::string value_;
};

template <typename T> constexpr T min(T a, T b) { return a < b ? a : b; }
template <typename T> constexpr T max(T a, T b) { return a > b ? a : b; }
template <typename T> constexpr T constrain(T value, T low, T high) {
  return value < low ? low : value > high ? high : value;
}
inline uint32_t millis() { return 123456U; }
