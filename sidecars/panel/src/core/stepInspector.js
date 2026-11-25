/**
 * @fileoverview 步骤搜索筛选、快捷诊断统计、耗时瀑布计算及单步诊断 Markdown 导出纯函数模块 (`stepInspector.js`)。
 * 保持零 DOM 耦合和单遍 O(N) 高性能，供 `StepsDetailView` 及单元测试直接复用。
 */

import { classifyTtftTier } from '../../shared/telemetry-display-rules.mjs';
import {
  formatAnomalyKindLabel,
  formatCompactDateTime,
  formatMetric,
  formatPctNumber,
  formatSpeedMetric,
  formatTimingDetailSec,
  formatTokensPrecise,
  formatUsd,
  resolveModelDisplayInfo,
  speedReasonText,
} from './formatters.js';

export const STEP_LOW_CACHE_MIN_PROMPT_TOKENS = 2000;
export const STEP_LOW_CACHE_MAX_PCT = 50;
export const STEP_SLOW_TTFT_MIN_SEC = 30;

/**
 * 同 `StepTableWidget` 保持一致的单步稳定选择键。
 *
 * @param {object|null|undefined} st
 * @param {string} [fallbackCascadeId='']
 * @returns {string}
 */
export function getStepSelectionKey(st, fallbackCascadeId = '') {
  if (!st || typeof st !== 'object') return '';
  const agentKey =
    st.agentCascadeId || st.agentId || st.cascadeId || fallbackCascadeId || 'conv';
  return `${agentKey}-${st.stepIndex}`;
}

export function isLowCacheStep(st) {
  if (!st || st.isCompactionStep) return false;
  const promptTok = Number(st.inputTokens || 0) + Number(st.cacheReadTokens || 0);
  if (promptTok < STEP_LOW_CACHE_MIN_PROMPT_TOKENS) return false;
  const pct =
    st.cacheHitPct != null && Number.isFinite(Number(st.cacheHitPct))
      ? Number(st.cacheHitPct)
      : promptTok > 0
        ? (Number(st.cacheReadTokens || 0) / promptTok) * 100
        : 0;
  return pct < STEP_LOW_CACHE_MAX_PCT;
}

export function isSlowTtftStep(st) {
  if (!st || st.isCompactionStep) return false;
  return classifyTtftTier(st.ttftSec) === 'danger';
}

/**
 * 单遍 O(N) 统计当前步骤集中各诊断快捷筛选芯片的命中数量。
 *
 * @param {Array<object>} steps
 * @returns {{ anomaly: number, compaction: number, low_cache: number, slow_ttft: number }}
 */
export function computeStepQuickChipCounts(steps) {
  let anomaly = 0;
  let compaction = 0;
  let lowCache = 0;
  let slowTtft = 0;
  if (Array.isArray(steps)) {
    for (let i = 0; i < steps.length; i += 1) {
      const st = steps[i];
      if (!st) continue;
      if (st.anomaly && Number(st.anomaly.count) > 0) anomaly += 1;
      if (st.isCompactionStep) compaction += 1;
      if (isLowCacheStep(st)) lowCache += 1;
      if (isSlowTtftStep(st)) slowTtft += 1;
    }
  }
  return {
    anomaly,
    compaction,
    low_cache: lowCache,
    slow_ttft: slowTtft,
  };
}

/**
 * 按快捷诊断芯片、异常类型及多词关键字过滤步骤列表（纯函数 O(N)）。
 *
 * @param {Array<object>} steps
 * @param {{ query?: string, quickChip?: string, anomalyKindFilter?: string, displaySettings?: object }} [opts]
 * @returns {Array<object>}
 */
export function filterStepsBySearchAndChip(
  steps,
  { query = '', quickChip = '', anomalyKindFilter = '', displaySettings = {} } = {}
) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const rawTerms = String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const chip = String(quickChip || '').trim();
  const kind = String(anomalyKindFilter || '').trim();

  if (!chip && !kind && rawTerms.length === 0) {
    return steps;
  }

  const out = [];
  for (let i = 0; i < steps.length; i += 1) {
    const st = steps[i];
    if (!st) continue;

    if (chip === 'anomaly' || kind) {
      const a = st.anomaly;
      if (!a || !(Number(a.count) > 0)) continue;
      if (kind && !(Number(a.kinds?.[kind] || 0) > 0)) continue;
    } else if (chip === 'compaction') {
      if (!st.isCompactionStep) continue;
    } else if (chip === 'low_cache') {
      if (!isLowCacheStep(st)) continue;
    } else if (chip === 'slow_ttft') {
      if (!isSlowTtftStep(st)) continue;
    }

    if (rawTerms.length > 0) {
      const modelInfo = resolveModelDisplayInfo(st, displaySettings);
      const anomalyKinds = st.anomaly?.kinds ? Object.keys(st.anomaly.kinds).join(' ') : '';
      const anomalyEventsText = Array.isArray(st.anomaly?.events)
        ? st.anomaly.events
            .map((ev) => `${ev?.kind || ''} ${ev?.attempt ?? ''} ${ev?.message || ''}`)
            .join(' ')
        : '';
      const anomalyItemsText = Array.isArray(st.anomaly?.items)
        ? st.anomaly.items
            .map((it) => `${it?.kind || ''} ${it?.httpStatus || ''} ${it?.detail || ''}`)
            .join(' ')
        : '';
      const haystack = [
        `#${st.stepIndex ?? ''}`,
        String(st.stepIndex ?? ''),
        modelInfo.text,
        modelInfo.title,
        st.modelLabel || '',
        st.modelShort || '',
        st.modelKey || '',
        st.modelUpstream || '',
        st.responseModel || '',
        st.rawModelId || '',
        st.upstreamName || '',
        st.turnPrompt || '',
        st.rootTurnPrompt || '',
        st.agentLabel || '',
        st.agentRole || '',
        st.agentBadge || '',
        st.isCompactionStep ? 'compaction' : '',
        anomalyKinds,
        anomalyEventsText,
        anomalyItemsText,
      ]
        .join(' ')
        .toLowerCase();

      let matchedAll = true;
      for (let tIdx = 0; tIdx < rawTerms.length; tIdx += 1) {
        if (!haystack.includes(rawTerms[tIdx])) {
          matchedAll = false;
          break;
        }
      }
      if (!matchedAll) continue;
    }

    out.push(st);
  }
  return out;
}

