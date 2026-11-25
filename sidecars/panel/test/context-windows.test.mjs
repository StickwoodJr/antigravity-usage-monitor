import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  createContextWindowSyncExpression,
  getContextWindowModels,
  isContextWindowOption,
  isContextWindowSettingId,
  resolveContextWindowRules,
} from '../backend/context-windows.mjs';
import {
  createCloudCodeProxyController,
  detectSystemHttpsProxy,
  extractUpstreamCheckpointDefaults,
  getDefaultCloudCodeProxyStatus,
  isValidUpstreamCloudCodeUrl,
  reconcileDefaultCloudCodeProxy,
  rewriteFetchAvailableModelsPayload,
  stopDefaultCloudCodeProxy,
} from '../backend/cloudcode-proxy.mjs';
import { createWindowBridgeController } from '../backend/window-bridge.mjs';
import { backendHarness } from './backend-harness.mjs';
import { createMockDom } from './mock-dom.mjs';

const argon = 'MODEL_PLACEHOLDER_M430';
const flash = 'MODEL_PLACEHOLDER_M431';
const other = 'MODEL_PLACEHOLDER_M432';
const carbon = 'MODEL_PLACEHOLDER_M427';
const carbonLow = 'MODEL_PLACEHOLDER_M438';
const newCarbonLow = 'MODEL_PLACEHOLDER_M439';
const carbonGroup = 'model:gemini-4-carbon';
const availableModels = {
  'gemini-4-carbon-high': { model: carbon, maxTokens: 1048576, maxOutputTokens: 262144 },
  'gemini-4-carbon-low': { model: carbonLow, maxTokens: 700000, maxOutputTokens: 64000 },
  'gemini-other': { model: other, maxTokens: 250000, maxOutputTokens: 64000 },
};
const carbonModels = [
  { label: 'Gemini 4 Carbon (High)', modelId: 'gemini-4-carbon-high', modelOrAlias: { model: carbon } },
  { label: 'Gemini 4 Carbon (Low)', modelId: 'gemini-4-carbon-low', modelOrAlias: { model: carbonLow } },
];

test('saves and restores one model at a time using host presets or verified model capacity', async () => {
  const h = backendHarness({
    settings: { contextLimitOverrideTokens: 900000 },
    availableModels,
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Argon', modelOrAlias: { model: argon },
            contextWindowOptions: [{ name: '512K' }, { name: '900K', expensive: true }] },
          { label: 'Flash', modelOrAlias: { model: flash }, contextWindowOptions: [{ name: '256K' }] },
          { label: 'Other', modelOrAlias: { model: other } },
          ...carbonModels,
        ],
      },
    },
  });
  const update = h.executeModelContextWindowAction;
  const { contextWindowModels } = await h.buildTelemetryPayloadInternal('');
  const [argonModel, flashModel, otherModel, carbonModel] = JSON.parse(JSON.stringify(contextWindowModels));
  assert.deepEqual(argonModel.options, [{ name: '512K', expensive: false }, { name: '900K', expensive: true }]);
  assert.deepEqual(flashModel.options, [{ name: '256K', expensive: false }]);
  assert.deepEqual(otherModel.options.map(({ tokens }) => tokens), [128000, 186000]);
  assert.equal(carbonModel.id, carbonGroup);
  assert.equal(carbonModel.label, 'Gemini 4 Carbon');
  assert.deepEqual(carbonModel.members, [carbon, carbonLow]);
  assert.deepEqual(carbonModel.options.map(({ tokens }) => tokens), [128000, 256000, 384000, 512000, 636000]);
  assert.equal((await update({ modelId: carbonGroup, option: '768000' })).status, 400);
  h.state.settings.modelContextWindows = { [carbon]: '768000', [carbonLow]: '256000' };
  assert.equal((await update({ modelId: carbonGroup, option: '384000' })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [carbonGroup]: '384000' });
  assert.equal((await update({ modelId: carbonGroup, option: '512000' })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [carbonGroup]: '512000' });
  assert.equal((await update({ modelId: carbonGroup, option: null })).status, 200);
  assert.equal((await update({ modelId: flash, option: '900K' })).status, 400);
  assert.equal((await update({ modelId: other, option: '900K' })).status, 400);
  assert.equal((await update({ modelId: '__proto__', option: null })).status, 400);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, {});

  const [a, b] = await Promise.all([
    update({ modelId: argon, option: '900K' }),
    update({ modelId: flash, option: '256K' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [argon]: '900K', [flash]: '256K' });
  assert.equal((await update({ modelId: argon, option: null })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [flash]: '256K' });
  h.executeResetSettingsAction();
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, {});
});

