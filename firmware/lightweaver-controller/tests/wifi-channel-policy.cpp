// Host coverage for the channel decisions behind the setup hotspot.
//
// The radio behaviour itself is not host-testable — nothing here can prove that
// a real ESP32-S3 stops deauthenticating phones — but the two decisions that
// drive it are pure and are exactly where the last regression lived: a lookup
// that could only ever answer "unknown" on the boot path, so the alignment it
// fed never ran. These assertions pin that it now has a second source.
#include <cassert>
#include <cstdint>

#include "../src/LightweaverWifiChannelPolicy.h"

using lightweaver::kWifiChannelUnknown;
using lightweaver::normalizeWifiChannel;
using lightweaver::planWifiProvenRecord;
using lightweaver::setupApChannel;
using lightweaver::WifiProvenRecord;

static_assert(kWifiChannelUnknown == 0, "unknown must stay distinguishable from every real channel");
static_assert(normalizeWifiChannel(1) == 1, "channel 1 is usable");
static_assert(normalizeWifiChannel(14) == 14, "channel 14 is usable");
static_assert(normalizeWifiChannel(0) == kWifiChannelUnknown, "0 already means unknown");
static_assert(normalizeWifiChannel(15) == kWifiChannelUnknown, "above 2.4GHz is not usable");
static_assert(normalizeWifiChannel(36) == kWifiChannelUnknown, "a 5GHz association cannot carry the soft AP");
static_assert(normalizeWifiChannel(-1) == kWifiChannelUnknown, "an SDK error return must not reach softAP()");

// Fresh scan results beat a remembered channel: during commissioning the setup
// page has just scanned, so they describe the network as it is right now.
static_assert(setupApChannel(6, 11) == 6, "scan results win when present");
static_assert(setupApChannel(6, kWifiChannelUnknown) == 6, "scan results are enough on their own");

// The boot path. The scan cache is always empty there — the speculative boot
// scan was removed because it parked the radio off-channel — so without the
// remembered channel this answers "unknown" and the AP goes up wherever the SDK
// puts it, which is the bug this whole change exists to fix.
static_assert(setupApChannel(kWifiChannelUnknown, 11) == 11,
              "a remembered channel must carry the boot path, where no scan has run");

// A blank card has neither, and must behave exactly as it always has: the AP
// starts on the SDK default and nothing tries to move it.
static_assert(setupApChannel(kWifiChannelUnknown, kWifiChannelUnknown) == kWifiChannelUnknown,
              "a card that has never joined anything must not be aimed at a channel");

// A stored value that is not a real channel is worth no more than none at all.
static_assert(setupApChannel(kWifiChannelUnknown, 99) == kWifiChannelUnknown,
              "a corrupt stored channel must normalize away, not reach softAP()");
static_assert(setupApChannel(200, 11) == 11,
              "a nonsense scan reading falls through to the remembered channel");

int main() {
  // First association on freshly saved credentials: nothing is stored yet, so
  // this is the write that makes the card resumable and remembers the channel.
  WifiProvenRecord first = planWifiProvenRecord(true, false, kWifiChannelUnknown, 6);
  assert(first.persist);
  assert(first.channel == 6);

  // Steady state. This runs on every connectivity poll, so it has to stop
  // writing once there is nothing new to say, or it burns NVS every 250ms.
  WifiProvenRecord steady = planWifiProvenRecord(true, true, 6, 6);
  assert(!steady.persist);

  // The router moved channels since the last boot. The AP went up on the stale
  // channel and the SDK migrated it — no worse than before this change — but
  // the new channel gets written back so the *next* boot is right.
  WifiProvenRecord moved = planWifiProvenRecord(true, true, 6, 11);
  assert(moved.persist);
  assert(moved.channel == 11);

  // Associated somewhere the soft AP could not have followed. A good 2.4GHz
  // memory is still worth more than nothing, so it must survive.
  WifiProvenRecord offBand = planWifiProvenRecord(true, true, 6, 36);
  assert(!offBand.persist);
  assert(offBand.channel == 6);

  // Proven but with no channel yet — a card upgraded from firmware that had no
  // channel field. The first association after the upgrade fills it in.
  WifiProvenRecord backfill = planWifiProvenRecord(true, true, kWifiChannelUnknown, 11);
  assert(backfill.persist);
  assert(backfill.channel == 11);

  // Proven, no stored channel, and nothing usable observed: still nothing to
  // write. An older card on 5GHz must not rewrite its credentials every poll.
  WifiProvenRecord nothingToSay = planWifiProvenRecord(true, true, kWifiChannelUnknown, 36);
  assert(!nothingToSay.persist);
  assert(nothingToSay.channel == kWifiChannelUnknown);

  // No credentials at all: there is no network to attribute a channel to, so
  // nothing is ever persisted. The blank-card path stays untouched.
  WifiProvenRecord blank = planWifiProvenRecord(false, false, kWifiChannelUnknown, 6);
  assert(!blank.persist);

  return 0;
}
