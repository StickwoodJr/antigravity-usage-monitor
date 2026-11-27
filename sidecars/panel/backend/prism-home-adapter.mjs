/**
 * Obsidian Prism Home-Screen Studio Dashboard Adapter (prism-home-adapter.mjs).
 * Maps Usage Monitor's canonical trajectory cache, multi-window aggregator, and
 * quota pool engine directly into the snapshot format consumed by `home-studio-panel.js`
 * (zero duplicate telemetry engine or `pulse-dashboard` backend).
 *
 * Adapted for antigravity-usage-monitor (GPL-3.0-only) on 2026-11-26.
 */

import { getEndpointCacheStore } from './endpoint-registry.mjs';
import { loadExternalDeepStatsCache } from './local-scanner.mjs';
import { createStepModelResolver, resolveModelInfo } from './model-pricing.mjs';
import { computeQuotaForecast } from './quota-pools.mjs';
import { buildTelemetryPayload } from './telemetry-builder.mjs';
import { normalizeWorkspaceBucket } from './usage-aggregator.mjs';

const HOME_HEAT_WEEKS = 26;
const HOME_HEAT_STEPS = 5;
const HOME_CHART_DAYS = 30;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function localDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function rangeStartDayKey(windowDays, nowDate) {
  if (!(windowDays > 0)) return null;
  const d = new Date(nowDate.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (windowDays - 1));
  return localDayKey(d.getTime());
}

function resolveStepOutputTokens(st) {
  const out = toNum(st?.outputTokens);
  if (out > 0) return out;
  return toNum(st?.thinkingTokens) + toNum(st?.responseTokens);
}

function buildHeatGrid(dayTotalsMap, nowDate) {
  const today = new Date(nowDate.getTime());
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (HOME_HEAT_WEEKS * 7 - 1));
  start.setDate(start.getDate() - start.getDay());
  const cells = [];
  let peak = 0;
  for (const cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
    const key = localDayKey(cursor.getTime());
    const tokens = toNum(dayTotalsMap[key]);
    if (tokens > peak) peak = tokens;
    cells.push({ date: key, tokens, level: 0 });
  }
  for (const cell of cells) {
    if (cell.tokens > 0 && peak > 0) {
      cell.level = Math.max(
        1,
        Math.min(HOME_HEAT_STEPS, Math.ceil((cell.tokens / peak) * HOME_HEAT_STEPS))
      );
    }
  }
  return { cells, peak };
}