test('reports the latest observed threshold separately from the saved group preference', async () => {
  const h = backendHarness({
    availableModels,
    settings: { modelContextWindows: { [carbonGroup]: '512000' } },
    userStatus: { cascadeModelConfigData: { clientModelConfigs: carbonModels } },
    summaries: { active: { stepCount: 1, lastModifiedTime: '2026-01-01T00:00:01Z', status: 'IDLE' } },
    trajectories: {
      active: { trajectory: {
        steps: [{ metadata: {
          createdAt: '2026-01-01T00:00:00Z',
          finishedGeneratingAt: '2026-01-01T00:00:01Z',
          modelUsage: { model: carbonLow, inputTokens: 20, outputTokens: 20 },
        }, plannerResponse: { response: 'ok' } }],
        generatorMetadata: [{ stepIndices: [0], chatModel: {
          chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } },
        } }],
      } },
    },
  });
  const result = await h.buildTelemetryPayloadInternal('active');
  assert.equal(result.contextWindowModels.find(({ id }) => id === carbonGroup).reportedLimitTokens, 256000);
  assert.equal(result.settings.modelContextWindows[carbonGroup], '512000');
  const previouslyCached = h.state.saves.find(({ data }) => data.active?.contextLimitTelemetry).data.active;
  const cached = structuredClone(previouslyCached);
  delete cached.contextLimitTelemetry;
  delete cached.steps[0].reportedContextLimitTokens;
  const upgraded = backendHarness({
    availableModels,
    userStatus: h.state.userStatus,
    cache: { active: cached },
    summaries: { active: { stepCount: 1, lastModifiedTime: '2026-01-01T00:00:01Z', status: 'IDLE' } },
    trajectories: h.state.trajectories,
  });
  const reloaded = await upgraded.buildTelemetryPayloadInternal('active');
  assert.equal(reloaded.contextWindowModels[0].reportedLimitTokens, 256000);
});

