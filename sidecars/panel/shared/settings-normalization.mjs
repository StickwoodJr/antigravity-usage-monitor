/**
 * @fileoverview 前后端与 CLI 共用的偏好设置枚举常量、默认值与无状态纯函数归一化规则。
 */

export const SUPPORTED_LANGUAGES = Object.freeze(['auto', 'zh-CN', 'en-US']);

export const THEME_ACCENT_KEYS = Object.freeze([
  'host',
  'blue',
  'emerald',
  'amber',
  'violet',
  'cyan',
  'rose',
]);

export const FONT_SCALE_KEYS = Object.freeze(['sm', 'md', 'lg', 'xl']);

export const TOPBAR_SLOT_KEYS = Object.freeze([
  'context',
  'tps',
  'ttft',
  'avg_tps',
  'cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'quota_auto',
  'gemini_5h',
  'gemini_weekly',
  'argon_weekly',
  'claude_5h',
  'claude_weekly',
]);

export const DEFAULT_TOPBAR_SLOTS = Object.freeze(['tps', 'ttft', 'context']);
export const MIN_TOPBAR_SLOTS = 1;
export const MAX_TOPBAR_SLOTS = 5;

export const DEFAULT_CLI_STATUSLINE_SLOTS = Object.freeze([
  'tps',
  'ttft',
  'session_cost',
  'quota_auto',
  'context',
]);
export const MIN_CLI_STATUSLINE_SLOTS = 1;
export const MAX_CLI_STATUSLINE_SLOTS = 6;
export const CLI_STATUSLINE_PRESETS = Object.freeze({
  compact: Object.freeze(['tps', 'ttft', 'context']),
  balanced: DEFAULT_CLI_STATUSLINE_SLOTS,
  full: Object.freeze(['tps', 'ttft', 'cache_hit', 'session_cost', 'quota_auto', 'context']),
});

export const OVERVIEW_MODULE_KEYS = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_OVERVIEW_MODULES = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_HOVER_MODULES = Object.freeze(['metrics', 'context', 'quotas']);

export const OVERVIEW_METRIC_KEYS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'context_usage',
  'quota_tightest',
]);

export const DEFAULT_OVERVIEW_METRICS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
]);

