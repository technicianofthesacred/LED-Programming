#include "LightweaverWeb.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverWledJsonApi.h"
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
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
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
            "<meta http-equiv='Cache-Control' content='no-store, no-cache, must-revalidate'>"
            "<meta http-equiv='Pragma' content='no-cache'>"
            "<meta http-equiv='Expires' content='0'>"
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
            ".grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}"
            ".tile{position:relative;background:#141414;border:1px solid #262626;border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:6px;cursor:pointer;overflow:hidden}"
            ".tile.active{border-color:#c89b5c}"
            ".tile .name{font-size:12px;font-weight:500;letter-spacing:0.2px;color:#f4ede0;text-align:center}"
            ".sw{height:54px;border-radius:6px;overflow:hidden;background-color:#262626;-webkit-transform:translateZ(0);transform:translateZ(0);will-change:background-position}"
            ".sw-aurora{background-color:#2a8a9a;background-image:linear-gradient(90deg,#0a3a4a,#2a8a9a,#4ac0d0,#2a8a9a,#0a3a4a);background-size:200% 100%;animation:flow 6s linear infinite}"
            ".sw-ember{background-color:#8a2008;background-image:radial-gradient(circle at 30% 50%,#d04a18,#8a2008 40%,#2a0800);animation:flicker 1.5s ease-in-out infinite}"
            ".sw-rainbow{background-color:#f39c12;background-image:linear-gradient(90deg,#e74c3c,#f39c12,#f1c40f,#27ae60,#3498db,#9b59b6,#e74c3c);background-size:200% 100%;animation:flow 4s linear infinite}"
            ".sw-breathe{background-color:#5a3a1a;background-image:radial-gradient(circle at 50% 50%,#c89b5c,#5a3a1a 60%,#1a1208);animation:breathe 3s ease-in-out infinite}"
            ".sw-scanner{background-color:#000;background-image:linear-gradient(90deg,#000 0%,#000 30%,#c89b5c 50%,#000 70%,#000 100%);background-size:200% 100%;animation:scan 2.5s linear infinite}"
            ".sw-sunset{background-color:#8a2050;background-image:linear-gradient(90deg,#2a0830,#8a2050,#d04a18,#f1c40f,#d04a18,#8a2050,#2a0830);background-size:200% 100%;animation:flow 9s linear infinite}"
            ".sw-twinkle{background-color:#3a2c1a;background-image:radial-gradient(circle at 20% 40%,#f4ede0 0%,transparent 8%),radial-gradient(circle at 70% 60%,#f4ede0 0%,transparent 6%),radial-gradient(circle at 45% 80%,#f4ede0 0%,transparent 5%),linear-gradient(180deg,#3a2c1a,#1a1208);animation:flicker 2s ease-in-out infinite}"
            ".sw-wave{background-color:#3a3a8a;background-image:linear-gradient(90deg,#1a1a4a,#5c5cc8,#9b9be0,#5c5cc8,#1a1a4a);background-size:200% 100%;animation:flow 5s linear infinite}"
            ".sw-warm-white{background-color:#c89b5c;background-image:linear-gradient(90deg,#3a2c1a,#c89b5c,#f4ede0,#c89b5c,#3a2c1a);background-size:200% 100%;animation:flow 8s linear infinite}"
            ".sw-cool-white{background-color:#5c8ac8;background-image:linear-gradient(90deg,#1a2a3a,#5c8ac8,#e0edf4,#5c8ac8,#1a2a3a);background-size:200% 100%;animation:flow 8s linear infinite}"
            ".sw-photo-white{background-color:#c8b89c;background-image:linear-gradient(90deg,#3a3328,#c8b89c,#f4ede0,#c8b89c,#3a3328);background-size:200% 100%;animation:flow 10s linear infinite}"
            ".sw-custom-color{background-color:#c89b5c;background-image:linear-gradient(90deg,#e74c3c,#f39c12,#f1c40f,#27ae60,#3498db,#9b59b6,#e74c3c)}"
            ".color-panel{background:#141414;border:1px solid #c89b5c;border-radius:14px;padding:14px;display:none;flex-direction:column;gap:12px}"
            ".color-panel.open{display:flex}"
            ".color-row{display:flex;align-items:center;gap:12px}"
            ".color-row .lbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#9a8d75;flex-shrink:0;width:64px}"
            ".color-row .val{font-size:11px;color:#c89b5c;font-family:ui-monospace,SF Mono,monospace;flex-shrink:0;min-width:30px;text-align:right}"
            ".hue-slider{flex:1;-webkit-appearance:none;height:22px;border-radius:11px;background:linear-gradient(90deg,#e74c3c,#f39c12,#f1c40f,#27ae60,#3498db,#9b59b6,#e74c3c);outline:none;padding:0}"
            ".hue-slider::-webkit-slider-thumb{-webkit-appearance:none;width:32px;height:32px;border-radius:50%;background:#f4ede0;border:3px solid #050505;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.5)}"
            ".hue-slider::-moz-range-thumb{width:32px;height:32px;border-radius:50%;background:#f4ede0;border:3px solid #050505;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.5)}"
            ".sat-slider{flex:1;-webkit-appearance:none;height:14px;border-radius:7px;background:#262626;outline:none}"
            ".sat-slider::-webkit-slider-thumb{-webkit-appearance:none;width:28px;height:28px;border-radius:50%;background:#c89b5c;cursor:pointer;border:0;box-shadow:0 2px 6px rgba(0,0,0,0.5)}"
            ".sat-slider::-moz-range-thumb{width:28px;height:28px;border-radius:50%;background:#c89b5c;cursor:pointer;border:0;box-shadow:0 2px 6px rgba(0,0,0,0.5)}"
            ".swatch-large{height:42px;border-radius:8px;border:1px solid #262626;transition:background-color 0.1s}"
            ".toggles{display:flex;gap:10px}"
            ".toggle{flex:1;background:#0a0a0a;border:1px solid #333;color:#9a8d75;padding:12px 10px;border-radius:10px;cursor:pointer;font-family:inherit;display:flex;flex-direction:column;align-items:center;gap:3px;text-align:center}"
            ".toggle .t-name{font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:#f4ede0;font-weight:500}"
            ".toggle .t-sub{font-size:10px;color:#6a6055;letter-spacing:0.3px;text-transform:none;line-height:1.3}"
            ".toggle.on{background:#c89b5c;border-color:#c89b5c}"
            ".toggle.on .t-name{color:#050505}"
            ".toggle.on .t-sub{color:#3a2c1a}"
            ".pill-row{display:flex;gap:8px}"
            ".pill{flex:1;border:0;color:#050505;padding:10px 8px;border-radius:24px;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;cursor:pointer;font-family:inherit;font-weight:600;opacity:0.7;transition:opacity 0.15s}"
            ".pill.on{opacity:1;box-shadow:0 0 0 2px #c89b5c}"
            "@keyframes flow{0%{background-position:0 0}100%{background-position:200% 0}}"
            "@keyframes scan{0%{background-position:100% 0}100%{background-position:-100% 0}}"
            "@keyframes flicker{0%,100%{opacity:0.9}25%{opacity:1}50%{opacity:0.7}75%{opacity:1}}"
            "@keyframes breathe{0%,100%{transform:scale(1);opacity:0.6}50%{transform:scale(1.05);opacity:1}}"
            ".bright{background:#141414;border:1px solid #262626;border-radius:14px;padding:18px 18px;display:flex;align-items:center;gap:14px}"
            ".bright .lbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#9a8d75;flex-shrink:0}"
            ".bright .val{font-size:12px;color:#c89b5c;font-family:ui-monospace,SF Mono,monospace;flex-shrink:0;min-width:36px;text-align:right}"
            "input[type=range]{flex:1;-webkit-appearance:none;height:14px;border-radius:7px;background:#262626;outline:none;margin:0}"
            "input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:28px;height:28px;border-radius:50%;background:#c89b5c;cursor:pointer;border:0;box-shadow:0 2px 6px rgba(0,0,0,0.5)}"
            "input[type=range]::-moz-range-thumb{width:28px;height:28px;border-radius:50%;background:#c89b5c;cursor:pointer;border:0;box-shadow:0 2px 6px rgba(0,0,0,0.5)}"
            ".foot{display:flex;justify-content:space-between;align-items:center;padding:4px 4px 0}"
            ".off-btn{background:transparent;border:1px solid #333;color:#f4ede0;padding:8px 18px;border-radius:20px;font-size:12px;letter-spacing:1px;text-transform:uppercase;font-family:inherit;cursor:pointer}"
            ".off-btn.on{background:#c89b5c;color:#0a0a0a;border-color:#c89b5c}"
            ".set-link{background:transparent;border:0;color:#5a5247;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;font-family:inherit;padding:8px 0}"
            ".set-link:active{color:#c89b5c}"
            ".drawer{background:#141414;border:1px solid #262626;border-radius:14px;padding:0;margin-top:12px;display:none;flex-direction:column;overflow:hidden}"
            ".drawer.open{display:flex}"
            ".drawer .field{display:block;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#9a8d75;margin:14px 0 6px;padding:0 18px}"
            ".drawer input[type=text]{margin:0 18px;width:calc(100% - 36px);background:#0a0a0a;color:#f4ede0;border:1px solid #333;border-radius:8px;padding:12px;font-size:16px;font-family:inherit}"
            ".drawer input[type=text]:focus{outline:none;border-color:#c89b5c}"
            ".drawer-row{padding:0 18px;margin-top:14px;display:flex;gap:10px;flex-wrap:wrap}"
            ".drawer-row .ghost{flex:1;background:transparent;border:1px solid #333;color:#f4ede0;padding:12px;border-radius:10px;font-size:12px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;font-family:inherit;text-align:center}"
            ".drawer-row .primary{flex:1;background:#c89b5c;border:0;color:#050505;padding:12px;border-radius:10px;font-size:12px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;font-family:inherit;font-weight:500}"
            ".drawer-row .danger{flex:1;background:#3a1f1f;border:1px solid #5a2a2a;color:#e07856;padding:12px;border-radius:10px;font-size:12px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;font-family:inherit}"
            ".drawer-note{padding:12px 18px 18px;font-size:11px;color:#5a5247;font-family:ui-monospace,SF Mono,monospace;border-top:1px solid #1f1f1f;margin-top:6px}"
            ".drawer-msg{padding:0 18px;margin:12px 0 0;font-size:12px;color:#9a8d75}"
            ".drawer-msg.ok{color:#7fb069}"
            ".drawer-msg.err{color:#e07856}"
            // External-stream banner. Same dark background + bronze accent as
            // .color-panel, but a single horizontal row that sits above the
            // pattern grid only while Art-Net / WLED-realtime is driving us.
            ".stream-banner{display:none;background:#141414;border:1px solid #c89b5c;border-radius:14px;padding:12px 14px;align-items:center;gap:12px;transition:opacity 0.35s}"
            ".stream-banner.on{display:flex}"
            ".stream-banner.fading{opacity:0}"
            ".stream-banner .dot{width:8px;height:8px;border-radius:50%;background:#c89b5c;flex-shrink:0;animation:breathe 1.6s ease-in-out infinite}"
            ".stream-banner .msg{flex:1;font-size:12px;letter-spacing:0.4px;color:#f4ede0}"
            ".stream-banner .msg b{color:#c89b5c;font-weight:600}"
            ".stream-banner .cancel{background:transparent;border:1px solid #c89b5c;color:#c89b5c;padding:8px 14px;border-radius:18px;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-family:inherit;cursor:pointer;flex-shrink:0}"
            ".stream-banner .cancel:active{background:#c89b5c;color:#050505}"
            // While streaming, pattern tiles look disabled — they're not
            // controlling anything until the external source stops.
            ".grid.streaming .tile{pointer-events:none;opacity:0.35;filter:grayscale(0.8)}"
            "</style></head><body><div class='wrap'>"
            "<div class='head'>"
              "<span class='title'>Lightweaver</span>");
  if (cfg.pieceName.length() > 0 && cfg.pieceName != "Lightweaver") {
    page += F("<span class='piece'>");
    page += escapeHtml(cfg.pieceName);
    page += F("</span>");
  }
  page += F("</div>"
            "<div class='stream-banner' id='stream-banner'>"
              "<span class='dot'></span>"
              "<span class='msg'>Streaming from <b id='stream-src'>external source</b></span>"
              "<button class='cancel' id='stream-cancel' type='button'>Cancel stream</button>"
            "</div>"
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
                "<button class='toggle' id='breathe-btn'>"
                  "<span class='t-name'>Breathe</span>"
                  "<span class='t-sub'>slow fade in &amp; out</span>"
                "</button>"
                "<button class='toggle' id='drift-btn'>"
                  "<span class='t-name'>Drift</span>"
                  "<span class='t-sub'>slowly cycle hues</span>"
                "</button>"
              "</div>"
              "<div class='pill-row' id='drift-palette-row'>"
                "<button class='pill' data-lo='0' data-hi='60' id='pal-warm' style='background:linear-gradient(90deg,#8a2008,#d04a18,#f1c40f)'>Warm</button>"
                "<button class='pill' data-lo='130' data-hi='200' id='pal-cool' style='background:linear-gradient(90deg,#0a3a4a,#2a8a9a,#5c5cc8)'>Cool</button>"
                "<button class='pill' data-lo='0' data-hi='255' id='pal-rainbow' style='background:linear-gradient(90deg,#e74c3c,#f39c12,#27ae60,#3498db,#9b59b6)'>Rainbow</button>"
              "</div>"
            "</div>"
            "<div class='bright'>"
              "<span class='lbl'>Brightness</span>"
              "<input type='range' min='2' max='100' value='100' id='b-slider'>"
              "<span class='val' id='b-val'>100%</span>"
            "</div>"
            "<div class='bright'>"
              "<span class='lbl'>Speed</span>"
              "<input type='range' min='0' max='100' value='50' id='s-slider'>"
              "<span class='val' id='s-val'>1.00\xC3\x97</span>"
            "</div>"
            "<div class='bright'>"
              "<span class='lbl'>Hue shift</span>"
              "<input type='range' min='-128' max='128' value='0' id='h-slider'>"
              "<span class='val' id='h-val'>0</span>"
            "</div>"
            "<div class='foot'>"
              "<button class='off-btn' id='off-btn'>Off</button>"
              "<button class='set-link' id='set-toggle' type='button'>Settings</button>"
            "</div>"
            "<div class='drawer' id='drawer'>"
              "<label class='field'>Piece name</label>"
              "<input type='text' id='rn-piece' value='");
  page += escapeHtml(cfg.pieceName);
  page += F("'>"
              "<label class='field'>Hostname</label>"
              "<input type='text' id='rn-host' value='");
  page += escapeHtml(cfg.activeHostname.length() ? cfg.activeHostname : cfg.wifi.hostname);
  page += F("'>"
              "<div class='drawer-row'>"
                "<button class='primary' id='rn-save' type='button'>Save names</button>"
              "</div>"
              "<div class='drawer-row'>"
                "<button class='ghost' id='identify' type='button'>Identify (3 flashes)</button>"
              "</div>"
              "<div class='drawer-row'>"
                "<button class='ghost' id='reboot' type='button'>Reboot</button>"
                "<button class='ghost' id='change-wifi' type='button'>Change WiFi</button>"
              "</div>"
              "<div class='drawer-row'>"
                "<button class='danger' id='factory' type='button'>Factory reset</button>"
              "</div>"
              "<label class='field'>Paste designer config</label>"
              "<textarea id='cfg-paste' placeholder='Paste the JSON shown in the designer when direct save was blocked' style='margin:0 18px;width:calc(100% - 36px);background:#0a0a0a;color:#f4ede0;border:1px solid #333;border-radius:8px;padding:12px;font-size:12px;font-family:ui-monospace,SF Mono,monospace;min-height:120px;box-sizing:border-box;resize:vertical'></textarea>"
              "<div class='drawer-row'>"
                "<button class='primary' id='cfg-apply' type='button'>Apply config</button>"
              "</div>"
              "<p class='drawer-msg' id='set-msg'></p>"
              "<div class='drawer-note' id='fw-info'>\xE2\x80\x94</div>"
            "</div>"
            "</div>"
            "<script>"
            "const $=id=>document.getElementById(id);"
            "const post=(p,b)=>fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());"
            "const get=p=>fetch(p).then(r=>r.json());"
            "let patterns=[],currentId='',blackoutOn=false;"
            "let customHue=32,customSat=230,customBreathe=false,customDrift=false,driftMin=0,driftMax=255;"
            "const swClass=id=>'sw-'+id.replace(/[^a-z0-9-]/g,'-');"
            // Generic coalescing sender per field
            "const makeSender=key=>{let pending=null,inflight=false;const flush=async()=>{if(inflight||pending===null)return;inflight=true;const v=pending;pending=null;try{await post('/api/control',{[key]:v})}catch(e){}finally{inflight=false;if(pending!==null)flush()}};return v=>{pending=v;flush()}};"
            "const sendBright=makeSender('brightness');"
            "const sendHue=makeSender('hue');"
            "const sendSat=makeSender('saturation');"
            "const sendSpeed=makeSender('speed');"
            "const sendHueShift=makeSender('hueShift');"
            "$('b-slider').oninput=e=>{const pct=parseInt(e.target.value,10);$('b-val').textContent=pct+'%';sendBright(pct/100)};"
            // Speed slider is non-linear: 0..100 -> 0.05x..3x with ^1.63 curve.
            // Slider midpoint (50) maps to 1.0x; the bottom half spans 0.05x to 1x
            // (extra-slow meditation range with plenty of fine control), the top
            // half spans 1x to 3x. Floor is 0.05x because below that the Breathe
            // pattern's beat-rate math rounds to zero BPM and visibly freezes.
            "const speedFromSlider=v=>{const t=Math.pow(v/100,1.63);return 0.05+t*2.95};"
            "const sliderFromSpeed=s=>{const t=Math.max(0,Math.min(1,(s-0.05)/2.95));return Math.round(Math.pow(t,1/1.63)*100)};"
            "$('s-slider').oninput=e=>{const sp=speedFromSlider(parseInt(e.target.value,10));$('s-val').textContent=sp.toFixed(2)+'\xC3\x97';sendSpeed(sp)};"
            "$('h-slider').oninput=e=>{const v=parseInt(e.target.value,10);$('h-val').textContent=v;sendHueShift(v)};"
            // Hue helpers — FastLED hue 0..255 to CSS HSL deg 0..360
            "const hueToHsl=(h,s)=>{return 'hsl('+(h/255*360)+','+(s/255*100)+'%,50%)'};"
            "const renderColorPanel=()=>{"
              "$('color-swatch').style.background=hueToHsl(customHue,customSat);"
              "$('hue-val').textContent=customHue;"
              "$('sat-val').textContent=customSat;"
              "$('hue-slider').value=customHue;"
              "$('sat-slider').value=customSat;"
              "$('breathe-btn').classList.toggle('on',customBreathe);"
              "$('drift-btn').classList.toggle('on',customDrift);"
              "$('pal-warm').classList.toggle('on',driftMin===0&&driftMax===60);"
              "$('pal-cool').classList.toggle('on',driftMin===130&&driftMax===200);"
              "$('pal-rainbow').classList.toggle('on',driftMin===0&&driftMax===255)"
            "};"
            "const showColorPanel=show=>{$('color-panel').classList.toggle('open',show)};"
            "$('hue-slider').oninput=e=>{customHue=parseInt(e.target.value,10);renderColorPanel();sendHue(customHue)};"
            "$('sat-slider').oninput=e=>{customSat=parseInt(e.target.value,10);renderColorPanel();sendSat(customSat)};"
            "$('breathe-btn').onclick=async()=>{customBreathe=!customBreathe;renderColorPanel();await post('/api/control',{breathe:customBreathe})};"
            "$('drift-btn').onclick=async()=>{customDrift=!customDrift;renderColorPanel();await post('/api/control',{drift:customDrift})};"
            "const setPalette=async(lo,hi)=>{driftMin=lo;driftMax=hi;if(!customDrift){customDrift=true}renderColorPanel();await post('/api/control',{drift:customDrift,driftMin:lo,driftMax:hi})};"
            "$('pal-warm').onclick=()=>setPalette(0,60);"
            "$('pal-cool').onclick=()=>setPalette(130,200);"
            "$('pal-rainbow').onclick=()=>setPalette(0,255);"
            // Pattern grid
            "const renderPat=()=>{const g=$('grid');g.innerHTML='';patterns.forEach(p=>{"
              "const el=document.createElement('div');el.className='tile'+(p.id===currentId?' active':'');"
              "let swatchHtml='<div class=\"sw '+swClass(p.id)+'\"';"
              "if(p.id==='custom-color')swatchHtml+=' style=\"background:'+hueToHsl(customHue,customSat)+'\"';"
              "swatchHtml+='></div>';"
              "el.innerHTML=swatchHtml+'<div class=\"name\">'+p.label+'</div>';"
              "el.onclick=async()=>{const wasActive=p.id===currentId;currentId=p.id;renderPat();showColorPanel(p.id==='custom-color');if(!wasActive)await post('/api/control',{patternId:p.id})};"
              "g.appendChild(el)"
            "})};"
            "$('off-btn').onclick=async()=>{blackoutOn=!blackoutOn;$('off-btn').classList.toggle('on',blackoutOn);await post('/api/control',{blackout:blackoutOn})};"
            // Settings drawer (inline, no separate page)
            "$('set-toggle').onclick=()=>{const open=$('drawer').classList.toggle('open');if(open){"
              "fetch('/api/firmware-info').then(r=>r.json()).then(d=>{$('fw-info').textContent='build '+d.build+' \xE2\x80\xA2 '+(d.freeHeap/1024|0)+'KB free \xE2\x80\xA2 '+d.rssi+' dBm'}).catch(()=>{});"
            "}};"
            "const setMsg=(text,kind)=>{const m=$('set-msg');m.textContent=text;m.className='drawer-msg'+(kind?' '+kind:'')};"
            "$('rn-save').onclick=async()=>{setMsg('Saving\xE2\x80\xA6');try{const r=await post('/api/rename',{pieceName:$('rn-piece').value,hostname:$('rn-host').value});if(r.ok){setMsg('Saved. Reboot to use new hostname.','ok')}else{setMsg(r.error||'Failed','err')}}catch(e){setMsg(e.message,'err')}};"
            "$('identify').onclick=async()=>{setMsg('Identifying\xE2\x80\xA6','ok');try{await post('/api/identify',{});setTimeout(()=>setMsg(''),2200)}catch(_){setMsg('Could not reach card','err')}};"
            "$('reboot').onclick=async()=>{if(!confirm('Reboot the card?'))return;setMsg('Rebooting\xE2\x80\xA6');try{await post('/api/reboot',{})}catch(_){}};"
            "$('change-wifi').onclick=()=>{if(!confirm('Wipe WiFi credentials and restart in setup mode?'))return;post('/api/factory-reset',{})};"
            "$('factory').onclick=()=>{if(!confirm('Erase ALL settings (patterns, WiFi, names) and restart? This cannot be undone.'))return;post('/api/factory-reset',{})};"
            // Apply pasted designer config (the mixed-content fallback path)
            "$('cfg-apply').onclick=async()=>{const raw=$('cfg-paste').value.trim();if(!raw){setMsg('Paste a config JSON first','err');return}let json;try{json=JSON.parse(raw)}catch(e){setMsg('Not valid JSON: '+e.message,'err');return}"
              "const cfg=json.config?json.config:json;setMsg('Applying\xE2\x80\xA6');"
              "try{const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});const j=await r.json();"
                "if(r.ok&&j.ok){setMsg('Saved on card. Rebooting to apply.','ok');setTimeout(()=>{location.reload()},2000);await post('/api/reboot',{})}"
                "else{setMsg(j.error||('HTTP '+r.status),'err')}}"
              "catch(e){setMsg('Failed: '+e.message,'err')}};"
            "(async()=>{try{const s=await get('/api/status');const p=await get('/api/patterns');patterns=p.patterns||[];currentId=p.currentId||'';blackoutOn=!!s.blackout;"
              // Pull current custom-color state by posting an empty control (the echo includes it)
              "try{const e=await post('/api/control',{});if(typeof e.hue==='number'){customHue=e.hue;customSat=e.saturation;customBreathe=!!e.breathe;customDrift=!!e.drift}"
                "if(typeof e.driftMin==='number')driftMin=e.driftMin;"
                "if(typeof e.driftMax==='number')driftMax=e.driftMax;"
                "if(typeof e.brightness==='number'){const pct=Math.round(e.brightness*100);$('b-slider').value=pct;$('b-val').textContent=pct+'%'}"
                "if(typeof e.speed==='number'){$('s-slider').value=sliderFromSpeed(e.speed);$('s-val').textContent=e.speed.toFixed(2)+'\xC3\x97'}"
                "if(typeof e.hueShift==='number'){$('h-slider').value=e.hueShift;$('h-val').textContent=e.hueShift}"
              "}catch(_){}"
              "renderColorPanel();showColorPanel(currentId==='custom-color');"
              "$('off-btn').classList.toggle('on',blackoutOn);renderPat()}catch(e){}})();"
            // Streaming-state poll. Cheap 1Hz GET on /api/status — well under
            // anything that would compete with the 30fps Art-Net frames the
            // card is also processing. When streaming flips on, dim the pattern
            // grid and show the source banner; when it flips off, fade banner.
            "let _streamWasOn=false;let _streamFadeT=null;"
            "const srcLabel=k=>k==='artnet'?'Madrix / Art-Net':k==='wled-realtime'?'designer live preview':'external source';"
            "const applyStream=s=>{const on=!!(s&&s.streaming);const bn=$('stream-banner');const gr=$('grid');"
              "if(on){"
                "$('stream-src').textContent=srcLabel(s.frameSource);"
                "if(_streamFadeT){clearTimeout(_streamFadeT);_streamFadeT=null}"
                "bn.classList.remove('fading');bn.classList.add('on');"
                "gr.classList.add('streaming');_streamWasOn=true"
              "}else if(_streamWasOn){"
                "bn.classList.add('fading');gr.classList.remove('streaming');"
                "if(_streamFadeT)clearTimeout(_streamFadeT);"
                "_streamFadeT=setTimeout(()=>{bn.classList.remove('on');bn.classList.remove('fading');_streamFadeT=null},400);"
                "_streamWasOn=false"
              "}};"
            "$('stream-cancel').onclick=async()=>{try{await post('/api/control',{cancelStream:true});applyStream({streaming:false})}catch(_){}};"
            "const pollStream=async()=>{try{const s=await get('/api/status');applyStream(s)}catch(_){}};"
            "pollStream();setInterval(pollStream,1000);"
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
            ".grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}"
            ".pat-btn{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px;text-align:center}"
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
              ".sw-plasma{background:linear-gradient(135deg,#7400b8,#5390d9,#06d6a0,#9bf6ff,#7400b8)}"
              ".sw-fire{background:linear-gradient(0deg,#330000,#cc2200,#ff6600,#ffcc00,#fff)}"
              ".sw-ocean{background:linear-gradient(180deg,#fff,#7aecff,#0077b6,#03045e)}"
              ".sw-ripple{background:radial-gradient(circle,#fff 0%,#00ccff 20%,#0033aa 50%,#000022 80%)}"
              ".sw-lava{background:radial-gradient(ellipse at 30% 70%,#ff4400 0%,#cc0000 30%,#220000 100%)}"
              ".sw-ember{background:linear-gradient(90deg,#2a0800,#8a2008,#d04a18,#8a2008,#2a0800)}"
              ".sw-rainbow{background:linear-gradient(90deg,#e74c3c,#f39c12,#f1c40f,#27ae60,#3498db,#9b59b6,#e74c3c)}"
              ".sw-sparkle{background:radial-gradient(circle at 20% 50%,#fff 0%,transparent 8%),radial-gradient(circle at 70% 30%,#fff 0%,transparent 7%),#080820}"
              ".sw-breathe{background:linear-gradient(90deg,#3a2a18,#8a6a3a,#c89b5c,#8a6a3a,#3a2a18)}"
              ".sw-meteor{background:linear-gradient(90deg,#000010,#000030 40%,#8888ff 80%,#fff)}"
              ".sw-chase{background:linear-gradient(90deg,#050510 0%,#4cc9f0 50%,#fff 51%,#050510 100%)}"
              ".sw-scanner{background:linear-gradient(90deg,#000,#c89b5c 50%,#000)}"
              ".sw-candle{background:radial-gradient(ellipse at 50% 80%,#fff 0%,#ffee88 10%,#ff7700 40%,#220000 100%)}"
              ".sw-lightning{background:linear-gradient(90deg,#050515,#7070ff,#fff,#7070ff,#050515)}"
              ".sw-neon{background:linear-gradient(90deg,#ff00aa 0 33%,#00ffcc 33% 66%,#ffff00 66%)}"
              ".sw-matrix{background:linear-gradient(180deg,#fff,#00ff41 15%,#003b00 60%,#000)}"
              ".sw-heartbeat{background:radial-gradient(ellipse,#ff0022 0%,#880011 50%,#110003 100%)}"
              ".sw-stained{background:conic-gradient(#ff2200,#ffaa00,#00dd44,#0066ff,#cc00ff,#ff2200)}"
              ".sw-confetti{background:radial-gradient(circle at 20% 30%,#ff0066 0%,transparent 8%),radial-gradient(circle at 70% 60%,#00ff88 0%,transparent 6%),#080808}"
              ".sw-warp{background:radial-gradient(circle,#fff 0%,#8888ff 10%,#000022 50%,#000)}"
              ".sw-pulse-ring{background:radial-gradient(circle,#fff 0%,#ff00ff 18%,#110022 62%,#000)}"
              ".sw-blocks{background:linear-gradient(90deg,#ff0066 0 20%,#ffcc00 20% 40%,#00cc66 40% 60%,#0099ff 60% 80%,#6633ff 80%)}"
              ".sw-bloom{background:radial-gradient(circle,#ffd6f0 0%,#ff5ab3 24%,#46102e 62%,#09030b 100%)}"
              ".sw-calm{background:linear-gradient(120deg,#071923,#14515c,#1f8076,#071923)}"
              ".sw-drift{background:linear-gradient(90deg,#7fc7ff,#d9a8ff,#ffc2d6,#ffe7a8,#7fc7ff)}"
              ".sw-sunset{background:linear-gradient(90deg,#2a0830,#8a2050,#d04a18,#f1c40f,#d04a18,#8a2050,#2a0830)}"
              ".sw-twinkle{background:linear-gradient(180deg,#3a2c1a,#1a1208)}"
              ".sw-wave{background:linear-gradient(90deg,#1a1a4a,#5c5cc8,#9b9be0,#5c5cc8,#1a1a4a)}"
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
              "<div class='row'><button id='identify'>Find this card</button><span class='note' style='margin:0'>Flashes 3 times</span></div>"
              "<div class='row'><button id='reboot'>Reboot</button><button class='ghost' id='change-wifi'>Reset WiFi only</button></div>"
              "<p class='note' style='font-size:11px;color:#5a5247'>Reset WiFi only keeps your piece name and patterns. The card will reboot into setup mode \xE2\x80\x94 join its <strong>Lightweaver-XXXX</strong> WiFi from a phone to enter new credentials.</p>"
              "<details style='margin-top:14px;border:1px solid #3a2c1a;border-radius:8px;padding:12px;background:rgba(58,44,26,0.2)'>"
                "<summary style='cursor:pointer;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#e07856'>Dangerous \xE2\x80\x94 erase everything</summary>"
                "<p class='note' style='margin-top:10px'>Erases <strong>all</strong> stored settings: WiFi, piece name, hostname, any custom patterns. Card returns to factory defaults. Only use this if the card is in an unknown state. <strong>Cannot be undone.</strong></p>"
                "<p class='note'>To proceed, type <code style='background:#0a0a0a;padding:2px 6px;border-radius:4px;font-family:ui-monospace,monospace'>RESET</code> below:</p>"
                "<input type='text' id='factory-confirm' placeholder='Type RESET to confirm' style='width:100%;background:#0a0a0a;border:1px solid #3a2c1a;color:#f4ede0;padding:10px;border-radius:6px;margin-bottom:10px'>"
                "<div class='row'><button class='danger' id='factory'>Erase all settings</button></div>"
              "</details>"
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
              "$('identify').onclick=()=>{post('/api/identify',{});const m=$('set-msg');m.textContent='Watch the strip — it will flash 3 times.';m.className='note ok';setTimeout(()=>m.textContent='',3000)};"
              "$('reboot').onclick=async()=>{if(!confirm('Reboot the card? Everything stays saved; the strip will go dark for ~5 seconds.'))return;const m=$('set-msg');m.textContent='Rebooting…';m.className='note';await post('/api/reboot',{})};"
              "$('change-wifi').onclick=()=>{if(!confirm('Reset WiFi only? Patterns and piece name stay. Card reboots into setup mode — you will need to rejoin it from a phone (Lightweaver-XXXX) to enter new WiFi credentials.'))return;const m=$('set-msg');m.textContent='Resetting WiFi…';m.className='note';post('/api/reset-wifi',{})};"
              "$('factory').onclick=async()=>{const v=$('factory-confirm').value;if(v!=='RESET'){const m=$('set-msg');m.textContent='Type RESET in the box above first.';m.className='note err';return}const m=$('set-msg');m.textContent='Erasing everything and rebooting…';m.className='note';try{await post('/api/factory-reset',{confirm:'RESET'})}catch(e){}};"
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
  String body = runtimeStatusJson(
    *runtimeConfigPtr,
    *errorCodePtr,
    *totalPixelsPtr,
    *currentLookIndexPtr
  );
  // Inject streaming state. Keeps runtimeStatusJson() decoupled from the
  // Art-Net / WLED-realtime layer; the customer page polls /api/status so
  // it only needs the flag + source label.
  uint8_t src = runtimeFrameSource();
  const char* srcLabel = src == 1 ? "wled-realtime" : src == 2 ? "artnet" : "internal";
  int lastBrace = body.lastIndexOf('}');
  if (lastBrace > 0) {
    String tail = String(",\"streaming\":") + (runtimeIsStreaming() ? "true" : "false") +
                  ",\"frameSource\":\"" + srcLabel + "\"}";
    body = body.substring(0, lastBrace) + tail;
  }
  server.send(200, "application/json", body);
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
  // Optional `zone` field targets a single zone. Empty / missing = broadcast
  // (under sync rules — see runtime API). Visitors using the basic page never
  // send `zone`; the designer surface does.
  String zoneTarget = hasControlField(doc, "zone") ? controlString(doc, "zone") : String("");

  // Apply sync mode before any empty-zone writes. Otherwise an "all sections"
  // command sent while the card is in split preview mode updates only zone 0.
  if (hasControlField(doc, "syncZones")) runtimeSetSyncZones(controlBool(doc, "syncZones"));
  if (hasControlField(doc, "colorOrder")) runtimeSetLedColorOrder(controlString(doc, "colorOrder"));
  if (hasControlField(doc, "brightness")) runtimeSetBrightnessZ(zoneTarget, controlFloat(doc, "brightness"));
  if (hasControlField(doc, "speed")) runtimeSetSpeedZ(zoneTarget, controlFloat(doc, "speed"));
  if (hasControlField(doc, "hueShift")) runtimeSetHueShiftZ(zoneTarget, controlInt(doc, "hueShift"));
  if (hasControlField(doc, "blackout")) runtimeSetBlackoutZ(zoneTarget, controlBool(doc, "blackout"));
  if (hasControlField(doc, "next") && controlBool(doc, "next")) runtimeNextPattern();
  if (hasControlField(doc, "previous") && controlBool(doc, "previous")) runtimePreviousPattern();
  if (hasControlField(doc, "patternId")) {
    String id = controlString(doc, "patternId");
    if (id.length()) runtimeSelectPatternByIdZ(zoneTarget, id);
  }
  if (hasControlField(doc, "hue")) runtimeSetCustomHueZ(zoneTarget, uint8_t(controlInt(doc, "hue") & 0xff));
  if (hasControlField(doc, "saturation")) runtimeSetCustomSaturationZ(zoneTarget, uint8_t(controlInt(doc, "saturation") & 0xff));
  if (hasControlField(doc, "breathe")) runtimeSetCustomBreatheZ(zoneTarget, controlBool(doc, "breathe"));
  if (hasControlField(doc, "drift")) runtimeSetCustomDriftZ(zoneTarget, controlBool(doc, "drift"));
  if (hasControlField(doc, "driftMin") || hasControlField(doc, "driftMax")) {
    uint8_t lo = hasControlField(doc, "driftMin") ? uint8_t(controlInt(doc, "driftMin") & 0xff) : runtimeGetDriftHueMin();
    uint8_t hi = hasControlField(doc, "driftMax") ? uint8_t(controlInt(doc, "driftMax") & 0xff) : runtimeGetDriftHueMax();
    runtimeSetDriftRangeZ(zoneTarget, lo, hi);
  }
  if (hasControlField(doc, "cancelStream") && controlBool(doc, "cancelStream")) runtimeCancelStream();
  // Echo current state back
  JsonDocument out;
  out["ok"] = true;
  out["brightness"] = runtimeGetBrightness();
  out["speed"] = runtimeGetSpeed();
  out["hueShift"] = runtimeGetHueShift();
  out["blackout"] = runtimeIsBlackedOut();
  out["hue"] = runtimeGetCustomHue();
  out["saturation"] = runtimeGetCustomSaturation();
  out["colorOrder"] = runtimeGetLedColorOrder();
  out["breathe"] = runtimeGetCustomBreathe();
  out["drift"] = runtimeGetCustomDrift();
  out["driftMin"] = runtimeGetDriftHueMin();
  out["driftMax"] = runtimeGetDriftHueMax();
  String body;
  serializeJson(out, body);
  server.send(200, "application/json", body);
}

