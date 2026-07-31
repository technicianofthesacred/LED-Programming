#include <cassert>

#include "../src/LightweaverLookModePolicy.h"

int main() {
  assert(effectiveLookRequiresSequenceMetadata(false, false, true, false));
  assert(!effectiveLookRequiresSequenceMetadata(false, false, true, true));
  assert(effectiveLookRequiresSequenceMetadata(true, true, false, false));
  assert(!effectiveLookRequiresSequenceMetadata(true, false, true, false));
  assert(!effectiveLookRequiresSequenceMetadata(true, true, true, true));
  return 0;
}