export const STEP_TABLE_COLUMN_KEYS = Object.freeze([
  'step',
  'time',
  'model',
  'tps',
  'ttft',
  'duration',
  'tokens_combo',
  'tokens_io_cache',
  'tokens_custom',
  'input_tokens',
  'cache_tokens',
  'output_tokens',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TABLE_COLUMNS = Object.freeze([
  'step',
  'model',
  'tps',
  'ttft',
  'tokens_combo',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TOKEN_COMBO_FORMAT = 'context:in:cache';

export const STEP_TOKEN_SEGMENT_ALIASES = Object.freeze({
  context: 'context',
  ctx: 'context',
  in: 'in',
  new: 'in',
  input: 'in',
  out: 'out',
  output: 'out',
  cache: 'cache',
  cached: 'cache',
  cache_read: 'cache',
  cacheread: 'cache',
  think: 'think',
  thinking: 'think',
  reply: 'reply',
  body: 'reply',
  resp: 'reply',
  response: 'reply',
  text: 'reply',
  total: 'total',
  all: 'total',
  sum: 'total',
});

export const POPOVER_WIDTH_MODES = Object.freeze(['auto', 'custom']);
export const MIN_POPOVER_WIDTH = 440;
export const MAX_POPOVER_WIDTH = 1080;
export const DEFAULT_POPOVER_WIDTH = 580;

/**
 * 归一化界面语言枚举（默认 `'auto'`，支持 `'zh-CN'` 及 `'en-US'`）。
 *
 * @param {unknown} lang
 * @returns {'auto'|'zh-CN'|'en-US'}
 */
export function normalizeLanguageSetting(lang) {
  const raw = String(lang ?? '').trim();
  if (!raw) return 'auto';
  const lower = raw.toLowerCase();
  if (lower === 'auto' || lower === 'system') return 'auto';
  if (lower === 'en' || lower === 'en-us' || lower.startsWith('en-')) return 'en-US';
  if (lower === 'zh' || lower === 'zh-cn' || lower.startsWith('zh')) return 'zh-CN';
  return 'auto';
}

/**
 * 归一化主题强调色预设键（默认 `'host'` 跟随宿主原生主题）。
 *
 * @param {unknown} accent
 * @returns {'host'|'blue'|'emerald'|'amber'|'violet'|'cyan'|'rose'}
 */
export function normalizeThemeAccent(accent) {
  const clean = String(accent ?? '').trim().toLowerCase();
  return THEME_ACCENT_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'host';
}

/**
 * 归一化面板字号档位（默认 `'md'` 标准 100%）。
 *
 * @param {unknown} scale
 * @returns {'sm'|'md'|'lg'|'xl'}
 */
export function normalizeFontScale(scale) {
  const clean = String(scale ?? '').trim().toLowerCase();
  return FONT_SCALE_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'md';
}

/**
 * 归一化模型名称展示模式（`'short'` | `'upstream_compact'` | `'upstream'`），兼容历史 `showUpstreamModel`。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyShowUpstream]
 * @returns {'short'|'upstream_compact'|'upstream'}
 */
export function normalizeModelDisplayMode(mode, legacyShowUpstream) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'upstream' || m === 'raw' || m === 'full') return 'upstream';
  if (m === 'upstream_compact' || m === 'compact_upstream' || m === 'trimmed') {
    return 'upstream_compact';
  }
  if (m === 'short') return 'short';
  if (legacyShowUpstream === true) return 'upstream';
  return 'short';
}

/**
 * 归一化 Orchestrator 系列模型 ID 显示风格（`'compact'` vs `'full'`，默认 `'compact'`）。
 *
 * @param {unknown} mode
 * @returns {'compact'|'full'}
 */
export function normalizeOrchestratorIdMode(mode) {
  return String(mode ?? '').trim().toLowerCase() === 'full' ? 'full' : 'compact';
}

/**
 * 归一化悬浮主面板宽度模式（`'auto'` | `'custom'`，默认 `'auto'`）。
 *
 * @param {unknown} mode
 * @returns {'auto'|'custom'}
 */
export function normalizePopoverWidthMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return m === 'custom' || m === 'fixed' ? 'custom' : 'auto';
}

/**
 * 归一化悬浮主面板自定义宽度像素值（范围 `440..1080`，默认 `580`）。
 *
 * @param {unknown} width
 * @returns {number}
 */
export function normalizePopoverWidth(width) {
  const num = Number(width);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_POPOVER_WIDTH;
  return Math.max(MIN_POPOVER_WIDTH, Math.min(MAX_POPOVER_WIDTH, Math.round(num)));
}

/**
 * 解析步骤表自定义 Token 组合表达式，支持 `:`、`/`、`,`、`|` 分隔与中英文别名（1~4 项不重复）。
 *
 * @param {unknown} raw
 * @returns {Array<'context'|'in'|'out'|'cache'|'think'|'reply'|'total'>}
 */
export function parseStepTokenComboSegments(raw) {
  const str = String(raw ?? '').trim();
  const out = [];
  const seen = new Set();
  if (str) {
    for (const part of str.split(/[:/,|]+/)) {
      const key = part.trim().toLowerCase();
      if (!key) continue;
      const mapped = Object.prototype.hasOwnProperty.call(STEP_TOKEN_SEGMENT_ALIASES, key)
        ? STEP_TOKEN_SEGMENT_ALIASES[key]
        : null;
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(/** @type {any} */ (mapped));
      if (out.length >= 4) break;
    }
  }
  return out.length > 0 ? out : ['context', 'in', 'cache'];
}

/**
 * 归一化步骤表自定义 Token 组合格式字符串（如 `'context:new:cache'` -> `'context:in:cache'`）。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeStepTokenComboFormat(raw) {
  return parseStepTokenComboSegments(raw).join(':');
}

/**
 * 归一化插件更新策略枚举（兼容历史 `autoUpdatePlugin` 布尔开关，默认 `'off'`，加固分支禁止 `'auto'`）。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyAutoUpdate]
 * @returns {'off'|'manual'}
 */
export function normalizePluginUpdateMode(mode, legacyAutoUpdate) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'off' || m === 'manual') return m;
  if (m === 'auto' || legacyAutoUpdate === true) return 'manual';
  return 'off';
}

