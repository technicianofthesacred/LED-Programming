import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

async function withTempRoot(callback) {
  const rootDir = await mkdtemp(join(tmpdir(), 'lightweaver-server-test-'));

  try {
    return await callback(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
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
  assert.equal(successCall.options.maxRetries, 0);
});

let draftSanitizationCall = null;
const draftSanitizationApp = createLightweaverServer({
  env: { OPENAI_API_KEY: 'test-key' },
  client: {
    responses: {
      async parse(payload) {
        draftSanitizationCall = payload;
        return {
          output_parsed: {
            name: 'Refined Draft',
            description: 'A refined pattern.',
            changeSummary: ['Adjusted draft'],
            palette: ['#00ffaa', '#6600aa'],
            code: 'return hsv(time, 1, 1);',
            suggestedParams: [],
            notes: '',
          },
        };
      },
    },
  },
});
await withServer(draftSanitizationApp, async (baseUrl) => {
  const { response } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'refine',
      instruction: 'clean up this draft',
      secret: 'top-level-secret',
      draftPattern: {
        id: 'draft-1',
        name: 'Draft One',
        description: 'Allowed description',
        code: 'return rgb(1,0,0);',
        palette: ['#ff0000', '#000000'],
        params: {
          speed: 0.5,
          enabled: true,
          label: 'fast',
          missing: null,
          nested: { secret: 'nested-secret' },
        },
        isCustom: true,
        secret: 'draft-secret',
      },
    }),
  });
  assert.equal(response.status, 200);
  const providerUserInput = JSON.parse(draftSanitizationCall.input[1].content);
  assert.equal(providerUserInput.secret, undefined);
  assert.equal(providerUserInput.draftPattern.secret, undefined);
  assert.equal(providerUserInput.draftPattern.id, 'draft-1');
  assert.equal(providerUserInput.draftPattern.name, 'Draft One');
  assert.equal(providerUserInput.draftPattern.description, 'Allowed description');
  assert.equal(providerUserInput.draftPattern.params.speed, 0.5);
  assert.equal(providerUserInput.draftPattern.params.enabled, true);
  assert.equal(providerUserInput.draftPattern.params.label, 'fast');
  assert.equal(providerUserInput.draftPattern.params.missing, null);
  assert.equal(providerUserInput.draftPattern.params.nested, undefined);
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

const refusalApp = createLightweaverServer({
  env: { OPENAI_API_KEY: 'test-key' },
  client: {
    responses: {
      async parse() {
        return {
          output: [
            {
              content: [
                {
                  type: 'refusal',
                  refusal: 'I cannot help with that request.',
                },
              ],
            },
          ],
          output_parsed: null,
        };
      },
    },
  },
});
await withServer(refusalApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower' }),
  });
  assert.equal(response.status, 422);
  assert.equal(body.error.code, 'refused');
});

const incompleteApp = createLightweaverServer({
  env: { OPENAI_API_KEY: 'test-key' },
  client: {
    responses: {
      async parse() {
        return {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output_parsed: null,
        };
      },
    },
  },
});
await withServer(incompleteApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower' }),
  });
  assert.equal(response.status, 502);
  assert.equal(body.error.code, 'incomplete');
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

await withTempRoot(async (rootDir) => {
  const distDir = join(rootDir, 'dist');
  const indexHtml = '<!doctype html><title>Lightweaver test fixture</title>';
  await mkdir(distDir);
  await writeFile(join(distDir, 'index.html'), indexHtml);
  const serverApp = createLightweaverServer({ rootDir, env: {} });

  await withServer(serverApp, async (baseUrl) => {
    const health = await fetchJson(`${baseUrl}/api/health`);
    assert.equal(health.response.status, 200);
    assert.deepEqual(health.body, { ok: true, app: 'Lightweaver' });

    const apiNotFound = await fetchJson(`${baseUrl}/api/nope`);
    assert.equal(apiNotFound.response.status, 404);
    assert.equal(apiNotFound.body.error.code, 'not_found');

    const invalidJson = await fetchJson(`${baseUrl}/api/ai/pattern`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"instruction":',
    });
    assert.equal(invalidJson.response.status, 400);
    assert.equal(invalidJson.body.error.code, 'invalid_json');

    const spaResponse = await fetch(`${baseUrl}/some/gallery/path`);
    const spaText = await spaResponse.text();
    assert.equal(spaResponse.status, 200);
    assert.equal(spaText, indexHtml);
  });
});

await withTempRoot(async (rootDir) => {
  const serverApp = createLightweaverServer({ rootDir, env: {} });

  await withServer(serverApp, async (baseUrl) => {
    const missingDistResponse = await fetch(`${baseUrl}/some/gallery/path`);
    const missingDistText = await missingDistResponse.text();
    assert.equal(missingDistResponse.status, 404);
    assert.match(missingDistText, /Lightweaver dist\/ not found/);
  });
});

const serverApp = createLightweaverServer({ env: {} });
await withServer(serverApp, async (baseUrl) => {
  const health = await fetchJson(`${baseUrl}/api/health`);
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { ok: true, app: 'Lightweaver' });

  const apiNotFound = await fetchJson(`${baseUrl}/api/nope`);
  assert.equal(apiNotFound.response.status, 404);
  assert.equal(apiNotFound.body.error.code, 'not_found');

  const invalidJson = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"instruction":',
  });
  assert.equal(invalidJson.response.status, 400);
  assert.equal(invalidJson.body.error.code, 'invalid_json');
});
