#!/usr/bin/env node
// Tiny Art-Net DMX sender for sanity-checking LightweaverArtnet.
//
// Usage:
//   node tests/artnet-send-test.mjs <ip> [universe] [pixelCount]
//
// Sends one ArtDMX packet with a rainbow ramp. Listener side should write
// the gradient into leds[universe * 170 .. universe * 170 + pixelCount - 1]
// and tick frameSourceMarkExternal(FRAME_ARTNET).

import dgram from 'node:dgram';

const [, , host = '127.0.0.1', universeArg = '0', countArg = '170'] = process.argv;
const universe = Number(universeArg) & 0xffff;
const pixelCount = Math.min(170, Math.max(1, Number(countArg)));

const HEADER = Buffer.from('Art-Net\0', 'binary');
const dataLength = pixelCount * 3;
const packet = Buffer.alloc(18 + dataLength);

HEADER.copy(packet, 0);                   // bytes 0..7
packet.writeUInt16LE(0x5000, 8);          // OpCode ArtDMX (little-endian)
packet.writeUInt16BE(14, 10);             // ProtVer 14 (big-endian)
packet[12] = 0;                           // Sequence
packet[13] = 0;                           // Physical
packet[14] = universe & 0xff;             // SubUni (low byte of universe)
packet[15] = (universe >> 8) & 0x0f;      // Net (high nibble; we keep net=0)
packet.writeUInt16BE(dataLength, 16);     // Length (big-endian)

// Rainbow ramp body
for (let i = 0; i < pixelCount; i++) {
  const t = i / Math.max(1, pixelCount - 1);
  const hue = Math.floor(t * 255);
  // Cheap HSV->RGB
  const h = hue / 255 * 6;
  const f = h - Math.floor(h);
  const p = 0, q = Math.floor((1 - f) * 255), tt = Math.floor(f * 255);
  let r, g, b;
  switch (Math.floor(h) % 6) {
    case 0: r = 255; g = tt;  b = p;   break;
    case 1: r = q;   g = 255; b = p;   break;
    case 2: r = p;   g = 255; b = tt;  break;
    case 3: r = p;   g = q;   b = 255; break;
    case 4: r = tt;  g = p;   b = 255; break;
    default:r = 255; g = p;   b = q;
  }
  const base = 18 + i * 3;
  packet[base]     = r;
  packet[base + 1] = g;
  packet[base + 2] = b;
}

const sock = dgram.createSocket('udp4');
sock.send(packet, 6454, host, (err) => {
  if (err) {
    console.error('send failed:', err.message);
    process.exit(1);
  }
  console.log(`sent ${packet.length} bytes to ${host}:6454 universe=${universe} pixels=${pixelCount}`);
  sock.close();
});