test('host requests apply a rule only to the exact model across App and IDE transports', async () => {
  const sendPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
  const statusPath = sendPath.replace('SendUserCascadeMessage', 'GetUserStatus');
  const host = 'https://127.0.0.1:25190';
  let catalog = availableModels;
  let variants = carbonModels;
  const nativeFetch = async (url, init) => {
    if (url === host + statusPath.replace('GetUserStatus', 'GetAvailableModels')) {
      return { ok: true, json: async () => ({ response: { models: catalog } }) };
    }
    if (url !== host + statusPath || init.body !== '{}') return init;
    assert.equal(init.headers['x-codeium-csrf-token'], 'local-test');
    return { ok: true, json: async () => ({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [
      { modelOrAlias: { model: argon }, contextWindowOptions: [{ name: '900K' }] },
      { modelOrAlias: { model: flash }, contextWindowOptions: [{ name: '256K' }] },
      ...variants,
      { modelOrAlias: { model: other } },
    ] } } }) };
  };
  class WebSocket {
    constructor(url) { this.url = url; }
    send(data) { return data; }
  }
  const nativeSend = WebSocket.prototype.send;
  const window = { location: new URL(host), fetch: nativeFetch, WebSocket, __APP_CONFIG__: { csrfToken: 'local-test' } };
  const context = vm.createContext({ window, URL, TextEncoder, TextDecoder, Headers, Uint8Array, AbortSignal, setTimeout, clearTimeout });
  const install = (rules, boot = 'first') => vm.runInContext(createContextWindowSyncExpression(rules, boot), context);
  const request = (model) => ({
    cascadeId: 'conversation-1',
    items: [{ text: 'Keep the request intact' }],
    cascadeConfig: {
      plannerConfig: { planModel: model },
      checkpointConfig: { maxTokenLimit: 128000, checkpointIntervalTokens: 20000 },
    },
  });
  const options = (body, type = 'application/json') => ({
    method: 'POST', headers: { 'Content-Type': type }, body,
  });
  const preferences = { [argon]: '900K', [flash]: '900K', [carbonGroup]: '512000', [other]: '512000' };
  await install(preferences);
  try {
    const payload = request(argon);
    const input = options(JSON.stringify(payload));
    const edited = JSON.parse((await window.fetch(host + sendPath, input)).body);
    assert.deepEqual(edited, {
      ...payload,
      cascadeConfig: {
        ...payload.cascadeConfig,
        checkpointConfig: { contextWindow: '900K', checkpointIntervalTokens: 20000 },
      },
    });
    const untouched = options(JSON.stringify(request(flash)));
    assert.equal(await window.fetch(host + sendPath, untouched), untouched);
    const lowCapacity = options(JSON.stringify(request(other)));
    assert.equal(await window.fetch(host + sendPath, lowCapacity), lowCapacity);
    const carbonPayload = request(carbon);
    carbonPayload.cascadeConfig.checkpointConfig.contextWindow = 'default';
    const carbonBody = (await window.fetch(host + sendPath, options(JSON.stringify(carbonPayload)))).body;
    assert.deepEqual(JSON.parse(carbonBody).cascadeConfig.checkpointConfig,
      { maxTokenLimit: 512000, checkpointIntervalTokens: 20000 });
    const lowPayload = options(JSON.stringify(request(carbonLow)));
    assert.equal(JSON.parse((await window.fetch(host + sendPath, lowPayload)).body).cascadeConfig.checkpointConfig.maxTokenLimit, 512000);
    assert.equal(await window.fetch('https://127.0.0.1:25191' + sendPath, input), input);
    assert.equal(await window.fetch(host + statusPath, input), input);

    const frame = Buffer.alloc(5 + Buffer.byteLength(input.body));
    frame.writeUInt32BE(frame.length - 5, 1);
    frame.write(input.body, 5);
    const framed = await window.fetch(host + sendPath, options(frame, 'application/grpc-web+json'));
    assert.equal(Buffer.from(framed.body).readUInt32BE(1), framed.body.length - 5);
    assert.deepEqual(JSON.parse(Buffer.from(framed.body.subarray(5)).toString()), edited);

    const socket = new WebSocket('wss://127.0.0.1:25190/connect-websocket');
    const msg = { type: 'start', stream: false, procedure: sendPath, streamId: 'request-1', payload };
    assert.deepEqual(JSON.parse(socket.send(JSON.stringify(msg))), { ...msg, payload: edited });
    const unrelated = JSON.stringify({ ...msg, payload: request(flash) });
    assert.equal(socket.send(unrelated), unrelated);
    const external = new WebSocket('wss://127.0.0.1:25191/connect-websocket');
    assert.equal(external.send(JSON.stringify(msg)), JSON.stringify(msg));

    const firstHook = window.fetch;
    variants = [carbonModels[0], { ...carbonModels[1], modelOrAlias: { model: newCarbonLow } }];
    catalog = { ...availableModels, 'gemini-4-carbon-low': { ...availableModels['gemini-4-carbon-low'], model: newCarbonLow } };
    await install(preferences, 'second');
    assert.notEqual(window.fetch, firstHook);
    assert.equal(await window.fetch(host + sendPath, lowPayload), lowPayload);
    window.fetch = nativeFetch;
    await install(preferences, 'second');
    const newLowPayload = options(JSON.stringify(request(newCarbonLow)));
    assert.equal(JSON.parse((await window.fetch(host + sendPath, newLowPayload)).body).cascadeConfig.checkpointConfig.maxTokenLimit, 512000);

    catalog['gemini-4-carbon-low'] = { model: newCarbonLow, maxTokens: 300000, maxOutputTokens: 64000 };
    await install(preferences, 'third');
    assert.equal(await window.fetch(host + sendPath, newLowPayload), newLowPayload);
    assert.equal(await window.fetch(host + sendPath, options(JSON.stringify(carbonPayload))).then(({ body }) => body), JSON.stringify(carbonPayload));
  } finally {
    await install({});
  }
  assert.equal(window.fetch, nativeFetch);
  assert.equal(WebSocket.prototype.send, nativeSend);
});