function formatHourBucket(hour, lang) {
  const h = Math.max(0, Math.min(23, Math.floor(toNum(hour))));
  if (String(lang || '').toLowerCase().startsWith('zh')) {
    return `${String(h).padStart(2, '0')}:00`;
  }
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${suffix}`;
}

function toStudioQuotaGroups(quotasPayload, nowMs) {
  const pools = Array.isArray(quotasPayload?.pools) ? quotasPayload.pools : [];
  return pools.map((p) => {
    const rem5h =
      p.remainingFraction !== null && p.remainingFraction !== undefined
        ? Number(p.remainingFraction)
        : p.remainingPct !== null && p.remainingPct !== undefined
          ? Number(p.remainingPct) / 100
          : null;
    const remWk =
      p.weeklyRemainingFraction !== null && p.weeklyRemainingFraction !== undefined
        ? Number(p.weeklyRemainingFraction)
        : p.weeklyRemainingPct !== null && p.weeklyRemainingPct !== undefined
          ? Number(p.weeklyRemainingPct) / 100
          : null;
    const b5h =
      p.has5h && rem5h !== null
        ? {
            id: `${p.poolKey}-5h`,
            remaining: rem5h,
            remainingFraction: rem5h,
            resetTime: p.resetTime || null,
            forecast: p.forecast5h || computeQuotaForecast({ remainingFraction: rem5h, resetTime: p.resetTime }, '5h', nowMs),
          }
        : null;
    const bWk =
      p.hasWeekly && remWk !== null
        ? {
            id: `${p.poolKey}-weekly`,
            remaining: remWk,
            remainingFraction: remWk,
            resetTime: p.weeklyResetTime || null,
            forecast:
              p.forecastWeekly ||
              computeQuotaForecast(
                { remainingFraction: remWk, resetTime: p.weeklyResetTime },
                'weekly',
                nowMs
              ),
          }
        : null;
    return {
      id: p.poolKey,
      name: p.poolLabel || p.poolName || p.poolKey,
      family: p.family || p.poolKey,
      models: Array.isArray(p.models) ? p.models : [],
      pace: p.pace || null,
      windows: {
        ...(b5h ? { '5h': b5h } : {}),
        ...(bWk ? { weekly: bWk } : {}),
      },
      ...(b5h ? { fiveHour: b5h } : {}),
      ...(bWk ? { weekly: bWk } : {}),
    };
  });
}

/**
 * Builds the Home-Screen Studio dashboard snapshot directly from Usage Monitor's
 * telemetry, trajectory cache, and quota pool subsystems.
 *
 * @param {{
 *   range?: string,
 *   workspace?: string,
 *   includeArchived?: boolean,
 *   force?: boolean,
 *   endpoint?: object|null,
 *   conversationId?: string,
 * }} [opts]
 */
export async function buildPrismHomeSnapshot(opts = {}) {
  const rangeId = ['all', '30d', '7d'].includes(String(opts.range || ''))
    ? String(opts.range)
    : 'all';
  const rangeDays = rangeId === '7d' ? 7 : rangeId === '30d' ? 30 : 0;
  const workspaceFilter =
    typeof opts.workspace === 'string' && opts.workspace && opts.workspace !== 'all'
      ? opts.workspace
      : '';
  const includeArchived = opts.includeArchived !== false;
  const endpoint = opts.endpoint || null;
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const nowDate = new Date();
  const nowMs = nowDate.getTime();
  const startDay = rangeStartDayKey(rangeDays, nowDate);
  const inRange = (dk) => !startDay || dk >= startDay;

  let telemetry = null;
  try {
    telemetry = await buildTelemetryPayload(opts.conversationId || '', Boolean(opts.force), {
      range: 'all',
      scope: 'consumption',
      endpoint,
    });
  } catch {
    telemetry = null;
  }

  const liveConvMap = new Map();
  for (const conv of Array.isArray(telemetry?.conversations) ? telemetry.conversations : []) {
    if (conv?.cascadeId) {
      liveConvMap.set(String(conv.cascadeId).toLowerCase(), conv);
    }
  }

  const cacheStore = getEndpointCacheStore(endpoint);
  const externalConvos = isRemote ? new Map() : loadExternalDeepStatsCache();

  const mergedByLower = new Map();
  for (const [rawId, entry] of cacheStore.listCachedTrajectoryEntries()) {
    const cid = String(rawId || '').toLowerCase();
    if (!cid || !entry || typeof entry !== 'object') continue;
    const prev = mergedByLower.get(cid);
    if (!prev || (entry.steps?.length || 0) > (prev.steps?.length || 0)) {
      mergedByLower.set(cid, { cid, entry, archived: !liveConvMap.has(cid) && liveConvMap.size > 0 });
    }
  }
  for (const ext of externalConvos.values()) {
    const cid = String(ext?.cascadeId || '').toLowerCase();
    if (!cid) continue;
    const prev = mergedByLower.get(cid);
    if (!prev || (ext.steps?.length || 0) > (prev.entry?.steps?.length || 0)) {
      mergedByLower.set(cid, {
        cid,
        entry: ext,
        archived: !liveConvMap.has(cid) && liveConvMap.size > 0,
      });
    }
  }

  const resolveModel = createStepModelResolver(new Map());

  let totalTokens = 0;
  let mainTokens = 0;
  let subagentTokens = 0;
  let totalCalls = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let hasArchived = false;
  const sessionSet = new Set();
  const activeSet = new Set();
  const archivedSet = new Set();
  const subagentSessionSet = new Set();
  const activeDaySet = new Set();
  const hourCounts = new Array(24).fill(0);
  const modelTotals = new Map();
  const allDayTotals = Object.create(null);
  const allDayModels = Object.create(null);
  const workspaceMap = new Map();

  for (const { cid, entry, archived } of mergedByLower.values()) {
    const rawRoot = String(entry?.rootConversationId || '').trim().toLowerCase();
    const rawParent = String(entry?.parentConversationId || '').trim().toLowerCase();
    const parentCid =
      rawRoot && rawRoot !== cid
        ? rawRoot
        : rawParent && rawParent !== cid
          ? rawParent
          : '';
    const isSub = Boolean(parentCid || entry?.subagentSpec);
    const parentRec = parentCid ? mergedByLower.get(parentCid) : null;
    const isArch = Boolean(parentRec ? parentRec.archived : archived);
    if (!isSub && isArch) hasArchived = true;

    const wsRaw = String(parentRec?.entry?.workspaceUri || entry?.workspaceUri || '').trim();
    const wsInfo = wsRaw ? normalizeWorkspaceBucket(wsRaw) : null;
    const wsId = wsInfo?.label || '';
    const matchWs = !workspaceFilter || wsId === workspaceFilter;

    if (wsId) {
      if (!workspaceMap.has(wsId)) {
        workspaceMap.set(wsId, { id: wsId, path: wsInfo.workspacePath, tokens: 0, sessionsSet: new Set() });
      }
    }

    const steps = Array.isArray(entry?.steps) ? entry.steps : [];
    let countedInRange = false;
    let countedArchInRange = false;

    for (const st of steps) {
      if (!st || typeof st !== 'object') continue;
      const tMs = toNum(st.createdAtMs);
      if (!(tMs > 0)) continue;
      const dk = localDayKey(tMs);
      const inp = toNum(st.inputTokens);
      const cr = toNum(st.cacheReadTokens);
      const out = resolveStepOutputTokens(st);
      const stepTotal = inp + cr + out;
      const okRange = inRange(dk);

      if (wsId && okRange) {
        const wsEntry = workspaceMap.get(wsId);
        wsEntry.tokens += stepTotal;
        if (!isSub && stepTotal > 0) wsEntry.sessionsSet.add(cid);
      }

      if (!matchWs) continue;
      if (!isSub && isArch && okRange && !countedArchInRange && stepTotal > 0) {
        archivedSet.add(parentCid || cid);
        countedArchInRange = true;
      }
      if (!includeArchived && isArch) continue;

      const modelInfo = resolveModel ? resolveModel(st) : resolveModelInfo(st.modelKey);
      const modelId = String(modelInfo?.shortName || modelInfo?.label || st.modelKey || 'unknown');

      allDayTotals[dk] = (allDayTotals[dk] || 0) + stepTotal;
      if (!allDayModels[dk]) allDayModels[dk] = Object.create(null);
      allDayModels[dk][modelId] = (allDayModels[dk][modelId] || 0) + stepTotal;

      if (!okRange) continue;

      if (stepTotal > 0) {
        activeDaySet.add(dk);
        if (isSub) subagentSessionSet.add(cid);
        else if (!countedInRange) {
          sessionSet.add(cid);
          if (!isArch) activeSet.add(cid);
          countedInRange = true;
        }
      }

      totalTokens += stepTotal;
      if (isSub) subagentTokens += stepTotal;
      else mainTokens += stepTotal;
      totalCalls += 1;
      totalInput += inp + cr;
      totalCacheRead += cr;
      hourCounts[new Date(tMs).getHours()] += 1;

      if (!modelTotals.has(modelId)) {
        modelTotals.set(modelId, {
          id: modelId,
          family: modelInfo?.family || 'Other',
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          tokens: 0,
          subagentTokens: 0,
          calls: 0,
          sessionsSet: new Set(),
        });
      }
      const mEntry = modelTotals.get(modelId);
      mEntry.input += inp;
      mEntry.output += out;
      mEntry.cacheRead += cr;
      mEntry.tokens += stepTotal;
      mEntry.calls += 1;
      if (isSub) mEntry.subagentTokens += stepTotal;
      else mEntry.sessionsSet.add(cid);
    }
  }

  let bestHour = 0;
  let hourSum = 0;
  for (let h = 0; h < 24; h += 1) {
    hourSum += hourCounts[h];
    if (hourCounts[h] > hourCounts[bestHour]) bestHour = h;
  }
  const lang = telemetry?.settings?.language || 'en-US';
  const peakHour = hourSum > 0 ? formatHourBucket(bestHour, lang) : null;

  const models = Array.from(modelTotals.values())
    .map(({ sessionsSet, ...m }) => {
      const mInp = m.input + m.cacheRead + m.cacheWrite;
      return {
        ...m,
        cacheHitRate: mInp > 0 ? m.cacheRead / mInp : null,
        sessions: sessionsSet.size,
      };
    })
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || a.id.localeCompare(b.id));

  const workspaces = Array.from(workspaceMap.values())
    .map((w) => ({ id: w.id, path: w.path, tokens: w.tokens, sessions: w.sessionsSet.size }))
    .filter((w) => w.tokens > 0 || w.sessions > 0)
    .sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));

  const chartSpan = rangeDays > 0 && rangeDays < HOME_CHART_DAYS ? rangeDays : HOME_CHART_DAYS;
  const chartStart = rangeStartDayKey(chartSpan, nowDate);
  const modelDays = Object.keys(allDayModels)
    .filter((dk) => dk >= chartStart)
    .sort()
    .map((dk) => ({ date: dk, models: allDayModels[dk] }));

  return {
    ok: true,
    range: rangeId,
    workspace: workspaceFilter || 'all',
    includeArchived,
    fetchedAtMs: nowMs,
    rollup: {
      sessions: sessionSet.size,
      activeSessions: activeSet.size,
      archivedSessions: archivedSet.size,
      hasArchived,
      subagentSessions: subagentSessionSet.size,
      calls: totalCalls,
      tokens: totalTokens,
      mainTokens,
      subagentTokens,
      totalInput,
      cacheReadTokens: totalCacheRead,
      cacheHitRate: totalInput > 0 ? totalCacheRead / totalInput : null,
      activeDays: activeDaySet.size,
      peakHour,
      model: models[0]?.id || null,
      grid: buildHeatGrid(allDayTotals, nowDate),
      models,
      modelDays,
      workspaces,
    },
    quotas: {
      groups: toStudioQuotaGroups(telemetry?.quotas, nowMs),
      meta: telemetry?.quotas?.meta || null,
      activePool: telemetry?.quotas?.activePool || null,
    },
    activeConversationId: telemetry?.activeConversation?.cascadeId || '',
    settings: telemetry?.settings || null,
  };
}
