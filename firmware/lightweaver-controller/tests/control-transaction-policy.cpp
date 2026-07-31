#include <cassert>
#include <cstdint>

#include "../src/LightweaverControlTransaction.h"
#include "../src/LightweaverSequenceActivationPolicy.h"

int main() {
  uint8_t otherMutations = 0;
  uint32_t revision = 17;
  uint32_t responseRevision = revision;

  bool applied = applyPreparedControlTransaction(
      true,
      []() { return false; },
      [&]() { otherMutations++; },
      [&]() { return ++revision; },
      responseRevision);
  assert(!applied);
  assert(otherMutations == 0);
  assert(revision == 17);
  assert(responseRevision == 17);

  uint8_t currentLook = 2;
  uint32_t activeSequence = 41;
  bool blackedOut = true;
  float fade = 0.35f;
  uint8_t zonePattern = 7;
  otherMutations = 0;
  responseRevision = revision;
  applied = applyPreparedControlTransaction(
      true,
      [&]() {
        if (!preparedSequenceActivationReady(
                true, 52, 52, 12, 9)) {
          return false;
        }
        currentLook = 3;
        activeSequence = 52;
        blackedOut = false;
        fade = 1.0f;
        zonePattern = 8;
        return true;
      },
      [&]() { otherMutations++; },
      [&]() { return ++revision; },
      responseRevision);
  assert(!applied);
  assert(currentLook == 2);
  assert(activeSequence == 41);
  assert(blackedOut);
  assert(fade == 0.35f);
  assert(zonePattern == 7);
  assert(otherMutations == 0);
  assert(revision == 17);
  assert(responseRevision == 17);

  applied = applyPreparedControlTransaction(
      true,
      []() { return true; },
      [&]() { otherMutations++; },
      [&]() { return ++revision; },
      responseRevision);
  assert(applied);
  assert(otherMutations == 1);
  assert(revision == 18);
  assert(responseRevision == 18);
  assert(preparedSequenceActivationReady(true, 52, 52, 12, 12));
  assert(!preparedSequenceActivationReady(true, 52, 51, 12, 12));

  return 0;
}