test('Issue #27: syncHostContextWindows falls back to backend pre-resolved rules without __APP_CONFIG__.csrfToken and intercepts StartCascade + Uint8Array / connect+json frames', async () => {
  const sendPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
  const startPath = '/exa.language_server_pb.LanguageServerService/StartCascade';
  const host = 'https://127.0.0.1:26190';
  const nativeFetch = async (_url, init) => init;
  class WebSocket {
    constructor(url) {
      this.url = url;
    }
    send(data) {
      return data;
    }
  }
  const window = {
    location: new URL(host),
    fetch: nativeFetch,
    WebSocket,
    __APP_CONFIG__: {}, // Simulate 2.33.0+ environment without exposed csrfToken on window
  };
  const context = vm.createContext({
    window,
    URL,
    TextEncoder,
    TextDecoder,
    Headers,
    Uint8Array,
    AbortSignal,
    setTimeout,
    clearTimeout,
  });

  const prefs = { [carbonGroup]: '256000' };
  const fallbackRules = { [carbon]: 256000, [carbonLow]: 256000 };
  const syncResult = await vm.runInContext(
    createContextWindowSyncExpression(prefs, 'boot-233', fallbackRules),
    context
  );
  assert.deepEqual({ ...syncResult }, { attached: true, ruleCount: 2 });

  try {
    // 1. StartCascade on new conversation creation with Uint8Array JSON body
    const startPayload = {
      cascadeConfig: {
        plannerConfig: { planModel: carbon },
        checkpointConfig: { maxTokenLimit: 512000 },
      },
    };
    const uint8Body = new TextEncoder().encode(JSON.stringify(startPayload));
    const startOut = await window.fetch(new URL(host + startPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: uint8Body,
    });
    assert.equal(startOut.body instanceof Uint8Array, true);
    assert.equal(
      JSON.parse(new TextDecoder().decode(startOut.body)).cascadeConfig.checkpointConfig
        .maxTokenLimit,
      256000
    );

    // 2. application/connect+json 5-byte envelope on SendUserCascadeMessage
    const msgBytes = Buffer.from(JSON.stringify(startPayload), 'utf8');
    const connectFrame = new Uint8Array(5 + msgBytes.length);
    new DataView(connectFrame.buffer).setUint32(1, msgBytes.length);
    connectFrame.set(msgBytes, 5);
    const framedOut = await window.fetch(host + sendPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/connect+json' },
      body: connectFrame,
    });
    const decodedJson = JSON.parse(
      new TextDecoder().decode(framedOut.body.subarray(5))
    );
    assert.equal(decodedJson.cascadeConfig.checkpointConfig.maxTokenLimit, 256000);

    // 3. WebSocket StartCascade frame
    const ws = new WebSocket('wss://127.0.0.1:26190/connect-websocket');
    const wsFrame = JSON.parse(
      ws.send(
        JSON.stringify({
          type: 'start',
          stream: false,
          procedure: startPath,
          payload: startPayload,
        })
      )
    );
    assert.equal(wsFrame.payload.cascadeConfig.checkpointConfig.maxTokenLimit, 256000);
  } finally {
    await vm.runInContext(createContextWindowSyncExpression({}, 'boot-233', {}), context);
  }
  assert.equal(window.fetch, nativeFetch);
});

