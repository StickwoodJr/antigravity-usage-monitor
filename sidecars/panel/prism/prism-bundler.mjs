/**
 * Zero-eval, vm.Script-verified bundle compiler for Obsidian Prism host channels.
 * Compiles Channel 1 + lazy channels (Home Studio, Settings, Omni, Wallpaper, Mascots)
 * with SHA-256 content-hashed disk caching under DATA_DIR.
 *
 * Adapted for antigravity-usage-monitor (GPL-3.0-only) on 2026-11-26.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../backend/config.mjs';

const PRISM_DIR = path.dirname(fileURLToPath(import.meta.url));
const STYLE_ID = 'ag-prism-css';
const PRISM_VERSION = '1.0.8-beta.3';
const BUNDLE_CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_FILENAME = '.prism-bundle-cache.json';

const CHANNEL1_JS_PARTS = Object.freeze([
  'i18n-core.js',
  'usage-core.js',
  'crystal-prism-core.js',
  'animated-icons.js',
  'motion-engine.js',
  'ripple-core.js',
  'conv-aura.js',
  'smooth-caret.js',
  'effort-slider/upstream-client.js',
  'effort-slider/slider-coexist.js',
  'home-ripple-host.js',
  'model-glyph-crystal.js',
  'stream-choreography.js',
  'prism-rim-canvas.js',
  'host-workbench-enhancer.js',
  'ui-runtime.js',
]);

let _memChannel1Base = null;
const _memChannelAssets = new Map();

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function shortHash(text) {
  return sha256Hex(text).slice(0, 12);
}

/**
 * Verifies JavaScript expression syntax using `vm.Script` (never executes it).
 * Throws if invalid syntax is detected.
 */
export function verifyCompiledExpression(expr, label = 'prism-expr') {
  new vm.Script(String(expr || ''), { filename: `${label}.compiled.js` });
  return true;
}

/**
 * Strips comments and redundant runs of whitespace from CSS while preserving quoted strings
 * and `calc(...)` spacing.
 */
export function compactCss(rawCss) {
  const src = String(rawCss || '');
  let out = '';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[++i];
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === '\r' || ch === '\n' || ch === '\t') {
      if (out.length > 0 && !/[\s{}:;,]$/.test(out)) out += ' ';
      continue;
    }
    if (ch === ' ' && (out.length === 0 || /\s$/.test(out))) continue;
    out += ch;
  }
  return out.trim();
}

function getFileSig(filePath) {
  const st = fs.statSync(filePath);
  return `${st.mtimeMs}:${st.size}`;
}

function readLocalesSliceForLang(lang) {
  const locPath = path.join(PRISM_DIR, 'i18n-locales.js');
  if (!fs.existsSync(locPath)) return null;
  try {
    const code = fs.readFileSync(locPath, 'utf8');
    const sandbox = { globalThis: null, window: null };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.runInNewContext(code, sandbox, { timeout: 250 });
    const mod = sandbox.__agCsLocales;
    if (!mod || typeof mod.getUiStrings !== 'function') return null;
    const normLang = String(lang || '').toLowerCase().startsWith('zh')
      ? /tw|hk|mo|hant/i.test(String(lang)) ? 'zh-TW' : 'zh-CN'
      : 'en';
    const sliceKeys = [
      'sectionTitle', 'foldExpandHint', 'foldCollapseHint', 'tabOverview', 'tabModels', 'tabQuotas',
      'kpiSessions', 'kpiCalls', 'kpiTokens', 'kpiDays', 'kpiCacheHit', 'kpiFavModel',
      'homeScopeAll', 'homeScopeActive', 'homeScopeActiveCount', 'homeScopeArchivedCount',
      'homeLocalOnlyTag', 'homeLocalScopeNote', 'quotaPoolsTitle', 'quotaEmptyHint', 'quotaLoading',
      'quotaLow', 'quotaTight', 'quotaHealthy', 'weeklyLabel', 'fiveHourLabel', 'refreshBtnTitle',
      'thinkingEllipsis', 'workspaceAll', 'workspaceFilterAria', 'noModelUsage', 'showLess',
      'tokensInShort', 'tokensOutShort', 'cacheShort', 'cacheRead', 'sessionsUnit', 'subagentsUnit',
      'tokenUnit', 'swarmBadge', 'optHost', 'optWarm', 'optObsidian', 'optLightCrystal',
      'optLightAlabaster', 'optMotionOff', 'optMotionSubtle', 'optMotionStandard', 'optMotionUltra',
    ];
    const picked = mod.getUiStrings(normLang) || {};
    const vals = sliceKeys.map((k) => (typeof picked[k] === 'string' ? picked[k] : ''));
    return { active: normLang, keys: sliceKeys, vals: { [normLang]: vals } };
  } catch {
    return null;
  }
}

