/**
 * @fileoverview View 2: ConsumptionView (全景消耗统计视图).
 * 采用 5 段式分析布局展示指定时间窗口内的全量 Token 与费用消耗：
 * 1. 用量概览：支持预设时间段与自定义区间筛选，通过 3+3 组合矩阵展示总 Token/调用次数、
 *    USD/CNY 预估费用、缓存命中率与命中量、新输入/缓存读取（含节省费用）/输出细分占比，以及底部 4 段比例条 (`FourSegmentBar`)。
 * 2. 历史趋势：基于 `TrendAreaChart` 渲染纯 SVG 三次贝塞尔平滑曲线面积图、峰值气泡、对齐多刻度时间轴与悬停详情浮层。
 * 3. 热门模型：按 Token 总量降序展示各模型的消耗占比徽章、4 段构成条及输入/缓存/输出/思考/调用明细。
 * 4. 数据来源：按调用来源聚合展示 Token 构成、占比与费用明细。
 * 5. 按月细分：12 个月垂直 4 段堆叠柱状图，直观对比全年各月费用、Token 总量与缓存/思考结构。
 */

import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../core/domPatch.js';
import {
  formatCnyApprox,
  formatDateSpanBadge,
  formatMetric,
  formatPctNumber,
  formatSpeedMetric,
  formatTokensPrecise,
  formatUsd,
  getCanonicalModelColorSeed,
  mergeModelsByDisplayName,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdDisplayMode,
} from '../core/formatters.js';
import {
  buildPrismModelColorMap,
  resolvePrismChartModelColor,
} from '../core/prismColors.js';
import { scaleBucketsExact } from '../../shared/telemetry-display-rules.mjs';
import {
  buildConsumptionExportBaseName,
  buildConsumptionMarkdownReport,
  buildConsumptionXlsx,
  sanitizeExportFilename,
} from '../core/reportExporter.js';
import {
  copyTextWithFeedback,
  exportBinaryFileWithFeedback,
} from '../core/fileExportClient.js';
import { i18nStore, isEnglishLocale, t } from '../i18n/index.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import { ActionMenu } from '../components/ui/ActionMenu.js';
import {
  getDefaultCtxInspectorAgentId,
  prefetchConsumptionPresets,
  selectConsumptionTimeRange,
  selectConversation,
  telemetryStore,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import {
  createTrendAreaChart,
  HEATMAP_DAYS_THRESHOLD,
} from '../components/charts/TrendAreaChart.js';
import { CustomDateTimePicker } from '../components/ui/CustomDateTimePicker.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { createFourSegmentBar } from '../components/ui/FourSegmentBar.js';
import { createConsumptionBreakdownContent } from '../components/ui/ConsumptionTooltipContent.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';

/** 消耗统计顶栏支持的时间范围预设项 */
function getConsumptionTimeRangeOptions() {
  return [
    { value: 'cycle', label: t('cons.rangeCycle') },
    { value: 'today', label: t('cons.rangeToday') },
    { value: '24h', label: t('cons.range24h') },
    { value: '7d', label: t('cons.range7d') },
    { value: '14d', label: t('cons.range14d') },
    { value: '30d', label: t('cons.range30d') },
    { value: 'all', label: t('cons.rangeAll') },
    { value: 'custom', label: t('cons.rangeCustom') },
  ];
}

function floorToStartOfMinuteMs(ms) {
  const n = Number(ms);
  if (!(n > 0)) return 0;
  const d = new Date(n);
  d.setSeconds(0, 0);
  return d.getTime();
}

function ceilToEndOfMinuteMs(ms) {
  const n = Number(ms);
  if (!(n > 0)) return 0;
  const d = new Date(n);
  d.setSeconds(59, 999);
  return d.getTime();
}

export const ConsumptionView = defineComponent({
  name: 'ConsumptionView',
  setup({ onCleanup }) {
    // --- 时间筛选栏：快速时间段分段控制器与自定义起止时间选择条 ---
    let draftStartMs = telemetryStore.getState().customStartMs;
    let draftEndMs = telemetryStore.getState().customEndMs;
    let hasUncommittedCustomDraft = false;
    let hasCommittedCustomRange = false;

    const timeFilterSwitch = SegmentedControl({
      ariaLabel: t('cons.rangeAria'),
      modelValue: telemetryStore.getState().selectedTimeRange,
      options: getConsumptionTimeRangeOptions(),
      onUpdateModelValue: (nextRange) => {
        if (nextRange === 'custom') {
          const st = telemetryStore.getState();
          if (!hasCommittedCustomRange && st.selectedTimeRange !== 'custom') {
            const nowMs = Date.now();
            draftStartMs = floorToStartOfMinuteMs(nowMs - 24 * 3600 * 1000);
            draftEndMs = ceilToEndOfMinuteMs(nowMs);
            hasUncommittedCustomDraft = false;
            startPicker.setValue(draftStartMs);
            endPicker.setValue(draftEndMs);
            selectConsumptionTimeRange('custom', {
              customStartMs: draftStartMs,
              customEndMs: draftEndMs,
            });
            return;
          }
          draftStartMs = st.customStartMs;
          draftEndMs = st.customEndMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(draftStartMs);
          endPicker.setValue(draftEndMs);
        } else {
          hasUncommittedCustomDraft = false;
        }
        selectConsumptionTimeRange(nextRange);
      },
    });

    const startPicker = CustomDateTimePicker({
      modelValue: draftStartMs,
      onUpdateModelValue: (ms) => {
        draftStartMs = ms;
        hasUncommittedCustomDraft = true;
        startPicker.setValue(ms);
      },
    });

    const endPicker = CustomDateTimePicker({
      modelValue: draftEndMs,
      onUpdateModelValue: (ms) => {
        draftEndMs = ms;
        hasUncommittedCustomDraft = true;
        endPicker.setValue(ms);
      },
    });

    const applyCustomBtnLabel = h('span', { text: t('cons.applyFilter') });
    const applyCustomBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        style: 'height: 26px; padding: 0 10px;',
        onClick: () => {
          const sMs = Number(draftStartMs || 0);
          const eMs = Number(draftEndMs || 0);
          const rawMinMs = sMs > 0 && eMs > 0 ? Math.min(sMs, eMs) : sMs;
          const rawMaxMs = sMs > 0 && eMs > 0 ? Math.max(sMs, eMs) : eMs;
          const minMs = floorToStartOfMinuteMs(rawMinMs);
          const maxMs = ceilToEndOfMinuteMs(rawMaxMs);
          draftStartMs = minMs;
          draftEndMs = maxMs;
          hasUncommittedCustomDraft = false;
          hasCommittedCustomRange = true;
          startPicker.setValue(minMs);
          endPicker.setValue(maxMs);
          selectConsumptionTimeRange('custom', {
            customStartMs: minMs,
            customEndMs: maxMs,
          });
        },
      },
      [createSvgIcon('check', { size: 12 }), applyCustomBtnLabel]
    );

    const rangeToSpan = h('span', { className: 'text-muted', text: t('cons.rangeTo') });
    const customRangeBar = h(
      'div',
      {
        className: 'cons-custom-range-bar',
        hidden: true,
      },
      [
        startPicker.el,
        rangeToSpan,
        endPicker.el,
        applyCustomBtn,
      ]
    );

    // --- Section 1: 用量概览矩阵 (上层 3 列核心总量 + 下层 3 列新输入/缓存读取/输出拆分 + 底部 4 段比例条) ---
    const dateSpanBadge = h('span', { className: 'cons-badge text-mono', text: '-- ~ --' });
    const heroTotalTokens = h('strong', { className: 'cons-hero-num text-mono', text: '0' });
    const heroTotalCalls = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.callsCount', { calls: 0 }) });
    const heroCostUsd = h('strong', { className: 'cons-hero-cost text-mono', text: '$0.00' });
    const heroCostCny = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: '≈ ¥0' });

    const cacheHitPctEl = h('strong', { className: 'cons-hero-cache text-mono', text: '0%' });
    const cacheTokensEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.cacheHitTokens', { tokens: 0 }) });

    const inputSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-input); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const inputMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const inputSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.uncachedInput') });

    const cacheSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-cached); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const cacheMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const cacheSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.savedCost', { cost: '$0.00' }) });

    const outputSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-output); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const outputMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const outputSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.replyAndThink', { resp: 0, think: 0 }) });

    const overviewSegBar = createFourSegmentBar();
    const consExportMenu = ActionMenu({
      ariaLabel: t('cons.exportMenuAria'),
      className: 'cons-export-menu',
      items: [
        {
          key: 'xlsx',
          icon: 'download',
          label: t('cons.exportXlsx'),
          title: t('cons.exportXlsxTip'),
          onSelect: () => {
            const cons = latestSlice?.consumption;
            if (!cons) return;
            const displaySettings = {
              modelDisplayMode: latestSlice?.modelDisplayMode,
              showUpstreamModel: latestSlice?.showUpstreamModel,
              orchestratorIdMode: latestSlice?.orchestratorIdMode,
            };
            const bytes = buildConsumptionXlsx(cons, latestSlice?.modelBreakdown || [], {
              displaySettings,
            });
            const baseName = buildConsumptionExportBaseName(
              cons,
              latestSlice?.range || 'all'
            );
            void exportBinaryFileWithFeedback(
              sanitizeExportFilename(baseName, 'xlsx'),
              bytes
            );
          },
        },
        {
          key: 'md',
          icon: 'copy',
          label: t('cons.exportMd'),
          title: t('cons.exportMdTip'),
          onSelect: () => {
            const cons = latestSlice?.consumption;
            if (!cons) return;
            const displaySettings = {
              modelDisplayMode: latestSlice?.modelDisplayMode,
              showUpstreamModel: latestSlice?.showUpstreamModel,
              orchestratorIdMode: latestSlice?.orchestratorIdMode,
            };
            const md = buildConsumptionMarkdownReport(cons, latestSlice?.modelBreakdown || [], {
              displaySettings,
            });
            void copyTextWithFeedback(md, t('cons.exportMdDone'));
          },
        },
      ],
    });
    consExportMenu.refs.setHidden(true);
    const totalTokensLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.totalTokens') });
    const estCostLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.estCost') });
    const cacheHitRateLabel = h('span', { text: t('cons.cacheHitRate') });
    const newInputLabel = h('span', { text: t('cons.newInput') });
    const cacheReadLabel = h('span', { text: t('cons.cacheRead') });
    const outputUsageLabel = h('span', { text: t('cons.outputUsage') });

    const overviewPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header cons-overview-head' }, [
        h('span', { className: 'panel-title' }, [
          dateSpanBadge,
        ]),
        h('div', { className: 'cons-overview-controls' }, [
          timeFilterSwitch.el,
          consExportMenu.el,
        ]),
      ]),
      customRangeBar,
      h('div', { className: 'cons-box cons-unified-matrix' }, [
        h('div', { className: 'cons-split-3' }, [
          h('div', { className: 'cons-col' }, [
            totalTokensLabel,
            h('div', { className: 'cons-baseline' }, [heroTotalTokens, heroTotalCalls]),
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            estCostLabel,
            h('div', { className: 'cons-baseline' }, [heroCostUsd, heroCostCny]),
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('span', { className: 'legend-left', style: 'font-size: var(--fs-md);' }, [
              h('span', { className: 'dot-swatch seg-cached' }),
              cacheHitRateLabel,
            ]),
            h('div', { className: 'cons-baseline' }, [cacheHitPctEl, cacheTokensEl]),
          ]),
        ]),
        h('div', { className: 'cons-split-3 cons-matrix-bottom' }, [
          h('div', { className: 'cons-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-input' }),
                newInputLabel,
              ]),
              inputSharePct,
            ]),
            inputMainTokens,
            inputSubText,
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-cached' }),
                cacheReadLabel,
              ]),
              cacheSharePct,
            ]),
            cacheMainTokens,
            cacheSubText,
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-output' }),
                outputUsageLabel,
              ]),
              outputSharePct,
            ]),
            outputMainTokens,
            outputSubText,
          ]),
        ]),
      ]),
      overviewSegBar.el,
    ]);

    function drillDownToTimeRange(startMs, endMs) {
      const minMs = floorToStartOfMinuteMs(startMs);
      const maxMs = ceilToEndOfMinuteMs(endMs);
      if (!(minMs > 0) || !(maxMs > minMs)) return;
      hideBreakdownPopover();
      draftStartMs = minMs;
      draftEndMs = maxMs;
      hasUncommittedCustomDraft = false;
      hasCommittedCustomRange = true;
      startPicker.setValue(minMs);
      endPicker.setValue(maxMs);
      selectConsumptionTimeRange('custom', {
        customStartMs: minMs,
        customEndMs: maxMs,
      });
    }

    // --- Section 2: 历史趋势 (交互式 SVG 平滑曲线图 + 悬停精确日期/小时浮层 + 点击时段下钻) ---
    const trendTitleSpan = h('span', { text: t('cons.trendTitle') });
    const trendRangeBadge = h('span', { className: 'cons-badge', text: t('cons.allTime') });
    const trendGranularityHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.trendPointsHintHourly', { points: 0 }),
    });
    const trendChart = createTrendAreaChart({
      onSelectSlot: (slot) => {
        if (slot && Number(slot.startMs) > 0 && Number(slot.endMs) > Number(slot.startMs)) {
          drillDownToTimeRange(slot.startMs, slot.endMs);
        }
      },
    });

    const trendPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          trendTitleSpan,
          trendRangeBadge,
        ]),
        trendGranularityHint,
      ]),
      trendChart.el,
    ]);

    // --- Section 3: 统一排行卡片（分段切换「模型排行 | 项目排行 | 会话排行」，右侧联动对应排序切换） ---
    let activeRankingTab = 'models';
    let modelsSortBy = 'tokens';
    let topConvsSortBy = 'cost';
    let lastModelsCount = 0;
    let lastWorkspacesCount = 0;
    let lastConvsCount = 0;

    function getRankingTabOptions(
      modelsCount = lastModelsCount,
      convsCount = lastConvsCount,
      workspacesCount = lastWorkspacesCount
    ) {
      const opts = [
        {
          value: 'models',
          label:
            modelsCount > 0
              ? t('cons.rankTabModelsCount', { count: modelsCount })
              : t('cons.topModels'),
        },
      ];
      if (workspacesCount > 0) {
        opts.push({
          value: 'workspaces',
          label: t('cons.rankTabWorkspacesCount', { count: workspacesCount }),
        });
      }
      opts.push({
        value: 'sessions',
        label:
          convsCount > 0
            ? t('cons.rankTabSessionsCount', { count: convsCount })
            : t('cons.rankTabSessions'),
      });
      return opts;
    }

    function getModelsSortOptions() {
      return [
        { value: 'tokens', label: t('cons.modelsSortTokens') },
        { value: 'cost', label: t('cons.modelsSortCost') },
        { value: 'speed', label: t('cons.modelsSortSpeed') },
        { value: 'calls', label: t('cons.modelsSortCalls') },
      ];
    }

    function getTopConvsSortOptions() {
      return [
        { value: 'cost', label: t('cons.topConvsSortCost') },
        { value: 'tokens', label: t('cons.topConvsSortTokens') },
      ];
    }

    const rankingTabSwitch = SegmentedControl({
      ariaLabel: t('cons.rankTabAria'),
      modelValue: activeRankingTab,
      options: getRankingTabOptions(0, 0, 0),
      onUpdateModelValue: (nextTab) => {
        if (nextTab !== 'models' && nextTab !== 'sessions' && nextTab !== 'workspaces') return;
        activeRankingTab = nextTab;
        rankingTabSwitch.setValue(nextTab);
        if (latestSlice) {
          renderConsumptionData(latestSlice);
        }
      },
    });

    const modelsSortSwitch = SegmentedControl({
      ariaLabel: t('cons.modelsSortAria'),
      modelValue: modelsSortBy,
      options: getModelsSortOptions(),
      onUpdateModelValue: (nextSort) => {
        if (!['tokens', 'cost', 'speed', 'calls'].includes(nextSort)) return;
        modelsSortBy = nextSort;
        modelsSortSwitch.setValue(nextSort);
        if (latestSlice) {
          renderConsumptionData(latestSlice);
        }
      },
    });

    const topConvsSortSwitch = SegmentedControl({
      ariaLabel: t('cons.topConvsSortAria'),
      modelValue: topConvsSortBy,
      options: getTopConvsSortOptions(),
      onUpdateModelValue: (nextSort) => {
        if (nextSort !== 'cost' && nextSort !== 'tokens') return;
        topConvsSortBy = nextSort;
        topConvsSortSwitch.setValue(nextSort);
        if (latestSlice) {
          renderConsumptionData(latestSlice);
        }
      },
    });
    patchAttr(topConvsSortSwitch.el, 'hidden', true);

    const rankingSortWrap = h('div', { className: 'cons-ranking-sort-wrap' }, [
      modelsSortSwitch.el,
      topConvsSortSwitch.el,
    ]);
    const modelsListEl = h('div', { className: 'cons-item-list' });
    const topConvsListEl = h('div', { className: 'cons-item-list', hidden: true });
    const workspacesListEl = h('div', { className: 'cons-item-list', hidden: true });
    const topConvsEmptyEl = h('div', {
      className: 'cons-ranking-empty text-muted',
      hidden: true,
      text: t('cons.topConvsEmpty'),
    });
    const rankingPanel = h('section', { className: 'panel cons-ranking-panel' }, [
      h('div', { className: 'panel-header cons-ranking-head' }, [
        rankingTabSwitch.el,
        rankingSortWrap,
      ]),
      modelsListEl,
      topConvsListEl,
      workspacesListEl,
      topConvsEmptyEl,
    ]);

    // --- Section 4: 客户端来源列表 ---
    const sourcesTitleSpan = h('span', { className: 'panel-title', text: t('cons.clientSources') });
    const sourcesHoverHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.hoverModelsHint'),
    });
    const sourcesListEl = h('div', { className: 'cons-item-list' });
    const sourcesPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        sourcesTitleSpan,
        sourcesHoverHint,
      ]),
      sourcesListEl,
    ]);

    // --- Section 5: 按月细分 (12 个月垂直按模型配色堆叠柱状图 + 悬停明细浮层) ---
    const monthlyTitleSpan = h('span', { text: t('cons.monthlyTitle') });
    const monthlyYearBadge = h('span', { className: 'cons-badge text-mono', text: '2026' });
    const monthlyHoverHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.hoverModelsHint'),
    });

    let activeHoverTargetEl = null;
    let cachedBreakdownRootRect = null;
    let cachedBreakdownAnchorRect = null;

    const popoverContent = createConsumptionBreakdownContent({
      showModelDot: true,
      monoTitle: false,
    });
    const breakdownPopoverEl = h(
      'div',
      { className: 'cons-breakdown-popover is-rich-breakdown', hidden: true },
      popoverContent.children
    );

    function hideBreakdownPopover() {
      cachedBreakdownRootRect = null;
      cachedBreakdownAnchorRect = null;
      if (activeHoverTargetEl) {
        patchClasses(activeHoverTargetEl, { 'is-hovered': false });
        activeHoverTargetEl = null;
      }
      patchAttr(breakdownPopoverEl, 'hidden', true);
      patchClasses(breakdownPopoverEl, { 'is-tracking': false });
    }

    function positionBreakdownPopover(anchorEl, pointerClientX = null, pointerClientY = null) {
      if (!cachedBreakdownRootRect) {
        cachedBreakdownRootRect = rootEl.getBoundingClientRect?.() || {
          left: 0,
          top: 0,
          width: 360,
          height: 600,
        };
      }
      const rootRect = cachedBreakdownRootRect;
      if (!cachedBreakdownAnchorRect) {
        cachedBreakdownAnchorRect = anchorEl?.getBoundingClientRect?.() || {
          left: 0,
          top: 0,
          bottom: 0,
          width: 0,
          height: 0,
        };
      }
      const anchorRect = cachedBreakdownAnchorRect;
      const tipW = Number(breakdownPopoverEl.offsetWidth || 0) || 216;
      const tipH = Number(breakdownPopoverEl.offsetHeight || 0) || 108;
      const rootW = rootRect.width > 0 ? rootRect.width : 360;
      const rootH = rootRect.height > 0 ? rootRect.height : 600;

      const hasPointerX = Number.isFinite(pointerClientX) && pointerClientX > 0 && rootRect.width > 0;
      const hasPointerY = Number.isFinite(pointerClientY) && pointerClientY > 0 && rootRect.height > 0;

      const centerX = hasPointerX
        ? pointerClientX - rootRect.left
        : anchorRect.left - rootRect.left + anchorRect.width / 2;
      const anchorY = hasPointerY
        ? pointerClientY - rootRect.top
        : anchorRect.top - rootRect.top;

      const maxLeft = Math.max(8, rootW - tipW - 8);
      let leftPx = Math.max(8, Math.min(maxLeft, centerX - tipW / 2));

      const aboveTop = anchorY - tipH - (hasPointerY ? 14 : 8);
      const belowTop = hasPointerY ? anchorY + 18 : anchorRect.bottom - rootRect.top + 8;
      let topPx;
      if (aboveTop >= 6) {
        topPx = Math.min(Math.max(6, rootH - tipH - 6), aboveTop);
      } else if (hasPointerX && centerX + 16 + tipW <= rootW - 8) {
        leftPx = centerX + 16;
        topPx = Math.max(6, Math.min(Math.max(6, rootH - tipH - 6), anchorY - tipH / 2));
      } else if (hasPointerX && centerX - 16 - tipW >= 8) {
        leftPx = centerX - 16 - tipW;
        topPx = Math.max(6, Math.min(Math.max(6, rootH - tipH - 6), anchorY - tipH / 2));
      } else {
        topPx = Math.min(Math.max(6, rootH - tipH - 6), Math.max(6, belowTop));
      }

      patchStyleVar(breakdownPopoverEl, '--pop-x', `${Math.round(leftPx)}px`);
      patchStyleVar(breakdownPopoverEl, '--pop-y', `${Math.round(topPx)}px`);
    }

    function showBreakdownPopover(
      anchorEl,
      payload,
      pointerClientX = null,
      pointerClientY = null
    ) {
      if (!payload || !(payload.totalTokens > 0 || payload.calls > 0)) {
        hideBreakdownPopover();
        return;
      }
      if (activeHoverTargetEl && activeHoverTargetEl !== anchorEl) {
        patchClasses(activeHoverTargetEl, { 'is-hovered': false });
        cachedBreakdownAnchorRect = null;
      } else if (!activeHoverTargetEl) {
        cachedBreakdownRootRect = null;
        cachedBreakdownAnchorRect = null;
      }
      activeHoverTargetEl = anchorEl;
      patchClasses(anchorEl, { 'is-hovered': true });

      popoverContent.update({
        title: payload.title || '—',
        calls: payload.calls || 0,
        totalTokens: payload.totalTokens || 0,
        costText: payload.costText || '$0.00',
        inputTokens: payload.inputTokens,
        cacheReadTokens: payload.cacheReadTokens,
        thinkingTokens: payload.thinkingTokens,
        responseTokens: payload.responseTokens,
        outputTokens: payload.outputTokens,
        segments: Array.isArray(payload.segments) ? payload.segments : [],
      });

      const wasHidden = breakdownPopoverEl.hasAttribute('hidden');
      patchAttr(breakdownPopoverEl, 'hidden', false);
      positionBreakdownPopover(anchorEl, pointerClientX, pointerClientY);
      if (wasHidden) {
        patchClasses(breakdownPopoverEl, { 'is-tracking': false });
        void breakdownPopoverEl.offsetWidth;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => {
            if (!breakdownPopoverEl.hasAttribute('hidden')) {
              patchClasses(breakdownPopoverEl, { 'is-tracking': true });
            }
          });
        } else {
          patchClasses(breakdownPopoverEl, { 'is-tracking': true });
        }
      }
    }

    function createMonthModelSegment() {
      const segEl = h('div', { className: 'month-seg cons-model-seg' });
      return { el: segEl, refs: { segEl } };
    }

    const monthlyCols = Array.from({ length: 12 }, (_, idx) => {
      const costText = h('span', { className: 'month-cost text-mono', text: '' });
      const stackWrap = h('div', { className: 'month-stack' });
      const zeroDot = h('span', { className: 'month-zero-dot' });
      const monthLabel = h('span', { className: 'month-label', text: t('cons.monthLabel', { m: idx + 1 }) });
      const tokText = h('span', { className: 'month-tok text-mono', text: '' });

      const colState = { hoverPayload: null, monthRange: null };
      const colEl = h(
        'div',
        {
          className: 'month-col',
          onClick: () => {
            if (colState.monthRange) {
              drillDownToTimeRange(colState.monthRange.startMs, colState.monthRange.endMs);
            }
          },
          onMouseEnter: (e) => {
            if (colState.hoverPayload) {
              showBreakdownPopover(
                colEl,
                colState.hoverPayload,
                e?.clientX ?? null,
                e?.clientY ?? null
              );
            } else {
              e?.stopPropagation?.();
            }
          },
          onMouseMove: (e) => {
            if (colState.hoverPayload && activeHoverTargetEl === colEl) {
              positionBreakdownPopover(colEl, e?.clientX ?? null, e?.clientY ?? null);
            }
          },
          onMouseLeave: () => {
            if (activeHoverTargetEl === colEl) hideBreakdownPopover();
          },
        },
        [
          costText,
          h('div', { className: 'month-bar-well' }, [stackWrap, zeroDot]),
          monthLabel,
          tokText,
        ]
      );
      return {
        el: colEl,
        costText,
        stackWrap,
        zeroDot,
        monthLabel,
        tokText,
        colState,
      };
    });

    const monthlyPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          monthlyTitleSpan,
          monthlyYearBadge,
        ]),
        monthlyHoverHint,
      ]),
      h(
        'div',
        { className: 'monthly-grid' },
        monthlyCols.map((c) => c.el)
      ),
    ]);

    const scrollInner = h(
      'div',
      {
        style: 'display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: var(--space-3);',
      },
      [
        overviewPanel,
        trendPanel,
        rankingPanel,
        sourcesPanel,
        monthlyPanel,
      ]
    );

    const viewScrollbar = CustomScrollbar({
      contentEl: scrollInner,
      className: 'view-pane',
    });
    viewScrollbar.el.addEventListener?.('scroll', hideBreakdownPopover, { passive: true });

    const rootEl = h('div', { className: 'cons-view-stage' }, [
      viewScrollbar.el,
      breakdownPopoverEl,
    ]);

    /**
     * 将分模型列表收敛为主力模型 + 长尾「其他 (N)」，避免进度条尾部与浮层出现 0.0% 碎屑噪音。
     */
    function partitionModelSegments(
      mergedModels,
      modelColorMap,
      { maxMain = 5, minSharePct = 1.5 } = {}
    ) {
      if (!Array.isArray(mergedModels) || mergedModels.length === 0) return [];
      const sumTok = mergedModels.reduce((sum, m) => sum + Number(m.totalTokens || 0), 0);
      const mainModels = [];
      const tailModels = [];

      for (let i = 0; i < mergedModels.length; i++) {
        const m = mergedModels[i];
        const mTok = Number(m.totalTokens || 0);
        const sharePct = sumTok > 0 ? (mTok / sumTok) * 100 : 0;
        if (i === 0 || (mainModels.length < maxMain && sharePct >= minSharePct)) {
          mainModels.push(m);
        } else {
          tailModels.push(m);
        }
      }

      if (tailModels.length === 1) {
        mainModels.push(tailModels.pop());
      }

      const out = mainModels.map((m) => {
        const seed = getCanonicalModelColorSeed(m);
        const color =
          modelColorMap?.get(seed) || resolvePrismChartModelColor(seed || m.displayText);
        const tok = Number(m.totalTokens || 0);
        const pct = sumTok > 0 ? (tok / sumTok) * 100 : 0;
        const label = m.displayText || m.label || m.shortName || '—';
        const inputTokens = Math.max(0, Number(m.inputTokens || 0));
        const cacheReadTokens = Math.max(0, Number(m.cacheReadTokens || 0));
        const thinkingTokens = Math.max(0, Number(m.thinkingTokens || 0));
        const responseTokens =
          m.responseTokens != null
            ? Math.max(0, Number(m.responseTokens))
            : Math.max(0, Number(m.outputTokens || 0) - thinkingTokens);
        return {
          key: label,
          label,
          tok,
          pct,
          inputTokens,
          cacheReadTokens,
          thinkingTokens,
          responseTokens,
          outputTokens: responseTokens + thinkingTokens,
          tokText: formatTokensPrecise(tok),
          pctText: formatPctNumber(pct, { withSymbol: true }),
          color,
          isOther: false,
        };
      });

      if (tailModels.length >= 2) {
        let otherTok = 0;
        let otherIn = 0;
        let otherCache = 0;
        let otherThink = 0;
        let otherResp = 0;
        for (const m of tailModels) {
          const mt = Math.max(0, Number(m.thinkingTokens || 0));
          const mr =
            m.responseTokens != null
              ? Math.max(0, Number(m.responseTokens))
              : Math.max(0, Number(m.outputTokens || 0) - mt);
          otherTok += Number(m.totalTokens || 0);
          otherIn += Math.max(0, Number(m.inputTokens || 0));
          otherCache += Math.max(0, Number(m.cacheReadTokens || 0));
          otherThink += mt;
          otherResp += mr;
        }
        const otherPct = sumTok > 0 ? (otherTok / sumTok) * 100 : 0;
        const otherLabel = t('cons.otherModelsCount', { count: tailModels.length });
        out.push({
          key: '__other__',
          label: otherLabel,
          tok: otherTok,
          pct: otherPct,
          inputTokens: otherIn,
          cacheReadTokens: otherCache,
          thinkingTokens: otherThink,
          responseTokens: otherResp,
          outputTokens: otherResp + otherThink,
          tokText: formatTokensPrecise(otherTok),
          pctText: formatPctNumber(otherPct, { withSymbol: true }),
          color: 'var(--cons-other-seg)',
          isOther: true,
        });
      }

      return out;
    }

    /**
     * 创建热门模型单行 DOM 结构（模型名称 + 按总占比缩放的 4 段比例条 + 底部分项脚标）。
     */
    function createBreakdownItemRow() {
      const nameTextEl = h('span', { className: 'cons-row-title-text' });
      const nameEl = h('strong', { className: 'cons-row-title' }, [nameTextEl]);
      const pctBadge = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
      const totalTokEl = h('span', { className: 'cons-row-tok text-mono' });
      const costEl = h('strong', { className: 'cons-row-cost text-mono' });
      const segBar = createFourSegmentBar();

      const inLbl = h('span', { text: t('cons.footInput') });
      const cacheLbl = h('span', { text: t('cons.footCache') });
      const outLbl = h('span', { text: t('cons.footOutput') });
      const thinkLbl = h('span', { text: t('cons.footThinking') });
      const callsLbl = h('span', { text: t('cons.footCalls') });

      const inVal = h('strong', { className: 'text-mono' });
      const cacheVal = h('strong', { className: 'text-mono' });
      const outVal = h('strong', { className: 'text-mono' });
      const thinkVal = h('strong', { className: 'text-mono' });
      const callsVal = h('strong', { className: 'text-mono' });
      const metricBarFillEl = h('div', { className: 'progress-seg cons-metric-fill' });
      const metricBarEl = h(
        'div',
        { className: 'progress-track cons-seg-bar cons-metric-bar', hidden: true },
        [metricBarFillEl]
      );
      const tokenFootEl = h('div', { className: 'cons-item-foot' }, [
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-input' }),
          inLbl,
          inVal,
        ]),
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-cached' }),
          cacheLbl,
          cacheVal,
        ]),
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-thinking' }),
          thinkLbl,
          thinkVal,
        ]),
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-output' }),
          outLbl,
          outVal,
        ]),
        h('span', { className: 'legend-left' }, [
          callsLbl,
          callsVal,
        ]),
      ]);
      const perfMainEl = h('span', { className: 'cons-model-perf-main text-mono' });
      const perfUnitCostEl = h('span', { className: 'cons-model-unit-cost text-mono', hidden: true });
      const perfFootEl = h('div', { className: 'cons-model-perf-foot', hidden: true }, [
        perfMainEl,
        perfUnitCostEl,
      ]);
      const focusLeftEl = h('span', { className: 'cons-model-focus-left text-mono' });
      const focusRightEl = h('span', { className: 'cons-model-focus-right text-mono' });
      const focusFootEl = h(
        'div',
        { className: 'cons-item-foot cons-model-focus-foot', hidden: true },
        [focusLeftEl, focusRightEl]
      );

      const rowEl = h('div', { className: 'cons-item-row' }, [
        h('div', { className: 'panel-header' }, [
          nameEl,
          h('span', { className: 'cons-row-metrics' }, [
            pctBadge,
            totalTokEl,
            costEl,
          ]),
        ]),
        segBar.el,
        metricBarEl,
        tokenFootEl,
        perfFootEl,
        focusFootEl,
      ]);

      return {
        el: rowEl,
        refs: {
          nameEl,
          nameTextEl,
          pctBadge,
          totalTokEl,
          costEl,
          segBar,
          metricBarEl,
          metricBarFillEl,
          tokenFootEl,
          inLbl,
          cacheLbl,
          outLbl,
          thinkLbl,
          callsLbl,
          inVal,
          cacheVal,
          outVal,
          thinkVal,
          callsVal,
          perfFootEl,
          perfMainEl,
          perfUnitCostEl,
          focusFootEl,
          focusLeftEl,
          focusRightEl,
        },
      };
    }

    /**
     * 增量更新模型排行单行：
     * - `tokens` 模式展示完整四段 Token 构成及效率副行；
     * - `cost` / `speed` / `calls` 模式切换对应占比百分比、进度条尺度及聚焦单行脚标。
     */
    function updateBreakdownItemRow(refs, item, totalsCtx, sortMode = 'tokens') {
      const displayLabel = item.label || item.name || item.shortName || '—';
      patchText(refs.nameTextEl, displayLabel);
      patchAttr(refs.nameEl, 'title', item.title || displayLabel);

      const total = Number(item.totalTokens || 0);
      const costVal = Number(item.costUsd || 0);
      const callsCount = Number(item.calls || 0);
      const isAllUnpriced =
        callsCount > 0 && Number(item.unpricedCalls || 0) >= callsCount && !(costVal > 0);
      const costText = formatUsd(isAllUnpriced ? null : costVal, {
        precise: costVal > 0 && costVal < 0.1,
      });

      const avgTps =
        item.avgTokPerSec != null &&
        Number.isFinite(Number(item.avgTokPerSec)) &&
        Number(item.avgTokPerSec) > 0
          ? Number(item.avgTokPerSec)
          : null;
      const avgTtft =
        item.avgTtftSec != null &&
        Number.isFinite(Number(item.avgTtftSec)) &&
        Number(item.avgTtftSec) >= 0
          ? Number(item.avgTtftSec)
          : null;
      const hasExplicitCachePct =
        item.cacheHitPct != null && Number.isFinite(Number(item.cacheHitPct));
      const promptTok = Number(item.inputTokens || 0) + Number(item.cacheReadTokens || 0);
      const cachePctVal = hasExplicitCachePct
        ? Number(item.cacheHitPct)
        : promptTok > 0 && Number(item.cacheReadTokens || 0) > 0
          ? +((Number(item.cacheReadTokens || 0) / promptTok) * 100).toFixed(1)
          : 0;
      const cachePctStr = formatPctNumber(cachePctVal);
      const effCostPer1M =
        !isAllUnpriced && costVal > 0 && total >= 1000 ? costVal / (total / 1_000_000) : null;
      const outTok = Number(
        item.outputTokens ??
          Number(item.responseTokens || 0) + Number(item.thinkingTokens || 0)
      );

      if (sortMode === 'cost') {
        const costBase = Number(totalsCtx?.totalCost || 0);
        const costShare = costBase > 0 ? +((costVal / costBase) * 100).toFixed(1) : 0;
        const barPct = costBase > 0 && costVal > 0 ? Math.min(100, Math.max(1, (costVal / costBase) * 100)) : 0;
        patchAttr(refs.pctBadge, 'hidden', false);
        patchAttr(refs.pctBadge, 'title', null);
        patchText(refs.pctBadge, formatPctNumber(costShare, { withSymbol: true }));
        patchText(refs.totalTokEl, isAllUnpriced ? '' : formatCnyApprox(costVal));
        patchText(refs.costEl, costText);

        patchAttr(refs.segBar.el, 'hidden', true);
        patchAttr(refs.metricBarEl, 'hidden', false);
        patchStyleVar(refs.metricBarFillEl, '--seg-w', `${barPct.toFixed(2)}%`);
        patchClasses(refs.metricBarFillEl, {
          'tone-cost': true,
          'tone-speed': false,
          'tone-calls': false,
        });

        patchAttr(refs.tokenFootEl, 'hidden', true);
        patchAttr(refs.perfFootEl, 'hidden', true);
        patchAttr(refs.focusFootEl, 'hidden', false);
        const unitPart =
          effCostPer1M !== null
            ? t('cons.modelUnitCost', {
                cost: formatUsd(effCostPer1M, { precise: effCostPer1M < 0.1 }),
              })
            : '';
        const cachePart = t('cons.topConvCacheMeta', { pct: cachePctStr });
        patchText(refs.focusLeftEl, unitPart ? `${unitPart} · ${cachePart}` : cachePart);
        patchText(
          refs.focusRightEl,
          `${formatTokensPrecise(total)} · ${t('cons.callsCount', { calls: callsCount })}`
        );
        return;
      }

      if (sortMode === 'speed') {
        const maxTps = Number(totalsCtx?.maxAvgTps || 0);
        const speedPct =
          maxTps > 0 && avgTps !== null ? Math.min(100, Math.max(2, (avgTps / maxTps) * 100)) : 0;
        patchAttr(refs.pctBadge, 'hidden', avgTps === null);
        patchAttr(refs.pctBadge, 'title', avgTps !== null ? t('cons.speedRelTip') : null);
        patchText(refs.pctBadge, avgTps !== null ? `${Math.round(speedPct)}%` : '');
        patchText(
          refs.totalTokEl,
          avgTtft !== null ? t('cons.focusTtft', { ttft: formatMetric(avgTtft, 's') }) : ''
        );
        patchText(refs.costEl, formatSpeedMetric(avgTps, ' tok/s'));

        patchAttr(refs.segBar.el, 'hidden', true);
        patchAttr(refs.metricBarEl, 'hidden', false);
        patchStyleVar(refs.metricBarFillEl, '--seg-w', `${speedPct.toFixed(2)}%`);
        patchClasses(refs.metricBarFillEl, {
          'tone-cost': false,
          'tone-speed': true,
          'tone-calls': false,
        });

        patchAttr(refs.tokenFootEl, 'hidden', true);
        patchAttr(refs.perfFootEl, 'hidden', true);
        patchAttr(refs.focusFootEl, 'hidden', false);
        patchText(
          refs.focusLeftEl,
          t('cons.focusSpeedMeta', {
            ttft: formatMetric(avgTtft, 's'),
            cache: cachePctStr,
            out: formatTokensPrecise(outTok),
          })
        );
        patchText(refs.focusRightEl, t('cons.callsCount', { calls: callsCount }));
        return;
      }

      if (sortMode === 'calls') {
        const callsBase = Number(totalsCtx?.totalCalls || 0);
        const callsShare = callsBase > 0 ? +((callsCount / callsBase) * 100).toFixed(1) : 0;
        const barPct =
          callsBase > 0 && callsCount > 0 ? Math.min(100, Math.max(1, (callsCount / callsBase) * 100)) : 0;
        patchAttr(refs.pctBadge, 'hidden', false);
        patchAttr(refs.pctBadge, 'title', null);
        patchText(refs.pctBadge, formatPctNumber(callsShare, { withSymbol: true }));
        patchText(refs.totalTokEl, formatTokensPrecise(total));
        patchText(refs.costEl, t('cons.callsCount', { calls: callsCount }));

        patchAttr(refs.segBar.el, 'hidden', true);
        patchAttr(refs.metricBarEl, 'hidden', false);
        patchStyleVar(refs.metricBarFillEl, '--seg-w', `${barPct.toFixed(2)}%`);
        patchClasses(refs.metricBarFillEl, {
          'tone-cost': false,
          'tone-speed': false,
          'tone-calls': true,
        });

        patchAttr(refs.tokenFootEl, 'hidden', true);
        patchAttr(refs.perfFootEl, 'hidden', true);
        patchAttr(refs.focusFootEl, 'hidden', false);
        const avgPerCall = callsCount > 0 ? total / callsCount : 0;
        patchText(
          refs.focusLeftEl,
          t('cons.focusCallsMeta', {
            avgTok: formatTokensPrecise(avgPerCall),
            cost: costText,
          })
        );
        patchText(refs.focusRightEl, t('cons.topConvCacheMeta', { pct: cachePctStr }));
        return;
      }

      // 默认 Token 模式：展示全部四段 Token 构成及效率副行
      patchText(refs.inLbl, t('cons.footInput'));
      patchText(refs.cacheLbl, t('cons.footCache'));
      patchText(refs.outLbl, t('cons.footOutput'));
      patchText(refs.thinkLbl, t('cons.footThinking'));
      patchText(refs.callsLbl, t('cons.footCalls'));
      const grandTotalTokens = Number(totalsCtx?.totalTokens || 0);
      const share = grandTotalTokens > 0 ? +((total / grandTotalTokens) * 100).toFixed(1) : 0;
      const scaleRatio =
        grandTotalTokens > 0 && total > 0 ? Math.min(1, Math.max(0.008, total / grandTotalTokens)) : 0;
      patchAttr(refs.pctBadge, 'hidden', false);
      patchAttr(refs.pctBadge, 'title', null);
      patchText(refs.pctBadge, formatPctNumber(share, { withSymbol: true }));
      patchText(refs.totalTokEl, formatTokensPrecise(total));
      patchText(refs.costEl, costText);

      const responseTok =
        item.responseTokens != null
          ? Number(item.responseTokens)
          : Math.max(0, Number(item.outputTokens || 0) - Number(item.thinkingTokens || 0));
      const thinkingTok = Number(item.thinkingTokens || 0);

      patchAttr(refs.segBar.el, 'hidden', false);
      patchAttr(refs.metricBarEl, 'hidden', true);
      refs.segBar.update({
        inputTokens: Number(item.inputTokens || 0),
        cacheReadTokens: Number(item.cacheReadTokens || 0),
        responseTokens: responseTok,
        thinkingTokens: thinkingTok,
        scaleRatio,
      });

      patchAttr(refs.tokenFootEl, 'hidden', false);
      patchAttr(refs.focusFootEl, 'hidden', true);
      patchText(refs.inVal, formatTokensPrecise(item.inputTokens || 0));
      patchText(refs.cacheVal, formatTokensPrecise(item.cacheReadTokens || 0));
      patchText(refs.outVal, formatTokensPrecise(responseTok));
      patchText(refs.thinkVal, formatTokensPrecise(thinkingTok));
      patchText(refs.callsVal, String(callsCount));

      const hasPerfMeta = avgTps !== null || avgTtft !== null || effCostPer1M !== null;
      patchAttr(refs.perfFootEl, 'hidden', !hasPerfMeta);
      if (hasPerfMeta) {
        if (avgTps !== null || avgTtft !== null) {
          patchText(
            refs.perfMainEl,
            t('steps.modelPerfFoot', {
              tps: formatSpeedMetric(avgTps, ' tok/s'),
              ttft: formatMetric(avgTtft, 's'),
              cache: cachePctStr,
            })
          );
        } else {
          patchText(refs.perfMainEl, t('cons.topConvCacheMeta', { pct: cachePctStr }));
        }
        patchAttr(refs.perfUnitCostEl, 'hidden', effCostPer1M === null);
        patchText(
          refs.perfUnitCostEl,
          effCostPer1M !== null
            ? t('cons.modelUnitCost', {
                cost: formatUsd(effCostPer1M, { precise: effCostPer1M < 0.1 }),
              })
            : ''
        );
      }
    }

    function createSourceModelSegment() {
      const segEl = h('div', { className: 'progress-seg cons-model-seg' });
      return { el: segEl, refs: { segEl } };
    }

    function createSourceTopModelItem() {
      const dotEl = h('span', { className: 'dot-swatch cons-model-dot cons-source-top-dot' });
      const nameEl = h('span', { className: 'cons-source-top-name' });
      const pctEl = h('strong', { className: 'cons-source-top-pct text-mono' });
      const itemEl = h('span', { className: 'cons-source-top-item' }, [dotEl, nameEl, pctEl]);
      return { el: itemEl, refs: { itemEl, dotEl, nameEl, pctEl } };
    }

    function formatCompactSourceSharePct(pct) {
      const num = Number(pct || 0);
      if (!Number.isFinite(num) || num <= 0) return '0%';
      if (num >= 10) return `${Math.round(num)}%`;
      return `${num.toFixed(1)}%`;
    }

    /**
     * 创建客户端来源单行 DOM 结构（保留长尾合并分段配色进度条、单行不换行的 Top 2-3 模型速览和右侧总调用数，悬停进度条或速览区弹出完整明细浮层）。
     */
    function createSourceBreakdownRow() {
      const nameTextEl = h('span', { className: 'cons-row-title-text' });
      const nameEl = h('strong', { className: 'cons-row-title' }, [nameTextEl]);
      const pctBadge = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
      const totalTokEl = h('span', { className: 'cons-row-tok text-mono' });
      const costEl = h('strong', { className: 'cons-row-cost text-mono' });
      const trackEl = h('div', { className: 'progress-track cons-seg-bar cons-source-model-bar' });
      const rowState = { hoverPayload: null };
      const bindPopoverHover = (targetEl) => ({
        onMouseEnter: (e) => {
          if (rowState.hoverPayload) {
            showBreakdownPopover(
              targetEl,
              rowState.hoverPayload,
              e?.clientX ?? null,
              e?.clientY ?? null
            );
          }
        },
        onMouseMove: (e) => {
          if (rowState.hoverPayload && activeHoverTargetEl === targetEl) {
            positionBreakdownPopover(targetEl, e?.clientX ?? null, e?.clientY ?? null);
          }
        },
        onMouseLeave: () => {
          if (activeHoverTargetEl === targetEl) hideBreakdownPopover();
        },
      });
      const barHitEl = h(
        'div',
        {
          className: 'cons-source-bar-hit',
        },
        [trackEl]
      );
      const barHandlers = bindPopoverHover(barHitEl);
      barHitEl.addEventListener('mouseenter', barHandlers.onMouseEnter);
      barHitEl.addEventListener('mousemove', barHandlers.onMouseMove);
      barHitEl.addEventListener('mouseleave', barHandlers.onMouseLeave);

      const topModelsEl = h('div', { className: 'cons-source-top-models', hidden: true });
      const topHandlers = bindPopoverHover(topModelsEl);
      topModelsEl.addEventListener('mouseenter', topHandlers.onMouseEnter);
      topModelsEl.addEventListener('mousemove', topHandlers.onMouseMove);
      topModelsEl.addEventListener('mouseleave', topHandlers.onMouseLeave);

      const callsLbl = h('span', { text: t('cons.footCalls') });
      const callsVal = h('strong', { className: 'text-mono' });

      const rowEl = h('div', { className: 'cons-item-row cons-source-row' }, [
        h('div', { className: 'panel-header' }, [
          nameEl,
          h('span', { className: 'cons-row-metrics' }, [
            pctBadge,
            totalTokEl,
            costEl,
          ]),
        ]),
        barHitEl,
        h('div', { className: 'cons-item-foot cons-source-foot' }, [
          topModelsEl,
          h('span', { className: 'legend-left cons-calls-stat' }, [
            callsLbl,
            callsVal,
          ]),
        ]),
      ]);

      return {
        el: rowEl,
        refs: {
          nameEl,
          nameTextEl,
          pctBadge,
          totalTokEl,
          costEl,
          barHitEl,
          trackEl,
          topModelsEl,
          callsLbl,
          callsVal,
          rowState,
        },
      };
    }

    function updateSourceBreakdownRow(refs, item, grandTotalTokens, modelColorMap) {
      patchText(refs.callsLbl, t('cons.footCalls'));
      const displayLabel = item.label || item.name || '—';
      patchText(refs.nameTextEl, displayLabel);
      patchAttr(refs.nameEl, 'title', item.title || displayLabel);

      const total = Number(item.totalTokens || 0);
      const share = grandTotalTokens > 0 ? +((total / grandTotalTokens) * 100).toFixed(1) : 0;
      const scaleRatio =
        grandTotalTokens > 0 && total > 0 ? Math.min(1, Math.max(0.01, total / grandTotalTokens)) : 0;
      patchText(refs.pctBadge, formatPctNumber(share, { withSymbol: true }));
      patchText(refs.totalTokEl, formatTokensPrecise(total));

      const costVal = Number(item.costUsd || 0);
      const callsCount = Number(item.calls || 0);
      const isAllUnpriced =
        callsCount > 0 && Number(item.unpricedCalls || 0) >= callsCount && !(costVal > 0);
      const costText = formatUsd(isAllUnpriced ? null : costVal, {
        precise: costVal > 0 && costVal < 0.1,
      });
      patchText(refs.costEl, costText);
      patchText(refs.callsVal, String(callsCount));

      const sourceModels = Array.isArray(item.mergedModels) ? item.mergedModels : [];
      const partitioned = partitionModelSegments(sourceModels, modelColorMap, {
        maxMain: 5,
        minSharePct: 1.5,
      });

      const barItems =
        partitioned.length > 0
          ? partitioned.map((seg) => ({
              key: seg.key,
              segPct: scaleRatio > 0 ? seg.pct * scaleRatio : 0,
              color: seg.color,
            }))
          : total > 0
            ? [
                {
                  key: '__source_fallback__',
                  segPct: scaleRatio * 100,
                  color: 'var(--accent-primary)',
                },
              ]
            : [];

      patchKeyedList(refs.trackEl, barItems, {
        keyFn: (seg) => seg.key,
        sigFn: (seg) => `${seg.key}:${seg.segPct.toFixed(2)}:${seg.color}`,
        createRow: createSourceModelSegment,
        updateRow: (segRefs, seg) => {
          patchStyleVar(segRefs.segEl, '--seg-w', `${seg.segPct.toFixed(2)}%`);
          patchStyleVar(segRefs.segEl, '--seg-color', seg.color);
        },
      });

      const topModels = partitioned
        .filter((seg) => !seg.isOther)
        .slice(0, 3)
        .map((seg) => ({
          key: seg.key,
          label: seg.label,
          pctText: formatCompactSourceSharePct(seg.pct),
          color: seg.color,
        }));
      patchAttr(refs.topModelsEl, 'hidden', topModels.length === 0);
      patchKeyedList(refs.topModelsEl, topModels, {
        keyFn: (m) => m.key,
        sigFn: (m) => `${m.key}:${m.label}:${m.pctText}:${m.color}`,
        createRow: createSourceTopModelItem,
        updateRow: (mRefs, m) => {
          patchStyleVar(mRefs.dotEl, '--dot-color', m.color);
          patchText(mRefs.nameEl, m.label);
          patchText(mRefs.pctEl, m.pctText);
          patchAttr(mRefs.itemEl, 'title', `${m.label} (${m.pctText})`);
        },
      });

      refs.rowState.hoverPayload =
        total > 0 || callsCount > 0
          ? {
              title: displayLabel,
              calls: callsCount,
              totalTokens: total,
              costText,
              inputTokens: item.inputTokens,
              cacheReadTokens: item.cacheReadTokens,
              thinkingTokens: item.thinkingTokens,
              responseTokens: item.responseTokens,
              outputTokens: item.outputTokens,
              segments: partitioned,
            }
          : null;
    }

    function createTopConversationRow() {
      const titleTextEl = h('span', { className: 'cons-row-title-text' });
      const wsBadgeEl = h('span', { className: 'cons-ws-sessions-tag text-mono', hidden: true });
      const titleEl = h('strong', { className: 'cons-row-title cons-top-conv-title' }, [
        titleTextEl,
        wsBadgeEl,
      ]);
      const pctBadge = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
      const totalTokEl = h('span', { className: 'cons-row-tok text-mono' });
      const costEl = h('strong', { className: 'cons-row-cost text-mono' });
      const trackEl = h('div', { className: 'progress-track cons-seg-bar cons-source-model-bar' });
      const rowState = { cascadeId: '', canJump: false, hoverPayload: null };

      const bindPopoverHover = (targetEl) => ({
        onMouseEnter: (e) => {
          if (rowState.hoverPayload) {
            showBreakdownPopover(
              targetEl,
              rowState.hoverPayload,
              e?.clientX ?? null,
              e?.clientY ?? null
            );
          }
        },
        onMouseMove: (e) => {
          if (rowState.hoverPayload && activeHoverTargetEl === targetEl) {
            positionBreakdownPopover(targetEl, e?.clientX ?? null, e?.clientY ?? null);
          }
        },
        onMouseLeave: () => {
          if (activeHoverTargetEl === targetEl) hideBreakdownPopover();
        },
      });

      const barHitEl = h('div', { className: 'cons-source-bar-hit' }, [trackEl]);
      const barHandlers = bindPopoverHover(barHitEl);
      barHitEl.addEventListener('mouseenter', barHandlers.onMouseEnter);
      barHitEl.addEventListener('mousemove', barHandlers.onMouseMove);
      barHitEl.addEventListener('mouseleave', barHandlers.onMouseLeave);

      const topModelsEl = h('div', { className: 'cons-source-top-models', hidden: true });
      const topHandlers = bindPopoverHover(topModelsEl);
      topModelsEl.addEventListener('mouseenter', topHandlers.onMouseEnter);
      topModelsEl.addEventListener('mousemove', topHandlers.onMouseMove);
      topModelsEl.addEventListener('mouseleave', topHandlers.onMouseLeave);

      const fallbackMetaEl = h('span', { className: 'cons-top-conv-meta', hidden: true });
      const callsLbl = h('span', { text: t('cons.footCalls') });
      const callsVal = h('strong', { className: 'text-mono' });

      const rowEl = h(
        'div',
        {
          className: 'cons-top-conv-row',
          onClick: () => {
            if (!rowState.cascadeId) return;
            hideBreakdownPopover();
            selectConversation(rowState.cascadeId);
            uiStore.setState({
              activeView: 'steps',
              stepsSubTab: 'steps',
              selectedAgentScope: 'all',
              ctxInspectorAgentId: getDefaultCtxInspectorAgentId(
                telemetryStore.getState().telemetry?.settings
              ),
            });
          },
        },
        [
          h('div', { className: 'panel-header' }, [
            titleEl,
            h('span', { className: 'cons-row-metrics' }, [
              pctBadge,
              totalTokEl,
              costEl,
            ]),
          ]),
          barHitEl,
          h('div', { className: 'cons-item-foot cons-source-foot' }, [
            topModelsEl,
            fallbackMetaEl,
            h('span', { className: 'legend-left cons-calls-stat' }, [
              callsLbl,
              callsVal,
            ]),
          ]),
        ]
      );

      return {
        el: rowEl,
        refs: {
          rowEl,
          titleEl,
          titleTextEl,
          wsBadgeEl,
          pctBadge,
          totalTokEl,
          costEl,
          barHitEl,
          trackEl,
          topModelsEl,
          fallbackMetaEl,
          callsLbl,
          callsVal,
          rowState,
        },
      };
    }

    function updateTopConversationRow(refs, item, bases, modelColorMap, sortMode = 'cost') {
      patchText(refs.callsLbl, t('cons.footCalls'));
      const isWorkspaceRow = Boolean(item.isWorkspaceRow);
      const title = isWorkspaceRow
        ? item.isUnbound
          ? t('cons.workspaceUnbound')
          : String(item.label || item.workspacePath || '—').trim()
        : String(item.title || item.cascadeId || '—').trim();
      refs.rowState.cascadeId = String(
        isWorkspaceRow ? item.latestCascadeId || '' : item.cascadeId || ''
      );
      refs.rowState.canJump = item.canJump !== false && Boolean(refs.rowState.cascadeId);
      patchClasses(refs.rowEl, {
        'is-jumpable': refs.rowState.canJump,
        'cons-workspace-row': isWorkspaceRow,
      });
      const baseTip =
        isWorkspaceRow && item.workspacePath && item.workspacePath !== title
          ? `${title} (${item.workspacePath})`
          : title;
      const jumpTip = isWorkspaceRow ? t('cons.workspaceJumpTip') : t('cons.topConvJumpTip');
      patchAttr(refs.rowEl, 'title', refs.rowState.canJump ? `${baseTip} — ${jumpTip}` : baseTip);
      patchText(refs.titleTextEl, title);
      if (refs.wsBadgeEl) {
        const showWsBadge = isWorkspaceRow && Number(item.sessionCount || 0) > 0;
        patchAttr(refs.wsBadgeEl, 'hidden', !showWsBadge);
        if (showWsBadge) {
          patchText(refs.wsBadgeEl, t('cons.workspaceSessions', { count: item.sessionCount }));
        }
      }

      const total = Number(item.totalTokens || 0);
      const costVal = Number(item.costUsd || 0);
      const callsCount = Number(item.calls || 0);
      const isAllUnpriced =
        callsCount > 0 && Number(item.unpricedCalls || 0) >= callsCount && !(costVal > 0);
      const costText = formatUsd(isAllUnpriced ? null : costVal, {
        precise: costVal > 0 && costVal < 0.1,
      });

      const tokBase = Number(bases?.tokens || 0);
      const costBase = Number(bases?.cost || 0);
      const useCostBasis = sortMode === 'cost' && costBase > 0;
      const share = useCostBasis
        ? +((costVal / costBase) * 100).toFixed(1)
        : tokBase > 0
          ? +((total / tokBase) * 100).toFixed(1)
          : 0;
      const scaleRatio = useCostBasis
        ? costVal > 0
          ? Math.min(1, Math.max(0.01, costVal / costBase))
          : 0
        : tokBase > 0 && total > 0
          ? Math.min(1, Math.max(0.01, total / tokBase))
          : 0;

      patchText(refs.pctBadge, formatPctNumber(share, { withSymbol: true }));
      if (sortMode === 'tokens') {
        patchText(refs.totalTokEl, costText);
        patchText(refs.costEl, formatTokensPrecise(total));
      } else {
        patchText(refs.totalTokEl, formatTokensPrecise(total));
        patchText(refs.costEl, costText);
      }
      patchText(refs.callsVal, String(callsCount));

      // 复用客户端来源同款按模型配色分段进度条、Top 2-3 模型速览及共享悬浮详情浮层
      const convModels = Array.isArray(item.mergedModels) ? item.mergedModels : [];
      const partitioned = partitionModelSegments(convModels, modelColorMap, {
        maxMain: 5,
        minSharePct: 1.5,
      });
      const barItems =
        partitioned.length > 0
          ? partitioned.map((seg) => ({
              key: seg.key,
              segPct: scaleRatio > 0 ? seg.pct * scaleRatio : 0,
              color: seg.color,
            }))
          : scaleRatio > 0
            ? [
                {
                  key: '__conv_fallback__',
                  segPct: scaleRatio * 100,
                  color: 'var(--accent-primary)',
                },
              ]
            : [];

      patchKeyedList(refs.trackEl, barItems, {
        keyFn: (seg) => seg.key,
        sigFn: (seg) => `${seg.key}:${seg.segPct.toFixed(2)}:${seg.color}`,
        createRow: createSourceModelSegment,
        updateRow: (segRefs, seg) => {
          patchStyleVar(segRefs.segEl, '--seg-w', `${seg.segPct.toFixed(2)}%`);
          patchStyleVar(segRefs.segEl, '--seg-color', seg.color);
        },
      });

      const topModels = partitioned
        .filter((seg) => !seg.isOther)
        .slice(0, 3)
        .map((seg) => ({
          key: seg.key,
          label: seg.label,
          pctText: formatCompactSourceSharePct(seg.pct),
          color: seg.color,
        }));
      patchAttr(refs.topModelsEl, 'hidden', topModels.length === 0);
      patchKeyedList(refs.topModelsEl, topModels, {
        keyFn: (m) => m.key,
        sigFn: (m) => `${m.key}:${m.label}:${m.pctText}:${m.color}`,
        createRow: createSourceTopModelItem,
        updateRow: (mRefs, m) => {
          patchStyleVar(mRefs.dotEl, '--dot-color', m.color);
          patchText(mRefs.nameEl, m.label);
          patchText(mRefs.pctEl, m.pctText);
          patchAttr(mRefs.itemEl, 'title', `${m.label} (${m.pctText})`);
        },
      });

      const showFallbackMeta = topModels.length === 0;
      patchAttr(refs.fallbackMetaEl, 'hidden', !showFallbackMeta);
      if (showFallbackMeta) {
        const srcLabel = item.sourceName || item.appSource || '';
        const cacheLabel = t('cons.topConvCacheMeta', {
          pct: formatPctNumber(item.cacheHitPct ?? 0),
        });
        patchText(refs.fallbackMetaEl, srcLabel ? `${srcLabel} · ${cacheLabel}` : cacheLabel);
      }

      refs.rowState.hoverPayload =
        partitioned.length > 0 && (total > 0 || callsCount > 0)
          ? {
              title,
              calls: callsCount,
              totalTokens: total,
              costText,
              inputTokens: item.inputTokens,
              cacheReadTokens: item.cacheReadTokens,
              thinkingTokens: item.thinkingTokens,
              responseTokens: item.responseTokens,
              outputTokens: item.outputTokens,
              segments: partitioned,
            }
          : null;
    }

    let latestSlice = null;
    let isDirty = false;
    let prefetchedOnCurrentVisit = false;

    let lastRenderedTuple = null;
    let cachedMonthlySeriesRef = null;
    let cachedMonthlyDisplayKey = '';
    let cachedMonthsMergedModels = null;
    let cachedAllMonthMergedModels = null;

    function isSameRenderTuple(prev, next) {
      if (!prev || prev.length !== next.length) return false;
      for (let i = 0; i < prev.length; i++) {
        if (!Object.is(prev[i], next[i])) return false;
      }
      return true;
    }

    /**
     * 将遥测状态切片同步渲染至消费统计视图的 5 个子面板。
     */
    function renderConsumptionData(slice) {
      if (!slice) return;
      const cons = slice.consumption || {};
      const rangeInfo = cons.selectedRange || {};

      // 始终在 0ms 同步顶部时间段滑块与自定义日期条显隐，给予即刻交互反馈
      timeFilterSwitch.setValue(slice.range);
      patchAttr(customRangeBar, 'hidden', slice.range !== 'custom');
      if (!hasUncommittedCustomDraft) {
        draftStartMs = slice.customStartMs;
        draftEndMs = slice.customEndMs;
        startPicker.setValue(draftStartMs);
        endPicker.setValue(draftEndMs);
      }

      // 极少数缓存未命中时（如自定义新区间或进页瞬间抢点），跳过用旧趋势/模型跑无效半更新重绘，待几毫秒后单帧原子绘制
      if (rangeInfo.key && slice.range && rangeInfo.key !== slice.range) {
        return;
      }

      const preset =
        slice.range !== 'custom' && cons.presets?.[slice.range]
          ? cons.presets[slice.range]
          : null;
      const acct = cons.account || preset?.account || {};
      const dateSpan = formatDateSpanBadge(rangeInfo.startMs, rangeInfo.endMs);
      const now = new Date();
      const currentMonthIdx = now.getMonth();
      const monthlyYear = cons.monthlyYear || now.getFullYear();
      const locale = i18nStore.getState().locale;
      const renderTuple = [
        locale,
        slice.range,
        slice.customStartMs,
        slice.customEndMs,
        slice.modelDisplayMode,
        slice.showUpstreamModel,
        slice.orchestratorIdMode,
        dateSpan,
        preset?.label || rangeInfo.label,
        acct,
        cons.trendSeries,
        slice.modelBreakdown,
        activeRankingTab,
        modelsSortBy,
        cons.topConversations,
        topConvsSortBy,
        cons.sourcesBreakdown,
        monthlyYear,
        currentMonthIdx,
        cons.monthlySeries,
      ];
      if (isSameRenderTuple(lastRenderedTuple, renderTuple)) return;
      drawConsumptionData(slice, { cons, preset, acct, rangeInfo, dateSpan, currentMonthIdx, monthlyYear });
      lastRenderedTuple = renderTuple;
    }

    function drawConsumptionData(slice, { cons, preset, acct, rangeInfo, dateSpan, currentMonthIdx, monthlyYear }) {
      // 1. 同步用量概览矩阵与顶部 4 段比例条
      patchText(dateSpanBadge, dateSpan);
      const totalTokens = Number(acct.totalTokens || 0);
      const inputTokens = Number(acct.inputTokens || 0);
      const cacheTokens = Number(acct.cacheReadTokens || 0);
      const outputTokens = Number(acct.outputTokens || 0);
      const responseTokens = Number(acct.responseTokens || 0);
      const thinkingTokens = Number(acct.thinkingTokens || 0);
      const costUsd = Number(acct.costUsd || 0);
      const savedCostUsd = Number(acct.savedCostUsd || 0);

      patchText(heroTotalTokens, formatTokensPrecise(totalTokens));
      patchText(heroTotalCalls, t('cons.callsCount', { calls: acct.calls || 0 }));
      patchText(heroCostUsd, formatUsd(costUsd));
      patchText(heroCostCny, formatCnyApprox(costUsd));

      patchText(cacheHitPctEl, formatPctNumber(acct.cacheHitPct ?? 0, { withSymbol: true }));
      patchText(cacheTokensEl, t('cons.cacheHitTokens', { tokens: formatTokensPrecise(cacheTokens) }));

      let inPct = 0;
      let cachePct = 0;
      let outPct = 0;
      if (totalTokens > 0) {
        const scaled = scaleBucketsExact(
          { in: inputTokens, cache: cacheTokens, out: outputTokens },
          ['in', 'cache', 'out'],
          1000
        );
        inPct = +(scaled.in / 10).toFixed(1);
        cachePct = +(scaled.cache / 10).toFixed(1);
        outPct = +(scaled.out / 10).toFixed(1);
      }

      patchText(inputSharePct, `${inPct}%`);
      patchText(inputMainTokens, formatTokensPrecise(inputTokens));
      patchText(inputSubText, t('cons.uncachedInput'));

      patchText(cacheSharePct, `${cachePct}%`);
      patchText(cacheMainTokens, formatTokensPrecise(cacheTokens));
      patchText(
        cacheSubText,
        t('cons.savedCost', {
          cost: formatUsd(savedCostUsd, { precise: savedCostUsd > 0 && savedCostUsd < 0.01 }),
        })
      );

      patchText(outputSharePct, `${outPct}%`);
      patchText(outputMainTokens, formatTokensPrecise(outputTokens));
      patchText(
        outputSubText,
        t('cons.replyAndThink', {
          resp: formatTokensPrecise(responseTokens),
          think: formatTokensPrecise(thinkingTokens),
        })
      );
      consExportMenu.refs.setHidden(!(totalTokens > 0 || Number(acct.calls || 0) > 0));

      overviewSegBar.update({
        inputTokens,
        cacheReadTokens: cacheTokens,
        responseTokens,
        thinkingTokens,
      });

      // 2-5. 统一解析展示模式与全局确定性模型配色映射（确保趋势浮层、模型排行圆点、客户端来源条、月度堆叠柱四处完全同色）
      const localeSig = i18nStore.getState().locale;
      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
        orchestratorIdMode: slice.orchestratorIdMode,
      };
      const mergeAndSortBucketModels = (rawList) =>
        mergeModelsByDisplayName(rawList || [], displaySettings, {
          preferLabelInShort: true,
        })
          .filter((m) => Number(m.totalTokens || 0) > 0 || Number(m.calls || 0) > 0)
          .sort(
            (a, b) =>
              (b.totalTokens || 0) - (a.totalTokens || 0) || (b.calls || 0) - (a.calls || 0)
          );

      const models = mergeModelsByDisplayName(slice.modelBreakdown || [], displaySettings, {
        preferLabelInShort: true,
      }).sort((a, b) => {
        if (modelsSortBy === 'cost') {
          return (b.costUsd || 0) - (a.costUsd || 0) || (b.totalTokens || 0) - (a.totalTokens || 0);
        }
        if (modelsSortBy === 'speed') {
          const sa = Number(a.avgTokPerSec) > 0 ? Number(a.avgTokPerSec) : -1;
          const sb = Number(b.avgTokPerSec) > 0 ? Number(b.avgTokPerSec) : -1;
          return sb - sa || (b.totalTokens || 0) - (a.totalTokens || 0);
        }
        if (modelsSortBy === 'calls') {
          return (b.calls || 0) - (a.calls || 0) || (b.totalTokens || 0) - (a.totalTokens || 0);
        }
        return (b.totalTokens || 0) - (a.totalTokens || 0) || (b.calls || 0) - (a.calls || 0);
      });
      const modelsTotalTok = models.reduce((s, m) => s + Number(m.totalTokens || 0), 0);
      const modelsTotalCost = models.reduce((s, m) => s + Math.max(0, Number(m.costUsd || 0)), 0);
      const modelsTotalCalls = models.reduce((s, m) => s + Math.max(0, Number(m.calls || 0)), 0);
      const modelsMaxAvgTps = models.reduce((mx, m) => {
        const v = Number(m.avgTokPerSec || 0);
        return Number.isFinite(v) && v > mx ? v : mx;
      }, 0);
      const modelsTotalsCtx = {
        totalTokens: modelsTotalTok,
        totalCost: modelsTotalCost,
        totalCalls: modelsTotalCalls,
        maxAvgTps: modelsMaxAvgTps,
      };

      const rawTopConvs = Array.isArray(cons.topConversations) ? cons.topConversations : [];
      const allTopConvMergedModels = [];
      const topConvsWithModels = rawTopConvs.map((c) => {
        const mergedModels = mergeAndSortBucketModels(c.models);
        for (const m of mergedModels) {
          allTopConvMergedModels.push(m);
        }
        return { ...c, mergedModels };
      });

      const rawTopWorkspaces = Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [];
      const allWorkspaceMergedModels = [];
      const topWorkspacesWithModels = rawTopWorkspaces.map((w) => {
        const mergedModels = mergeAndSortBucketModels(w.models);
        for (const m of mergedModels) {
          allWorkspaceMergedModels.push(m);
        }
        return { ...w, isWorkspaceRow: true, mergedModels };
      });

      const rawSources = cons.sourcesBreakdown || [];
      const sourcesTotalTok = rawSources.reduce((s, x) => s + Number(x.totalTokens || 0), 0);
      const allSourceMergedModels = [];
      const sourcesWithModels = rawSources.map((s) => {
        const mergedModels = mergeAndSortBucketModels(s.models);
        for (const m of mergedModels) {
          allSourceMergedModels.push(m);
        }
        return { ...s, mergedModels };
      });

      const monthlySeries = cons.monthlySeries || [];
      const monthlyDisplayKey = `${displaySettings.modelDisplayMode}|${displaySettings.showUpstreamModel ? 1 : 0}|${displaySettings.orchestratorIdMode}`;
      let monthsMergedModels;
      let allMonthMergedModels;
      if (
        cachedMonthlySeriesRef === monthlySeries &&
        cachedMonthlyDisplayKey === monthlyDisplayKey &&
        cachedMonthsMergedModels &&
        cachedAllMonthMergedModels
      ) {
        monthsMergedModels = cachedMonthsMergedModels;
        allMonthMergedModels = cachedAllMonthMergedModels;
      } else {
        allMonthMergedModels = [];
        monthsMergedModels = Array.from({ length: 12 }, (_, idx) => {
          const merged = mergeAndSortBucketModels(monthlySeries[idx]?.models);
          for (const m of merged) {
            allMonthMergedModels.push(m);
          }
          return merged;
        });
        cachedMonthlySeriesRef = monthlySeries;
        cachedMonthlyDisplayKey = monthlyDisplayKey;
        cachedMonthsMergedModels = monthsMergedModels;
        cachedAllMonthMergedModels = allMonthMergedModels;
      }

      const rawTrendSeries = cons.trendSeries || [];
      const allTrendMergedModels = [];
      const trendMergedByIdx = rawTrendSeries.map((slot) => {
        if (!Array.isArray(slot?.models) || slot.models.length === 0) return null;
        const merged = mergeAndSortBucketModels(slot.models);
        for (const m of merged) {
          allTrendMergedModels.push(m);
        }
        return merged;
      });

      const allColorSeeds = [
        ...models,
        ...allSourceMergedModels,
        ...allTopConvMergedModels,
        ...allWorkspaceMergedModels,
        ...allMonthMergedModels,
        ...allTrendMergedModels,
      ]
        .map((m) => getCanonicalModelColorSeed(m))
        .filter(Boolean);
      const modelColorMap = buildPrismModelColorMap(allColorSeeds);

      // 2. 同步历史趋势交互式 SVG 面积图 / 类 GitHub 每日热力图（>90天）与悬停分模型浮层
      const rangeBadgeText = isEnglishLocale()
        ? getConsumptionTimeRangeOptions().find((o) => o.value === slice.range)?.label ||
          t('cons.allTime')
        : preset?.label || rangeInfo.label || t('cons.allTime');
      patchText(trendRangeBadge, rangeBadgeText);
      const isHourlyTrend =
        rawTrendSeries[0]?.granularity === 'hour' ||
        (rawTrendSeries[0]?.label || '').includes(':');
      const isHeatmapTrend = !isHourlyTrend && rawTrendSeries.length > HEATMAP_DAYS_THRESHOLD;
      patchText(
        trendGranularityHint,
        isHeatmapTrend
          ? t('cons.trendHeatmapHint', { days: rawTrendSeries.length })
          : isHourlyTrend
            ? t('cons.trendPointsHintHourly', { points: rawTrendSeries.length || 0 })
            : t('cons.trendPointsHintDaily', { points: rawTrendSeries.length || 0 })
      );
      const enrichedTrendSeries = rawTrendSeries.map((slot, idx) => {
        const mergedSlotModels = trendMergedByIdx[idx];
        if (!mergedSlotModels || mergedSlotModels.length === 0) return slot;
        return {
          ...slot,
          modelSegments: partitionModelSegments(mergedSlotModels, modelColorMap, {
            maxMain: 5,
            minSharePct: 1.5,
          }),
        };
      });
      trendChart.update(enrichedTrendSeries);

      // 3. 同步统一排行卡片（分段切换「模型排行 | 项目排行 | 会话排行」及对应排序控制）
      const sortedTopConvs = [...topConvsWithModels].sort((a, b) =>
        topConvsSortBy === 'tokens'
          ? (b.totalTokens || 0) - (a.totalTokens || 0) || (b.costUsd || 0) - (a.costUsd || 0)
          : (b.costUsd || 0) - (a.costUsd || 0) || (b.totalTokens || 0) - (a.totalTokens || 0)
      );
      const sortedTopWorkspaces = [...topWorkspacesWithModels].sort((a, b) =>
        topConvsSortBy === 'tokens'
          ? (b.totalTokens || 0) - (a.totalTokens || 0) || (b.costUsd || 0) - (a.costUsd || 0)
          : (b.costUsd || 0) - (a.costUsd || 0) || (b.totalTokens || 0) - (a.totalTokens || 0)
      );
      if (activeRankingTab === 'workspaces' && sortedTopWorkspaces.length === 0) {
        activeRankingTab = 'models';
      }
      lastModelsCount = models.length;
      lastWorkspacesCount = sortedTopWorkspaces.length;
      lastConvsCount = sortedTopConvs.length;
      rankingTabSwitch.setProps({
        ariaLabel: t('cons.rankTabAria'),
        modelValue: activeRankingTab,
        options: getRankingTabOptions(
          models.length,
          sortedTopConvs.length,
          sortedTopWorkspaces.length
        ),
      });
      const showSessionsTab = activeRankingTab === 'sessions';
      const showWorkspacesTab = activeRankingTab === 'workspaces' && sortedTopWorkspaces.length > 0;
      const showModelsTab = !showSessionsTab && !showWorkspacesTab;
      patchAttr(modelsSortSwitch.el, 'hidden', !showModelsTab);
      patchAttr(
        topConvsSortSwitch.el,
        'hidden',
        showModelsTab ||
          (showSessionsTab && sortedTopConvs.length === 0) ||
          (showWorkspacesTab && sortedTopWorkspaces.length === 0)
      );
      patchAttr(modelsListEl, 'hidden', !showModelsTab);
      patchAttr(topConvsListEl, 'hidden', !showSessionsTab || sortedTopConvs.length === 0);
      patchAttr(workspacesListEl, 'hidden', !showWorkspacesTab);
      patchAttr(topConvsEmptyEl, 'hidden', !showSessionsTab || sortedTopConvs.length > 0);
      patchText(topConvsEmptyEl, t('cons.topConvsEmpty'));

      patchKeyedList(modelsListEl, models, {
        keyFn: (m) => m.displayText || m.label || m.shortName,
        sigFn: (m) =>
          `${localeSig}:${modelsSortBy}:${m.displayText}:${m.displayTitle}:${m.totalTokens}:${m.inputTokens}:${m.cacheReadTokens}:${m.responseTokens}:${m.thinkingTokens}:${m.costUsd}:${m.unpricedCalls}:${m.calls}:${m.avgTokPerSec ?? ''}:${m.avgTtftSec ?? ''}:${m.cacheHitPct ?? ''}:${modelsTotalTok}:${modelsTotalCost.toFixed(4)}:${modelsTotalCalls}:${modelsMaxAvgTps}`,
        createRow: createBreakdownItemRow,
        updateRow: (refs, m) => {
          updateBreakdownItemRow(
            refs,
            { ...m, label: m.displayText, title: m.displayTitle },
            modelsTotalsCtx,
            modelsSortBy
          );
        },
      });

      const topConvsBaseTokens =
        totalTokens > 0
          ? totalTokens
          : sortedTopConvs.reduce((s, c) => s + Number(c.totalTokens || 0), 0);
      const topConvsBaseCost =
        costUsd > 0
          ? costUsd
          : sortedTopConvs.reduce((s, c) => s + Math.max(0, Number(c.costUsd || 0)), 0);
      const topConvsBases = { tokens: topConvsBaseTokens, cost: topConvsBaseCost };
      patchKeyedList(topConvsListEl, sortedTopConvs, {
        keyFn: (c) => c.cascadeId,
        sigFn: (c) => {
          const modelsSig = c.mergedModels
            .map((m) => {
              const seed = getCanonicalModelColorSeed(m);
              return `${m.displayText}:${m.totalTokens}:${m.inputTokens || 0}:${m.cacheReadTokens || 0}:${m.thinkingTokens || 0}:${m.responseTokens || 0}:${m.calls}:${modelColorMap.get(seed) || ''}`;
            })
            .join('|');
          return `${localeSig}:${topConvsSortBy}:${c.cascadeId}:${c.title}:${c.totalTokens}:${c.inputTokens || 0}:${c.cacheReadTokens || 0}:${c.thinkingTokens || 0}:${c.responseTokens || 0}:${c.costUsd}:${c.unpricedCalls}:${c.calls}:${c.cacheHitPct}:${c.sourceName}:${c.canJump ? 1 : 0}:${topConvsBaseTokens}:${topConvsBaseCost.toFixed(4)}:${modelsSig}`;
        },
        createRow: createTopConversationRow,
        updateRow: (refs, c) =>
          updateTopConversationRow(refs, c, topConvsBases, modelColorMap, topConvsSortBy),
      });

      const topWsBaseTokens =
        totalTokens > 0
          ? totalTokens
          : sortedTopWorkspaces.reduce((s, w) => s + Number(w.totalTokens || 0), 0);
      const topWsBaseCost =
        costUsd > 0
          ? costUsd
          : sortedTopWorkspaces.reduce((s, w) => s + Math.max(0, Number(w.costUsd || 0)), 0);
      const topWsBases = { tokens: topWsBaseTokens, cost: topWsBaseCost };
      patchKeyedList(workspacesListEl, sortedTopWorkspaces, {
        keyFn: (w) => w.workspaceKey,
        sigFn: (w) => {
          const modelsSig = w.mergedModels
            .map((m) => {
              const seed = getCanonicalModelColorSeed(m);
              return `${m.displayText}:${m.totalTokens}:${m.inputTokens || 0}:${m.cacheReadTokens || 0}:${m.thinkingTokens || 0}:${m.responseTokens || 0}:${m.calls}:${modelColorMap.get(seed) || ''}`;
            })
            .join('|');
          return `${localeSig}:${topConvsSortBy}:${w.workspaceKey}:${w.label}:${w.sessionCount}:${w.totalTokens}:${w.inputTokens || 0}:${w.cacheReadTokens || 0}:${w.thinkingTokens || 0}:${w.responseTokens || 0}:${w.costUsd}:${w.unpricedCalls}:${w.calls}:${w.cacheHitPct}:${w.latestCascadeId}:${w.canJump ? 1 : 0}:${topWsBaseTokens}:${topWsBaseCost.toFixed(4)}:${modelsSig}`;
        },
        createRow: createTopConversationRow,
        updateRow: (refs, w) =>
          updateTopConversationRow(refs, w, topWsBases, modelColorMap, topConvsSortBy),
      });

      // 4. 同步客户端来源列表（长尾合并分段配色 + 右侧总调用数 + 悬停进度条弹出明细浮层）
      patchKeyedList(sourcesListEl, sourcesWithModels, {
        keyFn: (s) => s.name,
        sigFn: (s) => {
          const modelsSig = s.mergedModels
            .map((m) => {
              const seed = getCanonicalModelColorSeed(m);
              return `${m.displayText}:${m.totalTokens}:${m.inputTokens || 0}:${m.cacheReadTokens || 0}:${m.thinkingTokens || 0}:${m.responseTokens || 0}:${m.calls}:${modelColorMap.get(seed) || ''}`;
            })
            .join('|');
          return `${localeSig}:${s.name}:${s.totalTokens}:${s.inputTokens || 0}:${s.cacheReadTokens || 0}:${s.thinkingTokens || 0}:${s.responseTokens || 0}:${s.costUsd}:${s.unpricedCalls}:${s.calls}:${sourcesTotalTok}:${modelsSig}`;
        },
        createRow: createSourceBreakdownRow,
        updateRow: (refs, s) => updateSourceBreakdownRow(refs, s, sourcesTotalTok, modelColorMap),
      });

      // 5. 同步 12 个月垂直堆叠柱状图（按模型配色堆叠 + 长尾合并 + 悬停弹出明细浮层）
      patchText(monthlyYearBadge, String(monthlyYear));
      const maxMonthTokens = Math.max(
        1,
        ...monthlySeries.map((m) => Number(m.totalTokens || 0))
      );

      for (let i = 0; i < 12; i++) {
        const col = monthlyCols[i];
        const m = monthlySeries[i] || { totalTokens: 0, costUsd: 0, calls: 0 };
        const mTot = Number(m.totalTokens || 0);
        const mCalls = Number(m.calls || 0);
        const hasData = mTot > 0;

        patchClasses(col.el, { 'is-interactive': hasData || mCalls > 0 });
        patchClasses(col.monthLabel, { 'is-current': i === currentMonthIdx });
        patchAttr(col.stackWrap, 'hidden', !hasData);
        patchAttr(col.zeroDot, 'hidden', hasData);

        if (!hasData) {
          patchText(col.costText, '');
          patchText(col.tokText, '');
          col.colState.hoverPayload = null;
          col.colState.monthRange = null;
          patchKeyedList(col.stackWrap, [], {
            keyFn: (x) => x.key,
            sigFn: (x) => x.key,
            createRow: createMonthModelSegment,
            updateRow: () => {},
          });
        } else {
          const cVal = Number(m.costUsd || 0);
          const isMonthUnpriced =
            mCalls > 0 && Number(m.unpricedCalls || 0) >= mCalls && !(cVal > 0);
          patchText(
            col.costText,
            isMonthUnpriced ? '—' : cVal >= 10 ? `$${Math.round(cVal)}` : `$${cVal.toFixed(2)}`
          );
          patchText(col.tokText, formatTokensPrecise(mTot));

          const totalHeightPct = Math.max(8, Math.min(100, (mTot / maxMonthTokens) * 100));
          patchStyleVar(col.stackWrap, '--bar-h', `${totalHeightPct.toFixed(1)}%`);

          const monthModels = monthsMergedModels[i] || [];
          const barPartitioned = partitionModelSegments(monthModels, modelColorMap, {
            maxMain: 5,
            minSharePct: 1.5,
          });
          // 垂直柱状图底端放主力模型、顶端叠放小占比及「其他」，视觉重心稳定
          const verticalSegments =
            barPartitioned.length > 0
              ? [...barPartitioned].reverse()
              : [{ key: '__month_fallback__', pct: 100, color: 'var(--accent-primary)' }];

          patchKeyedList(col.stackWrap, verticalSegments, {
            keyFn: (seg) => seg.key,
            sigFn: (seg) => `${seg.key}:${seg.pct.toFixed(2)}:${seg.color}`,
            createRow: createMonthModelSegment,
            updateRow: (segRefs, seg) => {
              patchStyleVar(segRefs.segEl, '--seg-h', `${seg.pct.toFixed(2)}%`);
              patchStyleVar(segRefs.segEl, '--seg-color', seg.color);
            },
          });

          col.colState.monthRange = {
            startMs: new Date(monthlyYear, i, 1, 0, 0, 0, 0).getTime(),
            endMs: new Date(monthlyYear, i + 1, 0, 23, 59, 59, 999).getTime(),
          };
          col.colState.hoverPayload = {
            title: t('cons.monthFullLabel', { year: monthlyYear, m: i + 1 }),
            calls: mCalls,
            totalTokens: mTot,
            costText: formatUsd(isMonthUnpriced ? null : cVal, {
              precise: cVal > 0 && cVal < 0.1,
            }),
            inputTokens: m.inputTokens,
            cacheReadTokens: m.cacheReadTokens,
            thinkingTokens: m.thinkingTokens,
            responseTokens: m.responseTokens,
            outputTokens: m.outputTokens,
            segments: barPartitioned,
          };
        }
      }

      if (activeHoverTargetEl && activeHoverTargetEl.isConnected === false) {
        hideBreakdownPopover();
      }

      viewScrollbar.refresh();
    }

    const unsub = telemetryStore.subscribe(
      (st) => ({
        range: st.selectedTimeRange,
        customStartMs: st.customStartMs,
        customEndMs: st.customEndMs,
        consumption: st.telemetry?.consumption,
        modelBreakdown: st.telemetry?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        orchestratorIdMode: normalizeOrchestratorIdDisplayMode(
          st.telemetry?.settings?.orchestratorIdMode
        ),
      }),
      (slice) => {
        latestSlice = slice;
        if (getVisibleMonitorView() !== 'consumption') {
          hideBreakdownPopover();
          isDirty = true;
          return;
        }
        isDirty = false;
        renderConsumptionData(slice);
        if (!prefetchedOnCurrentVisit && Number(slice?.consumption?.revision || 0) > 0) {
          prefetchedOnCurrentVisit = true;
          void prefetchConsumptionPresets();
        }
      }
    );

    const unsubView = uiStore.subscribe(
      getVisibleMonitorView,
      (activeView) => {
        if (activeView !== 'consumption') {
          prefetchedOnCurrentVisit = false;
          hideBreakdownPopover();
          return;
        }
        if (isDirty) {
          isDirty = false;
          if (latestSlice) {
            renderConsumptionData(latestSlice);
          }
        }
        if (!prefetchedOnCurrentVisit && Number(latestSlice?.consumption?.revision || 0) > 0) {
          prefetchedOnCurrentVisit = true;
          void prefetchConsumptionPresets();
        }
      }
    );

    function syncStaticLocaleLabels() {
      timeFilterSwitch.setProps({
        ariaLabel: t('cons.rangeAria'),
        options: getConsumptionTimeRangeOptions(),
      });
      patchText(applyCustomBtnLabel, t('cons.applyFilter'));
      patchText(rangeToSpan, t('cons.rangeTo'));
      patchText(totalTokensLabel, t('cons.totalTokens'));
      patchText(estCostLabel, t('cons.estCost'));
      patchText(cacheHitRateLabel, t('cons.cacheHitRate'));
      patchText(newInputLabel, t('cons.newInput'));
      patchText(cacheReadLabel, t('cons.cacheRead'));
      patchText(outputUsageLabel, t('cons.outputUsage'));
      consExportMenu.refs.setAriaLabel(t('cons.exportMenuAria'));
      consExportMenu.refs.updateItemLabels({
        xlsx: { label: t('cons.exportXlsx'), title: t('cons.exportXlsxTip') },
        md: { label: t('cons.exportMd'), title: t('cons.exportMdTip') },
      });
      patchText(trendTitleSpan, t('cons.trendTitle'));
      rankingTabSwitch.setProps({
        ariaLabel: t('cons.rankTabAria'),
        modelValue: activeRankingTab,
        options: getRankingTabOptions(),
      });
      modelsSortSwitch.setProps({
        ariaLabel: t('cons.modelsSortAria'),
        options: getModelsSortOptions(),
      });
      topConvsSortSwitch.setProps({
        ariaLabel: t('cons.topConvsSortAria'),
        options: getTopConvsSortOptions(),
      });
      patchText(topConvsEmptyEl, t('cons.topConvsEmpty'));
      patchText(sourcesTitleSpan, t('cons.clientSources'));
      patchText(sourcesHoverHint, t('cons.hoverModelsHint'));
      patchText(monthlyTitleSpan, t('cons.monthlyTitle'));
      patchText(monthlyHoverHint, t('cons.hoverModelsHint'));
      for (let i = 0; i < 12; i++) {
        patchText(monthlyCols[i].monthLabel, t('cons.monthLabel', { m: i + 1 }));
      }
    }

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncStaticLocaleLabels();
        if (getVisibleMonitorView() === 'consumption' && latestSlice) {
          isDirty = false;
          renderConsumptionData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      hideBreakdownPopover();
      unsub();
      unsubView();
      unsubI18n();
      consExportMenu.destroy();
      trendChart.destroy?.();
      rankingTabSwitch.destroy();
      modelsSortSwitch.destroy();
      topConvsSortSwitch.destroy();
      timeFilterSwitch.destroy();
      startPicker.destroy();
      endPicker.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: rootEl,
      refs: {
        timeFilterSwitch,
        startPicker,
        endPicker,
        viewScrollbar,
        breakdownPopoverEl,
        consExportMenu,
      },
    };
  },
});
