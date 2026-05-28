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

bool hasControlField(JsonDocument& doc, const char* key) {
  return !doc[key].isNull() || server.hasArg(key);
}

String controlString(JsonDocument& doc, const char* key) {
  if (!doc[key].isNull()) return String(doc[key].as<const char*>());
  return server.arg(key);
}

float controlFloat(JsonDocument& doc, const char* key) {
  if (!doc[key].isNull()) return doc[key].as<float>();
  return server.arg(key).toFloat();
}

int controlInt(JsonDocument& doc, const char* key) {
  if (!doc[key].isNull()) return doc[key].as<int>();
  return server.arg(key).toInt();
}

bool controlBool(JsonDocument& doc, const char* key) {
  if (!doc[key].isNull()) return doc[key].as<bool>();
  String value = server.arg(key);
  value.toLowerCase();
  return value == "1" || value == "true" || value == "yes" || value == "on";
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

void handleAdvancedRoot();

void handleRoot() {
  sendCors();
  RuntimeConfig& cfg = *runtimeConfigPtr;
  bool stationActive = cfg.activeTransport == WIFI_TRANSPORT_STATION;
  bool wifiConfigured = cfg.wifi.ssid.length() > 0;
  bool needsSetup = !stationActive && !wifiConfigured;

  // When the card hasn't been joined to home WiFi yet, the visitor surface
  // is meaningless — defer to the advanced/setup flow which has the WiFi form.
  if (needsSetup) {
    handleAdvancedRoot();
    return;
  }

  String page;
  page.reserve(6144);
  page += F("<!doctype html><html><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no'>"
            "<title>");
  page += escapeHtml(cfg.pieceName);
  page += F("</title>"
            "<style>"
            "*{box-sizing:border-box;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:manipulation}"
            "html,body{margin:0;background:#050505;color:#f4ede0;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased;overscroll-behavior:none;min-height:100%}"
            ".wrap{max-width:520px;margin:0 auto;padding:20px 18px 30px;display:flex;flex-direction:column;gap:16px}"
            ".head{display:flex;justify-content:space-between;align-items:baseline}"
            ".head .title{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#9a8d75}"
            ".head .piece{font-size:13px;letter-spacing:0.5px;color:#c89b5c}"
            ".grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}"
            ".tile{position:relative;background:#141414;border:1px solid #262626;border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:8px;cursor:pointer;overflow:hidden}"
            ".tile.active{border-color:#c89b5c}"
            ".tile .name{font-size:14px;font-weight:500;letter-spacing:0.2px;color:#f4ede0}"
            ".tile .mode{font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:#9a8d75}"
            ".sw{height:64px;border-radius:8px;overflow:hidden}"
            ".sw.sw-aurora{background:linear-gradient(90deg,#0a3a4a,#2a8a9a,#4ac0d0,#2a8a9a,#0a3a4a);background-size:200% 100%;animation:flow 6s linear infinite}"
            ".sw.sw-ember{background:radial-gradient(circle at 30% 50%,#d04a18,#8a2008 40%,#2a0800);animation:flicker 1.5s ease-in-out infinite}"
            ".sw.sw-rainbow{background:linear-gradient(90deg,#e74c3c,#f39c12,#f1c40f,#27ae60,#3498db,#9b59b6,#e74c3c);background-size:200% 100%;animation:flow 4s linear infinite}"
            ".sw.sw-breathe{background:radial-gradient(circle at 50% 50%,#c89b5c,#5a3a1a 60%,#1a1208);animation:breathe 3s ease-in-out infinite}"
            ".sw.sw-scanner{background:linear-gradient(90deg,#000 0%,#000 30%,#c89b5c 50%,#000 70%,#000 100%);background-size:200% 100%;animation:scan 2.5s linear infinite}"
            ".sw.sw-warm-white{background:linear-gradient(90deg,#3a2c1a,#c89b5c,#f4ede0,#c89b5c,#3a2c1a);background-size:200% 100%;animation:flow 8s linear infinite}"
            ".sw.sw-cool-white{background:linear-gradient(90deg,#1a2a3a,#5c8ac8,#e0edf4,#5c8ac8,#1a2a3a);background-size:200% 100%;animation:flow 8s linear infinite}"
            ".sw.sw-photo-white{background:linear-gradient(90deg,#3a3328,#c8b89c,#f4ede0,#c8b89c,#3a3328);background-size:200% 100%;animation:flow 10s linear infinite}"
            ".sw.sw-custom-color{background:linear-gradient(90deg,#e74c3c,#f39c12,#f1c40f,#27ae60,#3498db,#9b59b6,#e74c3c)}"
            ".color-panel{background:#141414;border:1px solid #c89b5c;border-radius:14px;padding:14px;display:none;flex-direction:column;gap:12px}"
            ".color-panel.open{display:flex}"
            ".color-row{display:flex;align-items:center;gap:12px}"
            ".color-row .lbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#9a8d75;flex-shrink:0;width:64px}"
            ".color-row .val{font-size:11px;color:#c89b5c;font-family:ui-monospace,SF Mono,monospace;flex-shrink:0;min-width:30px;text-align:right}"
            ".hue-slider{flex:1;-webkit-appearance:none;height:14px;border-radius:7px;background:linear-gradient(90deg,#e74c3c,#f39c12,#f1c40f,#27ae60,#3498db,#9b59b6,#e74c3c);outline:none}"
            ".hue-slider::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:50%;background:#f4ede0;border:2px solid #050505;cursor:pointer}"
            ".hue-slider::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:#f4ede0;border:2px solid #050505;cursor:pointer}"
            ".sat-slider{flex:1;-webkit-appearance:none;height:6px;border-radius:3px;background:#262626;outline:none}"
            ".sat-slider::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#c89b5c;cursor:pointer;border:0}"
            ".swatch-large{height:42px;border-radius:8px;border:1px solid #262626;transition:background-color 0.1s}"
            ".toggles{display:flex;gap:8px}"
            ".toggle{flex:1;background:#0a0a0a;border:1px solid #333;color:#9a8d75;padding:8px;border-radius:8px;font-size:11px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;font-family:inherit}"
            ".toggle.on{background:#c89b5c;color:#0a0a0a;border-color:#c89b5c}"
            "@keyframes flow{0%{background-position:0 0}100%{background-position:200% 0}}"
            "@keyframes scan{0%{background-position:100% 0}100%{background-position:-100% 0}}"
            "@keyframes flicker{0%,100%{opacity:0.9}25%{opacity:1}50%{opacity:0.7}75%{opacity:1}}"
            "@keyframes breathe{0%,100%{transform:scale(1);opacity:0.6}50%{transform:scale(1.05);opacity:1}}"
            ".bright{background:#141414;border:1px solid #262626;border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:14px}"
            ".bright .lbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#9a8d75;flex-shrink:0}"
            ".bright .val{font-size:12px;color:#c89b5c;font-family:ui-monospace,SF Mono,monospace;flex-shrink:0;min-width:36px;text-align:right}"
            "input[type=range]{flex:1;-webkit-appearance:none;height:4px;border-radius:2px;background:#262626;outline:none;margin:0}"
            "input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:#c89b5c;cursor:pointer;border:0}"
            "input[type=range]::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:#c89b5c;cursor:pointer;border:0}"
            ".foot{display:flex;justify-content:space-between;align-items:center;padding:4px 4px 0}"
            ".off-btn{background:transparent;border:1px solid #333;color:#f4ede0;padding:8px 18px;border-radius:20px;font-size:12px;letter-spacing:1px;text-transform:uppercase;font-family:inherit;cursor:pointer}"
            ".off-btn.on{background:#c89b5c;color:#0a0a0a;border-color:#c89b5c}"
            ".set-link{color:#5a5247;text-decoration:none;font-size:11px;letter-spacing:1.5px;text-transform:uppercase}"
            ".set-link:active{color:#c89b5c}"
            "</style></head><body><div class='wrap'>"
            "<div class='head'>"
              "<span class='title'>Lightweaver</span>"
              "<span class='piece'>");
  page += escapeHtml(cfg.pieceName);
  page += F("</span></div>"
            "<div class='grid' id='grid'></div>"
            "<div class='color-panel' id='color-panel'>"
              "<div class='swatch-large' id='color-swatch'></div>"
              "<div class='color-row'><span class='lbl'>Hue</span>"
                "<input type='range' class='hue-slider' min='0' max='255' value='32' id='hue-slider'>"
                "<span class='val' id='hue-val'>32</span></div>"
              "<div class='color-row'><span class='lbl'>Saturation</span>"
                "<input type='range' class='sat-slider' min='0' max='255' value='230' id='sat-slider'>"
                "<span class='val' id='sat-val'>230</span></div>"
              "<div class='toggles'>"
                "<button class='toggle' id='breathe-btn'>Breathe</button>"
                "<button class='toggle' id='drift-btn'>Drift</button>"
              "</div>"
            "</div>"
            "<div class='bright'>"
              "<span class='lbl'>Brightness</span>"
              "<input type='range' min='2' max='100' value='100' id='b-slider'>"
              "<span class='val' id='b-val'>100%</span>"
            "</div>"
            "<div class='foot'>"
              "<button class='off-btn' id='off-btn'>Off</button>"
              "<a class='set-link' href='/advanced'>Settings</a>"
            "</div>"
            "</div>"
            "<script>"
            "const $=id=>document.getElementById(id);"
            "const post=(p,b)=>fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());"
            "const get=p=>fetch(p).then(r=>r.json());"
            "let patterns=[],currentId='',blackoutOn=false;"
            "let customHue=32,customSat=230,customBreathe=false,customDrift=false;"
            "const swClass=id=>'sw-'+id.replace(/[^a-z0-9-]/g,'-');"
            // Generic coalescing sender per field
            "const makeSender=key=>{let pending=null,inflight=false;const flush=async()=>{if(inflight||pending===null)return;inflight=true;const v=pending;pending=null;try{await post('/api/control',{[key]:v})}catch(e){}finally{inflight=false;if(pending!==null)flush()}};return v=>{pending=v;flush()}};"
            "const sendBright=makeSender('brightness');"
            "const sendHue=makeSender('hue');"
            "const sendSat=makeSender('saturation');"
            "$('b-slider').oninput=e=>{const pct=parseInt(e.target.value,10);$('b-val').textContent=pct+'%';sendBright(pct/100)};"
            // Hue helpers — FastLED hue 0..255 to CSS HSL deg 0..360
            "const hueToHsl=(h,s)=>{return 'hsl('+(h/255*360)+','+(s/255*100)+'%,50%)'};"
            "const renderColorPanel=()=>{"
              "$('color-swatch').style.background=hueToHsl(customHue,customSat);"
              "$('hue-val').textContent=customHue;"
              "$('sat-val').textContent=customSat;"
              "$('hue-slider').value=customHue;"
              "$('sat-slider').value=customSat;"
              "$('breathe-btn').classList.toggle('on',customBreathe);"
              "$('drift-btn').classList.toggle('on',customDrift)"
            "};"
            "const showColorPanel=show=>{$('color-panel').classList.toggle('open',show)};"
            "$('hue-slider').oninput=e=>{customHue=parseInt(e.target.value,10);renderColorPanel();sendHue(customHue)};"
            "$('sat-slider').oninput=e=>{customSat=parseInt(e.target.value,10);renderColorPanel();sendSat(customSat)};"
            "$('breathe-btn').onclick=async()=>{customBreathe=!customBreathe;renderColorPanel();await post('/api/control',{breathe:customBreathe})};"
            "$('drift-btn').onclick=async()=>{customDrift=!customDrift;renderColorPanel();await post('/api/control',{drift:customDrift})};"
            // Pattern grid
            "const renderPat=()=>{const g=$('grid');g.innerHTML='';patterns.forEach(p=>{"
              "const el=document.createElement('div');el.className='tile'+(p.id===currentId?' active':'');"
              "let swatchHtml='<div class=\"sw '+swClass(p.id)+'\"';"
              "if(p.id==='custom-color')swatchHtml+=' style=\"background:'+hueToHsl(customHue,customSat)+'\"';"
              "swatchHtml+='></div>';"
              "el.innerHTML=swatchHtml+'<div class=\"name\">'+p.label+'</div><div class=\"mode\">'+p.mode+'</div>';"
              "el.onclick=async()=>{const wasActive=p.id===currentId;currentId=p.id;renderPat();showColorPanel(p.id==='custom-color');if(!wasActive)await post('/api/control',{patternId:p.id})};"
              "g.appendChild(el)"
            "})};"
            "$('off-btn').onclick=async()=>{blackoutOn=!blackoutOn;$('off-btn').classList.toggle('on',blackoutOn);await post('/api/control',{blackout:blackoutOn})};"
            "(async()=>{try{const s=await get('/api/status');const p=await get('/api/patterns');patterns=p.patterns||[];currentId=p.currentId||'';blackoutOn=!!s.blackout;"
              // Pull current custom-color state by posting an empty control (the echo includes it)
              "try{const e=await post('/api/control',{});if(typeof e.hue==='number'){customHue=e.hue;customSat=e.saturation;customBreathe=!!e.breathe;customDrift=!!e.drift}}catch(_){}"
              "renderColorPanel();showColorPanel(currentId==='custom-color');"
              "$('off-btn').classList.toggle('on',blackoutOn);renderPat()}catch(e){}})();"
            "</script></body></html>");

  server.send(200, "text/html", page);
}

void handleAdvancedRoot() {
  sendCors();
  RuntimeConfig& cfg = *runtimeConfigPtr;
  bool stationActive = cfg.activeTransport == WIFI_TRANSPORT_STATION;
  bool wifiConfigured = cfg.wifi.ssid.length() > 0;
  bool needsSetup = !stationActive && !wifiConfigured;

  String page;
  page.reserve(8192);
  page += F("<!doctype html><html><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no'>"
            "<title>Lightweaver Card</title>"
            "<style>"
            "*{box-sizing:border-box;touch-action:manipulation}"
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
              "</div>"
              "<style>"
              ".sw-aurora{background:linear-gradient(90deg,#0a3a4a,#2a8a9a,#4ac0d0,#2a8a9a,#0a3a4a)}"
              ".sw-ember{background:linear-gradient(90deg,#2a0800,#8a2008,#d04a18,#8a2008,#2a0800)}"
              ".sw-rainbow{background:linear-gradient(90deg,#e74c3c,#f39c12,#f1c40f,#27ae60,#3498db,#9b59b6,#e74c3c)}"
              ".sw-breathe{background:linear-gradient(90deg,#3a2a18,#8a6a3a,#c89b5c,#8a6a3a,#3a2a18)}"
              ".sw-scanner{background:linear-gradient(90deg,#000,#c89b5c 50%,#000)}"
              ".sw-warm-white{background:linear-gradient(90deg,#3a2c1a,#c89b5c,#f4ede0,#c89b5c,#3a2c1a)}"
              ".sw-cool-white{background:linear-gradient(90deg,#1a2a3a,#5c8ac8,#e0edf4,#5c8ac8,#1a2a3a)}"
              ".sw-photo-white{background:linear-gradient(90deg,#3a3328,#c8b89c,#f4ede0,#c8b89c,#3a3328)}"
              "</style>");

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
    page += F("let patterns=[],currentId='',blackoutOn=false;"
              "const swClass=id=>'sw-'+id.replace(/[^a-z0-9-]/g,'-');"
              "const renderGrid=()=>{const g=$('pat-grid');g.innerHTML='';patterns.forEach(p=>{const b=document.createElement('button');b.className='pat-btn'+(p.id===currentId?' active':'');b.innerHTML='<span class=\"name\">'+p.label+'</span><span class=\"swatch '+swClass(p.id)+'\"></span>';b.onclick=async()=>{currentId=p.id;renderGrid();$('now-name').textContent=p.label;$('now-mode').textContent=p.mode;await post('/api/control',{patternId:p.id})};g.appendChild(b)})};"
              "const loadOnce=async()=>{try{"
                "const s=await get('/api/status');"
                "const p=await get('/api/patterns');"
                "patterns=p.patterns||[];currentId=p.currentId||'';"
                "blackoutOn=!!s.blackout;"
                "$('now-name').textContent=patterns.find(x=>x.id===currentId)?.label||'—';"
                "$('now-mode').textContent=patterns.find(x=>x.id===currentId)?.mode||'—';"
                "renderGrid();"
                "$('blackout').classList.toggle('primary',blackoutOn);"
                "$('b-val').textContent=Math.round(($('brightness').value)/100*100)+'%';"
                "$('s-val').textContent=(($('speed').value)/100).toFixed(2)+'×';"
                "$('h-val').textContent=$('hue').value;"
              "}catch(e){}};"
              // Coalescing in-flight sender — at most 1 request per slider in flight
              "const makeSender=(key,fmt)=>{let pending=null,inflight=false;const flush=async()=>{if(inflight||pending===null)return;inflight=true;const v=pending;pending=null;try{const r=await post('/api/control',{[key]:v});if(typeof r[key]!=='undefined')fmt(r[key])}catch(e){}finally{inflight=false;if(pending!==null)flush()}};return v=>{pending=v;flush()}};"
              "const sendB=makeSender('brightness',v=>$('b-val').textContent=Math.round(v*100)+'%');"
              "const sendS=makeSender('speed',v=>$('s-val').textContent=v.toFixed(2)+'×');"
              "const sendH=makeSender('hueShift',v=>$('h-val').textContent=v);"
              "$('brightness').oninput=e=>{$('b-val').textContent=e.target.value+'%';sendB(parseInt(e.target.value,10)/100)};"
              "$('speed').oninput=e=>{$('s-val').textContent=(e.target.value/100).toFixed(2)+'×';sendS(parseInt(e.target.value,10)/100)};"
              "$('hue').oninput=e=>{$('h-val').textContent=e.target.value;sendH(parseInt(e.target.value,10))};"
              "$('prev').onclick=async()=>{await post('/api/control',{previous:true});loadOnce()};"
              "$('next').onclick=async()=>{await post('/api/control',{next:true});loadOnce()};"
              "$('blackout').onclick=async()=>{blackoutOn=!blackoutOn;$('blackout').classList.toggle('primary',blackoutOn);await post('/api/control',{blackout:blackoutOn})};"
              "$('identify').onclick=()=>{post('/api/identify',{});const m=$('set-msg');m.textContent='Identifying…';m.className='note ok';setTimeout(()=>m.textContent='',2000)};"
              "$('reboot').onclick=async()=>{if(!confirm('Reboot the card?'))return;const m=$('set-msg');m.textContent='Rebooting…';m.className='note';await post('/api/reboot',{})};"
              "$('change-wifi').onclick=()=>{if(!confirm('Wipe WiFi credentials and restart in setup mode?'))return;post('/api/factory-reset',{})};"
              "$('factory').onclick=()=>{if(!confirm('Erase ALL settings (patterns, WiFi, names) and restart? This cannot be undone.'))return;post('/api/factory-reset',{})};"
              "$('rn-save').onclick=async()=>{const m=$('set-msg');m.textContent='Saving…';m.className='note';"
                "const r=await post('/api/rename',{pieceName:$('rn-piece').value,hostname:$('rn-host').value});"
                "if(r.ok){m.textContent='Saved. Reboot to use new hostname.';m.className='note ok'}else{m.textContent=r.error||'Failed';m.className='note err'}};"
              "get('/api/firmware-info').then(d=>{const f=$('fw-info');f.textContent='build '+d.build+' • '+(d.freeHeap/1024|0)+'KB free • '+d.rssi+' dBm'}).catch(()=>{});"
              "loadOnce();");
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
  JsonDocument doc;
  if (server.hasArg("plain") && server.arg("plain").length()) {
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      server.send(400, "application/json", String("{\"ok\":false,\"error\":\"") + err.c_str() + "\"}");
      return;
    }
  }
  if (hasControlField(doc, "brightness")) runtimeSetBrightness(controlFloat(doc, "brightness"));
  if (hasControlField(doc, "speed")) runtimeSetSpeed(controlFloat(doc, "speed"));
  if (hasControlField(doc, "hueShift")) runtimeSetHueShift(controlInt(doc, "hueShift"));
  if (hasControlField(doc, "blackout")) runtimeSetBlackout(controlBool(doc, "blackout"));
  if (hasControlField(doc, "next") && controlBool(doc, "next")) runtimeNextPattern();
  if (hasControlField(doc, "previous") && controlBool(doc, "previous")) runtimePreviousPattern();
  if (hasControlField(doc, "patternId")) {
    String id = controlString(doc, "patternId");
    if (id.length()) runtimeSelectPatternById(id);
  }
  if (hasControlField(doc, "hue")) runtimeSetCustomHue(uint8_t(controlInt(doc, "hue") & 0xff));
  if (hasControlField(doc, "saturation")) runtimeSetCustomSaturation(uint8_t(controlInt(doc, "saturation") & 0xff));
  if (hasControlField(doc, "breathe")) runtimeSetCustomBreathe(controlBool(doc, "breathe"));
  if (hasControlField(doc, "drift")) runtimeSetCustomDrift(controlBool(doc, "drift"));
  // Echo current state back
  JsonDocument out;
  out["ok"] = true;
  out["brightness"] = runtimeGetBrightness();
  out["speed"] = runtimeGetSpeed();
  out["hueShift"] = runtimeGetHueShift();
  out["blackout"] = runtimeIsBlackedOut();
  out["hue"] = runtimeGetCustomHue();
  out["saturation"] = runtimeGetCustomSaturation();
  out["breathe"] = runtimeGetCustomBreathe();
  out["drift"] = runtimeGetCustomDrift();
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
  server.on("/advanced", HTTP_GET, handleAdvancedRoot);
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