/**
 * 在同代理步骤集合中定位目标步骤之前最近一步的上下文 Token 数，用于展示单步上下文增量。
 *
 * @param {Array<object>} allSteps
 * @param {object|null|undefined} targetStep
 * @returns {number|null}
 */
export function findPrevAgentContextTokens(allSteps, targetStep) {
  if (!Array.isArray(allSteps) || !targetStep || targetStep.stepIndex == null) return null;
  const targetIdx = Number(targetStep.stepIndex);
  const targetAgent = targetStep.agentId || 'main';
  if (!Number.isFinite(targetIdx)) return null;

  let bestIdx = -Infinity;
  let bestCtx = null;
  for (let i = 0; i < allSteps.length; i += 1) {
    const st = allSteps[i];
    if (!st) continue;
    if ((st.agentId || 'main') !== targetAgent) continue;
    const idx = Number(st.stepIndex);
    if (Number.isFinite(idx) && idx < targetIdx && idx > bestIdx) {
      const ctxVal = Number(
        st.contextTokens ||
          Number(st.inputTokens || 0) +
            Number(st.cacheReadTokens || 0) +
            Number(st.outputTokens || 0)
      );
      if (ctxVal > 0) {
        bestIdx = idx;
        bestCtx = ctxVal;
      }
    }
  }
  return bestCtx;
}

/**
 * 计算单步耗时瀑布分段比例（TTFT 首字等待 / 流式输出 / 工具及尾部阶段）。
 *
 * @param {object|null|undefined} st
 * @returns {{ totalSec: number, ttftSec: number, streamSec: number, otherSec: number, thinkingSec: number, ttftPct: number, streamPct: number, otherPct: number }|null}
 */
export function computeStepTimingWaterfall(st) {
  if (!st || typeof st !== 'object') return null;
  const rawTtft = st.ttftSec ?? st.nativeTtftSec;
  const ttft =
    rawTtft != null && Number.isFinite(Number(rawTtft)) && Number(rawTtft) >= 0
      ? Number(rawTtft)
      : 0;
  const rawStream = st.nativeStreamSec ?? st.streamDurationSec;
  const stream =
    rawStream != null && Number.isFinite(Number(rawStream)) && Number(rawStream) >= 0
      ? Number(rawStream)
      : 0;
  const thinking =
    st.thinkingDurationSec != null &&
    Number.isFinite(Number(st.thinkingDurationSec)) &&
    Number(st.thinkingDurationSec) >= 0
      ? Number(st.thinkingDurationSec)
      : 0;
  const rawDur = st.totalDurationSec ?? st.durationSec;
  const rawTotal =
    rawDur != null && Number.isFinite(Number(rawDur)) && Number(rawDur) > 0
      ? Number(rawDur)
      : ttft + stream;
  const totalSec = Math.max(rawTotal, ttft + stream);
  if (!(totalSec > 0)) return null;

  const effStream = Math.min(stream, Math.max(0, totalSec - ttft));
  const otherSec = Math.max(0, +(totalSec - ttft - effStream).toFixed(3));
  const ttftPct = +((ttft / totalSec) * 100).toFixed(2);
  const streamPct = +((effStream / totalSec) * 100).toFixed(2);
  const otherPct = Math.max(0, +(100 - ttftPct - streamPct).toFixed(2));

  return {
    totalSec: +totalSec.toFixed(3),
    ttftSec: +ttft.toFixed(3),
    streamSec: +effStream.toFixed(3),
    otherSec,
    thinkingSec: +thinking.toFixed(3),
    ttftPct,
    streamPct,
    otherPct,
  };
}

