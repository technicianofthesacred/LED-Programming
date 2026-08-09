#pragma once

#include <Arduino.h>

class WebServer;

static constexpr uint32_t LW_HTTP_STREAM_LEASE_TTL_MS = 1500;
static constexpr size_t LW_HTTP_STREAM_MAX_BODY_BYTES = 4096;
static constexpr size_t LW_HTTP_STREAM_MAX_PIXELS_PER_CHUNK = 320;

struct LightweaverHttpStreamBinding {
  String cardId;
  String bootId;
  String ownerSessionId;
  uint32_t operationGeneration = 0;
  String host;
  String origin;
  String networkIdentity;
};

void registerLightweaverHttpFrameStream(WebServer& server);
void handleLightweaverHttpFrameStream();
bool lightweaverHttpFrameStreamActive();
void stopLightweaverHttpFrameStream();
