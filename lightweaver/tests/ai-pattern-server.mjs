import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  AI_PATTERN_TIMEOUT_MS,
  AiPatternDraftSchema,
  buildOpenRouterResponseFormat,
  buildAiPatternInput,
  getAiPatternModel,
  getAiPatternProvider,
  normalizeAiProviderError,
  parseAiPatternDraftText,
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

function findDefaultAnnotation(value) {
  if (!value || typeof value !== 'object') return null;
  if (Object.hasOwn(value, 'default')) return value.default;
  for (const child of Object.values(value)) {
    const match = findDefaultAnnotation(child);
    if (match !== null) return match;
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
assert.equal(getAiPatternModel({}), 'openai/gpt-5.4-mini');
assert.equal(getAiPatternProvider({ AI_PATTERN_PROVIDER: 'anthropic' }), 'anthropic');
assert.equal(getAiPatternProvider({ AI_PATTERN_PROVIDER: 'openrouter' }), 'openrouter');
assert.equal(getAiPatternProvider({ AI_PATTERN_PROVIDER: 'bad-provider' }), 'openrouter');
assert.equal(getAiPatternModel({ AI_PATTERN_ANTHROPIC_MODEL: 'claude-test' }, 'anthropic'), 'claude-test');
assert.equal(getAiPatternModel({ AI_PATTERN_OPENROUTER_MODEL: 'openrouter/test' }, 'openrouter'), 'openrouter/test');

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
assert.equal(findDefaultAnnotation(textFormat), null);
const openRouterFormat = buildOpenRouterResponseFormat();
assert.equal(openRouterFormat.type, 'json_schema');
assert.equal(openRouterFormat.json_schema.name, 'lightweaver_pattern_draft');
assert.equal(openRouterFormat.json_schema.strict, true);

const validDraft = {
  name: 'Length Check',
  description: 'Checks the maximum code length.',
  changeSummary: ['Checked length'],
  palette: ['#000000', '#ffffff'],
  code: 'x'.repeat(4000),
  suggestedParams: [],
  notes: '',
};
assert.equal(AiPatternDraftSchema.safeParse(validDraft).success, true);
assert.equal(AiPatternDraftSchema.safeParse({ ...validDraft, code: 'x'.repeat(4001) }).success, false);
assert.deepEqual(
  parseAiPatternDraftText(`\n\`\`\`json\n${JSON.stringify(validDraft)}\n\`\`\`\n`).suggestedParams,
  {},
);

const providerError = normalizeAiProviderError(Object.assign(new Error('Rate limit'), { status: 429 }));
assert.equal(providerError.status, 429);
assert.equal(providerError.code, 'rate_limited');

const creditError = normalizeAiProviderError(Object.assign(new Error('Insufficient credits'), { status: 402 }));
assert.equal(creditError.status, 402);
assert.equal(creditError.code, 'insufficient_credits');
assert.match(creditError.message, /OpenRouter credits/i);

const modelError = normalizeAiProviderError(Object.assign(new Error('No endpoints found for model'), { status: 404 }));
assert.equal(modelError.status, 404);
assert.equal(modelError.code, 'model_unavailable');
assert.match(modelError.message, /model/i);

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
  const invalid = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: '' }),
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, 'invalid_request');

  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it blue' }),
  });
  assert.equal(response.status, 501);
  assert.equal(body.error.code, 'missing_api_key');
  assert.match(body.error.message, /OPENROUTER_API_KEY/);
});

const missingAnthropicKeyApp = createLightweaverServer({
  env: { AI_PATTERN_PROVIDER: 'anthropic' },
  fetchImpl() {
    throw new Error('provider should not be called without an Anthropic key');
  },
});
await withServer(missingAnthropicKeyApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it blue' }),
  });
  assert.equal(response.status, 501);
  assert.equal(body.error.code, 'missing_api_key');
  assert.match(body.error.message, /ANTHROPIC_API_KEY/);
});

const missingOpenRouterKeyApp = createLightweaverServer({
  env: { AI_PATTERN_PROVIDER: 'openrouter' },
  fetchImpl() {
    throw new Error('provider should not be called without an OpenRouter key');
  },
});
await withServer(missingOpenRouterKeyApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it blue' }),
  });
  assert.equal(response.status, 501);
  assert.equal(body.error.code, 'missing_api_key');
  assert.match(body.error.message, /OPENROUTER_API_KEY/);
});