test('cloudcode-proxy validates upstream URLs and rewrites checkpointer experiments cleanly', () => {
  assert.equal(isValidUpstreamCloudCodeUrl('https://daily-cloudcode-pa.googleapis.com'), true);
  assert.equal(isValidUpstreamCloudCodeUrl('https://cloudcode-pa.googleapis.com'), true);
  assert.equal(isValidUpstreamCloudCodeUrl('http://127.0.0.1:18148'), false);
  assert.equal(isValidUpstreamCloudCodeUrl('https://127.0.0.1:18148'), false);
  assert.equal(isValidUpstreamCloudCodeUrl('https://localhost:443'), false);
  assert.equal(isValidUpstreamCloudCodeUrl('http://daily-cloudcode-pa.googleapis.com'), false);

  const payload = {
    models: {
      'gemini-4-carbon-high': {
        model: carbon,
        maxTokens: 1048576,
        maxOutputTokens: 32768,
        ignoreExperiments: ['CASCADE_USE_EXPERIMENT_CHECKPOINTER', 'checkpoint-variant', 'unrelated-flag'],
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({
                strategy: 'CHECKPOINT_STRATEGY_SAME_MODEL',
                max_token_limit: '512000',
                max_output_tokens: '32768',
              }),
            },
            'CASCADE_USE_EXPERIMENT_CHECKPOINTER/claude-1m_840k': {
              stringValue: JSON.stringify({ max_token_limit: '840000' }),
            },
          },
        },
      },
      'argon-named': {
        model: argon,
        maxTokens: 1048576,
        maxOutputTokens: 32768,
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({ max_token_limit: '256000' }),
            },
            'CASCADE_USE_EXPERIMENT_CHECKPOINTER/context-window_900K': {
              stringValue: JSON.stringify({ max_token_limit: '900000', enabled: true }),
            },
          },
        },
      },
      'untouched-flash': {
        model: flash,
        maxTokens: 1048576,
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({ max_token_limit: '128000' }),
            },
          },
        },
      },
    },
  };

  const beforeDefaults = extractUpstreamCheckpointDefaults(payload.models);
  assert.deepEqual(beforeDefaults, { [carbon]: 512000, [argon]: 256000, [flash]: 128000 });

  const res = rewriteFetchAvailableModelsPayload(payload, { [carbon]: 300000, [argon]: '900K' });
  assert.equal(res.modified, true);
  assert.equal(res.applied.length, 2);
  assert.deepEqual(res.defaultsByModelId, { [carbon]: 512000, [argon]: 256000, [flash]: 128000 });

  const carbonMain = JSON.parse(
    payload.models['gemini-4-carbon-high'].modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER
      .stringValue
  );
  const carbonVariant = JSON.parse(
    payload.models['gemini-4-carbon-high'].modelExperiments.experiments[
      'CASCADE_USE_EXPERIMENT_CHECKPOINTER/claude-1m_840k'
    ].stringValue
  );
  assert.equal(carbonMain.max_token_limit, '300000');
  assert.equal(carbonMain.strategy, 'CHECKPOINT_STRATEGY_SAME_MODEL');
  assert.equal(carbonVariant.max_token_limit, '300000');
  assert.equal(payload.models['gemini-4-carbon-high'].maxTokens, 1048576);
  assert.deepEqual(payload.models['gemini-4-carbon-high'].ignoreExperiments, ['unrelated-flag']);

  const argonMain = JSON.parse(
    payload.models['argon-named'].modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue
  );
  assert.equal(argonMain.max_token_limit, '900000');
  assert.equal(argonMain.enabled, true);

  const flashMain = JSON.parse(
    payload.models['untouched-flash'].modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue
  );
  assert.equal(flashMain.max_token_limit, '128000');
});

