// showVoiceSentence.js — turn a music-responsive "voice" record into an
// editable plain-English sentence made of typed tokens. Pure, no React/DOM.
//
// A `voice` binds one motif (area) to one audio band and one visual
// character, at a given depth, plus an optional symmetry spread/direction:
//   voice = {
//     areaId, areaName,        // which motif ("lotus flowers")
//     character,               // 'swell' | 'twinkle' | 'ripple' | 'glow' | 'trace'
//     band,                    // 'lows' | 'mids' | 'highs' (or similar)
//     bandLabel,                // optional display label, defaults to `band`
//     depth,                   // 0..1, how strongly the band drives the character
//     resolved,                // boolean — false ⇒ trailing "not yet set up" clause
//     field,                   // optional symmetry field {fold, name} for spreadPhrase
//     spread, direction,       // optional symmetry authoring values (see symmetryFields.js)
//   }
//
// voiceSentenceTokens() renders ONE voice as a token stream:
//   The <area> <character> with the <band>, <depthAdverb>, <spreadPhrase>.
// Every bracketed piece is a kind:'control' token whose `value` is read
// straight off the voice record — never recomputed or reformatted — so the
// sentence and the underlying controls cannot structurally drift apart.
//
// groundSentenceTokens() renders the always-present coal-field ground clock:
//   Underneath, the coals breathe <depthAdverb-for-'glow'>.
//
// compositionParagraph() joins every resolved/unresolved voice sentence plus
// the ground sentence into one paragraph of tokens (flat array, sentences
// separated by a single text token containing a newline).
//
// Wiring note (NOT wired here — this file is pure token generation):
// a caller renders `Token[]` by mapping kind:'text' to a text node and
// kind:'control' to an inline <select>/chip bound to `value`, emitting
// changes back onto the voice record at `control` (e.g. 'depth' → voice.depth).

const CHARACTER_ADVERBS = {
  swell: ['barely', 'gently', 'clearly', 'deeply'],
  twinkle: ['faintly', 'softly', 'brightly', 'sharply'],
  ripple: ['barely', 'gently', 'clearly', 'strongly'],
  glow: ['dimly', 'gently', 'warmly', 'richly'],
  trace: ['faintly', 'quietly', 'clearly', 'boldly'],
};

const DEPTH_THRESHOLDS = [0.2, 0.45, 0.7];

const CHARACTER_OPTIONS = Object.keys(CHARACTER_ADVERBS).map((value) => ({
  value,
  label: value,
}));

const BAND_OPTIONS = [
  { value: 'lows', label: 'lows' },
  { value: 'mids', label: 'mids' },
  { value: 'highs', label: 'highs' },
];

const DIRECTION_OPTIONS = [
  { value: 1, label: 'clockwise' },
  { value: -1, label: 'counter-clockwise' },
];

function text(str) {
  return { kind: 'text', text: str };
}

function control(control, text, value, options) {
  return { kind: 'control', control, text, value, options: options || [] };
}

/**
 * depthAdverb(character, depth) -> string
 * Character-specific adverb ladder. Unknown character falls back to the
 * 'glow' ladder (a safe, neutral-reading set of adverbs) rather than
 * throwing, since a voice sentence must always be renderable.
 */
export function depthAdverb(character, depth) {
  const ladder = CHARACTER_ADVERBS[character] || CHARACTER_ADVERBS.glow;
  const d = typeof depth === 'number' && Number.isFinite(depth) ? depth : 0;
  let index = 0;
  if (d >= DEPTH_THRESHOLDS[2]) index = 3;
  else if (d >= DEPTH_THRESHOLDS[1]) index = 2;
  else if (d >= DEPTH_THRESHOLDS[0]) index = 1;
  else index = 0;
  return ladder[index];
}

/**
 * spreadPhrase(field, voice) -> string | null
 * null when fold === 1 (nothing to spread — a fold-1 motif is one body).
 * 'as one body' when fold > 1 and spread is 0.
 * Otherwise a directional phrase using the field's name when present.
 */
export function spreadPhrase(field, voice) {
  const fold = field && typeof field.fold === 'number' ? field.fold : 1;
  if (fold === 1) return null;

  const spread = voice && typeof voice.spread === 'number' ? voice.spread : 0;
  if (spread === 0) return 'as one body';

  const direction = voice && voice.direction === -1 ? -1 : 1;
  if (voice && voice.orderMode === 'radial') {
    return 'from the centre out';
  }
  return direction === -1
    ? 'one after another, counter-clockwise'
    : 'one after another, clockwise';
}

/**
 * voiceSentenceTokens(voice, ctx?) -> Token[]
 * ctx = { field } optionally supplies the symmetry field for spreadPhrase;
 * falls back to voice.field when omitted.
 */
export function voiceSentenceTokens(voice, ctx) {
  const field = (ctx && ctx.field) || voice.field || null;
  const areaName = voice.areaName || voice.areaId || 'motif';
  const bandLabel = voice.bandLabel || voice.band;

  const tokens = [text('The ')];

  tokens.push(control('area', areaName, voice.areaId, []));
  tokens.push(text(' '));
  tokens.push(control('character', voice.character, voice.character, CHARACTER_OPTIONS));
  tokens.push(text(' with the '));
  tokens.push(control('band', bandLabel, voice.band, BAND_OPTIONS));
  tokens.push(text(', '));
  tokens.push(control('depth', depthAdverb(voice.character, voice.depth), voice.depth, []));

  const phrase = spreadPhrase(field, voice);
  if (phrase !== null) {
    tokens.push(text(', '));
    if (phrase.startsWith('one after another')) {
      const direction = voice && voice.direction === -1 ? -1 : 1;
      tokens.push(control('spread', 'one after another', voice.spread, []));
      tokens.push(text(', '));
      tokens.push(
        control(
          'direction',
          direction === -1 ? 'counter-clockwise' : 'clockwise',
          direction,
          DIRECTION_OPTIONS
        )
      );
    } else {
      tokens.push(control('spread', phrase, voice.spread, []));
    }
  }

  tokens.push(text('.'));

  if (voice.resolved === false) {
    tokens.push(text(' (not yet set up)'));
  }

  return tokens;
}

/**
 * groundSentenceTokens(ground) -> Token[]
 * ground = { depth } — the always-present coal-field clock, character fixed
 * to 'glow' per the locked aesthetic (silence decays to a dim living-coal
 * field, never black, never frozen).
 */
export function groundSentenceTokens(ground) {
  const g = ground || {};
  const depth = typeof g.depth === 'number' ? g.depth : 0;
  return [
    text('Underneath, the coals breathe '),
    control('depth', depthAdverb('glow', depth), depth, []),
    text('.'),
  ];
}

/**
 * compositionParagraph(composition, resolved) -> Token[]
 * composition = { voices: Voice[], ground? }
 * resolved is currently unused for token content (each voice carries its own
 * `resolved` flag) but is accepted so a caller can pass a resolution map
 * keyed differently without this function needing to know the shape; when
 * present it is not required to match — voice.resolved is authoritative.
 */
export function compositionParagraph(composition, _resolved) {
  const voices = (composition && composition.voices) || [];
  const tokens = [];
  voices.forEach((voice) => {
    if (tokens.length > 0) tokens.push(text('\n'));
    tokens.push(...voiceSentenceTokens(voice));
  });
  if (tokens.length > 0) tokens.push(text('\n'));
  tokens.push(...groundSentenceTokens(composition && composition.ground));
  return tokens;
}
