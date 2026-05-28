#include "LightweaverWeb.h"
#include "LightweaverRuntimeApi.h"
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
  bool needsSetup = !stationActive && !wifiConfigured;

  String page;
  page.reserve(8192);
  page += F("<!doctype html><html><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>"
            "<title>Lightweaver Card</title>"
            "<style>"
            "*{box-sizing:border-box}"
            "body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;margin:0;background:#0a0a0a;color:#f4ede0;line-height:1.5;-webkit-font-smoothing:antialiased}"
            ".wrap{max-width:520px;margin:0 auto;padding:28px 20px 80px}"
            ".head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:28px}"
            "h1{font-size:22px;font-weight:500;letter-spacing:0.5px;margin:0}"
            ".piece{color:#9a8d75;font-size:13px;font-family:ui-monospace,SF Mono,monospace}"
            ".card{background:#141414;border:1px solid #262626;border-radius:14px;padding:20px;margin-bottom:14px}"
            ".card h2{font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:#9a8d75;margin:0 0 16px}"
            ".now{display:flex;align-items:center;gap:14px;margin-bottom:18px}"
            ".now .pat{font-size:18px;font-weight:500}"
            ".now .mode{font-size:12px;color:#9a8d75;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px}"
            ".preview{height:8px;border-radius:4px;background:linear-gradient(90deg,#c89b5c,#7a4a2a,#c89b5c);background-size:200% 100%;animation:flow 4s linear infinite;margin-bottom:18px}"
            "@keyframes flow{0%{background-position:0 0}100%{background-position:200% 0}}"
            ".slider{margin:14px 0}"
            ".slider label{display:flex;justify-content:space-between;font-size:12px;letter-spacing:0.5px;text-transform:uppercase;color:#9a8d75;margin-bottom:6px}"
            ".slider label .val{color:#c89b5c;font-family:ui-monospace,SF Mono,monospace}"
            "input[type=range]{width:100%;-webkit-appearance:none;height:6px;border-radius:3px;background:#262626;outline:none}"
            "input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:50%;background:#c89b5c;cursor:pointer;border:0}"
            "input[type=range]::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:#c89b5c;cursor:pointer;border:0}"
            ".row{display:flex;gap:10px;margin-top:12px}"
            ".row button{flex:1}"
            "button{background:#262626;color:#f4ede0;border:0;border-radius:10px;padding:14px;font-size:15px;font-weight:500;cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent}"
            "button:active{background:#333}"
            "button.primary{background:#c89b5c;color:#0a0a0a}"
            "button.primary:active{background:#b08749}"
            "button.danger{background:#3a1f1f;color:#e07856}"
            "button.ghost{background:transparent;border:1px solid #333}"
            "button:disabled{opacity:0.4;cursor:not-allowed}"
            ".grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}"
            ".pat-btn{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:14px;text-align:left}"
            ".pat-btn.active{background:#c89b5c;color:#0a0a0a}"
            ".pat-btn .name{font-size:14px;font-weight:500}"
            ".pat-btn .swatch{width:100%;height:6px;border-radius:3px;background:#666}"
            ".pat-btn.active .swatch{background:rgba(10,10,10,0.3)}"
            "details{background:#141414;border:1px solid #262626;border-radius:14px;padding:0;margin-bottom:14px}"
            "details summary{padding:18px 20px;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;font-size:14px;color:#9a8d75;font-weight:500;letter-spacing:0.5px}"
            "details summary::-webkit-details-marker{display:none}"
            "details summary::after{content:'+';font-size:18px;color:#9a8d75}"
            "details[open] summary::after{content:'−'}"
            "details .body{padding:0 20px 20px}"
            "label.field{display:block;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#9a8d75;margin:14px 0 6px}"
            "input[type=text],input[type=password],select{width:100%;background:#0a0a0a;color:#f4ede0;border:1px solid #333;border-radius:8px;padding:12px;font-size:16px;font-family:inherit}"
            "input[type=text]:focus,input[type=password]:focus,select:focus{outline:none;border-color:#c89b5c}"
            ".note{font-size:13px;color:#9a8d75;margin-top:12px;line-height:1.5}"
            ".ok{color:#7fb069}"
            ".err{color:#e07856}"
            ".link{display:block;text-align:center;color:#c89b5c;text-decoration:none;font-size:14px;padding:18px;margin-top:8px;border:1px solid #c89b5c;border-radius:10px}"
            ".link:active{background:rgba(200,155,92,0.1)}"
            ".foot{text-align:center;color:#5a5247;font-size:11px;margin-top:32px;font-family:ui-monospace,SF Mono,monospace}"
            "</style></head><body><div class='wrap'>");

  page += F("<div class='head'>"
            "<h1>Lightweaver</h1>"
            "<span class='piece' id='piece-name'>");
  page += escapeHtml(cfg.pieceName);
  page += F("</span></div>");

  if (needsSetup) {
    // First-time setup — only show the WiFi join form
    page += F("<div class='card'><h2>Set up</h2>"
              "<p class='note'>Join the card to your home WiFi to control it from anywhere on your network.</p>"
              "<label class='field'>Network</label>"
              "<select id='ssid'><option value=''>Scanning…</option></select>"
              "<label class='field'>Password</label>"
              "<input type='password' id='pw' autocomplete='off'>"
              "<label class='field'>Hostname</label>"
              "<input type='text' id='hn' value='lightweaver'>"
              "<div class='row'><button class='primary' id='join'>Save and reboot</button></div>"
              "<p class='note' id='msg'></p>"
              "</div>");
  } else {
    // Live control surface
    page += F("<div class='card'>"
              "<div class='now'>"
                "<div style='flex:1'>"
                  "<div class='pat' id='now-name'>—</div>"
                  "<div class='mode' id='now-mode'>—</div>"
                "</div>"
              "</div>"
              "<div class='preview' id='preview'></div>"
              "<div class='slider'>"
                "<label>Brightness <span class='val' id='b-val'>—</span></label>"
                "<input type='range' min='2' max='100' value='100' id='brightness'>"
              "</div>"
              "<div class='slider'>"
                "<label>Speed <span class='val' id='s-val'>—</span></label>"
                "<input type='range' min='25' max='400' value='100' id='speed'>"
              "</div>"
              "<div class='slider'>"
                "<label>Hue shift <span class='val' id='h-val'>—</span></label>"
                "<input type='range' min='-128' max='128' value='0' id='hue'>"
              "</div>"
              "<div class='row'>"
                "<button id='prev'>← Prev</button>"
                "<button id='blackout'>Blackout</button>"
                "<button id='next'>Next →</button>"
              "</div>"
              "</div>");

    page += F("<div class='card'><h2>Pattern bank</h2>"
              "<div class='grid' id='pat-grid'></div>"
              "</div>");

    page += F("<details><summary>Settings</summary><div class='body'>"
              "<label class='field'>Piece name</label>"
              "<input type='text' id='rn-piece' value='");
    page += escapeHtml(cfg.pieceName);
    page += F("'>"
              "<label class='field'>Hostname</label>"
              "<input type='text' id='rn-host' value='");
    page += escapeHtml(cfg.activeHostname.length() ? cfg.activeHostname : cfg.wifi.hostname);
    page += F("'><p class='note'>Reachable at <strong>&lt;hostname&gt;.local</strong> after reboot.</p>"
              "<div class='row'><button class='primary' id='rn-save'>Save names</button></div>"
              "<div class='row'><button id='identify'>Identify (3 flashes)</button></div>"
              "<div class='row'><button id='reboot'>Reboot</button><button class='ghost' id='change-wifi'>Change WiFi</button></div>"
              "<div class='row'><button class='danger' id='factory'>Factory reset</button></div>"
              "<p class='note' id='set-msg'></p>"
              "<p class='note' style='margin-top:18px;border-top:1px solid #262626;padding-top:14px'>"
                "<span id='fw-info' style='font-family:ui-monospace,SF Mono,monospace;font-size:11px;color:#5a5247'>—</span>"
              "</p>"
              "</div></details>");

    page += F("<a class='link' href='https://led.mandalacodes.com' target='_blank' rel='noopener'>Open Lightweaver app →</a>");
  }

  page += F("<div class='foot' id='foot'>");
  page += escapeHtml(stationActive ? cfg.activeHostname + ".local" : cfg.activeIp);
  page += F("</div></div>");

  // Script
  page += F("<script>"
            "const $=id=>document.getElementById(id);"
            "const post=(p,b)=>fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());"
            "const get=p=>fetch(p).then(r=>r.json());");

  if (needsSetup) {
    page += F("get('/api/wifi/scan').then(d=>{const sel=$('ssid');sel.innerHTML='';"
              "(d.networks||[]).forEach(n=>{const o=document.createElement('option');o.value=n.ssid;o.textContent=n.ssid+(n.rssi?' ('+n.rssi+'dBm)':'');sel.appendChild(o)});"
              "if(!d.networks||!d.networks.length)sel.innerHTML='<option>No networks found</option>'});"
              "$('join').onclick=async()=>{const btn=$('join'),m=$('msg');btn.disabled=true;m.textContent='Saving…';m.className='note';"
              "try{const r=await post('/api/wifi',{ssid:$('ssid').value,password:$('pw').value,hostname:$('hn').value});"
              "if(r.ok){m.textContent='Saved. Rebooting — reconnect to your home WiFi and open '+($('hn').value||'lightweaver')+'.local';m.className='note ok'}"
              "else{m.textContent=r.error||'Save failed';m.className='note err';btn.disabled=false}}catch(e){m.textContent=e.message;m.className='note err';btn.disabled=false}};");
  } else {
    page += F("let patterns=[],currentId='';"
              "const renderGrid=()=>{const g=$('pat-grid');g.innerHTML='';patterns.forEach(p=>{const b=document.createElement('button');b.className='pat-btn'+(p.id===currentId?' active':'');b.innerHTML='<span class=\"name\">'+p.label+'</span><span class=\"swatch\"></span>';b.onclick=async()=>{await post('/api/control',{patternId:p.id});refresh()};g.appendChild(b)})};"
              "const refresh=async()=>{try{"
                "const s=await get('/api/status');"
                "const p=await get('/api/patterns');"
                "patterns=p.patterns||[];currentId=p.currentId||'';"
                "$('now-name').textContent=patterns.find(x=>x.id===currentId)?.label||'—';"
                "$('now-mode').textContent=patterns.find(x=>x.id===currentId)?.mode||'—';"
                "renderGrid();"
                "if(s.blackout)$('blackout').classList.add('primary');else $('blackout').classList.remove('primary');"
              "}catch(e){}};"
              "const sendCtrl=async(p)=>{try{const r=await post('/api/control',p);"
                "if(typeof r.brightness==='number')$('b-val').textContent=Math.round(r.brightness*100)+'%';"
                "if(typeof r.speed==='number')$('s-val').textContent=r.speed.toFixed(2)+'×';"
                "if(typeof r.hueShift==='number')$('h-val').textContent=r.hueShift;"
              "}catch(e){}};"
              "let t1,t2,t3;"
              "$('brightness').oninput=e=>{clearTimeout(t1);t1=setTimeout(()=>sendCtrl({brightness:e.target.value/100}),60)};"
              "$('speed').oninput=e=>{clearTimeout(t2);t2=setTimeout(()=>sendCtrl({speed:e.target.value/100}),60)};"
              "$('hue').oninput=e=>{clearTimeout(t3);t3=setTimeout(()=>sendCtrl({hueShift:parseInt(e.target.value,10)}),60)};"
              "$('prev').onclick=()=>{sendCtrl({previous:true});setTimeout(refresh,200)};"
              "$('next').onclick=()=>{sendCtrl({next:true});setTimeout(refresh,200)};"
              "$('blackout').onclick=async()=>{const s=await get('/api/status');sendCtrl({blackout:!s.blackout});setTimeout(refresh,200)};"
              "$('identify').onclick=()=>{post('/api/identify',{});const m=$('set-msg');m.textContent='Identifying…';m.className='note ok';setTimeout(()=>m.textContent='',2000)};"
              "$('reboot').onclick=async()=>{if(!confirm('Reboot the card?'))return;const m=$('set-msg');m.textContent='Rebooting…';m.className='note';await post('/api/reboot',{})};"
              "$('change-wifi').onclick=()=>{if(!confirm('Wipe WiFi credentials and restart in setup mode?'))return;post('/api/factory-reset',{})};"
              "$('factory').onclick=()=>{if(!confirm('Erase ALL settings (patterns, WiFi, names) and restart? This cannot be undone.'))return;post('/api/factory-reset',{})};"
              "$('rn-save').onclick=async()=>{const m=$('set-msg');m.textContent='Saving…';m.className='note';"
                "const r=await post('/api/rename',{pieceName:$('rn-piece').value,hostname:$('rn-host').value});"
                "if(r.ok){m.textContent='Saved. Reboot to use new hostname.';m.className='note ok'}else{m.textContent=r.error||'Failed';m.className='note err'}};"
              "get('/api/firmware-info').then(d=>{const f=$('fw-info');f.textContent='build '+d.build+' • '+(d.freeHeap/1024|0)+'KB free • '+d.rssi+' dBm'});"
              "refresh();setInterval(refresh,4000);");
  }

  page += F("</script></body></html>");
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

