/**
 * @fileoverview Inline end-of-turn multi-agent & orchestrator telemetry card (`ChatTurnSummaryBar.js`).
 *
 * Renders inside an in-flow Shadow DOM sibling host (`.wm-turn-summary-host`)
 * placed immediately after `[data-testid="agent-response"]` in the Antigravity chat canvas.
 *
 * Design architecture (aligned with Usage Monitor's MetricMatrix & ContextSegmentMeter grammar):
 * - Collapsed: Calm single-row telemetry bar with plain typographic hierarchy (no decorative pills)
 *   and an edge-to-edge proportional rail along the bottom edge.
 * - Expanded: The full-width proportional rail acts as the architectural divider between header
 *   and body. Orchestrator turns open into a 2-column side-by-side comparison (Orchestrator vs
 *   Implementor) with dedicated per-role metric strips; Swarm/Subagent turns open into a
 *   proportional agent list with color-keyed vertical accents.
 */

import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { formatMetric, formatTokens } from '../../core/formatters.js';
import { t } from '../../i18n/index.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';

const ORCH_ROLE_COLOR = 'var(--accent-primary)';
const IMPL_ROLE_COLOR = 'var(--metric-info)';
const AUX_ROLE_COLOR = 'color-mix(in srgb, var(--text-secondary) 42%, transparent)';

const SWARM_BAR_PALETTE = Object.freeze([
  'var(--accent-primary)',
  'var(--metric-info)',
  'var(--metric-ok)',
  'var(--metric-warn)',
  'color-mix(in srgb, var(--text-secondary) 65%, transparent)',
]);

/**
 * Determine whether a turn summary should be displayed inline in chat.
 * Renders for orchestrator, swarm, subagent, and non-empty single-model turns.
 *
 * @param {object|null|undefined} summary
 * @returns {boolean}
 */
export function shouldRenderTurnSummary(summary) {
  if (!summary || typeof summary !== 'object') return false;
  if (
    summary.mode === 'orchestrator' ||
    summary.mode === 'swarm' ||
    summary.mode === 'subagent'
  ) {
    return true;
  }
  if (summary.orchestratorBreakdown) return true;
  if (Array.isArray(summary.agentBreakdown) && summary.agentBreakdown.length > 1) {
    return true;
  }
  if (summary.mode === 'single') {
    const steps = Number(summary.totalCompletedSteps || summary.totalSteps || 0);
    const agentSteps = Array.isArray(summary.agentBreakdown)
      ? summary.agentBreakdown.reduce(
          (acc, ag) => acc + Number(ag?.completedSteps || ag?.totalSteps || 0),
          0
        )
      : 0;
    const hasTokens =
      Number(summary.totals?.ctx || 0) > 0 ||
      Number(summary.totals?.outputTokens || 0) > 0 ||
      Number(summary.totals?.think || 0) > 0 ||
      Number(summary.totals?.reply || 0) > 0;
    return steps > 0 || agentSteps > 0 || hasTokens;
  }
  return false;
}

/**
 * Resolve default expanded state for a turn summary card.
 * Single-model turns default to expanded (compact 1-row metric strip);
 * multi-role/multi-agent turns default to collapsed to keep chat scannable.
 *
 * @param {object|null|undefined} summary
 * @returns {boolean}
 */
export function resolveDefaultTurnSummaryExpanded(summary) {
  if (!summary || typeof summary !== 'object') return false;
  return (
    summary.mode === 'single' &&
    !summary.orchestratorBreakdown &&
    (!Array.isArray(summary.agentBreakdown) || summary.agentBreakdown.length <= 1)
  );
}

function formatDurationCompact(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n >= 60) {
    const mins = Math.floor(n / 60);
    const rem = Math.round(n % 60);
    return `${mins}m${rem > 0 ? `${rem}s` : ''}`;
  }
  return n >= 10 ? `${Math.round(n)}s` : `${n.toFixed(1)}s`;
}

