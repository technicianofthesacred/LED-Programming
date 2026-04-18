/**
 * wled.js — WLED JSON API + WebSocket client
 *
 * HTTP API endpoints used:
 *   POST /json/state  — push state changes (preset, brightness, etc.)
 *
 * WebSocket /ws:
 *   Send  { "lv": true }  to subscribe to live LED colour frames.
 *   Receive binary frames: [type:u8][ledCount:u16be][R,G,B × N]
 *   Receive JSON frames:   state updates (brightness changed, etc.)
 *
 * WLED sets Access-Control-Allow-Origin: * so direct browser connections
 * work as long as both are on the same local network.
 */

export class WLEDClient {
  constructor(ip) {
    this.ip      = ip;
    this._base   = `http://${ip}`;
    this._ws     = null;
    this._wsOpen = false;
    this._reconnectTimer = null;

    this.onConnect      = null; // ()
    this.onDisconnect   = null; // ()
    this.onLiveFrame    = null; // (Uint8Array rgbData, count)
    this.onStateUpdate  = null; // (stateObj)
  }

  // ── HTTP API ──────────────────────────────────────────────────────────────

  async setState(patch) {
    const r = await fetch(`${this._base}/json/state`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
      signal:  AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  loadPreset(id) {
    return this.setState({ ps: parseInt(id) });
  }

  setBrightness(bri) {
    return this.setState({ bri: Math.round(clamp(bri, 0, 255)) });
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  connect() {
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.close();
    }
    clearTimeout(this._reconnectTimer);

    const ws = new WebSocket(`ws://${this.ip}/ws`);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      this._wsOpen = true;
      ws.send(JSON.stringify({ lv: true }));
      this.onConnect?.();
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this._parseBinaryFrame(new Uint8Array(ev.data));
      } else {
        try {
          const obj = JSON.parse(ev.data);
          this.onStateUpdate?.(obj);
        } catch { /* malformed JSON */ }
      }
    };

    ws.onclose = () => {
      this._wsOpen = false;
      this.onDisconnect?.();
      this._reconnectTimer = setTimeout(() => this.connect(), 3000);
    };

    ws.onerror = () => {
      // onerror always precedes onclose — let onclose handle reconnect
    };
  }

  disconnect() {
    clearTimeout(this._reconnectTimer);
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.close();
      this._ws = null;
    }
    this._wsOpen = false;
    this.onDisconnect?.();
  }

  get connected() { return this._wsOpen; }

  // ── Binary frame parser ───────────────────────────────────────────────────

  _parseBinaryFrame(data) {
    if (!this.onLiveFrame || data.length < 4) return;
    const type  = data[0];
    if (type !== 1 && type !== 2) return;
    const count = (data[1] << 8) | data[2];
    const body  = data.subarray(3);
    if (body.length < count * 3) return;
    this.onLiveFrame(body, count);
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
