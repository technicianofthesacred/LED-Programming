#pragma once

#include <Arduino.h>

// Relay client. Phones home to led.mandalacodes.com so customers can control
// their piece from anywhere on the internet without joining the home WiFi.
//
// Three responsibilities, all over HTTPS:
//
//   register   — first boot (or after factory reset). Sends our cardId,
//                receives an ownerToken (auth for all future calls) and a
//                pairing code we display on the local /pair page.
//   heartbeat  — every 15s. Posts current playback state + onlineness so
//                the customer's browser sees the piece is alive.
//   poll       — every 1s. Pulls the most recent command the browser wrote
//                and applies it locally via runtimeSet* APIs.
//
// Card identity is a UUID generated at first boot and persisted in NVS so
// it survives reboot but is fresh on factory reset. ownerToken is stored
// alongside.

void setupRelay(const String& cardLabel);
void handleRelay();
String relayPairCode();           // returns the current pair code or "" when none
uint32_t relayPairExpiresAt();    // millis() when current code expires (0 when none)
bool relayConnected();            // last network call within 60s succeeded
String relayCardId();             // stable UUID