test('CloudCode MITM proxy and SetCloudCodeURL are hard-disabled while read-only context-window helpers stay intact', async () => {
  const expectedDisabled = {
    state: 'disabled',
    active: false,
    disabled: true,
    ruleCount: 0,
    appliedModels: [],
    upstreamUrl: '',
    localUrl: '',
    syncedAtMs: 0,
    error: '',
  };

  let sideEffectsCalled = false;
  const proxy = createCloudCodeProxyController({
    allowHttpUpstream: true,
    allowTestEndpoint: true,
    detectUpstreamFn: () => {
      sideEffectsCalled = true;
      return 'https://daily-cloudcode-pa.googleapis.com';
    },
    detectProxyFn: async () => {
      sideEffectsCalled = true;
      return 'http://127.0.0.1:8888';
    },
    getEndpointFn: () => ({ addr: '127.0.0.1:44444', baseUrl: 'http://127.0.0.1:44444', csrfToken: 'tok-1' }),
    callRpcFn: async () => {
      sideEffectsCalled = true;
      throw new Error('SetCloudCodeURL must never be called');
    },
  });

  assert.deepEqual(proxy.getStatus(), expectedDisabled);
  assert.deepEqual(
    await proxy.reconcile({ enabled: true, rulesByModelId: { [carbon]: 300000 } }),
    expectedDisabled
  );
  assert.deepEqual(await proxy.stop(), expectedDisabled);
  assert.equal(sideEffectsCalled, false);

  assert.deepEqual(getDefaultCloudCodeProxyStatus(), expectedDisabled);
  assert.deepEqual(
    await reconcileDefaultCloudCodeProxy({ enabled: true, rulesByModelId: { [carbon]: 300000 } }),
    expectedDisabled
  );
  assert.deepEqual(await stopDefaultCloudCodeProxy(), expectedDisabled);

  // Windows registry `reg query` proxy lookup is removed; win32 without env proxy returns ''
  assert.equal(
    await detectSystemHttpsProxy('daily-cloudcode-pa.googleapis.com', { env: {}, platform: 'win32' }),
    ''
  );
  assert.equal(
    await detectSystemHttpsProxy('daily-cloudcode-pa.googleapis.com', {
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      platform: 'win32',
    }),
    'http://127.0.0.1:7890'
  );

  // Read-only context-windows catalog/schema helpers continue working
  assert.equal(isContextWindowSettingId(carbon), true);
  assert.equal(isContextWindowSettingId(carbonGroup), true);
  assert.equal(isContextWindowOption('512K'), true);
  assert.equal(isContextWindowOption('default'), false);
  const parsedModels = getContextWindowModels(carbonModels, availableModels);
  assert.deepEqual(resolveContextWindowRules(parsedModels, { [carbonGroup]: '512000' }), {
    [carbon]: 512000,
    [carbonLow]: 512000,
  });

  // Verify neither cloudcode-proxy.mjs nor context-windows.mjs references SetCloudCodeURL, createServer, or reg query
  const proxySrc = readFileSync(new URL('../backend/cloudcode-proxy.mjs', import.meta.url), 'utf8');
  const ctxSrc = readFileSync(new URL('../backend/context-windows.mjs', import.meta.url), 'utf8');
  assert.equal(proxySrc.includes('SetCloudCodeURL'), false);
  assert.equal(proxySrc.includes('createServer'), false);
  assert.equal(proxySrc.includes('reg query'), false);
  assert.equal(ctxSrc.includes('SetCloudCodeURL'), false);
});

