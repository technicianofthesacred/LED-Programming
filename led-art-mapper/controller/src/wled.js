/**
 * wled.js — WLED JSON API + WebSocket client
 *
 * HTTP API endpoints used:
 *   GET  /json/state  — read current state (brightness, effect, preset)
 *   POST /json/state  — push state changes
 *   GET  /json/info   — device info (LED count, version)
 *
 * WebSocket /ws:
 *   Send  { "lv": true }  to subscribe to live LED color frames.
 *   Receive binary frames: [type:u8][ledCount:u16be][R,G,B × N]
 *   Receive JSON frames:   state updates (brightness changed, etc.)
 *
 * WLED sets Access-Control-Allow-Origin: * so direct browser fetch works
 * as long as both are on the same network.
 */

export class WLEDClient {
  /**
   * @param {string} ip — e.g. "192.168.4.1"
   */
  constructor(ip) {
    this.ip      = ip;
    this._base   = `http://${ip}`;
    this._ws     = null;
    this._wsOpen = false;
    this._reconnectTimer = null;

    /** Callbacks set by main.js */
    this.onConnect      = null; // ()
    this.onDisconnect   = null; // ()
    this.onLiveFrame    = null; // (Uint8Array rgbData, count)
    this.onStateUpdate  = null; // (stateObj)
  }

  // ── HTTP API ─────────────────────────────────────────────────────────────

  async getState() {
    const r = await fetch(`${this._base}/json/state`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async getInfo() {
    const r = await fetch(`${this._base}/json/info`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /**
   * Push a partial state object.
   * @param {object} patch — any subset of WLED state
   */
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

  /** Load a WLED preset by slot number (1–250). */
  loadPreset(id) {
    return this.setState({ ps: parseInt(id) });
  }

  /** Set master brightness 0–255. */
  setBrightness(bri) {
    return this.setState({ bri: Math.round(clamp(bri, 0, 255)) });
  }

  /** Set effect speed + intensity on segment 0. */
  setSpeedIntensity(speed, intensity) {
    return this.setState({ seg: [{ sx: Math.round(speed), ix: Math.round(intensity) }] });
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  /**
   * Open (or reopen) the WebSocket connection.
   * Automatically reconnects on disconnect.
   */
  connect() {
    if (this._ws) {
      this._ws.onclose = null; // suppress reconnect from old socket
      this._ws.close();
    }
    clearTimeout(this._reconnectTimer);

    const ws = new WebSocket(`ws://${this.ip}/ws`);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      this._wsOpen = true;
      // Request live LED color streaming
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
        } catch { /* malformed JSON, ignore */ }
      }
    };

    ws.onclose  = () => {
      this._wsOpen = false;
      this.onDisconnect?.();
      // Auto-reconnect after 3 s
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

    // WLED live frame format:
    //   byte 0:    type  (1 = LEDs via notifier, 2 = LEDs via live)
    //   bytes 1-2: LED count big-endian uint16
    //   bytes 3…:  R, G, B, … for each LED
    const type  = data[0];
    if (type !== 1 && type !== 2) return; // unknown frame type

    const count = (data[1] << 8) | data[2];
    const body  = data.subarray(3);
    if (body.length < count * 3) return; // incomplete frame

    this.onLiveFrame(body, count);
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