/**
 * 归一化面板挂载方式枚举（`'dual'` | `'composer'` | `'sidebar'`），兼容历史 `enableWindowOverlay`。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyEnableOverlay]
 * @returns {'dual'|'composer'|'sidebar'}
 */
export function normalizeWindowMountMode(mode, legacyEnableOverlay) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'composer' || m === 'input') return 'composer';
  if (m === 'sidebar' || m === 'sidebar_only' || m === 'off') return 'sidebar';
  if (m === 'dual' || m === 'topbar') return 'dual';
  if (legacyEnableOverlay === false) return 'sidebar';
  return 'dual';
}

/**
 * 归一化每周额度统计模式枚举（`'official'` | `'custom_tokens'` | `'custom_cost'`）。
 *
 * @param {unknown} mode
 * @returns {'official'|'custom_tokens'|'custom_cost'}
 */
export function normalizeWeeklyLimitMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'custom_tokens' || m === 'tokens') return 'custom_tokens';
  if (m === 'custom_cost' || m === 'cost') return 'custom_cost';
  return 'official';
}

/**
 * 归一化顶栏/输入框胶囊槽位数组（1~5 项动态自添加，默认 3 项，自动清洗历史 `'none'` 与重复项）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeTopbarCapsuleSlots(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_TOPBAR_SLOTS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!val || val === 'none') continue;
    const mapped = val === 'step_cost' ? 'cost' : val;
    if (!TOPBAR_SLOT_KEYS.includes(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
    if (out.length >= MAX_TOPBAR_SLOTS) break;
  }
  if (out.length < MIN_TOPBAR_SLOTS) {
    return ['context'];
  }
  return out;
}

/**
 * 归一化 CLI 底部状态栏独立槽位配置（`null` 表示自动跟随宽屏默认或自定义顶栏槽位；
 * 支持预设名 `compact` / `balanced` / `full`、逗号分隔列表或数组，保留 1~6 个去重合法槽位）。
 *
 * @param {unknown} raw
 * @returns {string[]|null}
 */