function formatStepCountLabel(steps) {
  const n = Number(steps || 0);
  return n === 1 ? '1 step' : `${n} steps`;
}

function resolveSingleModelLabel(summary) {
  const agents = Array.isArray(summary?.agentBreakdown) ? summary.agentBreakdown : [];
  const primary = agents.find((a) => a?.isMain) || agents[0] || null;
  const label = String(primary?.modelLabel || summary?.modelLabel || '').trim();
  return label || 'Model';
}

function resolveModeMeta(summary) {
  if (summary?.mode === 'swarm') {
    return { label: t('turnSummary.badgeSwarm'), icon: 'swarm', variant: 'swarm' };
  }
  if (summary?.mode === 'subagent') {
    return { label: t('turnSummary.badgeMultiAgent'), icon: 'swarm', variant: 'subagent' };
  }
  if (summary?.mode === 'orchestrator' || summary?.orchestratorBreakdown) {
    return { label: t('turnSummary.badgeOrchestrator'), icon: 'layers', variant: 'orch' };
  }
  if (summary?.mode === 'single') {
    return { label: resolveSingleModelLabel(summary), icon: 'bolt', variant: 'single' };
  }
  return { label: t('turnSummary.badgeMultiAgent'), icon: 'swarm', variant: 'subagent' };
}

function buildHeaderMetaPlainText(summary) {
  const ob = summary?.orchestratorBreakdown;
  const agents = Array.isArray(summary?.agentBreakdown) ? summary.agentBreakdown : [];
  if (summary?.mode === 'single' && !ob && agents.length <= 1) {
    const stepCount = Number(
      summary?.totalCompletedSteps ||
        summary?.totalSteps ||
        agents[0]?.completedSteps ||
        agents[0]?.totalSteps ||
        0
    );
    return formatStepCountLabel(stepCount);
  }
  if ((summary?.mode === 'orchestrator' || !agents.length || agents.length <= 1) && ob) {
    const orch = ob.orchestrator || {};
    const impl = ob.implementor || {};
    const orchSteps = Number(orch.completedSteps || orch.totalSteps || 0);
    const implSteps = Number(impl.completedSteps || impl.totalSteps || 0);
    const orchPct = Number.isFinite(Number(orch.pct)) ? Number(orch.pct) : 0;
    const implPct = Number.isFinite(Number(impl.pct)) ? Number(impl.pct) : 0;
    return t('turnSummary.orchStepSplit', {
      orchPct,
      orchSteps,
      implPct,
      implSteps,
    });
  }
  const agentCount = agents.length || 1;
  const stepCount = Number(summary?.totalCompletedSteps || summary?.totalSteps || 0);
  return t('turnSummary.swarmMeta', { agents: agentCount, steps: stepCount });
}

function renderHeaderMeta(containerEl, summary) {
  containerEl.textContent = '';
  const ob = summary?.orchestratorBreakdown;
  const agents = Array.isArray(summary?.agentBreakdown) ? summary.agentBreakdown : [];
  if ((summary?.mode === 'orchestrator' || !agents.length || agents.length <= 1) && ob) {
    const orch = ob.orchestrator || {};
    const impl = ob.implementor || {};
    const orchSteps = Number(orch.completedSteps || orch.totalSteps || 0);
    const implSteps = Number(impl.completedSteps || impl.totalSteps || 0);
    const orchPct = Number.isFinite(Number(orch.pct)) ? Number(orch.pct) : 0;
    const implPct = Number.isFinite(Number(impl.pct)) ? Number(impl.pct) : 0;

    const makeSplitItem = (label, pct, steps, color) => {
      const dotEl = h('span', { className: 'wm-ts-dot', 'aria-hidden': 'true' });
      dotEl.style.background = color;
      return h('span', { className: `wm-ts-split-item${steps === 0 ? ' is-idle' : ''}` }, [
        dotEl,
        h('span', { className: 'wm-ts-split-label', text: label }),
        h('span', { className: 'wm-ts-split-pct', text: ` ${pct}%` }),
        h('span', { className: 'wm-ts-split-steps', text: ` (${steps})` }),
      ]);
    };

    containerEl.appendChild(makeSplitItem('Orch', orchPct, orchSteps, ORCH_ROLE_COLOR));
    containerEl.appendChild(
      h('span', { className: 'wm-ts-split-sep', 'aria-hidden': 'true', text: '/' })
    );
    containerEl.appendChild(makeSplitItem('Impl', implPct, implSteps, IMPL_ROLE_COLOR));
    return;
  }

  containerEl.appendChild(
    h('span', {
      className: 'wm-ts-swarm-meta',
      text: buildHeaderMetaPlainText(summary),
    })
  );
}

