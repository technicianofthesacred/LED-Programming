export const WLED_BASIC_EFFECT_ID_SOURCE = 'WLED 0.15.4 effect and palette lists';

export const WLED_STOCK_LOOKS = Object.freeze({
  aurora: stockLook('Aurora', 38, 'Aurora', 52, { sx: 72, ix: 150 }),
  breathe: stockLook('Breathe', 2, '* Color Gradient', 4, { sx: 72, ix: 128 }),
  candle: stockLook('Candle', 88, 'Fire', 35, { sx: 64, ix: 170 }),
  chase: stockLook('Chase', 28, 'Default', 0, { sx: 88, ix: 140 }),
  dna: stockLook('DNA', 150, 'Rainbow', 11, { sx: 80, ix: 140 }),
  drift: stockLook('Drift', 165, 'Aurora', 52, { sx: 44, ix: 128 }),
  fire: stockLook('Fire 2012', 66, 'Fire', 35, { sx: 124, ix: 160 }),
  gradient: stockLook('Gradient', 46, '* Color Gradient', 4, { sx: 42, ix: 128 }),
  lava: stockLook('Noise 1', 70, 'Lava', 8, { sx: 42, ix: 160 }),
  lightning: stockLook('Lightning', 57, 'Default', 0, { sx: 96, ix: 160 }),
  'lissajous-v2': stockLook('Lissajous', 176, 'Rainbow', 11, { sx: 64, ix: 128 }),
  matrix: stockLook('Matrix', 151, 'Default', 0, { sx: 80, ix: 128 }),
  meteor: stockLook('Meteor Smooth', 77, 'Default', 0, { sx: 74, ix: 140 }),
  'meteor-shower': stockLook('Meteor Smooth', 77, 'Default', 0, { sx: 88, ix: 150 }),
  ocean: stockLook('Pacifica', 99, 'Ocean', 9, { sx: 54, ix: 128 }),
  plasma: stockLook('Plasma', 97, 'Rainbow', 11, { sx: 52, ix: 128 }),
  'plasma-ball': stockLook('Plasma Ball', 179, 'Rainbow', 11, { sx: 68, ix: 140 }),
  rainbow: stockLook('Rainbow', 9, 'Rainbow', 11, { sx: 58, ix: 128 }),
  ripple: stockLook('Ripple', 79, 'Default', 0, { sx: 72, ix: 128 }),
  scanner: stockLook('Scanner', 40, 'Default', 0, { sx: 86, ix: 160 }),
  sparkle: stockLook('Sparkle', 20, 'Default', 0, { sx: 44, ix: 118 }),
  sunrise: stockLook('Sunrise', 104, 'Sunset', 13, { sx: 32, ix: 140 }),
  'sunrise-v2': stockLook('Sunrise', 104, 'Sunset', 13, { sx: 28, ix: 128 }),
  'sunrise-horizon': stockLook('Sunrise', 104, 'Sunset', 13, { sx: 26, ix: 128 }),
  twinkle: stockLook('Twinkle', 17, 'Default', 0, { sx: 40, ix: 110 }),
  waterfall: stockLook('Waterfall', 140, 'Ocean', 9, { sx: 70, ix: 150 }),
});

function stockLook(effectName, effectId, paletteName, paletteId, { sx = 128, ix = 128 } = {}) {
  return Object.freeze({ effectName, effectId, paletteName, paletteId, sx, ix });
}