function resolveCachePath(opts) {
  if (opts?.noDiskCache) return '';
  if (typeof opts?.cachePath === 'string' && opts.cachePath.trim()) {
    return path.resolve(opts.cachePath.trim());
  }
  return path.join(DATA_DIR, DEFAULT_CACHE_FILENAME);
}

function readVerifiedDiskCache(cachePath) {
  if (!cachePath) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    if (raw.length > 6 * 1024 * 1024) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== BUNDLE_CACHE_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeVerifiedDiskCacheAtomic(cachePath, payloadObj) {
  if (!cachePath) return;
  try {
    const dir = path.dirname(cachePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.prism-bundle.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const body = JSON.stringify({
      schemaVersion: BUNDLE_CACHE_SCHEMA_VERSION,
      ...payloadObj,
    });
    fs.writeFileSync(tmp, body, { mode: 0o600, encoding: 'utf8' });
    fs.renameSync(tmp, cachePath);
  } catch {
    // Non-fatal cache write failure
  }
}

function buildHostGuardSnippet(extraChecks = '') {
  return `
    try { if (window.self !== window.top) return { ok: false, status: 'skipped-subframe' }; }
    catch { return { ok: false, status: 'skipped-subframe' }; }
    try {
      const href = String(window.location?.href || '');
      const low = href.toLowerCase();
      if (/^(?:devtools:\\/\\/|data:|chrome:|chrome-extension:|edge:|blob:|plugin:)/.test(low)) {
        return { ok: false, status: 'skipped-non-host' };
      }
      if (/^https?:/.test(low)) {
        const m = /^(https?):\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])(?::\\d+)?(\\/[^?#]*)?/i.exec(href);
        if (!m) return { ok: false, status: 'skipped-non-host' };
        if (/^\\/(?:viewer(?:\\/|$)|sandbox(?:\\/|$)|stream(?:\\/|$)|api(?:\\/|$))/.test((m[3] || '/').toLowerCase())) {
          return { ok: false, status: 'skipped-non-host' };
        }
      }
      ${extraChecks}
    } catch {}
  `;
}

function readAndVerifyJs(relPath, extraPrepend = '') {
  const full = path.join(PRISM_DIR, relPath);
  const src = fs.readFileSync(full, 'utf8');
  const wrapped = extraPrepend ? `${extraPrepend}\n${src}` : src;
  new vm.Script(wrapped, { filename: relPath });
  return wrapped;
}

function getOrCompileChannel1Base(opts = null) {
  const cssPath = path.join(PRISM_DIR, 'style.css');
  const sigParts = [getFileSig(cssPath)];
  for (const rel of CHANNEL1_JS_PARTS) {
    sigParts.push(`${rel}:${getFileSig(path.join(PRISM_DIR, rel))}`);
  }
  const sourceSig = sigParts.join('|');
  const cachePath = resolveCachePath(opts);

  if (_memChannel1Base && _memChannel1Base.sourceSig === sourceSig && !opts?.forceRecompile) {
    return { ..._memChannel1Base, fromCache: true };
  }

  const hashHasher = crypto.createHash('sha256');
  hashHasher.update(`ch1:${BUNDLE_CACHE_SCHEMA_VERSION}:${PRISM_VERSION}\0`);
  const cssRaw = fs.readFileSync(cssPath, 'utf8');
  hashHasher.update(cssRaw);
  const partSources = [];
  for (const rel of CHANNEL1_JS_PARTS) {
    const body = fs.readFileSync(path.join(PRISM_DIR, rel), 'utf8');
    hashHasher.update(`\0${rel}\0`);
    hashHasher.update(body);
    const prepend = rel === 'effort-slider/upstream-client.js'
      ? 'globalThis.__agCodexEffortSliderDisableAutoBoot = true;'
      : '';
    partSources.push({ rel, body: prepend ? `${prepend}\n${body}` : body });
  }
  const sourceHash = hashHasher.digest('hex');

  if (cachePath && !opts?.forceRecompile) {
    const disk = readVerifiedDiskCache(cachePath);
    const ent = disk?.channel1;
    if (
      ent &&
      ent.sourceHash === sourceHash &&
      ent.bundleCode &&
      ent.minCss &&
      ent.codeHash &&
      sha256Hex(`${ent.codeHash}\0${ent.minCss}\0${ent.bundleCode}`) === ent.payloadSha256
    ) {
      const hit = {
        sourceSig,
        sourceHash,
        codeHash: ent.codeHash,
        minCss: ent.minCss,
        bundleCode: ent.bundleCode,
      };
      _memChannel1Base = hit;
      return { ...hit, fromCache: true };
    }
  }

  const minCss = compactCss(cssRaw);
  const chunks = partSources.map(({ rel, body }) => {
    new vm.Script(body, { filename: rel });
    return `;\n/* === ${rel} === */\n${body}`;
  });
  const bundleCode = `function __AG_INJ_BUNDLE__() {\n${chunks.join('\n')}\n}`;
  new vm.Script(bundleCode, { filename: 'channel1-bundle.js' });
  const codeHash = shortHash(`${minCss}\0${bundleCode}`);
  const payloadSha256 = sha256Hex(`${codeHash}\0${minCss}\0${bundleCode}`);

  const compiled = { sourceSig, sourceHash, codeHash, minCss, bundleCode };
  _memChannel1Base = compiled;

  if (cachePath) {
    const existing = readVerifiedDiskCache(cachePath) || {};
    writeVerifiedDiskCacheAtomic(cachePath, {
      ...existing,
      channel1: {
        sourceHash,
        codeHash,
        minCss,
        bundleCode,
        payloadSha256,
        updatedAt: Date.now(),
      },
    });
  }

  return { ...compiled, fromCache: false };
}

/**
 * Compiles Channel 1 injection expression with embedded CSS + runtime config + UI slice.
 */
export function buildPrismChannel1Expression(runtimeCfg = {}, opts = null) {
  const base = getOrCompileChannel1Base(opts);
  const uiSlice = readLocalesSliceForLang(runtimeCfg?.language || runtimeCfg?.lang || 'en');
  const bootCfg = {
    binding: '__agPrismSetting',
    ...runtimeCfg,
    codeHash: base.codeHash,
    ...(uiSlice ? { __uiSlice: uiSlice } : {}),
  };
  const cfgJson = JSON.stringify(bootCfg);
  const cssJson = JSON.stringify(base.minCss);
  const hashJson = JSON.stringify(base.codeHash);

  const expression = `(() => {
    ${buildHostGuardSnippet()}
    const D = document, W = window, G = globalThis;
    const VER = ${JSON.stringify(PRISM_VERSION)};
    const CODE_HASH = ${hashJson};
    const STYLE_ID = ${JSON.stringify(STYLE_ID)};
    const applyStyle = () => {
      try {
        const host = D.head || D.documentElement;
        if (!host) return;
        let el = D.getElementById(STYLE_ID);
        const css = ${cssJson};
        if (!el) {
          el = D.createElement('style');
          el.id = STYLE_ID;
          el.setAttribute('data-ag-owned', '1');
          el.setAttribute('data-ag-cs-css-hash', CODE_HASH);
          el.textContent = css;
          host.appendChild(el);
        } else if (el.getAttribute('data-ag-cs-css-hash') !== CODE_HASH) {
          el.setAttribute('data-ag-cs-css-hash', CODE_HASH);
          el.textContent = css;
        }
      } catch {}
    };
    const boot = () => {
      applyStyle();
      const bootCfg = ${cfgJson};
      const cur = W.__agPrism || W.__agClaudeStyle;
      if (cur && cur.version === VER && cur.codeHash === CODE_HASH && W.__agPrismEffortSlider) {
        cur.refreshConfig(bootCfg);
        return { ok: true, reused: true, codeHash: CODE_HASH };
      }
      ${base.bundleCode}
      __AG_INJ_BUNDLE__();
      if (typeof G.__agCsUiMain === 'function') {
        G.__agCsUiMain(bootCfg);
      }
      return { ok: true, status: 'mounted', codeHash: CODE_HASH };
    };
    if (D.documentElement) return boot();
    if (typeof D.addEventListener === 'function') {
      D.addEventListener('DOMContentLoaded', () => { try { boot(); } catch {} }, { once: true });
      return { ok: true, status: 'deferred', codeHash: CODE_HASH };
    }
    return { ok: false, status: 'no-document' };
  })()`;

  verifyCompiledExpression(expression, 'channel1');
  return {
    expression,
    codeHash: base.codeHash,
    sourceHash: base.sourceHash,
    byteLength: Buffer.byteLength(expression, 'utf8'),
    fromCache: base.fromCache,
  };
}

export const CHANNEL1_REMOVE_EXPRESSION = `(() => {
  try { (window.__agPrism || window.__agClaudeStyle)?.destroy?.(); } catch {}
  try { document.getElementById(${JSON.stringify(STYLE_ID)})?.remove?.(); } catch {}
  try { delete window.__agPrism; } catch {}
  try { delete window.__agClaudeStyle; } catch {}
  return { ok: true, status: 'off' };
})()`;

export function buildRefreshConfigExpression(runtimeCfg = {}) {
  const cfgJson = JSON.stringify({
    binding: '__agPrismSetting',
    ...runtimeCfg,
  });
  const expr = `(() => {
    try { if (window.self !== window.top) return { ok: false, status: 'skipped-subframe' }; }
    catch { return { ok: false, status: 'skipped-subframe' }; }
    try {
      const api = window.__agPrism || window.__agClaudeStyle;
      if (api && typeof api.refreshConfig === 'function') {
        api.refreshConfig(${cfgJson});
        return { ok: true, status: 'refreshed' };
      }
      return { ok: false, status: 'not-mounted' };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  })()`;
  verifyCompiledExpression(expr, 'refresh-config');
  return expr;
}

function getLazyPartCached(name, files) {
  const sig = files.map((f) => `${f}:${getFileSig(path.join(PRISM_DIR, f))}`).join('|');
  const prev = _memChannelAssets.get(name);
  if (prev && prev.sig === sig) return prev;
  const code = files.map((f) => readAndVerifyJs(f)).join(';\n');
  const codeHash = shortHash(code);
  const res = { sig, code, codeHash };
  _memChannelAssets.set(name, res);
  return res;
}

export const HOME_STUDIO_REMOVE_EXPRESSION = `(() => {
  try { (window.__agPrism || window.__agClaudeStyle)?.detachHomeStudio?.(); } catch {}
  try { document.getElementById('ag-prism-studio-v101-css')?.remove?.(); } catch {}
  try { document.querySelectorAll('.ag-cs-home-panel-seat, .ag-cs-home-panel').forEach((n) => n.remove()); } catch {}
  try { delete window.__agPrismHomeStudioPanel; delete globalThis.__agPrismHomeStudioPanel; } catch {}
  try { delete window.__agHomeStudioPanel; delete globalThis.__agHomeStudioPanel; } catch {}
  return { ok: true, status: 'off' };
})()`;

export function buildPrismHomeStudioExpression(runtimeCfg = {}) {
  if ((runtimeCfg?.homeLayout || 'studio') !== 'studio') return '';
  const { code, codeHash } = getLazyPartCached('homeStudio', ['home-studio-panel.js']);
  const hashJson = JSON.stringify(codeHash);
  const expr = `(() => {
    ${buildHostGuardSnippet()}
    const targetHash = ${hashJson};
    const existing = globalThis.__agPrismHomeStudioPanel || window.__agPrismHomeStudioPanel;
    if (existing && existing.__prismCodeHash === targetHash) {
      try { (window.__agPrism || window.__agClaudeStyle)?.syncHomeStudio?.(); } catch {}
      return { ok: true, reused: true, codeHash: targetHash };
    }
    ${code};
    const mod = globalThis.__agPrismHomeStudioPanel || window.__agPrismHomeStudioPanel;
    if (mod && typeof mod === 'object') {
      mod.__prismCodeHash = targetHash;
      window.__agPrismHomeStudioPanel = mod;
    }
    try { (window.__agPrism || window.__agClaudeStyle)?.syncHomeStudio?.(); } catch {}
    return { ok: true, status: 'mounted', codeHash: targetHash };
  })()`;
  verifyCompiledExpression(expr, 'homeStudio');
  return expr;
}

export const SETTINGS_REMOVE_EXPRESSION = `(() => {
  try {
    const sec = document.getElementById('ag-cs-settings-sec');
    sec?.__agMascotStageApi?.dispose?.();
    sec?.remove?.();
  } catch {}
  try { delete window.__agPrismSettingsPanel; delete globalThis.__agPrismSettingsPanel; } catch {}
  try { delete window.__agPrismBrandLogoSvg; delete globalThis.__agPrismBrandLogoSvg; } catch {}
  try { delete window.__agOctopathStageWebGL; delete globalThis.__agOctopathStageWebGL; } catch {}
  try { delete window.__agOctopathTavernAtlas; delete globalThis.__agOctopathTavernAtlas; } catch {}
  return { ok: true, status: 'off' };
})()`;

export function buildPrismSettingsExpression() {
  const { code, codeHash } = getLazyPartCached('settings', [
    'i18n-locales.js',
    'assets/brand-mark-svg.js',
    'mascots/tavern-atlas-data.js',
    'mascots/octopath-stage-webgl.js',
    'settings-panel.js',
  ]);
  const hashJson = JSON.stringify(codeHash);
  const expr = `(() => {
    ${buildHostGuardSnippet()}
    const targetHash = ${hashJson};
    const existingPanel = globalThis.__agPrismSettingsPanel || window.__agPrismSettingsPanel;
    const existingLoc = globalThis.__agCsLocales || window.__agCsLocales;
    if (existingPanel && existingPanel.__prismCodeHash === targetHash && existingLoc && existingLoc.__isFullLocales) {
      try { (window.__agPrism || window.__agClaudeStyle)?.sync?.(); } catch {}
      return { ok: true, reused: true, codeHash: targetHash };
    }
    try { document.getElementById('ag-cs-settings-sec')?.remove?.(); } catch {}
    ${code};
    const panel = globalThis.__agPrismSettingsPanel || window.__agPrismSettingsPanel;
    if (panel && typeof panel === 'object') {
      panel.__prismCodeHash = targetHash;
      window.__agPrismSettingsPanel = panel;
    }
    try { (window.__agPrism || window.__agClaudeStyle)?.sync?.(); } catch {}
    return { ok: true, status: 'mounted', codeHash: targetHash };
  })()`;
  verifyCompiledExpression(expr, 'settings');
  return expr;
}

export const OMNI_REMOVE_EXPRESSION = `(() => {
  try { (window.__agPrismOmni || globalThis.__agPrismOmni)?.destroy?.(); } catch {}
  try { document.getElementById('ag-prism-omni-css')?.remove?.(); } catch {}
  try { document.querySelectorAll('.ag-prism-omni-menu, .ag-prism-omni-pane, [data-ag-prism-omni-owned="1"]').forEach((n) => n.remove()); } catch {}
  try { delete window.__agPrismOmni; delete globalThis.__agPrismOmni; } catch {}
  try { delete window.__agPrismOmniClient; delete globalThis.__agPrismOmniClient; } catch {}
  try { delete window.__agPrismOmniServerMeta; delete globalThis.__agPrismOmniServerMeta; } catch {}
  return { ok: true, status: 'off' };
})()`;

export function buildPrismOmniExpression(runtimeCfg = {}, omniMeta = null) {
  if (runtimeCfg?.omniModule === 'off') return '';
  const { code, codeHash } = getLazyPartCached('omni', ['omni/omni-client.js']);
  const hashJson = JSON.stringify(codeHash);
  const cfgJson = JSON.stringify(runtimeCfg || {});
  const metaJson = JSON.stringify(omniMeta || null);
  const expr = `(() => {
    ${buildHostGuardSnippet()}
    const targetHash = ${hashJson};
    const meta = ${metaJson};
    const cfg = ${cfgJson};
    window.__agPrismOmniServerMeta = meta;
    globalThis.__agPrismOmniServerMeta = meta;
    const existing = window.__agPrismOmni || globalThis.__agPrismOmni;
    if (existing && existing.__prismCodeHash === targetHash) {
      try { existing.sync?.(cfg, meta); } catch {}
      return { ok: true, reused: true, codeHash: targetHash };
    }
    try { existing?.destroy?.(); } catch {}
    ${code};
    const factoryMod = globalThis.__agPrismOmniClient || window.__agPrismOmniClient;
    if (factoryMod && typeof factoryMod.createOmniClient === 'function') {
      const inst = factoryMod.createOmniClient({ window, document });
      inst.__prismCodeHash = targetHash;
      window.__agPrismOmni = inst;
      globalThis.__agPrismOmni = inst;
      try { inst.sync?.(cfg, meta); } catch {}
      return { ok: true, status: 'mounted', codeHash: targetHash };
    }
    return { ok: false, status: 'no-factory' };
  })()`;
  verifyCompiledExpression(expr, 'omni');
  return expr;
}

export const WALLPAPER_REMOVE_EXPRESSION = `(() => {
  try { (window.__agPrismWallpaper || globalThis.__agPrismWallpaper)?.destroy?.(); } catch {}
  try { document.getElementById('ag-prism-wallpaper-root')?.remove?.(); } catch {}
  try { document.getElementById('ag-prism-wallpaper-css')?.remove?.(); } catch {}
  try { document.documentElement?.removeAttribute?.('data-ag-prism-wallpaper'); } catch {}
  try { document.documentElement?.removeAttribute?.('data-ag-prism-wallpaper-hole'); } catch {}
  try { delete window.__agPrismWallpaper; delete globalThis.__agPrismWallpaper; } catch {}
  try { delete window.__agPrismWallpaperFactory; delete globalThis.__agPrismWallpaperFactory; } catch {}
  try { delete window.__agPrismWallpaperSettingsUi; delete globalThis.__agPrismWallpaperSettingsUi; } catch {}
  try { delete window.__prismMountWallpaperUi; delete globalThis.__prismMountWallpaperUi; } catch {}
  return { ok: true, status: 'off' };
})()`;

export function buildPrismWallpaperExpression(runtimeCfg = {}, wpConfig = null, opts = null) {
  const wpEnabled = Boolean(wpConfig?.enabled || runtimeCfg?.wallpaperEnabled);
  const forceForSettings = Boolean(opts?.forceForSettings);
  if (!wpEnabled && !forceForSettings) {
    return '';
  }
  const { code, codeHash } = getLazyPartCached('wallpaper', [
    'wallpaper/wallpaper-client.js',
    'wallpaper/wallpaper-settings-ui.js',
  ]);
  const hashJson = JSON.stringify(codeHash);
  const wpJson = JSON.stringify(wpConfig || { enabled: wpEnabled });
  const expr = `(() => {
    ${buildHostGuardSnippet()}
    const targetHash = ${hashJson};
    const wpCfg = ${wpJson};
    const existing = window.__agPrismWallpaper || globalThis.__agPrismWallpaper;
    if (existing && existing.__prismCodeHash === targetHash) {
      try { existing.applyConfig ? existing.applyConfig(wpCfg) : existing.sync?.(wpCfg); } catch {}
      try { document.getElementById('ag-cs-settings-sec')?.__prismMountWp?.(); } catch {}
      return { ok: true, reused: true, codeHash: targetHash };
    }
    try { existing?.destroy?.(); } catch {}
    ${code};
    const factory = globalThis.__agPrismWallpaperFactory || window.__agPrismWallpaperFactory;
    if (typeof factory === 'function') {
      const inst = factory({ window, document });
      inst.__prismCodeHash = targetHash;
      window.__agPrismWallpaper = inst;
      globalThis.__agPrismWallpaper = inst;
      try { inst.applyConfig ? inst.applyConfig(wpCfg) : inst.sync?.(wpCfg); } catch {}
    }
    try { document.getElementById('ag-cs-settings-sec')?.__prismMountWp?.(); } catch {}
    return { ok: true, status: 'mounted', codeHash: targetHash };
  })()`;
  verifyCompiledExpression(expr, 'wallpaper');
  return expr;
}

export const MASCOT_REMOVE_EXPRESSION = `(() => {
  try { (window.__agDualMascotRig || globalThis.__agDualMascotRig)?.dispose?.(); } catch {}
  try { (window.__agPrism || window.__agClaudeStyle)?.sync?.(); } catch {}
  try {
    document.querySelectorAll('.ag-cs-crab, .ag-cs-dual-stage, .ag-cs-crab-stage, .ag-cs-mascot-stage, .ag-v2-mascot-stage, .ag-v2-habitat-prop').forEach((n) => {
      try { n.__agMascotApi?.dispose?.(); } catch {}
      n.remove?.();
    });
  } catch {}
  try { document.querySelectorAll('[data-ag-cs-crab-anchor]').forEach((n) => n.removeAttribute('data-ag-cs-crab-anchor')); } catch {}
  try { document.documentElement?.removeAttribute?.('data-ag-cs-has-crab'); document.documentElement?.removeAttribute?.('data-ag-cs-mascot-drag'); } catch {}
  try { delete window.__agDualMascotRig; delete globalThis.__agDualMascotRig; } catch {}
  return { ok: true, status: 'off' };
})()`;

export function buildPrismMascotExpression(runtimeCfg = {}) {
  const mascotMode = String(runtimeCfg?.mascot || 'off');
  if (mascotMode === 'off' || mascotMode === 'false') {
    return '';
  }
  const { code, codeHash } = getLazyPartCached('mascot', ['mascots/dual-mascot-rig.js']);
  const hashJson = JSON.stringify(codeHash);
  const expr = `(() => {
    ${buildHostGuardSnippet()}
    const targetHash = ${hashJson};
    const existing = globalThis.__agDualMascotRig || window.__agDualMascotRig;
    if (existing && existing.__prismCodeHash === targetHash) {
      try { (window.__agPrism || window.__agClaudeStyle)?.sync?.(); } catch {}
      return { ok: true, reused: true, codeHash: targetHash };
    }
    ${code};
    const mod = globalThis.__agDualMascotRig || window.__agDualMascotRig;
    if (mod && typeof mod === 'object') {
      mod.__prismCodeHash = targetHash;
      window.__agDualMascotRig = mod;
    }
    try { (window.__agPrism || window.__agClaudeStyle)?.sync?.(); } catch {}
    return { ok: true, status: 'mounted', codeHash: targetHash };
  })()`;
  verifyCompiledExpression(expr, 'mascot');
  return expr;
}
