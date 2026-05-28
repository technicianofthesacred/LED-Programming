#include "LightweaverWeb.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include <DNSServer.h>

namespace {
WebServer server(80);
DNSServer dnsServer;
bool dnsServerActive = false;
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

String sanitizeHostname(const String& raw) {
  String out;
  for (size_t i = 0; i < raw.length(); i++) {
    char c = raw[i];
    if (c >= 'A' && c <= 'Z') c = c + 32;
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') out += c;
  }
  if (!out.length()) out = "lightweaver";
  if (out.length() > 32) out = out.substring(0, 32);
  return out;
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

String escapeHtml(const String& in) {
  String out;
  out.reserve(in.length());
  for (size_t i = 0; i < in.length(); i++) {
    char c = in[i];
    if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '&') out += "&amp;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

void handleRoot() {
  sendCors();
  RuntimeConfig& cfg = *runtimeConfigPtr;
  bool stationActive = cfg.activeTransport == WIFI_TRANSPORT_STATION;
  bool wifiConfigured = cfg.wifi.ssid.length() > 0;

  String page;
  page.reserve(4096);
  page += F("<!doctype html><html><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<title>Lightweaver Card</title>"
            "<style>"
            "body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;margin:0;background:#0a0a0a;color:#f4ede0;line-height:1.5}"
            ".wrap{max-width:480px;margin:0 auto;padding:32px 24px}"
            "h1{font-size:24px;font-weight:500;letter-spacing:0.5px;margin:0 0 4px}"
            ".sub{color:#9a8d75;font-size:14px;margin-bottom:32px}"
            ".card{background:#141414;border:1px solid #262626;border-radius:12px;padding:20px;margin-bottom:16px}"
            ".card h2{font-size:14px;font-weight:500;letter-spacing:1px;text-transform:uppercase;color:#9a8d75;margin:0 0 14px}"
            ".row{display:flex;justify-content:space-between;padding:6px 0;font-size:14px}"
            ".row .k{color:#9a8d75}"
            ".row .v{color:#f4ede0;font-family:ui-monospace,SF Mono,monospace}"
            "label{display:block;font-size:12px;letter-spacing:0.5px;text-transform:uppercase;color:#9a8d75;margin:14px 0 6px}"
            "input,select{width:100%;box-sizing:border-box;background:#0a0a0a;color:#f4ede0;border:1px solid #333;border-radius:8px;padding:12px;font-size:16px;font-family:inherit}"
            "input:focus,select:focus{outline:none;border-color:#c89b5c}"
            "button{width:100%;background:#c89b5c;color:#0a0a0a;border:0;border-radius:8px;padding:14px;font-size:16px;font-weight:500;cursor:pointer;margin-top:18px}"
            "button:disabled{background:#3a3328;color:#7a6f5a;cursor:not-allowed}"
            ".note{font-size:13px;color:#9a8d75;margin-top:14px}"
            ".ok{color:#7fb069}"
            ".err{color:#e07856}"
            "</style></head><body><div class='wrap'>");

  page += F("<h1>Lightweaver Card</h1>");
  page += F("<div class='sub'>");
  page += escapeHtml(cfg.pieceName);
  page += F("</div>");

  page += F("<div class='card'><h2>Status</h2>");
  page += F("<div class='row'><span class='k'>Playing</span><span class='v'>");
  page += escapeHtml(cfg.lookCount && *currentLookIndexPtr < cfg.lookCount ? cfg.looks[*currentLookIndexPtr].label : "—");
  page += F("</span></div>");
  page += F("<div class='row'><span class='k'>Pixels</span><span class='v'>");
  page += String(*totalPixelsPtr);
  page += F("</span></div>");
  page += F("<div class='row'><span class='k'>WiFi</span><span class='v'>");
  if (stationActive) {
    page += escapeHtml(cfg.wifi.ssid);
  } else if (wifiConfigured) {
    page += F("<span class='err'>setup mode</span>");
  } else {
    page += F("not configured");
  }
  page += F("</span></div>");
  if (stationActive) {
    page += F("<div class='row'><span class='k'>Address</span><span class='v'>");
    page += escapeHtml(cfg.activeHostname);
    page += F(".local</span></div>");
  }
  page += F("</div>");

  if (!stationActive) {
    page += F("<div class='card'><h2>Join WiFi</h2>"
              "<p class='note'>After joining your home WiFi the card will be reachable at "
              "<strong>lightweaver.local</strong> from any device on that network.</p>"
              "<form id='wf'>"
              "<label>Network</label>"
              "<select name='ssid' id='ssid' required><option value=''>Scanning…</option></select>"
              "<label>Password</label>"
              "<input name='password' id='pw' type='password' autocomplete='off'>"
              "<label>Hostname</label>"
              "<input name='hostname' id='hn' value='");
    page += escapeHtml(cfg.wifi.hostname.length() ? cfg.wifi.hostname : String("lightweaver"));
    page += F("'>"
              "<button id='save' type='submit'>Save and reboot</button>"
              "<p class='note' id='msg'></p>"
              "</form></div>"
              "<script>"
              "const ssid=document.getElementById('ssid'),msg=document.getElementById('msg'),btn=document.getElementById('save');"
              "fetch('/api/wifi/scan').then(r=>r.json()).then(d=>{"
              "ssid.innerHTML='';if(!d.networks||!d.networks.length){ssid.innerHTML='<option value=\"\">No networks found</option>';return}"
              "d.networks.forEach(n=>{const o=document.createElement('option');o.value=n.ssid;o.textContent=n.ssid+(n.rssi?' ('+n.rssi+' dBm)':'');ssid.appendChild(o)})"
              "});"
              "document.getElementById('wf').addEventListener('submit',async e=>{e.preventDefault();btn.disabled=true;msg.textContent='Saving…';msg.className='note';"
              "const body=JSON.stringify({ssid:ssid.value,password:document.getElementById('pw').value,hostname:document.getElementById('hn').value});"
              "const r=await fetch('/api/wifi',{method:'POST',headers:{'Content-Type':'application/json'},body});const j=await r.json();"
              "if(j.ok){msg.textContent='Saved. Rebooting — reconnect to your home WiFi and open '+(document.getElementById('hn').value||'lightweaver')+'.local';msg.className='note ok'}"
              "else{msg.textContent=j.error||'Save failed';msg.className='note err';btn.disabled=false}"
              "});"
              "</script>");
  }

  page += F("<p class='note' style='text-align:center;margin-top:24px'>"
            "Configure patterns and brightness from the Lightweaver app."
            "</p></div></body></html>");

  server.send(200, "text/html", page);
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

void handleWifiPost() {
  sendCors();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing json body\"}");
    return;
  }
  String message;
  bool ok = saveWifiConfigJson(server.arg("plain"), *runtimeConfigPtr, message);
  if (!ok) {
    server.send(400, "application/json", String("{\"ok\":false,\"error\":\"") + message + "\"}");
    return;
  }
  server.send(200, "application/json", String("{\"ok\":true,\"message\":\"") + message + "\"}");
  delay(400);
  ESP.restart();
}

void handleWifiScan() {
  sendCors();
  int16_t found = WiFi.scanComplete();
  if (found == WIFI_SCAN_FAILED || found == -2) {
    WiFi.scanNetworks(true, false);
    server.send(200, "application/json", "{\"scanning\":true,\"networks\":[]}");
    return;
  }
  if (found == WIFI_SCAN_RUNNING) {
    server.send(200, "application/json", "{\"scanning\":true,\"networks\":[]}");
    return;
  }
  JsonDocument doc;
  doc["scanning"] = false;
  JsonArray arr = doc["networks"].to<JsonArray>();
  int limit = found > 12 ? 12 : found;
  for (int i = 0; i < limit; i++) {
    JsonObject net = arr.add<JsonObject>();
    net["ssid"] = WiFi.SSID(i);
    net["rssi"] = WiFi.RSSI(i);
    net["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  WiFi.scanDelete();
  WiFi.scanNetworks(true, false);
  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}

void handleReboot() {
  sendCors();
  server.send(200, "application/json", "{\"ok\":true,\"message\":\"rebooting\"}");
  delay(150);
  ESP.restart();
}

void handleCaptiveProbe() {
  server.sendHeader("Location", "/", true);
  server.send(302, "text/plain", "");
}

void handleNotFound() {
  if (dnsServerActive) {
    server.sendHeader("Location", "/", true);
    server.send(302, "text/plain", "");
    return;
  }
  server.send(404, "text/plain", "not found");
}

bool tryStationJoin(RuntimeConfig& config) {
  if (config.wifi.ssid.length() == 0) return false;
  String hostname = sanitizeHostname(config.wifi.hostname);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(hostname.c_str());
  WiFi.begin(config.wifi.ssid.c_str(), config.wifi.password.c_str());
  Serial.print("Joining WiFi ");
  Serial.print(config.wifi.ssid);
  Serial.print(" as ");
  Serial.println(hostname);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi join failed, falling back to AP");
    WiFi.disconnect(true, true);
    return false;
  }
  config.activeTransport = WIFI_TRANSPORT_STATION;
  config.activeIp = WiFi.localIP().toString();
  config.activeHostname = hostname;
  Serial.print("WiFi joined: ");
  Serial.print(config.activeIp);
  Serial.print(" / ");
  Serial.print(hostname);
  Serial.println(".local");
  if (MDNS.begin(hostname.c_str())) {
    MDNS.addService("http", "tcp", 80);
    Serial.println("mDNS responder up");
  }
  return true;
}

void startApMode(RuntimeConfig& config) {
  WiFi.mode(WIFI_AP);
  String ssid = apSsid();
  WiFi.softAP(ssid.c_str());
  config.activeTransport = WIFI_TRANSPORT_AP;
  config.activeIp = WiFi.softAPIP().toString();
  config.activeHostname = "";
  Serial.print("Lightweaver AP: ");
  Serial.print(ssid);
  Serial.print(" / ");
  Serial.println(config.activeIp);

  dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
  dnsServerActive = dnsServer.start(53, "*", WiFi.softAPIP());
  if (dnsServerActive) {
    Serial.println("Captive DNS up");
  }
}
}

void setupLightweaverWeb(RuntimeConfig& config, ErrorCode& errorCode, uint16_t& totalPixels, uint8_t& currentLookIndex) {
  runtimeConfigPtr = &config;
  errorCodePtr = &errorCode;
  totalPixelsPtr = &totalPixels;
  currentLookIndexPtr = &currentLookIndex;

  if (!tryStationJoin(config)) {
    startApMode(config);
  }

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/config", HTTP_OPTIONS, handleOptions);
  server.on("/api/config", HTTP_POST, handleConfigPost);
  server.on("/api/wifi", HTTP_OPTIONS, handleOptions);
  server.on("/api/wifi", HTTP_POST, handleWifiPost);
  server.on("/api/wifi/scan", HTTP_GET, handleWifiScan);
  server.on("/api/reboot", HTTP_OPTIONS, handleOptions);
  server.on("/api/reboot", HTTP_POST, handleReboot);

  // Captive-portal probes from iOS / Android / Windows — redirect to root
  server.on("/generate_204", HTTP_GET, handleCaptiveProbe);
  server.on("/gen_204", HTTP_GET, handleCaptiveProbe);
  server.on("/hotspot-detect.html", HTTP_GET, handleCaptiveProbe);
  server.on("/library/test/success.html", HTTP_GET, handleCaptiveProbe);
  server.on("/ncsi.txt", HTTP_GET, handleCaptiveProbe);
  server.on("/connecttest.txt", HTTP_GET, handleCaptiveProbe);
  server.on("/redirect", HTTP_GET, handleCaptiveProbe);
  server.onNotFound(handleNotFound);

  server.begin();
  if (config.activeTransport == WIFI_TRANSPORT_AP) {
    WiFi.scanNetworks(true, false);
  }
}

void handleLightweaverWeb() {
  if (dnsServerActive) dnsServer.processNextRequest();
  server.handleClient();
}
