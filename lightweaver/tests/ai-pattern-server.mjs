import assert from 'node:assert/strict';
import {
  buildAiPatternInput,
  getAiPatternModel,
  normalizeAiProviderError,
} from '../server/aiPattern.js';

assert.equal(getAiPatternModel({ AI_PATTERN_MODEL: 'gpt-5.5' }), 'gpt-5.5');
assert.equal(getAiPatternModel({}), 'gpt-5.4-mini');

const input = buildAiPatternInput({
  mode: 'transform',
  instruction: 'make it slower',
  sourcePattern: {
    id: 'aurora',
    name: 'Aurora',
    code: 'return hsv(time,1,1);',
    palette: ['#00ffaa', '#6600aa'],
    params: { speed: 0.2 },
    isCustom: false,
  },
  projectContext: { ledCount: 128, stripCount: 3, hasAudio: true, hasMappedXY: true },
});
assert.equal(input[0].role, 'developer');
assert.match(input[0].content, /Lightweaver pattern draft generator/);
assert.equal(input[1].role, 'user');
assert.match(input[1].content, /make it slower/);
assert.match(input[1].content, /"ledCount":128/);

const providerError = normalizeAiProviderError(Object.assign(new Error('Rate limit'), { status: 429 }));
assert.equal(providerError.status, 429);
assert.equal(providerError.code, 'rate_limited');

const timeoutError = normalizeAiProviderError(Object.assign(new Error('Timeout'), { name: 'AbortError' }));
assert.equal(timeoutError.status, 504);
assert.equal(timeoutError.code, 'timeout');
