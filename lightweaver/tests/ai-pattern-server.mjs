import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  AI_PATTERN_TIMEOUT_MS,
  AiPatternDraftSchema,
  buildAiPatternInput,
  getAiPatternModel,
  normalizeAiProviderError,
} from '../server/aiPattern.js';
import { createLightweaverServer } from '../server/index.js';

function findObjectAdditionalProperties(value) {
  if (!value || typeof value !== 'object') return null;
  if (
    Object.hasOwn(value, 'additionalProperties') &&
    value.additionalProperties &&
    typeof value.additionalProperties === 'object'
  ) {
    return value.additionalProperties;
  }
  for (const child of Object.values(value)) {
    const match = findObjectAdditionalProperties(child);
    if (match) return match;
  }
  return null;
}

async function withServer(app, callback) {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

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
assert.match(input[0].content, /suggestedParams.*name.*value/);
assert.equal(input[1].role, 'user');
assert.match(input[1].content, /make it slower/);
assert.match(input[1].content, /"ledCount":128/);

const textFormat = zodTextFormat(AiPatternDraftSchema, 'lightweaver_pattern_draft');
assert.equal(findObjectAdditionalProperties(textFormat), null);

const providerError = normalizeAiProviderError(Object.assign(new Error('Rate limit'), { status: 429 }));
assert.equal(providerError.status, 429);
assert.equal(providerError.code, 'rate_limited');

const timeoutError = normalizeAiProviderError(Object.assign(new Error('Timeout'), { name: 'AbortError' }));
assert.equal(timeoutError.status, 504);
assert.equal(timeoutError.code, 'timeout');

const missingKeyApp = createLightweaverServer({
  env: {},
  createOpenAiClient() {
    throw new Error('provider should not be constructed without an API key');
  },
});
await withServer(missingKeyApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it blue' }),
  });
  assert.equal(response.status, 501);
  assert.equal(body.error.code, 'missing_api_key');
});

let successCall = null;
const successApp = createLightweaverServer({
  env: { OPENAI_API_KEY: 'test-key', AI_PATTERN_MODEL: 'gpt-5.5' },
  client: {
    responses: {
      async parse(payload, options) {
        successCall = { payload, options };
        return {
          output_parsed: {
            name: 'Slow Aurora',
            description: 'A calmer aurora pattern.',
            changeSummary: ['Reduced speed'],
            palette: ['#00ffaa', '#6600aa'],
            code: 'return hsv(time * params.speed, 1, 1);',
            suggestedParams: [{ name: 'speed', value: 0.08 }],
            notes: '',
          },
        };
      },
    },
  },
});
await withServer(successApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower' }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.draft.suggestedParams.speed, 0.08);
  assert.deepEqual(body.draft.suggestedParams, { speed: 0.08 });
  assert.equal(successCall.payload.model, 'gpt-5.5');
  assert.equal(successCall.options.timeout, AI_PATTERN_TIMEOUT_MS);
});

const invalidRequestApp = createLightweaverServer({
  env: { OPENAI_API_KEY: 'test-key' },
  client: {
    responses: {
      async parse() {
        throw new Error('provider should not be called for invalid input');
      },
    },
  },
});
await withServer(invalidRequestApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: '' }),
  });
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'invalid_request');
});

const rateLimitApp = createLightweaverServer({
  env: { OPENAI_API_KEY: 'test-key' },
  client: {
    responses: {
      async parse() {
        throw Object.assign(new Error('Rate limit'), { status: 429 });
      },
    },
  },
});
await withServer(rateLimitApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower' }),
  });
  assert.equal(response.status, 429);
  assert.equal(body.error.code, 'rate_limited');
});

const emptyResponseApp = createLightweaverServer({
  env: { OPENAI_API_KEY: 'test-key' },
  client: {
    responses: {
      async parse() {
        return { output_parsed: null };
      },
    },
  },
});
await withServer(emptyResponseApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower' }),
  });
  assert.equal(response.status, 502);
  assert.equal(body.error.code, 'empty_response');
});

const serverApp = createLightweaverServer({ env: {} });
await withServer(serverApp, async (baseUrl) => {
  const health = await fetchJson(`${baseUrl}/api/health`);
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { ok: true, app: 'Lightweaver' });

  const spaResponse = await fetch(`${baseUrl}/some/gallery/path`);
  const spaText = await spaResponse.text();
  const expectedIndex = await readFile(join(import.meta.dirname, '..', 'dist', 'index.html'), 'utf8');
  assert.equal(spaResponse.status, 200);
  assert.equal(spaText, expectedIndex);
});