void handleControlPost() {
  sendCors();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing json body\"}");
    return;
  }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) {
    server.send(400, "application/json", String("{\"ok\":false,\"error\":\"") + err.c_str() + "\"}");
    return;
  }
  if (doc["brightness"].is<float>()) runtimeSetBrightness(doc["brightness"].as<float>());
  if (doc["speed"].is<float>()) runtimeSetSpeed(doc["speed"].as<float>());
  if (doc["hueShift"].is<int>()) runtimeSetHueShift(doc["hueShift"].as<int>());
  if (doc["blackout"].is<bool>()) runtimeSetBlackout(doc["blackout"].as<bool>());
  if (doc["next"].is<bool>() && doc["next"].as<bool>()) runtimeNextPattern();
  if (doc["previous"].is<bool>() && doc["previous"].as<bool>()) runtimePreviousPattern();
  if (doc["patternId"].is<const char*>()) {
    String id = String(doc["patternId"].as<const char*>());
    if (id.length()) runtimeSelectPatternById(id);
  }
  // Echo current state back
  JsonDocument out;
  out["ok"] = true;
  out["brightness"] = runtimeGetBrightness();
  out["speed"] = runtimeGetSpeed();
  out["hueShift"] = runtimeGetHueShift();
  out["blackout"] = runtimeIsBlackedOut();
  String body;
  serializeJson(out, body);
  server.send(200, "application/json", body);
}

