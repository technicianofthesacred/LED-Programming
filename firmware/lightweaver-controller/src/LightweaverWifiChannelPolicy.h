#pragma once

#include <cstdint>

// The ESP32-S3 has one radio, so the setup hotspot and the station link share a
// channel whether or not they agree on one. When they disagree the SDK drags
// the AP onto the station's channel during the join and deauthenticates every
// phone connected to it — the "Lightweaver hotspot won't stay up" report.
//
// Everything here exists to make them agree *before* the join starts, without
// scanning for the answer. Scanning is what parks the radio off-channel in the
// first place; a speculative boot scan was already removed for exactly that
// reason, which is what left the boot path with no channel to align to at all.
// The channel of a successful association is free to record, so it is recorded,
// and later boots read it back instead of going looking for it.
namespace lightweaver {

// "No usable channel." Distinct from every real channel, so the same value can
// mean "this card has never joined anything" and "that association was not on a
// channel the AP could have followed anyway".
constexpr uint8_t kWifiChannelUnknown = 0;

// Only plain 2.4GHz channels can carry the soft AP, so everything else — a
// 5GHz association, a negative SDK error return, a corrupt or hand-edited
// stored value — normalizes away rather than reaching WiFi.softAP().
constexpr uint8_t normalizeWifiChannel(int32_t channel) {
  return channel >= 1 && channel <= 14 ? uint8_t(channel) : kWifiChannelUnknown;
}

// Channel to raise the setup AP on. Fresh scan results win when there are any:
// during commissioning the setup page has just scanned, so they describe the
// network as it is right now. Otherwise the channel remembered from the last
// successful association is used — the only source available on the boot path,
// where the scan cache is always empty and refilling it would mean scanning.
//
// kWifiChannelUnknown when neither is known, which is the blank-card path: the
// AP goes up on the SDK default exactly as it always has.
constexpr uint8_t setupApChannel(uint8_t scannedChannel,
                                 uint8_t rememberedChannel) {
  return normalizeWifiChannel(scannedChannel) != kWifiChannelUnknown
      ? normalizeWifiChannel(scannedChannel)
      : normalizeWifiChannel(rememberedChannel);
}

// What to write back to the stored credentials once the card is associated.
struct WifiProvenRecord {
  bool persist = false;
  uint8_t channel = kWifiChannelUnknown;
};

// Decided on every connectivity poll, so the steady state has to be a no-op:
// persist only when the proven flag flips or the channel genuinely moved
// (the router changed channels since the last boot). A channel is stable for
// the life of an association, so that is one NVS write per join rather than
// one every 250ms.
//
// An unknown observed channel never erases a good stored one: a card can be
// associated on 5GHz and still hold a useful 2.4GHz memory for its hotspot.
inline WifiProvenRecord planWifiProvenRecord(bool hasCredentials,
                                             bool alreadyProven,
                                             uint8_t storedChannel,
                                             uint8_t observedChannel) {
  uint8_t stored = normalizeWifiChannel(storedChannel);
  uint8_t observed = normalizeWifiChannel(observedChannel);
  bool moved = observed != kWifiChannelUnknown && observed != stored;
  WifiProvenRecord record;
  record.persist = hasCredentials && (!alreadyProven || moved);
  record.channel = observed != kWifiChannelUnknown ? observed : stored;
  return record;
}

}  // namespace lightweaver