test('independent Main Agent & Subagents/Swarm switches persist, pin back main defaults, and keep CloudCode MITM proxy disabled', async () => {
  // 1. Settings defaults, persistence, telemetry exposure, and factory reset
  const h = backendHarness({
    availableModels,
    userStatus: { cascadeModelConfigData: { clientModelConfigs: carbonModels } },
  });
  const initSettings = h.loadSettings();
  assert.equal(initSettings.contextWindowMainEnabled, false);
  assert.equal(initSettings.contextWindowSwarmEnabled, false);

  const patchRes = h.executeSettingsAction({
    contextWindowMainEnabled: true,
    contextWindowSwarmEnabled: true,
  });
  assert.equal(patchRes.status, 200);
  assert.equal(h.loadSettings().contextWindowMainEnabled, true);
  assert.equal(h.loadSettings().contextWindowSwarmEnabled, true);

  const tele = await h.buildTelemetryPayloadInternal('');
  assert.equal(tele.settings.contextWindowMainEnabled, true);
  assert.equal(tele.settings.contextWindowSwarmEnabled, true);
  assert.equal(tele.cloudCodeProxy.state, 'disabled');
  assert.equal(tele.cloudCodeProxy.active, false);
  assert.equal(tele.cloudCodeProxy.disabled, true);

  h.executeResetSettingsAction();
  assert.equal(h.loadSettings().contextWindowMainEnabled, false);
  assert.equal(h.loadSettings().contextWindowSwarmEnabled, false);

  // 2. syncHostContextWindows pin-back mode overrides preferences with upstream default even when csrfToken exists
  const sendPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
  const host = 'https://127.0.0.1:26195';
  const nativeFetch = async (_url, init) => init;
  class WebSocket {
    constructor(url) {
      this.url = url;
    }
    send(data) {
      return data;
    }
  }
  const win = {
    location: new URL(host),
    fetch: nativeFetch,
    WebSocket,
    __APP_CONFIG__: { csrfToken: 'pin-test-token' },
  };
  const ctx = vm.createContext({
    window: win,
    URL,
    TextEncoder,
    TextDecoder,
    Headers,
    Uint8Array,
    AbortSignal,
    setTimeout,
    clearTimeout,
  });
  try {
    const syncOut = await vm.runInContext(
      createContextWindowSyncExpression(
        { [carbonGroup]: '300000' },
        'pin-boot',
        { [carbon]: 512000 },
        true,
        { [carbon]: 512000 }
      ),
      ctx
    );
    assert.deepEqual({ ...syncOut }, { attached: true, ruleCount: 1 });
    const reqPayload = {
      cascadeConfig: {
        plannerConfig: { planModel: carbon },
        checkpointConfig: {},
      },
    };
    const out = await win.fetch(host + sendPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqPayload),
    });
    assert.equal(
      JSON.parse(out.body).cascadeConfig.checkpointConfig.maxTokenLimit,
      512000,
      'pin-back mode forces main agent back to upstream default limit'
    );
  } finally {
    await vm.runInContext(createContextWindowSyncExpression({}, 'pin-boot', {}, true, null), ctx);
  }
  assert.equal(win.fetch, nativeFetch);

  // 3. Window bridge keeps CloudCode proxy hard-disabled even when Swarm toggle is enabled
  let currentSettings = {
    enableWindowOverlay: false,
    windowMountMode: 'sidebar',
    modelContextWindows: { [carbonGroup]: '300000' },
    contextWindowMainEnabled: false,
    contextWindowSwarmEnabled: true,
  };
  const hardenedProxy = createCloudCodeProxyController({
    callRpcFn: async () => {
      throw new Error('SetCloudCodeURL must never be called');
    },
  });
  const bridgeCtrl = createWindowBridgeController({
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    readAssetFn: async () => '',
    getSettingsFn: () => currentSettings,
    env: {},
    homeDir: '/nonexistent-home-for-test',
    autoConfigureIdeArgv: false,
    cloudCodeProxy: hardenedProxy,
    resolveLocalContextRulesFn: async () => ({
      verified: true,
      rules: { [carbon]: 300000 },
      catalog: availableModels,
    }),
  });
  await bridgeCtrl.syncAllWindows();
  assert.equal(hardenedProxy.getStatus().state, 'disabled');
  assert.equal(hardenedProxy.getStatus().active, false);
  assert.equal(hardenedProxy.getStatus().disabled, true);
  assert.equal(hardenedProxy.getStatus().localUrl, '');

  currentSettings = { ...currentSettings, contextWindowSwarmEnabled: false };
  await bridgeCtrl.syncAllWindows();
  assert.equal(hardenedProxy.getStatus().state, 'disabled');

  await bridgeCtrl.stop();
  assert.equal(hardenedProxy.getStatus().state, 'disabled');
});

