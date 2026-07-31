#pragma once

inline bool effectiveLookRequiresSequenceMetadata(bool explicitModePresent,
                                                  bool explicitModeSequence,
                                                  bool inheritedSequence,
                                                  bool hasNativeRecipe) {
  if (hasNativeRecipe) return false;
  return explicitModePresent ? explicitModeSequence : inheritedSequence;
}