void handleIdentify() {
  sendCors();
  runtimeTriggerIdentify();
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleZones() {
  sendCors();
  server.send(200, "application/json", runtimeZonesJson());
}

void handleFactoryReset() {
  sendCors();
  // Require a confirmation token in the body so this can't fire from a
  // stray click. The card-side UI types "RESET" into a confirmation field.
  if (server.hasArg("plain")) {
    JsonDocument doc;
    if (!deserializeJson(doc, server.arg("plain"))) {
      String token = String(doc["confirm"] | "");
      if (token != "RESET") {
        server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing confirmation\"}");
        return;
      }
    } else {
      server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing confirmation\"}");
      return;
    }
  } else {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing confirmation\"}");
    return;
  }
  server.send(200, "application/json", "{\"ok\":true,\"message\":\"erasing all settings and rebooting\"}");
  delay(200);
  runtimeFactoryReset();
}

void handleResetWifi() {
  sendCors();
  server.send(200, "application/json", "{\"ok\":true,\"message\":\"wiping wifi and rebooting into setup\"}");
  delay(200);
  runtimeResetWifi();
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
  WiFi.setSleep(false);
  WiFi.setHostname(hostname.c_str());
  WiFi.begin(config.wifi.ssid.c_str(), config.wifi.password.c_str());
  if (Serial) {
    Serial.print("Joining WiFi ");
    Serial.print(config.wifi.ssid);
    Serial.print(" as ");
    Serial.println(hostname);
  }

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (Serial) Serial.println("WiFi join failed, falling back to AP");
    WiFi.disconnect(true, true);
    return false;
  }
  config.activeTransport = WIFI_TRANSPORT_STATION;
  config.activeIp = WiFi.localIP().toString();
  config.activeHostname = hostname;
  if (Serial) {
    Serial.print("WiFi joined: ");
    Serial.print(config.activeIp);
    Serial.print(" / ");
    Serial.print(hostname);
    Serial.println(".local");
  }
  if (MDNS.begin(hostname.c_str())) {
    MDNS.addService("http", "tcp", 80);
    if (Serial) Serial.println("mDNS responder up");
  }
  return true;
}