/**
 * 生成结构化的单步诊断 Markdown 文本，便于直接复制到工单、讨论或性能复盘中。
 *
 * @param {object} st
 * @param {{ prevContextTokens?: number|null, displaySettings?: object }} [opts]
 * @returns {string}
 */
export function buildStepDiagnosticMarkdown(
  st,
  { prevContextTokens = null, displaySettings = {} } = {}
) {
  if (!st || typeof st !== 'object') return '';
  const modelInfo = resolveModelDisplayInfo(st, displaySettings);
  const timeStr = st.createdAtMs ? formatCompactDateTime(st.createdAtMs) : '—';
  const promptTok = Number(st.inputTokens || 0) + Number(st.cacheReadTokens || 0);
  const cachePct =
    st.cacheHitPct != null && Number.isFinite(Number(st.cacheHitPct))
      ? formatPctNumber(st.cacheHitPct, { withSymbol: true })
      : promptTok > 0
        ? formatPctNumber((Number(st.cacheReadTokens || 0) / promptTok) * 100, {
            withSymbol: true,
          })
        : '0%';
  const ctxTok = Number(st.contextTokens || promptTok + Number(st.outputTokens || 0));
  const ctxDelta =
    prevContextTokens != null && ctxTok > 0
      ? ` (${ctxTok >= prevContextTokens ? '+' : '-'}${formatTokensPrecise(Math.abs(ctxTok - prevContextTokens))})`
      : '';
  const wf = computeStepTimingWaterfall(st);
  const lines = [
    `### Step #${st.stepIndex ?? '—'} · ${modelInfo.text}${st.isCompactionStep ? ' [Compaction]' : ''}`,
    `- **Time**: ${timeStr}`,
    ...(modelInfo.title && modelInfo.title !== modelInfo.text
      ? [`- **Model ID**: \`${modelInfo.title}\``]
      : []),
    `- **Speed / Timing**: ${formatSpeedMetric(st.tokPerSec, ' tok/s')} | TTFT ${formatMetric(st.ttftSec, 's')} | Total ${wf ? formatTimingDetailSec(wf.totalSec) : '—'}${st.selectedSpeedReason ? ` (${speedReasonText(st.selectedSpeedReason) || st.selectedSpeedReason})` : ''}`,
    `- **Tokens**: Input ${formatTokensPrecise(st.inputTokens || 0)} | Cache ${formatTokensPrecise(st.cacheReadTokens || 0)} (${cachePct}) | Output ${formatTokensPrecise(st.outputTokens || 0)} (Think ${formatTokensPrecise(st.thinkingTokens || 0)} / Reply ${formatTokensPrecise(st.responseTokens || 0)})`,
    `- **Context / Cost**: ${formatTokensPrecise(ctxTok)}${ctxDelta} | ${formatUsd(st.costUsd, { precise: true })}`,
  ];
  if (st.anomaly && Number(st.anomaly.count) > 0) {
    const kinds = Object.entries(st.anomaly.kinds || {})
      .map(([k, v]) => `${formatAnomalyKindLabel(k)}×${v}`)
      .join(', ');
    lines.push(`- **Anomalies (${st.anomaly.count})**: ${kinds || st.anomaly.primaryKind || 'error'}`);
  }
  const promptText = String(st.turnPrompt || st.rootTurnPrompt || '').trim();
  if (promptText) {
    lines.push('', '> ' + promptText.replace(/\r?\n/g, '\n> '));
  }
  return lines.join('\n');
}

/**
 * 轻量剪贴板复制工具（优先 Clipboard API，降级至隐藏 textarea execCommand）。
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyPlainTextToClipboard(text) {
  const str = String(text ?? '');
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch {
    // 降级到 DOM 复制
  }
  try {
    if (typeof document !== 'undefined' && document.body && typeof document.execCommand === 'function') {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select?.();
      const ok = document.execCommand('copy');
      if (typeof ta.remove === 'function') {
        ta.remove();
      } else {
        document.body.removeChild?.(ta);
      }
      return Boolean(ok);
    }
  } catch {
    // 忽略非浏览器环境异常
  }
  return false;
}

/**
 * 统一的「已复制」临时反馈计时器控制器（自动重置定时器并在组件销毁时清理）。
 *
 * @param {{
 *   durationMs?: number,
 *   onChange?: (copiedKey: any) => void,
 *   onCleanup?: (cleanupFn: () => void) => void,
 * }} [options={}]
 */
export function createCopiedFeedbackController({
  durationMs = 1800,
  onChange = null,
  onCleanup = null,
} = {}) {
  let activeKey = null;
  let timer = null;
  let disposed = false;

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (activeKey !== null) {
      activeKey = null;
      if (!disposed) onChange?.(null);
    }
  }

  function trigger(key = true) {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    activeKey = key;
    onChange?.(activeKey);
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      activeKey = null;
      onChange?.(null);
    }, durationMs);
    timer?.unref?.();
  }

  onCleanup?.(() => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    activeKey = null;
  });

  return {
    isCopied: (key = true) => activeKey === key,
    getActiveKey: () => activeKey,
    trigger,
    clear,
  };
}