function renderQuickTokenTotals(containerEl, totals) {
  containerEl.textContent = '';
  if (!totals || typeof totals !== 'object') {
    patchAttr(containerEl, 'hidden', true);
    return;
  }
  const items = [];
  const ctx = Number(totals.ctx || 0);
  const think = Number(totals.think || 0);
  const reply = Number(totals.reply || 0);
  const out = Number(totals.outputTokens || 0);
  const dur = formatDurationCompact(totals.durationSec);

  if (ctx > 0) items.push({ val: formatTokens(ctx), unit: t('turnSummary.ctxShort') });
  if (think > 0 || reply > 0) {
    if (think > 0) items.push({ val: formatTokens(think), unit: t('turnSummary.thinkShort') });
    if (reply > 0) items.push({ val: formatTokens(reply), unit: t('turnSummary.replyShort') });
  } else if (out > 0) {
    items.push({ val: formatTokens(out), unit: t('turnSummary.outShort') });
  }
  if (dur !== '-') {
    items.push({ val: dur, unit: '', isTime: true });
  }

  if (items.length === 0) {
    patchAttr(containerEl, 'hidden', true);
    return;
  }
  patchAttr(containerEl, 'hidden', false);
  items.forEach((item) => {
    const children = [
      h('span', {
        className: item.isTime ? 'wm-ts-stat-val is-time' : 'wm-ts-stat-val',
        text: item.val,
      }),
    ];
    if (item.unit) {
      children.push(h('span', { className: 'wm-ts-stat-unit', text: ` ${item.unit}` }));
    }
    containerEl.appendChild(h('span', { className: 'wm-ts-stat' }, children));
  });
}

function buildRailSegments(summary) {
  const ob = summary?.orchestratorBreakdown;
  const agents = Array.isArray(summary?.agentBreakdown) ? summary.agentBreakdown : [];
  if (summary?.mode === 'single' && !ob && agents.length <= 1) {
    const modelLabel = resolveSingleModelLabel(summary);
    const steps = Number(
      summary?.totalCompletedSteps ||
        summary?.totalSteps ||
        agents[0]?.completedSteps ||
        agents[0]?.totalSteps ||
        0
    );
    return [
      {
        pct: 100,
        color: ORCH_ROLE_COLOR,
        title: `${modelLabel}: ${formatStepCountLabel(steps)}`,
      },
    ];
  }
  if ((summary?.mode === 'orchestrator' || agents.length <= 1) && ob) {
    const orchPct = Math.max(0, Math.min(100, Number(ob.orchestrator?.pct || 0)));
    const implPct = Math.max(0, Math.min(100, Number(ob.implementor?.pct || 0)));
    const orchSteps = Number(ob.orchestrator?.completedSteps || ob.orchestrator?.totalSteps || 0);
    const implSteps = Number(ob.implementor?.completedSteps || ob.implementor?.totalSteps || 0);
    const segs = [];
    if (orchPct > 0) {
      segs.push({
        pct: orchPct,
        color: ORCH_ROLE_COLOR,
        title: `${t('turnSummary.roleOrchestrator')}: ${orchSteps} (${orchPct}%)`,
      });
    }
    if (implPct > 0) {
      segs.push({
        pct: implPct,
        color: IMPL_ROLE_COLOR,
        title: `${t('turnSummary.roleImplementor')}: ${implSteps} (${implPct}%)`,
      });
    }
    return segs;
  }
  if (agents.length > 0) {
    const segs = [];
    agents.forEach((ag, idx) => {
      const pct = Math.max(0, Math.min(100, Number(ag?.pct || 0)));
      if (pct <= 0) return;
      const steps = Number(ag?.completedSteps || ag?.totalSteps || 0);
      const name = ag?.isMain
        ? t('turnSummary.roleMain')
        : ag?.label || ag?.role || ag?.agentId || 'Agent';
      segs.push({
        pct,
        color: ag?.isAuxiliary
          ? AUX_ROLE_COLOR
          : SWARM_BAR_PALETTE[idx % SWARM_BAR_PALETTE.length],
        title: `${name}: ${steps} (${pct}%)`,
      });
    });
    return segs;
  }
  return [];
}