test('SettingsOtherTab renders independent Main Agent and Subagents/Swarm switches with live sync feedback', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  const origFetch = globalThis.fetch;
  const savedPatches = [];

  globalThis.document = document;
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:41234', href: 'http://127.0.0.1:41234/' },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/api/settings') && init.method === 'POST') {
      const patch = JSON.parse(init.body || '{}');
      savedPatches.push(patch);
      return { ok: true, json: async () => ({ ...patch }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    const [{ setI18nLanguage }, { SettingsOtherTab }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/views/settings/SettingsOtherTab.js'),
    ]);
    setI18nLanguage('zh-CN');
    const tab = SettingsOtherTab({ onLayoutChange: () => {} });
    const mockModels = [
      {
        id: carbonGroup,
        label: 'Gemini 4 Carbon',
        members: [carbon],
        capacity: 786432,
        options: [{ name: '300000', tokens: 300000 }],
      },
    ];
    tab.refs.renderSettings(
      {
        contextWindowRiskAccepted: true,
        contextWindowMainEnabled: true,
        contextWindowSwarmEnabled: true,
        modelContextWindows: { [carbonGroup]: '300000' },
      },
      mockModels,
      { state: 'active' },
      'win32',
      { state: 'active', active: true, ruleCount: 1, error: '' }
    );

    const statusEl = tab.el.querySelector('.ctx-sync-status');
    assert.ok(statusEl);
    assert.equal(statusEl.hasAttribute('hidden'), true, 'no extra status clutter when active');

    // Toggle Main Agent off -> persists patch
    const mainOffBtn = tab.refs.ctxMainToggle.el.querySelectorAll('button')[1];
    mainOffBtn.dispatchEvent({
      type: 'click',
      target: mainOffBtn,
      currentTarget: mainOffBtn,
      stopPropagation() {},
      preventDefault() {},
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(savedPatches[0], { contextWindowMainEnabled: false });

    // Toggle Subagents & Swarm off -> persists patch
    const swarmOffBtn = tab.refs.ctxSwarmToggle.el.querySelectorAll('button')[1];
    swarmOffBtn.dispatchEvent({
      type: 'click',
      target: swarmOffBtn,
      currentTarget: swarmOffBtn,
      stopPropagation() {},
      preventDefault() {},
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(savedPatches[1], { contextWindowSwarmEnabled: false });

    // Error state surfaces cleanly
    tab.refs.renderSettings(
      {
        contextWindowRiskAccepted: true,
        contextWindowMainEnabled: false,
        contextWindowSwarmEnabled: true,
        modelContextWindows: { [carbonGroup]: '300000' },
      },
      mockModels,
      { state: 'no_devtools_port' },
      'win32',
      { state: 'error', active: false, ruleCount: 1, error: 'gateway pinned' }
    );
    assert.equal(statusEl.hasAttribute('hidden'), false);
    assert.match(statusEl.textContent, /gateway pinned/);

    // English labels refresh cleanly
    setI18nLanguage('en-US');
    tab.refs.refreshLabels();
    assert.match(statusEl.textContent, /Local sync failed: gateway pinned/);

    // Both off -> stays clean without extra small-text clutter
    tab.refs.renderSettings(
      {
        contextWindowRiskAccepted: true,
        contextWindowMainEnabled: false,
        contextWindowSwarmEnabled: false,
        modelContextWindows: { [carbonGroup]: '300000' },
      },
      mockModels,
      { state: 'active' },
      'win32',
      { state: 'disabled', active: false, ruleCount: 0, error: '' }
    );
    assert.equal(statusEl.hasAttribute('hidden'), true);

    tab.destroy();
  } finally {
    globalThis.document = origDocument;
    globalThis.window = origWindow;
    globalThis.fetch = origFetch;
  }
});
