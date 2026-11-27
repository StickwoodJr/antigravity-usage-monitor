/**
 * @fileoverview Sidecar Webview 与主窗口双栖桥接共享的 API 路由分发与运行时引导层。
 *
 * 与 `sidecar_sdk` 完全解耦，使同一套遥测聚合、偏好持久化、云端目录同步与自更新逻辑可同时服务于：
 * 1. Antigravity 2.0 客户端右侧辅助栏 (`main.mjs` -> `SidecarApp`)；
 * 2. Antigravity IDE / 2.0 后台守护桥接进程 (`mcp-entry.mjs` -> `bridge-daemon.mjs`)。
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BRIDGE_API_ROUTE_DEFS, LOCAL_ENDPOINT_ID } from '../shared/window-bridge-protocol.mjs';
import { handleAccountCredentialAction } from './account-switch.mjs';
import {
  clearRemoteEndpointCaches,
  resolveEndpointContext,
  trackEndpointRequestEnd,
  trackEndpointRequestStart,
} from './endpoint-registry.mjs';
import { isLocalHostRequest, readLocalAsync } from './http-helpers.mjs';
import { revealLocalExportFile, writeLocalExportFile } from './file-exporter.mjs';
import { clearScannerRuntimeMemos } from './local-scanner.mjs';
import { createPrismCdpHost } from './prism-cdp-host.mjs';
import {
  SETTINGS_FILE,
  clearRuntimeCaches,
  cloudSyncState,
  computeRuntimeCodeVersion,
  createDefaultSettingsObject,
  inFlightRequests,
  isPlainObject,
  loadSettings,
  lsRuntimeEndpoint,
  normalizeFullSettings,
  normalizeModelDisplayMode,
  normalizeModernUi,
  normalizePluginUpdateMode,
  normalizeWindowMountMode,
  saveJson,
} from './config.mjs';
import {
  getContextWindowModels,
  getContextWindowGroups,
  isContextWindowSettingId,
  isContextWindowOption,
  resolveContextWindowOption,
} from './context-windows.mjs';
import { ensureLsEndpointDiscovered } from './ls-discovery.mjs';
import { callLsRpc, getContextModelCatalog } from './ls-rpc.mjs';
import {
  performPluginUpdate,
  scheduleSidecarRestart,
  setSidecarRestartHandler,
  syncCloudCatalog,
} from './plugin-updater.mjs';
import { getCloudStatus } from './pricing-catalog.mjs';
import { buildTelemetryPayload, clearTelemetryBuilderMemo } from './telemetry-builder.mjs';
import {
  ensureDesktopLaunchEntriesConfigured,
  triggerDesktopHostRelaunch,
} from './desktop-launcher-config.mjs';
import {
  ensureIdeRemoteDebuggingArgv,
  notifyModelContextWindowsChanged,
  notifyWindowOverlaySetting,
  resolveDevToolsPortCandidates,
  startDefaultWindowBridge,
} from './window-bridge.mjs';
import { getQuotaReservationLogSnapshot } from './quota-reservation.mjs';
import { getSessionMigrationCatalog, migrateSessions } from './session-migrator.mjs';
import {
  ensureCliStatusLineConfigured,
  getCliStatusLineRuntimeStatus,
} from './cli-statusline-config.mjs';
import { mapPrismPatchToSettingsPatch } from '../shared/settings-normalization.mjs';
import { buildPrismHomeSnapshot } from './prism-home-adapter.mjs';

export const bootBundleVersion = computeRuntimeCodeVersion();

let standalonePortListener = null;
let prismSettingsSyncListener = null;
let prismWallpaperHandler = null;
let prismOmniStatusProvider = null;

export function setStandalonePortListener(listener) {
  standalonePortListener = typeof listener === 'function' ? listener : null;
}

export function setPrismBridgeHooks({
  onSettingsChanged = null,
  onWallpaperAction = null,
  getOmniStatus = null,
} = {}) {
  if (onSettingsChanged !== undefined) {
    prismSettingsSyncListener = typeof onSettingsChanged === 'function' ? onSettingsChanged : null;
  }
  if (onWallpaperAction !== undefined) {
    prismWallpaperHandler = typeof onWallpaperAction === 'function' ? onWallpaperAction : null;
  }
  if (getOmniStatus !== undefined) {
    prismOmniStatusProvider = typeof getOmniStatus === 'function' ? getOmniStatus : null;
  }
}

export { isLocalHostRequest, readLocalAsync };

const MAX_SAFE_DATE_MS = 8_640_000_000_000_000;

function sanitizePositiveFiniteMs(val) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 && num <= MAX_SAFE_DATE_MS ? Math.floor(num) : 0;
}

function projectDisplayStep(st) {
  const {
    stepIndex, createdAtMs, isCompactionStep, modelKey, modelShort, modelLabel,
    modelUpstream, responseModel, modelSource, tokPerSec, ttftSec, totalDurationSec,
    nativeStreamSec, thinkingDurationSec, hasToolCalls, selectedSpeedReason, anomaly, anomalySig,
    contextTokens, inputTokens, cacheReadTokens,
    outputTokens, thinkingTokens, responseTokens, cacheHitPct, costUsd, inCostUsd,
    cacheCostUsd, outCostUsd, agentId, agentCascadeId, agentKind, agentOrdinal,
    agentCustomRole, agentLabel, agentBadge, agentRole, agentIndex, isSubagent,
    isSideQuestion, sideIndex, orchestratorRole, hasVisibleText, turnIndex, isTurnStart, isLatestTurn, turnPrompt,
    turnPromptClean, turnHasMedia, turnMediaOnly, rootTurnIndex, isRootTurnStart,
    isRootLatestTurn, rootTurnPrompt, rootTurnPromptClean, rootTurnHasMedia,
    rootTurnMediaOnly,
  } = st;
  return {
    stepIndex, createdAtMs, isCompactionStep, modelKey, modelShort, modelLabel,
    modelUpstream, responseModel, modelSource, tokPerSec, ttftSec, totalDurationSec,
    nativeStreamSec, thinkingDurationSec, hasToolCalls, selectedSpeedReason,
    ...(anomaly ? { anomaly, anomalySig } : {}),
    contextTokens, inputTokens, cacheReadTokens,
    outputTokens, thinkingTokens, responseTokens, cacheHitPct, costUsd, inCostUsd,
    cacheCostUsd, outCostUsd, agentId, agentCascadeId, agentKind, agentOrdinal,
    agentCustomRole, agentLabel, agentBadge, agentRole, agentIndex, isSubagent,
    isSideQuestion, sideIndex, orchestratorRole, hasVisibleText, turnIndex, isTurnStart, isLatestTurn, turnPrompt,
    turnPromptClean, turnHasMedia, turnMediaOnly, rootTurnIndex, isRootTurnStart,
    isRootLatestTurn, rootTurnPrompt, rootTurnPromptClean, rootTurnHasMedia,
    rootTurnMediaOnly,
  };
}

const MAX_DISPLAY_STEP_CACHE_ENTRIES = 16;
const displayStepsCache = new Map();
const displayStepFields = Object.keys(projectDisplayStep({ anomaly: true, anomalySig: '' })).filter(
  (k) => k !== 'anomaly'
);

function buildEndpointErrorResponse(epCtx) {
  return {
    status: Number(epCtx?.status || 400),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      error: epCtx?.error || 'Invalid endpointId',
      ...(epCtx?.retryable ? { retryable: true } : {}),
    }),
  };
}

function resolveActionEndpoint(data, opts) {
  const rawId =
    opts && opts.endpointId !== undefined
      ? opts.endpointId
      : isPlainObject(data) && data.endpointId !== undefined
        ? data.endpointId
        : undefined;
  return resolveEndpointContext(rawId);
}

function stripEndpointField(data) {
  if (!isPlainObject(data) || !Object.prototype.hasOwnProperty.call(data, 'endpointId')) {
    return data;
  }
  const { endpointId: _ignored, ...rest } = data;
  return rest;
}

function haveSameDisplaySteps(previous, current) {
  if (!previous || !current) return previous === current;
  if (previous.length !== current.length) return false;
  for (let i = 0; i < current.length; i++) {
    const before = previous[i];
    const after = current[i];
    for (const key of displayStepFields) {
      if (before[key] !== after[key]) return false;
    }
  }
  return true;
}

function projectDisplayTelemetry(payload, requestedRevision) {
  const active = payload.activeConversation;
  const agents = active.agents;
  const endpointKey = payload.endpoint?.id || LOCAL_ENDPOINT_ID;
  const sourceSteps = [active.recentSteps, ...agents.map((agent) => agent.recentSteps)];
  let projected;
  let revision;
  if (typeof requestedRevision === 'string') {
    const cacheKey = `${endpointKey}::${active.cascadeId || '__empty__'}`;
    const scope = [
      endpointKey,
      payload.account?.status,
      payload.account?.email || payload.account?.name || '',
      active.cascadeId,
      ...agents.map((agent) => agent.agentId),
    ];
    const previous = displayStepsCache.get(cacheKey);
    if (previous && isDeepStrictEqual(scope, previous.scope) &&
        sourceSteps.every((steps, index) => (steps && previous.sources[index]?.deref() === steps) ||
          haveSameDisplaySteps(previous.steps[index], steps))) {
      ({ revision, steps: projected } = previous);
      previous.sources = sourceSteps.map((steps) => steps ? new WeakRef(steps) : undefined);
      displayStepsCache.delete(cacheKey);
      displayStepsCache.set(cacheKey, previous);
    } else {
      revision = randomUUID();
      projected = sourceSteps.map((steps) => steps?.map(projectDisplayStep));
      if (!displayStepsCache.has(cacheKey) && displayStepsCache.size >= MAX_DISPLAY_STEP_CACHE_ENTRIES) {
        displayStepsCache.delete(displayStepsCache.keys().next().value);
      }
      displayStepsCache.delete(cacheKey);
      displayStepsCache.set(cacheKey, {
        scope,
        steps: projected,
        revision,
        sources: sourceSteps.map((steps) => steps ? new WeakRef(steps) : undefined),
      });
    }
  }
  projected ||= sourceSteps.map((steps) => steps?.map(projectDisplayStep));
  const stepsUnchanged = revision !== undefined && requestedRevision === revision;
  return {
    ...payload,
    ...(revision ? { stepRevision: revision, stepsUnchanged } : {}),
    activeConversation: {
      ...active,
      recentSteps: stepsUnchanged ? undefined : projected[0],
      agents: agents.map((agent, index) => projected[index + 1]
        ? { ...agent, recentSteps: stepsUnchanged ? undefined : projected[index + 1] }
        : agent),
    },
  };
}

export async function executeTelemetryAction(data, opts = {}) {
  const { onRestart = null } = opts || {};
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  const isRemote = epCtx.isRemote;
  const rawConvId = String(
    data?.conversationId || (isRemote ? '' : process.env.ANTIGRAVITY_CONVERSATION_ID || '')
  ).trim();
  const convId = rawConvId && !/[\\/]|\.\./.test(rawConvId) ? rawConvId : '';
  const force = data?.force === '1' || data?.force === true;
  if (lsRuntimeEndpoint.addr !== 'test.invalid') {
    if (!isRemote && !lsRuntimeEndpoint.baseUrl) {
      await ensureLsEndpointDiscovered({ force: false });
    }
  }
  const rawScope = String(data?.scope || '').trim();
  const scope =
    rawScope === 'consumption' ||
    rawScope === 'consumption-presets' ||
    rawScope === 'conversation'
      ? rawScope
      : '';
  const filterOpts = {
    range: data?.range || 'all',
    startMs: sanitizePositiveFiniteMs(data?.startMs),
    endMs: sanitizePositiveFiniteMs(data?.endMs),
    ...(scope ? { scope } : {}),
    endpoint: epCtx.endpoint,
  };
  let payload;
  trackEndpointRequestStart(epCtx.endpoint);
  try {
    payload = await buildTelemetryPayload(convId, force, filterOpts);
  } catch (err) {
    if (
      lsRuntimeEndpoint.addr !== 'test.invalid' &&
      bootBundleVersion &&
      String(computeRuntimeCodeVersion()) !== String(bootBundleVersion)
    ) {
      if (typeof onRestart === 'function') {
        onRestart();
      } else {
        scheduleSidecarRestart(150);
      }
    }
    throw err;
  } finally {
    trackEndpointRequestEnd(epCtx.endpoint);
  }
  if (
    bootBundleVersion &&
    payload?.uiBundleVersion &&
    String(payload.uiBundleVersion) !== String(bootBundleVersion)
  ) {
    if (typeof onRestart === 'function') {
      onRestart();
    } else {
      scheduleSidecarRestart(150);
    }
  }
  const isScopedConsumptionPayload =
    payload?.scope === 'consumption' || payload?.scope === 'consumption-presets';
  const responsePayload =
    !isScopedConsumptionPayload && data?.stepDetails === 'display'
      ? projectDisplayTelemetry(payload, data.stepRevision)
      : payload;
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(responsePayload),
  };
}

function sanitizePositiveSettingNumber(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

export function executeSettingsAction(data) {
  const current = loadSettings();
  const payload = isPlainObject(data) ? stripEndpointField(data) : {};
  const nextPluginUpdateMode =
    payload.pluginUpdateMode !== undefined
      ? normalizePluginUpdateMode(payload.pluginUpdateMode)
      : typeof payload.autoUpdatePlugin === 'boolean'
        ? normalizePluginUpdateMode(payload.autoUpdatePlugin ? 'manual' : 'off')
        : normalizePluginUpdateMode(current.pluginUpdateMode, current.autoUpdatePlugin);
  const nextWindowMountMode =
    payload.windowMountMode !== undefined
      ? normalizeWindowMountMode(payload.windowMountMode)
      : typeof payload.enableWindowOverlay === 'boolean'
        ? payload.enableWindowOverlay
          ? current.windowMountMode === 'composer'
            ? 'composer'
            : 'dual'
          : 'sidebar'
        : normalizeWindowMountMode(current.windowMountMode, current.enableWindowOverlay);
  const nextModelDisplayMode =
    payload.modelDisplayMode !== undefined
      ? normalizeModelDisplayMode(payload.modelDisplayMode)
      : typeof payload.showUpstreamModel === 'boolean'
        ? payload.showUpstreamModel
          ? 'upstream'
          : 'short'
        : normalizeModelDisplayMode(current.modelDisplayMode, current.showUpstreamModel);
  const nextModernUi =
    payload.modernUi !== undefined
      ? normalizeModernUi(payload.modernUi)
      : payload.experimentalModernUi !== undefined
        ? normalizeModernUi(payload.experimentalModernUi)
        : normalizeModernUi(current.modernUi);
  const updated = normalizeFullSettings({
    ...current,
    ...payload,
    modernUi: nextModernUi,
    modelContextWindows: current.modelContextWindows,
    weeklyTokenBudget: sanitizePositiveSettingNumber(
      payload.weeklyTokenBudget ?? payload.weeklyTokenLimit,
      current.weeklyTokenBudget
    ),
    weeklyCostBudget: sanitizePositiveSettingNumber(
      payload.weeklyCostBudget,
      current.weeklyCostBudget
    ),
    modelDisplayMode: nextModelDisplayMode,
    pluginUpdateMode: nextPluginUpdateMode,
    windowMountMode: nextWindowMountMode,
  });
  if (!saveJson(SETTINGS_FILE, updated)) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to persist settings' }),
    };
  }
  const prevMountMode = normalizeWindowMountMode(
    current.windowMountMode,
    current.enableWindowOverlay
  );
  const contextWindowScopeChanged =
    (updated.contextWindowMainEnabled === true) !== (current.contextWindowMainEnabled === true) ||
    (updated.contextWindowSwarmEnabled === true) !== (current.contextWindowSwarmEnabled === true);
  const affectsBackendTelemetry =
    updated.weeklyLimitMode !== current.weeklyLimitMode ||
    updated.weeklyTokenBudget !== current.weeklyTokenBudget ||
    updated.weeklyCostBudget !== current.weeklyCostBudget ||
    updated.enableWindowOverlay !== (current.enableWindowOverlay !== false) ||
    updated.windowMountMode !== prevMountMode ||
    contextWindowScopeChanged;
  inFlightRequests.clear();
  if (affectsBackendTelemetry) {
    clearTelemetryBuilderMemo();
  }
  if (
    updated.enableWindowOverlay !== (current.enableWindowOverlay !== false) ||
    updated.windowMountMode !== prevMountMode
  ) {
    void notifyWindowOverlaySetting(updated.enableWindowOverlay);
  } else if (contextWindowScopeChanged) {
    void notifyModelContextWindowsChanged();
  }
  if ((updated.enableCliStatusLine === true) !== (current.enableCliStatusLine === true)) {
    ensureCliStatusLineConfigured({ enabled: updated.enableCliStatusLine === true });
  }
  if (
    typeof standalonePortListener === 'function' &&
    Number(updated.standalonePort || 0) !== Number(current.standalonePort || 0)
  ) {
    try {
      standalonePortListener(Number(updated.standalonePort || 0));
    } catch {
      // 忽略独立端口热重载回调异常
    }
  }
  if (typeof prismSettingsSyncListener === 'function') {
    try {
      void prismSettingsSyncListener(updated, current);
    } catch {
      // Ignore Prism settings broadcast errors
    }
  }
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    updated,
    body: JSON.stringify(updated),
  };
}

export async function executeModelContextWindowAction(data, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  const { modelId, option } = data || {};
  const respond = (status, payload) => ({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  });
  if (!isContextWindowSettingId(modelId) || (option !== null && !isContextWindowOption(option))) {
    return respond(400, { error: 'Invalid model context window' });
  }

  async function loadGroupsForEndpoint(targetEndpoint) {
    const [{ userStatus }, catalog] = await Promise.all([
      callLsRpc('GetUserStatus', {}, 5000, targetEndpoint),
      getContextModelCatalog(targetEndpoint),
    ]);
    const configs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
    if (!Array.isArray(configs) || configs.length === 0) return null;
    const models = getContextWindowModels(configs, catalog);
    return getContextWindowGroups(models);
  }

  let group;
  let verifiedHostConfigs = false;
  trackEndpointRequestStart(epCtx.endpoint);
  try {
    let groups = null;
    try {
      groups = await loadGroupsForEndpoint(epCtx.endpoint);
    } catch {
      groups = null;
    }
    if (epCtx.isRemote && !groups) {
      // 仅在远端 RPC 异常或未返回模型配置时安全回退本机校验；远端已成功返回时绝不放宽其档位限制
      try {
        groups = await loadGroupsForEndpoint(null);
      } catch {
        groups = null;
      }
    }
    if (Array.isArray(groups)) {
      verifiedHostConfigs = true;
      group = groups.find(({ id }) => id === modelId);
    }
  } finally {
    trackEndpointRequestEnd(epCtx.endpoint);
  }
  if (!verifiedHostConfigs) {
    if (option !== null || modelId.startsWith('model:')) {
      return respond(503, { error: 'Unable to verify the host model configuration' });
    }
  }
  if (option !== null && (!group || resolveContextWindowOption(group, option) === null)) {
    return respond(400, { error: 'This context window is not available for the selected model' });
  }
  const current = loadSettings();
  for (const id of group?.members || []) delete current.modelContextWindows[id];
  if (option === null) {
    delete current.modelContextWindows[modelId];
  } else {
    current.modelContextWindows[modelId] = option;
  }
  if (!saveJson(SETTINGS_FILE, current)) {
    return respond(500, { error: 'Failed to persist model context window' });
  }
  inFlightRequests.clear();
  clearTelemetryBuilderMemo();
  void notifyModelContextWindowsChanged();
  return respond(200, { modelContextWindows: current.modelContextWindows });
}

export function executeResetSettingsAction() {
  const current = loadSettings();
  const updated = createDefaultSettingsObject();
  if (!saveJson(SETTINGS_FILE, updated)) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to reset settings' }),
    };
  }
  inFlightRequests.clear();
  clearTelemetryBuilderMemo();
  const prevMountMode = normalizeWindowMountMode(
    current.windowMountMode,
    current.enableWindowOverlay
  );
  if (
    updated.enableWindowOverlay !== (current.enableWindowOverlay !== false) ||
    updated.windowMountMode !== prevMountMode
  ) {
    void notifyWindowOverlaySetting(updated.enableWindowOverlay);
  } else if (
    Object.keys(current.modelContextWindows).length ||
    current.contextWindowMainEnabled === true ||
    current.contextWindowSwarmEnabled === true
  ) {
    void notifyModelContextWindowsChanged();
  }
  if ((updated.enableCliStatusLine === true) !== (current.enableCliStatusLine === true)) {
    ensureCliStatusLineConfigured({ enabled: updated.enableCliStatusLine === true });
  }
  if (
    typeof standalonePortListener === 'function' &&
    Number(updated.standalonePort || 0) !== Number(current.standalonePort || 0)
  ) {
    try {
      standalonePortListener(Number(updated.standalonePort || 0));
    } catch {
      // 忽略独立端口热重载回调异常
    }
  }
  if (typeof prismSettingsSyncListener === 'function') {
    try {
      void prismSettingsSyncListener(updated, current);
    } catch {
      // Ignore Prism settings broadcast errors
    }
  }
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    updated,
    body: JSON.stringify(updated),
  };
}

export function executeRebuildCacheAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  const ok = epCtx.isRemote
    ? clearRemoteEndpointCaches(epCtx.id)
    : clearRuntimeCaches();
  if (!ok) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to clear trajectory cache' }),
    };
  }
  const cachePrefix = `${epCtx.id}::`;
  for (const key of Array.from(displayStepsCache.keys())) {
    if (key.startsWith(cachePrefix)) {
      displayStepsCache.delete(key);
    }
  }
  clearScannerRuntimeMemos(epCtx.isRemote ? epCtx.id : null);
  clearTelemetryBuilderMemo(epCtx.id);
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: true, endpointId: epCtx.id, clearedAt: Date.now() }),
  };
}

export async function executeCloudSyncAction() {
  const cloudStatus = await syncCloudCatalog({ force: true });
  clearTelemetryBuilderMemo();
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: !cloudStatus.lastSyncError, cloudStatus }),
  };
}

export async function executePluginUpdateAction() {
  const result = await performPluginUpdate({ isAuto: false });
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ...result, cloudStatus: getCloudStatus() }),
  };
}

export async function executeAccountCredentialAction(data, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ supported: false, accounts: [], error: 'unsupported' }),
    };
  }
  const cleanData = stripEndpointField(data);
  const result = await handleAccountCredentialAction(cleanData);
  if (cleanData?.action === 'switch') {
    clearTelemetryBuilderMemo(LOCAL_ENDPOINT_ID);
  }
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export async function executeBridgeRelaunchAction() {
  ensureIdeRemoteDebuggingArgv({ enabled: true });
  const launchConfig = await ensureDesktopLaunchEntriesConfigured({ enabled: true }).catch(
    () => null
  );
  const result = await triggerDesktopHostRelaunch({
    stalePortFiles: resolveDevToolsPortCandidates(),
    readOnlyShortcutPaths: launchConfig?.readOnlyPaths || [],
  });
  return {
    status: result.ok ? 200 : Number(result.status || 500),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export function executeCliStatusLineAction(rawAction) {
  const action = String(rawAction || '').trim();
  if (action !== 'force_install' && action !== 'clear_flags') {
    return {
      status: 400,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Unsupported CLI statusLine action' }),
    };
  }

  let current = loadSettings();
  if (action === 'force_install' && current.enableCliStatusLine !== true) {
    const nextSettings = normalizeFullSettings({
      ...current,
      enableCliStatusLine: true,
    });
    if (saveJson(SETTINGS_FILE, nextSettings)) {
      current = nextSettings;
    }
  }

  const result = ensureCliStatusLineConfigured({
    enabled: true,
    forceReplaceCustom: action === 'force_install',
    preserveManagedFlags: false,
  });
  const cliStatusLine = getCliStatusLineRuntimeStatus();
  const ok = Boolean(result?.updated || result?.alreadyConfigured || cliStatusLine.configured);
  return {
    status: ok ? 200 : 500,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      ok,
      action,
      result,
      cliStatusLine,
      settings: current,
    }),
  };
}

export function executeSessionMigrationCatalogAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        available: false,
        sqliteSupported: false,
        clients: [],
        sessionsByClient: {},
        desktopProjects: [],
        error: 'unsupported_remote',
      }),
    };
  }
  const catalog = getSessionMigrationCatalog();
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(catalog),
  };
}

export function executeSessionMigrationMigrateAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 400,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'unsupported_remote', results: [] }),
    };
  }
  const cleanData = stripEndpointField(data);
  const result = migrateSessions(cleanData);
  if (result.migratedCount > 0) {
    clearScannerRuntimeMemos(LOCAL_ENDPOINT_ID);
    clearTelemetryBuilderMemo(LOCAL_ENDPOINT_ID);
  }
  return {
    status: Number(result.status || (result.ok ? 200 : 400)),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export function executeExportFileAction(data, opts = {}) {
  const result = writeLocalExportFile(data || {}, {
    ...(opts?.exportDir ? { overrideDir: opts.exportDir } : {}),
    ...(opts?.homeDir ? { homeDir: opts.homeDir } : {}),
    ...(opts?.fallbackDataDir ? { fallbackDataDir: opts.fallbackDataDir } : {}),
  });
  return {
    status: Number(result.status || (result.ok ? 200 : 400)),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export function executeQuotaReservationLogAction() {
  const snapshot = getQuotaReservationLogSnapshot();
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: true, ...snapshot }),
  };
}

export function executeRevealFileAction(data, opts = {}) {
  const result = revealLocalExportFile(data?.filePath, {
    ...(opts?.platform ? { platform: opts.platform } : {}),
    ...(typeof opts?.spawnFn === 'function' ? { spawnFn: opts.spawnFn } : {}),
  });
  return {
    status: Number(result.status || (result.ok ? 200 : 400)),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export async function executePrismHomeSnapshotAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  const snapshot = await buildPrismHomeSnapshot({
    range: data?.range || 'all',
    workspace: data?.workspace || 'all',
    includeArchived: data?.includeArchived !== 'false' && data?.includeArchived !== false,
    force: data?.force === '1' || data?.force === true,
    conversationId: String(data?.conversationId || '').trim(),
    endpoint: epCtx.endpoint,
  });
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(snapshot),
  };
}

export function executePrismSettingsSyncAction(data = undefined) {
  const mappedPatch = mapPrismPatchToSettingsPatch(data);
  if (Object.keys(mappedPatch).length === 0) {
    const current = loadSettings();
    return {
      ok: true,
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      updated: current,
      body: JSON.stringify(current),
    };
  }
  return executeSettingsAction(mappedPatch);
}

export async function executePrismWallpaperAction(data = undefined) {
  if (typeof prismWallpaperHandler !== 'function') {
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ok: true,
        available: false,
        config: { enabled: false },
      }),
    };
  }
  const res = await prismWallpaperHandler(data || {});
  return {
    status: Number(res?.status || 200),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(res?.body ?? res ?? { ok: true }),
  };
}

export function executePrismOmniStatusAction() {
  const status =
    typeof prismOmniStatusProvider === 'function'
      ? prismOmniStatusProvider()
      : { ok: true, active: false, port: 0 };
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(status),
  };
}

const BRIDGE_ROUTE_LOOKUP = new Map(
  BRIDGE_API_ROUTE_DEFS.map((r) => [`${r.method}:${r.path}`, r.action])
);

export async function dispatchBridgeApiRequest(pathname, method, data, opts = undefined) {
  const action = BRIDGE_ROUTE_LOOKUP.get(`${String(method || '').toUpperCase()}:${pathname}`);
  switch (action) {
    case 'telemetry':
      return executeTelemetryAction(data, opts);
    case 'settings':
      if (isPlainObject(data) && data.__bridgeAction === 'relaunch') {
        return executeBridgeRelaunchAction();
      }
      if (isPlainObject(data) && typeof data.__cliStatusLineAction === 'string') {
        return executeCliStatusLineAction(data.__cliStatusLineAction);
      }
      if (isPlainObject(data) && data.__sessionMigrationAction === 'catalog') {
        return executeSessionMigrationCatalogAction(data, opts);
      }
      if (isPlainObject(data) && data.__sessionMigrationAction === 'migrate') {
        return executeSessionMigrationMigrateAction(data.payload || data, opts);
      }
      if (isPlainObject(data) && data.__exportFileAction === 'save') {
        return executeExportFileAction(data.payload || data, opts);
      }
      if (isPlainObject(data) && data.__exportFileAction === 'reveal') {
        return executeRevealFileAction(data.payload || data, opts);
      }
      if (isPlainObject(data) && data.__quotaReservationAction === 'log') {
        return executeQuotaReservationLogAction();
      }
      return executeSettingsAction(data);
    case 'accounts_get':
      return executeAccountCredentialAction(undefined, opts);
    case 'accounts_update':
      return executeAccountCredentialAction(data, opts);
    case 'context_window':
      return executeModelContextWindowAction(data, opts);
    case 'settings_reset':
      return executeResetSettingsAction();
    case 'cache_rebuild':
      return executeRebuildCacheAction(data, opts);
    case 'cloud_sync':
      return executeCloudSyncAction();
    case 'plugin_update':
      return executePluginUpdateAction();
    case 'bridge_relaunch':
      return executeBridgeRelaunchAction();
    case 'session_migration_catalog':
      return executeSessionMigrationCatalogAction(data, opts);
    case 'session_migration_migrate':
      return executeSessionMigrationMigrateAction(data, opts);
    case 'export_file':
      return executeExportFileAction(data, opts);
    case 'reveal_file':
      return executeRevealFileAction(data, opts);
    case 'quota_reservation_log':
      return executeQuotaReservationLogAction();
    case 'prism_home_snapshot':
      return executePrismHomeSnapshotAction(data, opts);
    case 'prism_settings_sync':
      return executePrismSettingsSyncAction(data);
    case 'prism_wallpaper':
      return executePrismWallpaperAction(data);
    case 'prism_omni_status':
      return executePrismOmniStatusAction();
    default:
      return {
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not found' }),
      };
  }
}

/**
 * 启动进程级双栖窗口桥接器（兼容 Sidecar 环境与独立后台守护进程环境）。
 *
 * @param {{ allowDynamicLs?: boolean, onRestart?: () => void }} [options]
 */