function createMetricCell(label, valueNode, extraClass = '') {
  return h('div', { className: `wm-ts-metric${extraClass ? ` ${extraClass}` : ''}` }, [
    h('span', { className: 'wm-ts-metric-label', text: label }),
    h('span', { className: 'wm-ts-metric-value' }, Array.isArray(valueNode) ? valueNode : [valueNode]),
  ]);
}

function buildRoleMetricCells(stats, isIdle) {
  const ctxVal = Number(stats?.ctx || 0);
  const thinkVal = Number(stats?.think || 0);
  const replyVal = Number(stats?.reply || 0);
  const outVal = Number(stats?.outputTokens || 0);
  const durStr = formatDurationCompact(stats?.durationSec);
  const tps = Number(stats?.tokPerSec);
  const hasTps = Number.isFinite(tps) && tps > 0;

  const ctxNode =
    ctxVal > 0
      ? h('span', { className: 'wm-ts-val-primary', text: formatTokens(ctxVal) })
      : h('span', { className: 'wm-ts-val-muted', text: isIdle ? '-' : '0' });

  let thinkNode;
  let replyNode;
  if (isIdle && thinkVal === 0 && replyVal === 0 && outVal === 0) {
    thinkNode = h('span', { className: 'wm-ts-val-muted', text: '-' });
    replyNode = h('span', { className: 'wm-ts-val-muted', text: '-' });
  } else if (thinkVal === 0 && replyVal === 0 && outVal > 0) {
    thinkNode = h('span', { className: 'wm-ts-val-muted', text: '-' });
    replyNode = [
      h('span', { className: 'wm-ts-val-primary', text: formatTokens(outVal) }),
      h('span', { className: 'wm-ts-val-unit', text: ` ${t('turnSummary.outShort')}` }),
    ];
  } else {
    thinkNode =
      thinkVal > 0
        ? h('span', { className: 'wm-ts-val-primary', text: formatTokens(thinkVal) })
        : h('span', { className: 'wm-ts-val-muted', text: '0' });
    replyNode =
      replyVal > 0
        ? h('span', { className: 'wm-ts-val-primary', text: formatTokens(replyVal) })
        : h('span', { className: 'wm-ts-val-muted', text: '0' });
  }

  const timeNode =
    durStr !== '-'
      ? h('span', { className: 'wm-ts-val-secondary', text: durStr })
      : h('span', { className: 'wm-ts-val-muted', text: '-' });

  const speedNode = hasTps
    ? [
        h('span', { className: 'wm-ts-val-speed', text: formatMetric(tps, '') }),
        h('span', { className: 'wm-ts-val-unit', text: ' t/s' }),
      ]
    : h('span', { className: 'wm-ts-val-muted', text: '-' });

  return [
    createMetricCell(t('turnSummary.colCtx'), ctxNode),
    createMetricCell(t('turnSummary.colThink'), thinkNode),
    createMetricCell(t('turnSummary.colReply'), replyNode),
    createMetricCell('Time', timeNode),
    createMetricCell('Speed', speedNode, 'is-speed'),
  ];
}

