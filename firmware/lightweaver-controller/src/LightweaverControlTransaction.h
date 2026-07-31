#pragma once

#include <stdint.h>

template <typename CommitSelection, typename ApplyOtherMutations, typename AdvanceRevision>
inline bool applyPreparedControlTransaction(bool selectionRequested,
                                            CommitSelection commitSelection,
                                            ApplyOtherMutations applyOtherMutations,
                                            AdvanceRevision advanceRevision,
                                            uint32_t& responseRevision) {
  if (selectionRequested && !commitSelection()) return false;
  applyOtherMutations();
  responseRevision = advanceRevision();
  return true;
}