export function bootWindowBridgeRuntime({ allowDynamicLs = false, onRestart = null } = {}) {
  if (lsRuntimeEndpoint.addr === 'test.invalid') return null;
  if (!allowDynamicLs && !lsRuntimeEndpoint.addr) return null;

  if (loadSettings().enableCliStatusLine === true) {
    ensureCliStatusLineConfigured({ enabled: true });
  }

  const triggerRestart =
    typeof onRestart === 'function' ? onRestart : () => scheduleSidecarRestart(150);
  if (typeof onRestart === 'function') {
    setSidecarRestartHandler(onRestart);
  }

  if (!lsRuntimeEndpoint.baseUrl) {
    ensureLsEndpointDiscovered({ force: false }).catch(() => {});
  }

  const bridgeController = startDefaultWindowBridge({
    handleApiRequest: (pathname, method, data, ctx) =>
      dispatchBridgeApiRequest(pathname, method, data, {
        onRestart: triggerRestart,
        ...(ctx?.endpointId !== undefined ? { endpointId: ctx.endpointId } : {}),
      }),
    readAssetFn: readLocalAsync,
    bootBundleVersion,
    onVersionDrift: triggerRestart,
  });

  if (process.env.AG_USAGE_DISABLE_PRISM_CDP === '1' || !bridgeController) {
    return bridgeController;
  }

  const prismHost = createPrismCdpHost({
    onTargetEvent: () => {
      try {
        bridgeController?.syncAllWindows?.({ forceReinject: false });
      } catch {}
    },
    onOpenMonitor: () => {
      if (standalonePortListener) {
        // Standalone listener already notified at boot; UI opens via overlay/standalone route
      }
    },
  });
  prismHost.start();

  const origStop = bridgeController.stop?.bind(bridgeController);
  return {
    ...bridgeController,
    getPrismHostStatus: () => prismHost.getStatus(),
    stop: async (opts) => {
      await prismHost.stop().catch(() => {});
      if (origStop) return await origStop(opts);
    },
  };
}

