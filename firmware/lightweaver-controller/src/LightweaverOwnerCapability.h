#pragma once

#include <Arduino.h>

class WebServer;

static constexpr uint32_t LW_OWNER_CAPABILITY_TTL_MS = 60000;
static constexpr size_t LW_OWNER_CAPABILITY_MAX_BODY_BYTES = 1024;

struct LightweaverOwnerBinding {
  String cardId;
  String bootId;
  String allowedOrigin;
  String host;
  String networkIdentity;
  String ownerSessionId;
  uint32_t operationGeneration = 0;
  String expectedProjectHead;
};

enum class LightweaverOwnerValidation : uint8_t {
  Accepted,
  Missing,
  Expired,
  TokenMismatch,
  BindingMismatch,
};

class LightweaverOwnerCapability {
 public:
  bool issue(const LightweaverOwnerBinding& binding, const String& token,
             uint32_t nowMs);
  LightweaverOwnerValidation validate(const String& token,
                                      const LightweaverOwnerBinding& binding,
                                      uint32_t nowMs);
  bool advanceExpectedProjectHead(const String& token,
                                  const LightweaverOwnerBinding& binding,
                                  const String& nextHead,
                                  uint32_t nowMs);
  void revoke();
  bool active(uint32_t nowMs);
  uint32_t expiresAtMs() const { return expiresAtMs_; }

 private:
  LightweaverOwnerBinding binding_;
  String token_;
  uint32_t expiresAtMs_ = 0;
  bool issued_ = false;
};

bool constantTimeTokenEqual(const String& left, const String& right);
LightweaverOwnerCapability& lightweaverOwnerCapability();
void registerLightweaverOwnerCapability(WebServer& server);
