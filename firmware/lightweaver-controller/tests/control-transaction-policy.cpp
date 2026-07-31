#include <cassert>
#include <cstdint>

#include "../src/LightweaverControlTransaction.h"
#include "../src/LightweaverSequenceActivationPolicy.h"

int main() {
  uint8_t otherMutations = 0;
  uint32_t revision = 17;
  uint32_t responseRevision = revision;
  bool selectionContextSync = false;

  bool applied = applyPreparedControlTransaction(
      true,
      [&]() { selectionContextSync = true; },
      [&]() { selectionContextSync = false; },
      []() { return false; },
      [&]() { otherMutations++; },
      [&]() { return ++revision; },
      responseRevision);
  assert(!applied);
  assert(otherMutations == 0);
  assert(!selectionContextSync);
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
      []() {},
      []() {},
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
      []() {},
      []() {},
      []() { return true; },
      [&]() { otherMutations++; },
      [&]() { return ++revision; },
      responseRevision);
  assert(applied);
  assert(otherMutations == 1);
  assert(revision == 18);
  assert(responseRevision == 18);

  // A whole-piece scene request can arrive while the card is in split mode.
  // The requested sync state must govern both the prepared scene commit and
  // any accompanying empty-target mutation such as blackout.
  bool syncZones = false;
  uint8_t zonePatterns[2] = {1, 2};
  uint8_t activePatternId = 0;
  bool zoneBlackout[2] = {false, false};
  applied = applyPreparedControlTransaction(
      true,
      [&]() { syncZones = true; },
      [&]() { syncZones = false; },
      [&]() {
        zonePatterns[0] = 9;
        if (syncZones) zonePatterns[1] = 9;
        activePatternId = zonePatterns[0] == 9 && zonePatterns[1] == 9 ? 9 : 0;
        return true;
      },
      [&]() {
        zoneBlackout[0] = true;
        if (syncZones) zoneBlackout[1] = true;
      },
      [&]() { return ++revision; },
      responseRevision);
  assert(applied);
  assert(syncZones);
  assert(zonePatterns[0] == 9);
  assert(zonePatterns[1] == 9);
  assert(activePatternId == 9);
  assert(zoneBlackout[0]);
  assert(zoneBlackout[1]);
  assert(preparedSequenceActivationReady(true, 52, 52, 12, 12));
  assert(!preparedSequenceActivationReady(true, 52, 51, 12, 12));

  return 0;
}
