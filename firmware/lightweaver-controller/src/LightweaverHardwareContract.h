#pragma once

// Generated from packages/lightweaver-contract/card-hardware.json. Do not edit.

#include <cstddef>
#include <cstdint>

constexpr uint8_t LW_CARD_HARDWARE_CONTRACT_VERSION = 1;
constexpr uint8_t LW_CARD_HARDWARE_OUTPUT_GPIOS[] = {4, 5, 6, 7, 15, 16, 17, 18, 21, 38, 40, 41, 42, 47, 48};
constexpr size_t LW_CARD_HARDWARE_OUTPUT_GPIO_COUNT =
    sizeof(LW_CARD_HARDWARE_OUTPUT_GPIOS) / sizeof(LW_CARD_HARDWARE_OUTPUT_GPIOS[0]);
constexpr uint8_t LW_CARD_HARDWARE_MAX_OUTPUTS = 4;
constexpr uint16_t LW_CARD_HARDWARE_MAX_PIXELS = 65535;
constexpr uint8_t LW_CARD_HARDWARE_MAX_ZONES = 12;
constexpr uint8_t LW_CARD_HARDWARE_MAX_RANGES_PER_ZONE = 6;
constexpr uint16_t LW_CARD_HARDWARE_CONFIG_CAPACITY_BYTES = 3968;