export function normalizeCliStatusLineSlots(raw) {
  if (raw === undefined || raw === null) return null;
  let items = null;
  if (typeof raw === 'string') {
    const clean = raw.trim();
    const lower = clean.toLowerCase();
    if (!clean || lower === 'auto' || lower === 'default') {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(CLI_STATUSLINE_PRESETS, lower)) {
      return [...CLI_STATUSLINE_PRESETS[lower]];
    }
    items = clean.split(/[\s,|:]+/);
  } else if (Array.isArray(raw)) {
    items = raw;
  } else {
    return null;
  }
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const val = String(item ?? '').trim();
    if (!val || val === 'none') continue;
    const mapped = val === 'step_cost' ? 'cost' : val;
    if (!TOPBAR_SLOT_KEYS.includes(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
    if (out.length >= MAX_CLI_STATUSLINE_SLOTS) break;
  }
  return out.length >= MIN_CLI_STATUSLINE_SLOTS ? out : null;
}

/**
 * 解析当前生效的 CLI 底栏槽位列表：
 * 1. 若用户显式设置了 `cliStatusLineSlots`，优先使用；
 * 2. 若用户自定义了非默认 `topbarCapsuleSlots`，沿用其自定义顺序保持兼容；
 * 3. 否则采用面向宽终端的 5 槽默认组合（速度 / 首字 / 费用 / 配额 / 上下文）。
 *
 * @param {object|null|undefined} settings
 * @returns {string[]}
 */
export function resolveEffectiveCliStatusLineSlots(settings) {
  const customCli = normalizeCliStatusLineSlots(settings?.cliStatusLineSlots);
  if (customCli && customCli.length > 0) {
    return customCli;
  }
  const topbar = normalizeTopbarCapsuleSlots(settings?.topbarCapsuleSlots);
  const isDefaultTopbar =
    topbar.length === DEFAULT_TOPBAR_SLOTS.length &&
    topbar.every((k, i) => k === DEFAULT_TOPBAR_SLOTS[i]);
  if (!isDefaultTopbar) {
    return topbar;
  }
  return [...DEFAULT_CLI_STATUSLINE_SLOTS];
}

/**
 * 归一化实时监控第一行指标矩阵的槽位与顺序（1~4 项，默认 4 项）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewMetrics(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_METRICS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const rawVal = String(item ?? '').trim();
    const val = rawVal === 'cost' ? 'step_cost' : rawVal;
    if (!OVERVIEW_METRIC_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : ['tps'];
}

/**
 * 归一化实时监控视图展示的模块及上下顺序（1~4 项，默认 4 项全开）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out.length > 0 ? out : ['metrics'];
}

/**
 * 归一化鼠标悬停速览窗展示的模块及上下顺序（0~4 项，默认 3 项；显式空数组 `[]` 表示禁用悬停弹窗）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeHoverModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_HOVER_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out;
}

/**
 * 归一化调用明细「按步查看」表格列配置与左右顺序（2~14 列，默认保留现有 7 列）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeStepTableColumns(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_STEP_TABLE_COLUMNS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!STEP_TABLE_COLUMN_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= STEP_TABLE_COLUMN_KEYS.length) break;
  }
  if (out.length < 2) {
    for (const fallbackCol of ['step', 'model', 'tps']) {
      if (!seen.has(fallbackCol)) {
        seen.add(fallbackCol);
        out.push(fallbackCol);
      }
      if (out.length >= 2) break;
    }
  }
  return out;
}

/**
 * 归一化独立 Web 服务自动托管端口（`0` 表示关闭自动拉起，合法监听端口范围 `1024..65535`）。
 *
 * @param {unknown} port
 * @returns {number}
 */
export function normalizeStandalonePort(port) {
  const num = Number(port);
  if (!Number.isInteger(num) || num <= 0) return 0;
  if (num >= 1024 && num <= 65535) return num;
  return 0;
}

/**
 * 归一化现代化 UI 开关（默认 `true`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeModernUi(val) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return true;
  }
  return Boolean(val);
}

export const CONTEXT_AGENT_MODES = Object.freeze(['main', 'auto']);
export const DEFAULT_CONTEXT_AGENT_MODE = 'main';

/**
 * 归一化顶栏胶囊及悬停速览浮窗的上下文代理来源（默认 `'main'` 锁定主代理，可选 `'auto'` 跟随活跃）。
 *
 * @param {unknown} raw
 * @returns {'main'|'auto'}
 */
export function normalizeContextAgentMode(raw) {
  const val = String(raw || '').trim().toLowerCase();
  return val === 'auto' ? 'auto' : 'main';
}

/**
 * 归一化配额预占估算开关（默认 `true`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeExperimentalQuotaReservation(val) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return true;
  }
  return Boolean(val);
}

/**
 * 归一化旧版实验性新 UI 字段（保留兼容，缺省返回 `false`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeExperimentalModernUi(val) {
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'on';
  }
  return Boolean(val);
}

/**
 * 归一化对话内轮次多代理/编排器摘要卡片开关（默认 `true`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeEnableChatTurnSummary(val) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return true;
  }
  return Boolean(val);
}

// ---------------------------------------------------------------------------
// Obsidian Prism Optical UI & Host Module Settings (GPL-3.0-only, @RMvdesi)
// ---------------------------------------------------------------------------

export const PRISM_PALETTE_KEYS = Object.freeze(['obsidian', 'warm']);
export const PRISM_LIGHT_PRESET_KEYS = Object.freeze(['crystal', 'alabaster']);
export const PRISM_DARK_AURA_STYLE_KEYS = Object.freeze(['prism', 'neon']);
export const PRISM_ACCENT_TONE_KEYS = Object.freeze(['follow', 'cobalt', 'iris', 'amber', 'mono']);
export const PRISM_CORNER_STYLE_KEYS = Object.freeze(['sharp', 'balanced', 'soft']);
export const PRISM_CODE_FONT_KEYS = Object.freeze(['default', 'jetbrains', 'cascadia', 'sfmono']);
export const PRISM_AMBIENT_INTENSITY_KEYS = Object.freeze(['0', '35', '70', '100']);
export const PRISM_DARK_AURA_KEYS = Object.freeze(['subtle', 'balanced', 'vivid']);
export const PRISM_MOTION_LEVEL_KEYS = Object.freeze(['off', 'subtle', 'standard', 'ultra']);
export const PRISM_TARGET_FPS_KEYS = Object.freeze(['60', '120', '180', 'native']);
export const PRISM_CONV_RIPPLE_KEYS = Object.freeze(['off', 'subtle', 'medium', 'full']);
export const PRISM_ON_OFF_AUTO_KEYS = Object.freeze(['auto', 'on', 'off']);
export const PRISM_ON_OFF_KEYS = Object.freeze(['on', 'off']);
export const PRISM_LINK_TARGET_KEYS = Object.freeze(['builtin', 'external']);

function normalizeEnumValue(raw, allowed, fallback) {
  const clean = String(raw ?? '').trim().toLowerCase();
  return allowed.includes(clean) ? clean : fallback;
}

function normalizeBoolDefault(raw, defaultValue) {
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return defaultValue;
  }
  return Boolean(raw);
}

export function normalizePrismPalette(raw) {
  const clean = String(raw ?? '').trim().toLowerCase();
  if (clean === 'claude' || clean === 'warm') return 'warm';
  return 'obsidian';
}

export function normalizePrismLightPreset(raw) {
  return normalizeEnumValue(raw, PRISM_LIGHT_PRESET_KEYS, 'crystal');
}

export function normalizePrismDarkAuraStyle(raw) {
  return normalizeEnumValue(raw, PRISM_DARK_AURA_STYLE_KEYS, 'prism');
}

export function normalizePrismAccentTone(raw) {
  return normalizeEnumValue(raw, PRISM_ACCENT_TONE_KEYS, 'follow');
}

export function normalizePrismCornerStyle(raw) {
  return normalizeEnumValue(raw, PRISM_CORNER_STYLE_KEYS, 'balanced');
}

export function normalizePrismCodeFont(raw) {
  const clean = String(raw ?? '').trim().toLowerCase();
  if (clean === 'fira') return 'jetbrains';
  if (clean === 'system') return 'sfmono';
  return PRISM_CODE_FONT_KEYS.includes(clean) ? clean : 'default';
}

export function normalizePrismAmbientIntensity(raw) {
  const clean = String(raw ?? '').trim();
  if (PRISM_AMBIENT_INTENSITY_KEYS.includes(clean)) return clean;
  const num = Number(clean);
  if (Number.isFinite(num)) {
    if (num <= 10) return '0';
    if (num <= 52) return '35';
    if (num <= 85) return '70';
    return '100';
  }
  return '100';
}

export function normalizePrismDarkAura(raw) {
  return normalizeEnumValue(raw, PRISM_DARK_AURA_KEYS, 'balanced');
}

export function normalizePrismMotionLevel(raw) {
  return normalizeEnumValue(raw, PRISM_MOTION_LEVEL_KEYS, 'ultra');
}

export function normalizePrismTargetFps(raw) {
  const clean = String(raw ?? '').trim().toLowerCase();
  if (clean === '144') return '180';
  if (clean === '240' || clean === '300') return 'native';
  return PRISM_TARGET_FPS_KEYS.includes(clean) ? clean : '180';
}

export function normalizePrismConvRipple(raw) {
  if (raw === true) return 'medium';
  if (raw === false) return 'off';
  const clean = String(raw ?? '').trim().toLowerCase();
  if (clean === 'true' || clean === 'on') return 'medium';
  return PRISM_CONV_RIPPLE_KEYS.includes(clean) ? clean : 'off';
}

export function normalizePrismAutoOnOff(raw, fallback = 'auto') {
  if (raw === true) return 'on';
  if (raw === false) return 'off';
  return normalizeEnumValue(raw, PRISM_ON_OFF_AUTO_KEYS, fallback);
}

export function normalizePrismOnOff(raw, fallback = 'on') {
  if (raw === true) return 'on';
  if (raw === false) return 'off';
  return normalizeEnumValue(raw, PRISM_ON_OFF_KEYS, fallback);
}

export function normalizePrismLinkTarget(raw) {
  return normalizeEnumValue(raw, PRISM_LINK_TARGET_KEYS, 'builtin');
}

export function normalizePrismMascot(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === false || raw === 'off') {
    return 'off';
  }
  const clean = String(raw).trim();
  if (clean === 'dual') return 'crab';
  if (clean === 'all') return 'quad-minis';
  if (clean === 'cat') return 'r:k1';
  if (clean === 'dragon') return 'r:d1';
  if (clean === 'whale') return 'r:w1';
  if (/^(crab|minis|quad|quad-minis|r:(?:[ckdw][0-4](?:,[ckdw][0-4])*)?(?:\+m)?)$/.test(clean)) {
    return clean;
  }
  return 'off';
}

export function normalizePrismEnabled(raw) {
  return normalizeBoolDefault(raw, true);
}

export function normalizePrismBoolTrue(raw) {
  return normalizeBoolDefault(raw, true);
}

export function normalizePrismBoolFalse(raw) {
  return normalizeBoolDefault(raw, false);
}

/**
 * Translate canonical Usage Monitor settings into Obsidian Prism runtime config.
 *
 * @param {object|null|undefined} settings
 * @returns {Record<string, any>}
 */
export function mapSettingsToPrismRuntimeConfig(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const enabled = normalizePrismEnabled(s.prismEnabled);
  const mascot = normalizePrismMascot(s.prismMascot);
  const homeStudio = normalizePrismOnOff(s.prismHomeStudio, 'on');
  const workbench = normalizePrismOnOff(s.prismWorkbenchEnhancer, 'on');
  const omni = normalizePrismOnOff(s.prismOmniModule, 'on');
  const effort = normalizePrismAutoOnOff(s.prismEffortSlider, 'auto');
  const effortMem = normalizePrismOnOff(s.prismEffortMemory, 'on');
  const wallpaperOn = normalizePrismBoolFalse(s.prismWallpaperEnabled);
  const homeRipple = normalizePrismBoolTrue(s.prismHomeRipple);
  const composerRestyle = normalizePrismBoolTrue(s.prismComposerRestyle);
  const sidebarRestyle = normalizePrismBoolTrue(s.prismSidebarRestyle);
  return {
    prismEnabled: enabled,
    language: normalizeLanguageSetting(s.language),
    lang: normalizeLanguageSetting(s.language),
    palette: normalizePrismPalette(s.prismPalette),
    lightPreset: normalizePrismLightPreset(s.prismLightPreset),
    darkAuraStyle: normalizePrismDarkAuraStyle(s.prismDarkAuraStyle),
    accentTone: normalizePrismAccentTone(s.prismAccentTone),
    cornerStyle: normalizePrismCornerStyle(s.prismCornerStyle),
    codeFont: normalizePrismCodeFont(s.prismCodeFont),
    codeLigatures: normalizePrismBoolFalse(s.prismCodeLigatures),
    ambientIntensity: normalizePrismAmbientIntensity(s.prismAmbientIntensity),
    darkAura: normalizePrismDarkAura(s.prismDarkAura),
    motionLevel: normalizePrismMotionLevel(s.prismMotionLevel),
    targetFps: normalizePrismTargetFps(s.prismTargetFps),
    homeLayout: homeStudio === 'on' ? 'studio' : 'off',
    homeMode: homeStudio === 'on' ? 'studio' : 'off',
    homeRipple,
    ripple: homeRipple ? 'on' : 'off',
    convRipple: normalizePrismConvRipple(s.prismConvRipple),
    smoothCaret: normalizePrismBoolTrue(s.prismSmoothCaret),
    scrollBottomMotion: normalizeEnumValue(s.prismScrollBottomMotion, ['smooth', 'instant'], 'smooth'),
    composerRestyle,
    composer: composerRestyle ? 'on' : 'off',
    sidebarRestyle,
    sidebar: sidebarRestyle ? 'on' : 'off',
    sidebarCompact: normalizePrismBoolFalse(s.prismSidebarCompact),
    sidebarNavFold: normalizePrismOnOff(s.prismSidebarNavFold, 'off'),
    placeholderStyle: normalizeEnumValue(s.prismPlaceholderStyle, ['studio', 'host'], 'studio'),
    promptStyle: normalizeEnumValue(s.prismPlaceholderStyle, ['studio', 'host'], 'studio'),
    logoInk: normalizeEnumValue(s.prismLogoInk, ['accent', 'mono', 'native'], 'accent'),
    effortSliderModule: effort,
    effortMemory: effortMem,
    workbenchEnhancer: workbench,
    omniModule: omni,
    linkTarget: normalizePrismLinkTarget(s.prismLinkTarget),
    mascot,
    wallpaperEnabled: wallpaperOn,
    // Strictly disabled excluded features
    telemetryModule: 'off',
    periodicModelPicker: 'off',
    thoughtTranslate: 'off',
    contextMenu: false,
    inlineDiff: 'off',
    sidebarStudio: 'off',
    hostLocalization: 'off',
    autoUpdate: 'off',
  };
}

/**
 * Translate a partial Obsidian Prism settings patch back to canonical Usage Monitor settings keys.
 *
 * @param {object|null|undefined} prismPatch
 * @returns {Record<string, any>}
 */
export function mapPrismPatchToSettingsPatch(prismPatch) {
  if (!prismPatch || typeof prismPatch !== 'object' || Array.isArray(prismPatch)) return {};
  const out = {};
  if ('prismEnabled' in prismPatch) out.prismEnabled = normalizePrismEnabled(prismPatch.prismEnabled);
  if ('palette' in prismPatch) out.prismPalette = normalizePrismPalette(prismPatch.palette);
  if ('lightPreset' in prismPatch) out.prismLightPreset = normalizePrismLightPreset(prismPatch.lightPreset);
  if ('darkAuraStyle' in prismPatch) out.prismDarkAuraStyle = normalizePrismDarkAuraStyle(prismPatch.darkAuraStyle);
  if ('accentTone' in prismPatch) out.prismAccentTone = normalizePrismAccentTone(prismPatch.accentTone);
  if ('cornerStyle' in prismPatch) out.prismCornerStyle = normalizePrismCornerStyle(prismPatch.cornerStyle);
  if ('codeFont' in prismPatch) out.prismCodeFont = normalizePrismCodeFont(prismPatch.codeFont);
  if ('codeLigatures' in prismPatch) out.prismCodeLigatures = normalizePrismBoolFalse(prismPatch.codeLigatures);
  if ('ambientIntensity' in prismPatch) out.prismAmbientIntensity = normalizePrismAmbientIntensity(prismPatch.ambientIntensity);
  if ('darkAura' in prismPatch) out.prismDarkAura = normalizePrismDarkAura(prismPatch.darkAura);
  if ('motionLevel' in prismPatch) out.prismMotionLevel = normalizePrismMotionLevel(prismPatch.motionLevel);
  if ('targetFps' in prismPatch) out.prismTargetFps = normalizePrismTargetFps(prismPatch.targetFps);
  if ('homeRipple' in prismPatch || 'ripple' in prismPatch) {
    const raw = 'homeRipple' in prismPatch ? prismPatch.homeRipple : prismPatch.ripple;
    out.prismHomeRipple = normalizePrismBoolTrue(raw);
  }
  if ('convRipple' in prismPatch) out.prismConvRipple = normalizePrismConvRipple(prismPatch.convRipple);
  if ('smoothCaret' in prismPatch) out.prismSmoothCaret = normalizePrismBoolTrue(prismPatch.smoothCaret);
  if ('scrollBottomMotion' in prismPatch) {
    out.prismScrollBottomMotion = normalizeEnumValue(prismPatch.scrollBottomMotion, ['smooth', 'instant'], 'smooth');
  }
  if ('composerRestyle' in prismPatch || 'composer' in prismPatch) {
    const raw = 'composerRestyle' in prismPatch ? prismPatch.composerRestyle : prismPatch.composer;
    out.prismComposerRestyle = normalizePrismBoolTrue(raw);
  }
  if ('sidebarRestyle' in prismPatch || 'sidebar' in prismPatch) {
    const raw = 'sidebarRestyle' in prismPatch ? prismPatch.sidebarRestyle : prismPatch.sidebar;
    out.prismSidebarRestyle = normalizePrismBoolTrue(raw);
  }
  if ('sidebarCompact' in prismPatch) out.prismSidebarCompact = normalizePrismBoolFalse(prismPatch.sidebarCompact);
  if ('sidebarNavFold' in prismPatch) out.prismSidebarNavFold = normalizePrismOnOff(prismPatch.sidebarNavFold, 'off');
  if ('placeholderStyle' in prismPatch || 'promptStyle' in prismPatch) {
    const raw = 'placeholderStyle' in prismPatch ? prismPatch.placeholderStyle : prismPatch.promptStyle;
    out.prismPlaceholderStyle = normalizeEnumValue(raw, ['studio', 'host'], 'studio');
  }
  if ('logoInk' in prismPatch) out.prismLogoInk = normalizeEnumValue(prismPatch.logoInk, ['accent', 'mono', 'native'], 'accent');
  if ('effortSliderModule' in prismPatch) out.prismEffortSlider = normalizePrismAutoOnOff(prismPatch.effortSliderModule, 'auto');
  if ('effortMemory' in prismPatch) out.prismEffortMemory = normalizePrismOnOff(prismPatch.effortMemory, 'on');
  if ('homeLayout' in prismPatch || 'homeMode' in prismPatch || 'homeStudio' in prismPatch) {
    const raw = prismPatch.homeStudio ?? prismPatch.homeLayout ?? prismPatch.homeMode;
    out.prismHomeStudio = raw === 'off' || raw === false ? 'off' : 'on';
  }
  if ('workbenchEnhancer' in prismPatch) out.prismWorkbenchEnhancer = normalizePrismOnOff(prismPatch.workbenchEnhancer, 'on');
  if ('omniModule' in prismPatch) out.prismOmniModule = normalizePrismOnOff(prismPatch.omniModule, 'on');
  if ('linkTarget' in prismPatch) out.prismLinkTarget = normalizePrismLinkTarget(prismPatch.linkTarget);
  if ('mascot' in prismPatch) out.prismMascot = normalizePrismMascot(prismPatch.mascot);
  if ('wallpaperEnabled' in prismPatch) out.prismWallpaperEnabled = normalizePrismBoolFalse(prismPatch.wallpaperEnabled);
  return out;
}
