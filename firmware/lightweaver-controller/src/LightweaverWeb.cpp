#include "LightweaverWeb.h"
#include <WiFi.h>

namespace {
WebServer server(80);
RuntimeConfig* runtimeConfigPtr = nullptr;
ErrorCode* errorCodePtr = nullptr;
uint16_t* totalPixelsPtr = nullptr;
uint8_t* currentLookIndexPtr = nullptr;

String apSsid() {
  uint64_t mac = ESP.getEfuseMac();
  char suffix[5];
  snprintf(suffix, sizeof(suffix), "%04X", uint16_t(mac & 0xffff));
  return String("Lightweaver-") + suffix;
}

void sendCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

void handleOptions() {
  sendCors();
  server.send(204, "text/plain", "");
}

void handleRoot() {
  sendCors();
  server.send(200, "text/html",
    "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>Lightweaver Card</title>"
    "<body style='font-family:system-ui;margin:24px;background:#090909;color:#f7f3ea'>"
    "<h1>Lightweaver Card</h1>"
    "<p>This card is running on ESP32 internal playback.</p>"
    "<p>Paste a Lightweaver internal flash card config JSON, then save it to this card.</p>"
    "<textarea id='cfg' style='width:100%;min-height:220px;background:#111;color:#f7f3ea;border:1px solid #555'></textarea>"
    "<button id='save' style='display:block;margin-top:12px;padding:12px 16px'>Save to card</button>"
    "<pre id='out'></pre>"
    "<script>"
    "save.onclick=async()=>{out.textContent='Saving...';"
    "const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:cfg.value});"
    "out.textContent=await r.text();};"
    "fetch('/api/status').then(r=>r.text()).then(t=>out.textContent=t);"
    "</script>"
    "</body>");
}

void handleStatus() {
  sendCors();
  server.send(200, "application/json", runtimeStatusJson(
    *runtimeConfigPtr,
    *errorCodePtr,
    *totalPixelsPtr,
    *currentLookIndexPtr
  ));
}

void handleConfigPost() {
  sendCors();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing json body\"}");
    return;
  }
  String message;
  bool ok = saveRuntimeConfigJson(server.arg("plain"), *runtimeConfigPtr, message);
  if (!ok) {
    server.send(400, "application/json", String("{\"ok\":false,\"error\":\"") + message + "\"}");
    return;
  }
  server.send(200, "application/json", String("{\"ok\":true,\"message\":\"") + message + "\"}");
}

void handleReboot() {
  sendCors();
  server.send(200, "application/json", "{\"ok\":true,\"message\":\"rebooting\"}");
  delay(150);
  ESP.restart();
}
}

void setupLightweaverWeb(RuntimeConfig& config, ErrorCode& errorCode, uint16_t& totalPixels, uint8_t& currentLookIndex) {
  runtimeConfigPtr = &config;
  errorCodePtr = &errorCode;
  totalPixelsPtr = &totalPixels;
  currentLookIndexPtr = &currentLookIndex;

  WiFi.mode(WIFI_AP);
  String ssid = apSsid();
  WiFi.softAP(ssid.c_str());
  Serial.print("Lightweaver AP: ");
  Serial.print(ssid);
  Serial.print(" / ");
  Serial.println(WiFi.softAPIP());

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/config", HTTP_OPTIONS, handleOptions);
  server.on("/api/config", HTTP_POST, handleConfigPost);
  server.on("/api/reboot", HTTP_OPTIONS, handleOptions);
  server.on("/api/reboot", HTTP_POST, handleReboot);
  server.begin();
}

void handleLightweaverWeb() {
  server.handleClient();
}
