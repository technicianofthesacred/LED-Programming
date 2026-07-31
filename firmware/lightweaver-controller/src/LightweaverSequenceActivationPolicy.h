#pragma once

#include <stddef.h>
#include <stdint.h>

inline bool preparedSequenceActivationReady(bool preparedReady,
                                            uint32_t candidateGeneration,
                                            uint32_t stagedGeneration,
                                            size_t frameBytes,
                                            size_t stagedFrameBytes) {
  return preparedReady &&
      candidateGeneration != 0 &&
      candidateGeneration == stagedGeneration &&
      frameBytes > 0 &&
      stagedFrameBytes == frameBytes;
}
