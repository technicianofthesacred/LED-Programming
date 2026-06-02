/* Real-data adapters for the exact v3 components.
   These return the live app's real data in the SAME shape the mockup
   components expect (pattern = {id,label,cat,sp,grad,pal,desc,mix?}), so the
   exact JSX/CSS renders unchanged but is driven by the real pattern bank,
   strips, palette, etc. No visual code lives here. */
import {
  CARD_PATTERN_BANK,
  getCardPatternById,
  getCardPatternFingerprint,
} from '../lib/cardPatternBank.js';

const TEMPO_TO_SP = { Slow: 'SLOW', Medium: 'MED', Fast: 'FAST' };

// category bucket from a pattern's fingerprint tags / id, mapped to the
// mockup's category ids: calm | water | warm | spark | motion | electric
function categoryFor(id, fp) {
  const tags = (fp.tags || []).map(t => String(t).toLowerCase());
  const tempo = String(fp.tempoLabel || '').toLowerCase();
  const hay = `${id} ${tags.join(' ')}`;
  if (/fire|lava|candle|ember|sunset|warm|flame|gold/.test(hay)) return 'warm';
  if (/ocean|ripple|wave|water|plasma|aqua|sea/.test(hay)) return 'water';
  if (/spark|twinkle|meteor|confetti|lightning|star/.test(hay)) return 'spark';
  if (/chase|scanner|warp|pulse|blocks|rainbow|motion|run/.test(hay)) return 'motion';
  if (/neon|matrix|heartbeat|stained|electric|digital/.test(hay)) return 'electric';
  if (/aurora|breathe|calm|drift|bloom|slow/.test(hay) || tempo === 'slow') return 'calm';
  return 'motion';
}

// one live pattern -> the exact-component pattern shape
export function adaptPattern(patternOrId) {
  const pattern = typeof patternOrId === 'object' && patternOrId
    ? patternOrId
    : getCardPatternById(patternOrId);
  const id = String(pattern?.id || patternOrId || '').trim();
  const fp = getCardPatternFingerprint(pattern || id);
  const pal = (fp.palette && fp.palette.length ? fp.palette : ['#1c2230', '#4e9ec9', '#8ce2d3']).slice(0, 4);
  // pad to 4 so the bead/strip renders the way the mockup expects
  while (pal.length < 4) pal.push(pal[pal.length - 1]);
  return {
    id,
    label: pattern?.label || id,
    cat: categoryFor(id.toLowerCase(), fp),
    sp: TEMPO_TO_SP[fp.tempoLabel] || 'MED',
    grad: pattern?.preview || `linear-gradient(110deg, ${pal.join(',')})`,
    pal,
    desc: pattern?.description || '',
  };
}

// the full real pattern bank in the exact-component shape
export const REAL_PATTERNS = CARD_PATTERN_BANK.map(adaptPattern);
export const REAL_PATTERN_BY_ID = new Map(REAL_PATTERNS.map(p => [p.id, p]));

export function adaptSavedLook(look) {
  if (!look) return null;
  const base = adaptPattern(look.patternId || look.base || 'aurora');
  return {
    ...base,
    id: look.id || `mix-${base.id}`,
    label: look.label || look.name || `${base.label} mix`,
    base: base.id,
    cat: 'mix',
    mix: true,
    desc: look.desc || `Saved mix · ${base.label}.`,
  };
}

// pick a warm pattern id for first-load preview (matches the mockup default)
export function defaultWarmPatternId() {
  const prefer = ['lava', 'fire', 'ember', 'candle', 'sunset'];
  for (const id of prefer) if (REAL_PATTERN_BY_ID.has(id)) return id;
  const warm = REAL_PATTERNS.find(p => p.cat === 'warm');
  return warm ? warm.id : (REAL_PATTERNS[0] && REAL_PATTERNS[0].id) || 'aurora';
}