void handleIdentify() {
  sendCors();
  runtimeTriggerIdentify();
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleFactoryReset() {
  sendCors();
  server.send(200, "application/json", "{\"ok\":true,\"message\":\"wiping and rebooting\"}");
  delay(200);
  runtimeFactoryReset();
}

void handleRenamePost() {
  sendCors();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing json body\"}");
    return;
  }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) {
    server.send(400, "application/json", String("{\"ok\":false,\"error\":\"") + err.c_str() + "\"}");
    return;
  }
  String pieceName = String(doc["pieceName"] | "");
  String hostname = sanitizeHostname(String(doc["hostname"] | ""));
  String message;
  if (!runtimeRename(pieceName, hostname, message)) {
    server.send(500, "application/json", String("{\"ok\":false,\"error\":\"") + message + "\"}");
    return;
  }
  server.send(200, "application/json", String("{\"ok\":true,\"message\":\"") + message + "\",\"requiresReboot\":true}");
}

void handleFirmwareInfo() {
  sendCors();
  server.send(200, "application/json", runtimeFirmwareInfo());
}

void handlePatterns() {
  sendCors();
  RuntimeConfig& cfg = *runtimeConfigPtr;
  JsonDocument doc;
  doc["currentIndex"] = *currentLookIndexPtr;
  doc["currentId"] = cfg.lookCount ? cfg.looks[*currentLookIndexPtr].id : "";
  JsonArray arr = doc["patterns"].to<JsonArray>();
  for (uint8_t i = 0; i < cfg.lookCount; i++) {
    JsonObject p = arr.add<JsonObject>();
    p["id"] = cfg.looks[i].id;
    p["label"] = cfg.looks[i].label;
    p["mode"] = cfg.looks[i].mode;
  }
  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
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
  server.on("/api/control", HTTP_OPTIONS, handleOptions);
  server.on("/api/control", HTTP_POST, handleControlPost);
  server.on("/api/identify", HTTP_OPTIONS, handleOptions);
  server.on("/api/identify", HTTP_POST, handleIdentify);
  server.on("/api/factory-reset", HTTP_OPTIONS, handleOptions);
  server.on("/api/factory-reset", HTTP_POST, handleFactoryReset);
  server.on("/api/rename", HTTP_OPTIONS, handleOptions);
  server.on("/api/rename", HTTP_POST, handleRenamePost);
  server.on("/api/firmware-info", HTTP_GET, handleFirmwareInfo);
  server.on("/api/patterns", HTTP_GET, handlePatterns);

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
