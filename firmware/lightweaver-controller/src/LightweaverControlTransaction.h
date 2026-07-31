#pragma once

#include <stdint.h>

template <typename ApplySelectionContext,
          typename RollbackSelectionContext,
          typename CommitSelection,
          typename ApplyOtherMutations,
          typename AdvanceRevision>
inline bool applyPreparedControlTransaction(bool selectionRequested,
                                            ApplySelectionContext applySelectionContext,
                                            RollbackSelectionContext rollbackSelectionContext,
                                            CommitSelection commitSelection,
                                            ApplyOtherMutations applyOtherMutations,
                                            AdvanceRevision advanceRevision,
                                            uint32_t& responseRevision) {
  applySelectionContext();
  if (selectionRequested && !commitSelection()) {
    rollbackSelectionContext();
    return false;
  }
  applyOtherMutations();
  responseRevision = advanceRevision();
  return true;
}
