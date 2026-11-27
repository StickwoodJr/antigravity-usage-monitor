/**
 * Ported & adapted from Obsidian Prism (`home-studio-panel.js` MODEL_CAMP_PALETTES)
 * by @RMvdesi (GPL-3.0-only). Modified on 2026-11-26 for antigravity-usage-monitor.
 *
 * Curated dual-theme (dark/light) per-provider model-camp palettes ensuring
 * high contrast and distinct hues between sibling models (Gemini, Claude, GPT, DeepSeek).
 */

export const PRISM_MODEL_CAMP_PALETTES = Object.freeze({
  gemini: Object.freeze([
    ['#4F8BFF', '#2563EB'],
    ['#22D3EE', '#0891B2'],
    ['#818CF8', '#4F46E5'],
    ['#2DD4BF', '#0D9488'],
    ['#93C5FD', '#1E40AF'],
  ]),
  claude: Object.freeze([
    ['#F59E0B', '#D97706'],
    ['#FB7185', '#E11D48'],
    ['#F97316', '#C2410C'],
    ['#FBBF24', '#B45309'],
    ['#F43F5E', '#BE123C'],
  ]),
  gpt: Object.freeze([
    ['#34D399', '#059669'],
    ['#A3E635', '#65A30D'],
    ['#4ADE80', '#16A34A'],
    ['#5EEAD4', '#0F766E'],
  ]),
  deepseek: Object.freeze([
    ['#A78BFA', '#7C3AED'],
    ['#E879F9', '#C026D3'],
    ['#C084FC', '#9333EA'],
    ['#F472B6', '#DB2777'],
  ]),
});

export const PRISM_MODEL_OVERFLOW_PALETTE = Object.freeze([
  ['#38BDF8', '#0284C7'],
  ['#EC4899', '#BE185D'],
  ['#84CC16', '#4D7C0F'],
  ['#FB923C', '#EA580C'],
  ['#C4B5FD', '#6D28D9'],
  ['#FACC15', '#CA8A04'],
  ['#14B8A6', '#115E59'],
  ['#94A3B8', '#475569'],
]);

const PRISM_ALL_FALLBACKS = Object.freeze([
  ...PRISM_MODEL_OVERFLOW_PALETTE,
  ...PRISM_MODEL_CAMP_PALETTES.gemini,
  ...PRISM_MODEL_CAMP_PALETTES.claude,
  ...PRISM_MODEL_CAMP_PALETTES.gpt,
  ...PRISM_MODEL_CAMP_PALETTES.deepseek,
]);

export function detectPrismModelCamp(modelSeed) {
  const s = String(modelSeed || '').toLowerCase();
  if (/gemini|argon|carbon|hydrogen|palm|bard|orchestrator/.test(s)) return 'gemini';
  if (/claude|anthropic|opus|sonnet|haiku/.test(s)) return 'claude';
  if (/gpt|openai|codex|chatgpt|\bo[134](?:-|\b)/.test(s)) return 'gpt';
  if (/deepseek/.test(s)) return 'deepseek';
  return 'other';
}

function prismHslToHex(hDeg, sPct, lPct) {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const s = sPct / 100;
  const l = lPct / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    const k = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v =
      k < 1 / 6 ? p + (q - p) * 6 * k : k < 0.5 ? q : k < 2 / 3 ? p + (q - p) * (2 / 3 - k) * 6 : p;
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  };
  return '#' + ch(h + 1 / 3) + ch(h) + ch(h - 1 / 3);
}

function prismFnv1a32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function hexToCssHsl(hex) {
  const clean = String(hex || '').replace('#', '');
  if (clean.length !== 6) return 'hsl(217 84% 53%)';
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

export function isPrismDarkColorScheme() {
  if (typeof document === 'undefined' || !document.documentElement) return true;
  const scheme = document.documentElement.getAttribute?.('data-color-scheme');
  if (scheme === 'light') return false;
  if (scheme === 'dark') return true;
  return true;
}

/**
 * Resolve a single deterministic `{ dark, light }` pair (CSS `hsl(...)`) for a model identifier.
 *
 * @param {string} seed
 * @returns {{ dark: string, light: string, camp: string }}
 */
export function resolvePrismModelCampPair(seed) {
  const clean = String(seed || '').trim();
  if (!clean) {
    return { dark: 'hsl(217 91% 68%)', light: 'hsl(221 83% 53%)', camp: 'other' };
  }
  const camp = detectPrismModelCamp(clean);
  const pool = PRISM_MODEL_CAMP_PALETTES[camp] || PRISM_MODEL_OVERFLOW_PALETTE;
  const idx = prismFnv1a32(clean.toLowerCase()) % pool.length;
  const pair = pool[idx] || PRISM_MODEL_OVERFLOW_PALETTE[0];
  return { dark: hexToCssHsl(pair[0]), light: hexToCssHsl(pair[1]), camp };
}

/**
 * Build a collision-free dark/light color map (`hsl(...)`) for a set of canonical model seeds.
 *
 * @param {string[]} seeds
 * @param {{ isDark?: boolean }} [options]
 * @returns {Map<string, string>}
 */
export function buildPrismModelColorMap(seeds, { isDark = isPrismDarkColorScheme() } = {}) {
  const uniqueSeeds = Array.from(
    new Set((Array.isArray(seeds) ? seeds : []).map((s) => String(s || '').trim()).filter(Boolean))
  ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const usedDark = new Set();
  const usedLight = new Set();
  const out = new Map();

  for (const seed of uniqueSeeds) {
    const camp = detectPrismModelCamp(seed);
    const campPool = PRISM_MODEL_CAMP_PALETTES[camp] || [];
    const candidates = [...campPool, ...PRISM_ALL_FALLBACKS];
    let picked = null;
    for (const pair of candidates) {
      if (!usedDark.has(pair[0]) && !usedLight.has(pair[1])) {
        picked = pair;
        break;
      }
    }
    if (!picked) {
      const baseHue = prismFnv1a32(seed) % 360;
      for (let step = 0; step < 360; step += 1) {
        const hue = (baseHue + step * 137.508) % 360;
        const dHex = prismHslToHex(hue, 76, step % 2 === 0 ? 64 : 54);
        const lHex = prismHslToHex(hue, 72, step % 2 === 0 ? 42 : 34);
        if (!usedDark.has(dHex) && !usedLight.has(lHex)) {
          picked = [dHex, lHex];
          break;
        }
      }
    }
    const pair = picked || ['#4F8BFF', '#2563EB'];
    usedDark.add(pair[0]);
    usedLight.add(pair[1]);
    out.set(seed, hexToCssHsl(isDark ? pair[0] : pair[1]));
  }
  return out;
}

/**
 * Convenience resolver for chart/legend models using Obsidian Prism's dual-theme model-camp palettes.
 *
 * @param {string} seed
 * @param {{ isDark?: boolean }} [options]
 * @returns {string}
 */
export function resolvePrismChartModelColor(seed, { isDark = isPrismDarkColorScheme() } = {}) {
  const pair = resolvePrismModelCampPair(seed);
  return isDark ? pair.dark : pair.light;
}