await withTempRoot(async (rootDir) => {
  let providerFetchCall = null;
  const settingsApp = createLightweaverServer({
    rootDir,
    env: {},
    fetchImpl: async (url, options) => {
      providerFetchCall = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        content: [{
          type: 'text',
          text: JSON.stringify({
            name: 'Saved Claude Draft',
            description: 'Generated with saved server-side settings.',
            changeSummary: ['Used saved Anthropic key'],
            palette: ['#00ffaa', '#6600aa'],
            code: 'return hsv(time, 1, 1);',
            suggestedParams: [],
            notes: '',
          }),
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  await withServer(settingsApp, async (baseUrl) => {
    const before = await fetchJson(`${baseUrl}/api/ai/settings`);
    assert.equal(before.response.status, 200);
    assert.equal(before.body.provider, 'openrouter');
    assert.equal(before.body.modelPreset, 'balanced');
    assert.equal(before.body.qualityPreset, 'balanced');
    assert.ok(before.body.modelPresets.some(preset => preset.id === 'creative' && preset.model === 'anthropic/claude-sonnet-4.6'));
    assert.ok(before.body.qualityPresets.some(preset => preset.id === 'showpiece'));
    assert.match(before.body.oauth.callbackUrl, /\/api\/ai\/openrouter\/oauth\/callback$/);
    assert.equal(before.body.oauth.isLocal, true);
    assert.match(before.body.oauth.deploymentMessage, /local/i);
    assert.match(before.body.cost.note, /OpenRouter account credits/i);
    assert.equal(before.body.providers.find(provider => provider.id === 'anthropic').configured, false);

    const saved = await fetchJson(`${baseUrl}/api/ai/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        keys: { anthropic: 'anthropic-secret-test-key' },
      }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.provider, 'anthropic');
    assert.equal(saved.body.providers.find(provider => provider.id === 'anthropic').configured, true);
    assert.equal(JSON.stringify(saved.body).includes('anthropic-secret-test-key'), false);

    const generated = await fetchJson(`${baseUrl}/api/ai/pattern`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'make it smoother' }),
    });
    assert.equal(generated.response.status, 200);
    assert.equal(generated.body.draft.name, 'Saved Claude Draft');
    assert.equal(providerFetchCall.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(providerFetchCall.options.headers['x-api-key'], 'anthropic-secret-test-key');
    assert.equal(providerFetchCall.body.model, 'claude-sonnet-4-20250514');
  });
});

await withTempRoot(async (rootDir) => {
  let openRouterGenerationCall = null;
  const modelSettingsApp = createLightweaverServer({
    rootDir,
    env: {},
    fetchImpl: async (url, options) => {
      openRouterGenerationCall = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              name: 'Creative Preset Draft',
              description: 'Generated with saved model and quality presets.',
              changeSummary: ['Used creative preset'],
              palette: ['#00ffaa', '#6600aa'],
              code: 'return hsv(time, 1, 1);',
              suggestedParams: [],
              notes: '',
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  await withServer(modelSettingsApp, async (baseUrl) => {
    const saved = await fetchJson(`${baseUrl}/api/ai/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter',
        keys: { openrouter: 'openrouter-saved-model-key' },
        modelPreset: 'creative',
        qualityPreset: 'showpiece',
      }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.modelPreset, 'creative');
    assert.equal(saved.body.qualityPreset, 'showpiece');
    assert.equal(JSON.stringify(saved.body).includes('openrouter-saved-model-key'), false);

    const generated = await fetchJson(`${baseUrl}/api/ai/pattern`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'make a more dimensional color journey' }),
    });
    assert.equal(generated.response.status, 200);
    assert.equal(generated.body.draft.name, 'Creative Preset Draft');
    assert.equal(openRouterGenerationCall.body.model, 'anthropic/claude-sonnet-4.6');
    assert.match(openRouterGenerationCall.body.messages[0].content, /showpiece/i);
    assert.match(openRouterGenerationCall.body.messages[0].content, /layered/i);
  });
});

await withTempRoot(async (rootDir) => {
  let connectionTestCall = null;
  const connectionTestApp = createLightweaverServer({
    rootDir,
    env: {},
    fetchImpl: async (url, options) => {
      connectionTestCall = { url, options };
      return new Response(JSON.stringify({
        data: {
          label: 'sk-or-v1-test...789',
          usage: 1.25,
          limit: 10,
          limit_remaining: 8.75,
          limit_reset: 'monthly',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  await withServer(connectionTestApp, async (baseUrl) => {
    await fetchJson(`${baseUrl}/api/ai/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter',
        keys: { openrouter: 'openrouter-connection-key' },
        modelPreset: 'budget',
      }),
    });

    const tested = await fetchJson(`${baseUrl}/api/ai/openrouter/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(tested.response.status, 200);
    assert.equal(tested.body.ok, true);
    assert.equal(tested.body.provider, 'openrouter');
    assert.equal(tested.body.model, 'openai/gpt-5-mini');
    assert.equal(tested.body.account.limitRemaining, 8.75);
    assert.equal(connectionTestCall.url, 'https://openrouter.ai/api/v1/key');
    assert.equal(connectionTestCall.options.method, 'GET');
    assert.equal(connectionTestCall.options.headers.authorization, 'Bearer openrouter-connection-key');
    assert.equal(JSON.stringify(tested.body).includes('openrouter-connection-key'), false);
  });
});

await withTempRoot(async (rootDir) => {
  const settingsAuthApp = createLightweaverServer({
    rootDir,
    env: { AI_PATTERN_AUTH_TOKEN: 'settings-secret' },
  });

  await withServer(settingsAuthApp, async (baseUrl) => {
    const unauthorized = await fetchJson(`${baseUrl}/api/ai/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', keys: { anthropic: 'secret' } }),
    });
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.body.error.code, 'unauthorized');

    const authorized = await fetchJson(`${baseUrl}/api/ai/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-lightweaver-ai-token': 'settings-secret' },
      body: JSON.stringify({ provider: 'openrouter', keys: { openrouter: 'router-secret' } }),
    });
    assert.equal(authorized.response.status, 200);
    assert.equal(authorized.body.provider, 'openrouter');
  });
});

await withTempRoot(async (rootDir) => {
  let exchangeCall = null;
  const oauthApp = createLightweaverServer({
    rootDir,
    env: {},
    fetchImpl: async (url, options) => {
      exchangeCall = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ key: 'sk-or-oauth-test-key' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await withServer(oauthApp, async (baseUrl) => {
    const started = await fetchJson(`${baseUrl}/api/ai/openrouter/oauth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: `${baseUrl}/#screen=pattern` }),
    });
    assert.equal(started.response.status, 200);
    const authUrl = new URL(started.body.authorizationUrl);
    assert.equal(`${authUrl.origin}${authUrl.pathname}`, 'https://openrouter.ai/auth');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authUrl.searchParams.get('code_challenge'));
    const callbackUrl = new URL(authUrl.searchParams.get('callback_url'));
    const state = callbackUrl.searchParams.get('state');
    assert.ok(state);

    const callbackResponse = await fetch(`${baseUrl}/api/ai/openrouter/oauth/callback?code=oauth-code&state=${state}`, {
      redirect: 'manual',
    });
    assert.equal(callbackResponse.status, 302);
    assert.equal(callbackResponse.headers.get('location'), `${baseUrl}/#screen=pattern&aiSetup=connected`);
    assert.equal(exchangeCall.url, 'https://openrouter.ai/api/v1/auth/keys');
    assert.equal(exchangeCall.body.code, 'oauth-code');
    assert.equal(exchangeCall.body.code_challenge_method, 'S256');
    assert.ok(exchangeCall.body.code_verifier);

    const settings = await fetchJson(`${baseUrl}/api/ai/settings`);
    assert.equal(settings.body.provider, 'openrouter');
    assert.equal(settings.body.providers.find(provider => provider.id === 'openrouter').configured, true);
    assert.equal(JSON.stringify(settings.body).includes('sk-or-oauth-test-key'), false);
  });
});

let authMissingProviderCalls = 0;
const authMissingApp = createLightweaverServer({
  env: { AI_PATTERN_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', AI_PATTERN_AUTH_TOKEN: 'shared-secret' },
  client: {
    responses: {
      async parse() {
        authMissingProviderCalls += 1;
        return { output_parsed: null };
      },
    },
  },
});
await withServer(authMissingApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower' }),
  });
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'unauthorized');
  assert.equal(authMissingProviderCalls, 0);

  const wrongToken = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower' }),
  });
  assert.equal(wrongToken.response.status, 401);
  assert.equal(wrongToken.body.error.code, 'unauthorized');
  assert.equal(authMissingProviderCalls, 0);
});

let bearerAuthCalls = 0;
const bearerAuthApp = createLightweaverServer({
  env: { AI_PATTERN_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', AI_PATTERN_AUTH_TOKEN: 'shared-secret' },
  client: {
    responses: {
      async parse() {
        bearerAuthCalls += 1;
        return {
          output_parsed: {
            name: 'Authorized Draft',
            description: 'Generated with bearer auth.',
            changeSummary: ['Authorized'],
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
await withServer(bearerAuthApp, async (baseUrl) => {
  const { response } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { authorization: 'Bearer shared-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower' }),
  });
  assert.equal(response.status, 200);
  assert.equal(bearerAuthCalls, 1);
});

let headerAuthCalls = 0;
const headerAuthApp = createLightweaverServer({
  env: { AI_PATTERN_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', AI_PATTERN_AUTH_TOKEN: 'shared-secret' },
  client: {
    responses: {
      async parse() {
        headerAuthCalls += 1;
        return {
          output_parsed: {
            name: 'Header Authorized Draft',
            description: 'Generated with header auth.',
            changeSummary: ['Authorized'],
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
await withServer(headerAuthApp, async (baseUrl) => {
  const { response } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'x-lightweaver-ai-token': 'shared-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower' }),
  });
  assert.equal(response.status, 200);
  assert.equal(headerAuthCalls, 1);
});

let successCall = null;
const successApp = createLightweaverServer({
  env: { AI_PATTERN_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', AI_PATTERN_MODEL: 'gpt-5.5' },
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

let anthropicFetchCall = null;
const anthropicApp = createLightweaverServer({
  env: {
    AI_PATTERN_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    AI_PATTERN_ANTHROPIC_MODEL: 'claude-test-model',
  },
  fetchImpl: async (url, options) => {
    anthropicFetchCall = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      content: [{
        type: 'text',
        text: JSON.stringify({
          name: 'Claude Aurora',
          description: 'Generated by Claude.',
          changeSummary: ['Routed through Anthropic'],
          palette: ['#00ffaa', '#6600aa'],
          code: 'return hsv(time, 1, 1);',
          suggestedParams: [{ name: 'speed', value: 0.1 }],
          notes: '',
        }),
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
await withServer(anthropicApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower' }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.draft.name, 'Claude Aurora');
  assert.equal(body.draft.suggestedParams.speed, 0.1);
  assert.equal(anthropicFetchCall.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropicFetchCall.options.headers['x-api-key'], 'anthropic-test-key');
  assert.equal(anthropicFetchCall.options.headers['anthropic-version'], '2023-06-01');
  assert.equal(anthropicFetchCall.body.model, 'claude-test-model');
  assert.match(anthropicFetchCall.body.system, /Lightweaver pattern draft generator/);
});

let openRouterFetchCall = null;
const openRouterApp = createLightweaverServer({
  env: {
    AI_PATTERN_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'openrouter-test-key',
    AI_PATTERN_OPENROUTER_MODEL: 'anthropic/claude-test',
  },
  fetchImpl: async (url, options) => {
    openRouterFetchCall = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            name: 'OpenRouter Aurora',
            description: 'Generated by OpenRouter.',
            changeSummary: ['Routed through OpenRouter'],
            palette: ['#00ffaa', '#6600aa'],
            code: 'return hsv(time, 1, 1);',
            suggestedParams: [],
            notes: '',
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
await withServer(openRouterApp, async (baseUrl) => {
  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openrouter', instruction: 'make it slower' }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.draft.name, 'OpenRouter Aurora');
  assert.equal(openRouterFetchCall.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(openRouterFetchCall.options.headers.authorization, 'Bearer openrouter-test-key');
  assert.equal(openRouterFetchCall.body.model, 'anthropic/claude-test');
  assert.equal(openRouterFetchCall.body.response_format.type, 'json_schema');
});

let draftSanitizationCall = null;
const manyParams = {
  speed: 0.5,
  enabled: true,
  label: 'fast',
  missing: null,
  nested: { secret: 'nested-secret' },
  ['x'.repeat(49)]: 1,
  longString: 'x'.repeat(121),
};
for (let index = 0; index < 35; index += 1) {
  manyParams[`p${index}`] = index;
}
const draftSanitizationApp = createLightweaverServer({
  env: { AI_PATTERN_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' },
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
        params: manyParams,
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
  assert.equal(providerUserInput.draftPattern.params['x'.repeat(49)], undefined);
  assert.equal(providerUserInput.draftPattern.params.longString, undefined);
  assert.equal(providerUserInput.draftPattern.params.p27, 27);
  assert.equal(providerUserInput.draftPattern.params.p28, undefined);
  assert.equal(Object.keys(providerUserInput.draftPattern.params).length, 32);
});

const invalidRequestApp = createLightweaverServer({
  env: { AI_PATTERN_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' },
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
  env: { AI_PATTERN_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' },
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

let endpointRateLimitCalls = 0;
const endpointRateLimitApp = createLightweaverServer({
  env: {
    AI_PATTERN_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-key',
    AI_PATTERN_RATE_LIMIT: '2',
    AI_PATTERN_RATE_WINDOW_MS: '600000',
  },
  client: {
    responses: {
      async parse() {
        endpointRateLimitCalls += 1;
        return {
          output_parsed: {
            name: 'Limited Draft',
            description: 'Counts endpoint calls.',
            changeSummary: ['Counted'],
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
await withServer(endpointRateLimitApp, async (baseUrl) => {
  for (let index = 0; index < 2; index += 1) {
    const { response } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: `make it slower ${index}` }),
    });
    assert.equal(response.status, 200);
  }

  const { response, body } = await fetchJson(`${baseUrl}/api/ai/pattern`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: 'make it slower again' }),
  });
  assert.equal(response.status, 429);
  assert.equal(body.error.code, 'rate_limited');
  assert.equal(endpointRateLimitCalls, 2);
});

const refusalApp = createLightweaverServer({
  env: { AI_PATTERN_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' },
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
  env: { AI_PATTERN_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' },
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
  env: { AI_PATTERN_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' },
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
