export function rgbToWledHex(pixel = {}) {
  return `${byteToHex(pixel.r)}${byteToHex(pixel.g)}${byteToHex(pixel.b)}`;
}

export function pixelsToWledHexArray(pixels = []) {
  return pixels.map(pixel => rgbToWledHex(pixel));
}

export function rgbArrayToWledHex(rgb = [0, 0, 0]) {
  return rgbToWledHex({ r: rgb[0], g: rgb[1], b: rgb[2] });
}

function byteToHex(value) {
  const byte = clampByte(value);
  return byte.toString(16).toUpperCase().padStart(2, '0');
}

function clampByte(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