function createOrchestratorRoleColumn({ title, subtitle = '', color, stats = {}, isSecond = false }) {
  const steps = Number(stats.completedSteps || stats.totalSteps || 0);
  const pct = Number.isFinite(Number(stats.pct)) ? Number(stats.pct) : 0;
  const isIdle = steps === 0;

  const accentEl = h('span', { className: 'wm-ts-role-accent', 'aria-hidden': 'true' });
  accentEl.style.background = color;

  const colClasses = [
    'wm-ts-orch-col',
    isSecond ? 'is-second' : '',
    isIdle ? 'is-idle' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const modelText = subtitle || (isIdle ? 'Not invoked' : '');

  return h('div', { className: colClasses }, [
    h('div', { className: 'wm-ts-role-head' }, [
      h('div', { className: 'wm-ts-role-ident' }, [
        accentEl,
        h('div', { className: 'wm-ts-role-titles' }, [
          h('span', { className: 'wm-ts-role-name', text: title }),
          modelText ? h('span', { className: 'wm-ts-role-model', text: modelText }) : null,
        ]),
      ]),
      h('div', { className: 'wm-ts-role-share' }, [
        h('span', { className: 'wm-ts-share-pct', text: `${pct}%` }),
        h('span', { className: 'wm-ts-share-steps', text: formatStepCountLabel(steps) }),
      ]),
    ]),
    h('div', { className: 'wm-ts-metrics-grid' }, buildRoleMetricCells(stats, isIdle)),
  ]);
}

function createAgentListRow({ title, subtitle = '', auxLabel = '', color, isMuted = false, stats = {} }) {
  const steps = Number(stats.completedSteps || stats.totalSteps || 0);
  const pct = Math.max(0, Math.min(100, Number.isFinite(Number(stats.pct)) ? Number(stats.pct) : 0));
  const isIdle = steps === 0;

  const accentEl = h('span', { className: 'wm-ts-role-accent', 'aria-hidden': 'true' });
  accentEl.style.background = color;

  const shareFillEl = h('span', { className: 'wm-ts-agent-bar-fill' });
  shareFillEl.style.width = `${pct}%`;
  shareFillEl.style.background = color;

  const rowClasses = [
    'wm-ts-agent-row',
    isMuted ? 'is-muted' : '',
    isIdle ? 'is-idle' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return h('div', { className: rowClasses }, [
    h('div', { className: 'wm-ts-agent-top' }, [
      h('div', { className: 'wm-ts-role-ident' }, [
        accentEl,
        h('div', { className: 'wm-ts-role-titles' }, [
          h('span', { className: 'wm-ts-role-title-line' }, [
            h('span', { className: 'wm-ts-role-name', text: title }),
            auxLabel ? h('span', { className: 'wm-ts-aux-text', text: auxLabel }) : null,
          ]),
          subtitle ? h('span', { className: 'wm-ts-role-model', text: subtitle }) : null,
        ]),
      ]),
      h('div', { className: 'wm-ts-agent-share' }, [
        h('span', { className: 'wm-ts-agent-share-meta' }, [
          h('span', { className: 'wm-ts-share-pct is-compact', text: `${pct}%` }),
          h('span', { className: 'wm-ts-share-steps', text: formatStepCountLabel(steps) }),
        ]),
        h('span', { className: 'wm-ts-agent-bar-track', 'aria-hidden': 'true' }, [shareFillEl]),
      ]),
    ]),
    h('div', { className: 'wm-ts-metrics-grid is-agent' }, buildRoleMetricCells(stats, isIdle)),
  ]);
}

/**
 * Create an inline end-of-turn summary card component.
 *
 * @param {{
 *   summary: object,
 *   expanded?: boolean,
 *   onToggleExpand?: (nextExpanded: boolean) => void,
 * }} props
 */
export function ChatTurnSummaryBar({ summary, expanded = undefined, onToggleExpand = null } = {}) {
  let currentSummary = summary || null;
  let isExpanded =
    expanded === undefined ? resolveDefaultTurnSummaryExpanded(currentSummary) : Boolean(expanded);

  const pulseDotEl = h('span', { className: 'wm-ts-pulse', hidden: true });
  const modeIcon = createSvgIcon('layers', { size: 13 });
  const modeLabelEl = h('span', { className: 'wm-ts-mode-label' });
  const modeEl = h('span', { className: 'wm-ts-mode' }, [modeIcon, modeLabelEl]);
  const headSepEl = h('span', { className: 'wm-ts-head-sep', 'aria-hidden': 'true' });
  const metaTextEl = h('span', { className: 'wm-ts-meta' });
  const totalsTextEl = h('span', { className: 'wm-ts-totals' });
  const chevronIcon = createSvgIcon('chevron-down', { size: 13 });
  const chevronWrapEl = h('span', { className: 'wm-ts-chevron' }, [chevronIcon]);

  const headerBtnEl = h(
    'button',
    {
      type: 'button',
      className: 'wm-ts-header',
      'aria-expanded': isExpanded ? 'true' : 'false',
      'aria-label': isExpanded ? t('turnSummary.ariaCollapse') : t('turnSummary.ariaExpand'),
      onMousedown: (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
      },
      onClick: (e) => {
        e?.stopPropagation?.();
        isExpanded = !isExpanded;
        syncExpandedState();
        onToggleExpand?.(isExpanded);
      },
    },
    [
      h('span', { className: 'wm-ts-header-left' }, [
        pulseDotEl,
        modeEl,
        headSepEl,
        metaTextEl,
      ]),
      h('span', { className: 'wm-ts-header-right' }, [
        totalsTextEl,
        chevronWrapEl,
      ]),
    ]
  );

  const railEl = h('div', { className: 'wm-ts-rail', 'aria-hidden': 'true' });
  const bodyEl = h('div', { className: 'wm-ts-body', hidden: !isExpanded });
  const rootEl = h('div', { className: 'wm-ts-card' }, [headerBtnEl, railEl, bodyEl]);

  function syncExpandedState() {
    patchClasses(rootEl, { 'is-expanded': isExpanded });
    patchAttr(headerBtnEl, 'aria-expanded', isExpanded ? 'true' : 'false');
    patchAttr(
      headerBtnEl,
      'aria-label',
      isExpanded ? t('turnSummary.ariaCollapse') : t('turnSummary.ariaExpand')
    );
    patchAttr(bodyEl, 'hidden', !isExpanded);
    if (isExpanded) {
      renderExpandedBody();
    }
  }

  function renderExpandedBody() {
    if (!bodyEl || !currentSummary) return;
    bodyEl.textContent = '';

    const ob = currentSummary.orchestratorBreakdown;
    const agents = Array.isArray(currentSummary.agentBreakdown)
      ? currentSummary.agentBreakdown
      : [];
    const showAgents =
      agents.length > 0 &&
      (currentSummary.mode === 'swarm' ||
        currentSummary.mode === 'subagent' ||
        agents.length > 1);

    if (ob) {
      const orchSection = h('div', { className: 'wm-ts-section' }, [
        showAgents
          ? h('div', { className: 'wm-ts-section-title', text: t('turnSummary.orchSection') })
          : null,
        h('div', { className: 'wm-ts-orch-grid' }, [
          createOrchestratorRoleColumn({
            title: t('turnSummary.roleOrchestrator'),
            subtitle: ob.orchestrator?.modelLabel || '',
            color: ORCH_ROLE_COLOR,
            stats: ob.orchestrator || {},
            isSecond: false,
          }),
          createOrchestratorRoleColumn({
            title: t('turnSummary.roleImplementor'),
            subtitle: ob.implementor?.modelLabel || '',
            color: IMPL_ROLE_COLOR,
            stats: ob.implementor || {},
            isSecond: true,
          }),
        ]),
      ]);
      bodyEl.appendChild(orchSection);
    }

    if (showAgents) {
      const agentSection = h('div', { className: `wm-ts-section${ob ? ' has-divider' : ''}` }, [
        ob ? h('div', { className: 'wm-ts-section-title', text: t('turnSummary.agentsSection') }) : null,
        h(
          'div',
          { className: 'wm-ts-agent-list' },
          agents.map((ag, idx) => {
            const displayRole = ag?.isMain
              ? t('turnSummary.roleMain')
              : ag?.label || ag?.role || ag?.agentId || 'Agent';
            const rowColor = ag?.isAuxiliary
              ? AUX_ROLE_COLOR
              : SWARM_BAR_PALETTE[idx % SWARM_BAR_PALETTE.length];
            return createAgentListRow({
              title: displayRole,
              subtitle: ag?.modelLabel || '',
              auxLabel: ag?.isAuxiliary ? t('turnSummary.auxBadge') : '',
              color: rowColor,
              isMuted: Boolean(ag?.isAuxiliary),
              stats: ag || {},
            });
          })
        ),
      ]);
      bodyEl.appendChild(agentSection);
    }

    if (!ob && !showAgents) {
      const primaryAgent = agents.find((a) => a?.isMain) || agents[0] || {};
      const stats = {
        ...primaryAgent,
        ...(currentSummary.totals || {}),
      };
      const stepCount = Number(
        currentSummary.totalCompletedSteps ||
          currentSummary.totalSteps ||
          primaryAgent.completedSteps ||
          primaryAgent.totalSteps ||
          0
      );
      bodyEl.appendChild(
        h('div', { className: 'wm-ts-metrics-grid is-single' }, buildRoleMetricCells(stats, stepCount === 0))
      );
    }
  }

  function renderSummary(nextSummary, nextExpanded = undefined) {
    if (nextSummary !== undefined) {
      currentSummary = nextSummary;
    }
    if (nextExpanded !== undefined) {
      isExpanded = Boolean(nextExpanded);
    }
    if (!currentSummary) return;

    const isRunning = Boolean(currentSummary.isRunning);
    const modeMeta = resolveModeMeta(currentSummary);
    const isSingleMode = modeMeta.variant === 'single';
    patchClasses(rootEl, {
      'is-running': isRunning,
      'is-expanded': isExpanded,
      'is-single': isSingleMode,
    });
    patchAttr(pulseDotEl, 'hidden', !isRunning);
    if (isRunning) {
      patchAttr(pulseDotEl, 'title', t('turnSummary.liveRunning'));
    }

    patchSvgIcon(modeIcon, modeMeta.icon);
    patchText(modeLabelEl, modeMeta.label);
    patchClasses(modeEl, {
      'is-orch': modeMeta.variant === 'orch',
      'is-swarm': modeMeta.variant === 'swarm',
      'is-subagent': modeMeta.variant === 'subagent',
      'is-single': isSingleMode,
    });

    renderHeaderMeta(metaTextEl, currentSummary);
    renderQuickTokenTotals(totalsTextEl, currentSummary.totals);

    const segs = buildRailSegments(currentSummary);
    railEl.textContent = '';
    if (segs.length === 0) {
      patchAttr(railEl, 'hidden', true);
    } else {
      patchAttr(railEl, 'hidden', false);
      patchAttr(railEl, 'title', buildHeaderMetaPlainText(currentSummary));
      for (const seg of segs) {
        const segEl = h('span', { className: 'wm-ts-rail-seg', title: seg.title });
        segEl.style.width = `${seg.pct}%`;
        segEl.style.background = seg.color;
        railEl.appendChild(segEl);
      }
    }

    syncExpandedState();
  }

  renderSummary(currentSummary, isExpanded);

  return {
    el: rootEl,
    refs: {
      update: ({ summary: nextSummary, expanded: nextExpanded } = {}) => {
        renderSummary(nextSummary, nextExpanded);
      },
      isExpanded: () => isExpanded,
      destroy: () => {
        rootEl.remove?.();
      },
    },
  };
}