void startApMode(RuntimeConfig& config) {
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  String ssid = apSsid();
  WiFi.softAP(ssid.c_str());
  config.activeTransport = WIFI_TRANSPORT_AP;
  config.activeIp = WiFi.softAPIP().toString();
  config.activeHostname = "";
  if (Serial) {
    Serial.print("Lightweaver AP: ");
    Serial.print(ssid);
    Serial.print(" / ");
    Serial.println(config.activeIp);
  }

  dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
  dnsServerActive = dnsServer.start(53, "*", WiFi.softAPIP());
  if (dnsServerActive) {
    if (Serial) Serial.println("Captive DNS up");
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
  server.on("/api/status", HTTP_OPTIONS, handleOptions);
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
  server.on("/api/reset-wifi", HTTP_OPTIONS, handleOptions);
  server.on("/api/reset-wifi", HTTP_POST, handleResetWifi);
  server.on("/api/rename", HTTP_OPTIONS, handleOptions);
  server.on("/api/rename", HTTP_POST, handleRenamePost);
  server.on("/api/firmware-info", HTTP_OPTIONS, handleOptions);
  server.on("/api/firmware-info", HTTP_GET, handleFirmwareInfo);
  server.on("/api/patterns", HTTP_OPTIONS, handleOptions);
  server.on("/api/patterns", HTTP_GET, handlePatterns);
  server.on("/api/zones", HTTP_OPTIONS, handleOptions);
  server.on("/api/zones", HTTP_GET, handleZones);

  // Pretend-WLED JSON API — lets the existing designer's WLED bar +
  // DevicesPanel + live-frame push path talk to the card without changes.
  lw_wled::registerEndpoints(server);

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
