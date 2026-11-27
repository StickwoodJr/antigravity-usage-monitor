import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  PRISM_ACCENT_TONE_KEYS,
  PRISM_CORNER_STYLE_KEYS,
  PRISM_DARK_AURA_STYLE_KEYS,
  PRISM_LIGHT_PRESET_KEYS,
  PRISM_PALETTE_KEYS,
  mapPrismPatchToSettingsPatch,
  mapSettingsToPrismRuntimeConfig,
} from '../shared/settings-normalization.mjs';
import { normalizeFullSettings } from '../backend/config.mjs';
import {
  buildPrismModelColorMap,
  detectPrismModelCamp,
  resolvePrismChartModelColor,
} from '../src/core/prismColors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PANEL_PATH = path.resolve(__dirname, '../prism/settings-panel.js');

test('Obsidian Prism settings enums, defaults, and bidirectional mappers work as expected', () => {
  assert.deepEqual(PRISM_PALETTE_KEYS, ['obsidian', 'warm']);
  assert.deepEqual(PRISM_LIGHT_PRESET_KEYS, ['crystal', 'alabaster']);
  assert.deepEqual(PRISM_DARK_AURA_STYLE_KEYS, ['prism', 'neon']);
  assert.deepEqual(PRISM_ACCENT_TONE_KEYS, ['follow', 'cobalt', 'iris', 'amber', 'mono']);
  assert.deepEqual(PRISM_CORNER_STYLE_KEYS, ['sharp', 'balanced', 'soft']);

  const defs = normalizeFullSettings({});
  assert.equal(defs.prismMascot, 'off', 'Mascots must be off by default');
  assert.equal(defs.prismWallpaperEnabled, false, 'Wallpapers Beta must be off by default');
  assert.equal(defs.prismPalette, 'obsidian');
  assert.equal(defs.prismLightPreset, 'crystal');

  const rtCfg = mapSettingsToPrismRuntimeConfig(defs);
  assert.equal(rtCfg.mascot, 'off');
  assert.equal(rtCfg.wallpaperEnabled, false);
  assert.equal(rtCfg.telemetryModule, 'off');
  assert.equal(rtCfg.periodicModelPicker, 'off');
  assert.equal(rtCfg.thoughtTranslate, 'off');
  assert.equal(rtCfg.contextMenu, false);

  const patchBack = mapPrismPatchToSettingsPatch({
    palette: 'warm',
    lightPreset: 'alabaster',
    accentTone: 'iris',
    cornerStyle: 'sharp',
    mascot: 'crab',
    wallpaperEnabled: true,
    effortSliderModule: 'on',
  });
  assert.deepEqual(patchBack, {
    prismPalette: 'warm',
    prismLightPreset: 'alabaster',
    prismAccentTone: 'iris',
    prismCornerStyle: 'sharp',
    prismMascot: 'crab',
    prismWallpaperEnabled: true,
    prismEffortSlider: 'on',
  });
});

test('prismColors.js resolves distinct dark/light HSL colors across model camps', () => {
  assert.equal(detectPrismModelCamp('gemini-2.5-pro'), 'gemini');
  assert.equal(detectPrismModelCamp('claude-3.7-sonnet'), 'claude');
  assert.equal(detectPrismModelCamp('gpt-4.1'), 'gpt');
  assert.equal(detectPrismModelCamp('deepseek-r1'), 'deepseek');

  const darkColor = resolvePrismChartModelColor('gemini-2.5-pro', { isDark: true });
  const lightColor = resolvePrismChartModelColor('gemini-2.5-pro', { isDark: false });
  assert.match(darkColor, /^hsl\(/);
  assert.match(lightColor, /^hsl\(/);
  assert.notEqual(darkColor, lightColor);

  const map = buildPrismModelColorMap(['gemini-2.5-pro', 'claude-3.7-sonnet', 'gpt-4.1', 'deepseek-r1'], {
    isDark: true,
  });
  assert.equal(new Set(map.values()).size, 4);
});

test('settings-panel.js exposes only in-scope controls and expands with zero ReferenceErrors', () => {
  // Minimal DOM mock to mount & expand the Settings section and verify zero ReferenceErrors
  const makeEl = (tag) => {
    const attrs = new Map();
    const listeners = new Map();
    const el = {
      tagName: String(tag || 'DIV').toUpperCase(),
      id: '',
      className: '',
      hidden: false,
      style: { setProperty() {}, removeProperty() {} },
      children: [],
      parentElement: null,
      parentNode: null,
      textContent: '',
      innerHTML: '',
      classList: {
        _set: new Set(),
        add(...cs) { cs.forEach((c) => this._set.add(c)); },
        remove(...cs) { cs.forEach((c) => this._set.delete(c)); },
        contains(c) { return this._set.has(c); },
      },
      setAttribute(k, v) { attrs.set(String(k), String(v)); },
      getAttribute(k) { return attrs.get(String(k)) ?? null; },
      hasAttribute(k) { return attrs.has(String(k)); },
      removeAttribute(k) { attrs.delete(String(k)); },
      appendChild(c) {
        c.parentElement = el;
        c.parentNode = el;
        el.children.push(c);
        return c;
      },
      removeChild(c) {
        el.children = el.children.filter((x) => x !== c);
      },
      addEventListener(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(fn);
      },
      removeEventListener() {},
      dispatchEvent(ev) {
        for (const fn of listeners.get(ev?.type) || []) fn(ev);
      },
      remove() {
        if (el.parentElement) el.parentElement.removeChild(el);
      },
      querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
      _matches(sel) {
        for (const sub of sel.split(',').map((s) => s.trim())) {
          if (sub === 'div.p-6' && el.tagName === 'DIV' && String(el.className).includes('p-6')) return true;
          if (sub === 'div.space-y-2' && el.tagName === 'DIV' && String(el.className).includes('space-y-2')) return true;
          if (sub === '[role="dialog"]' && el.getAttribute('role') === 'dialog') return true;
          if (sub === '[role="dialog"] h2' && el.tagName === 'H2') return true;
          const mAttr = sub.match(/^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i);
          if (mAttr && (mAttr[2] !== undefined ? el.getAttribute(mAttr[1]) === mAttr[2] : el.hasAttribute(mAttr[1]))) return true;
          if (sub === 'button[data-ag-cs-key]' && el.tagName === 'BUTTON' && el.hasAttribute('data-ag-cs-key')) return true;
        }
        return false;
      },
      querySelectorAll(sel) {
        const res = [];
        const walk = (n) => {
          for (const c of n.children || []) {
            if (c._matches(sel)) res.push(c);
            walk(c);
          }
        };
        walk(el);
        return res;
      },
      closest(sel) {
        for (let cur = el; cur; cur = cur.parentElement) {
          if (cur._matches(sel)) return cur;
        }
        return null;
      },
      get isConnected() { return true; },
      get firstChild() { return el.children[0] || null; },
    };
    return el;
  };

  const doc = makeEl('HTML');
  const head = makeEl('HEAD');
  const body = makeEl('BODY');
  doc.head = head;
  doc.body = body;
  doc.documentElement = doc;
  const dlg = makeEl('DIV');
  dlg.setAttribute('role', 'dialog');
  const panel = makeEl('DIV');
  panel.className = 'p-6';
  const h2 = makeEl('H2');
  h2.textContent = 'Appearance';
  const spaceDiv = makeEl('DIV');
  spaceDiv.className = 'space-y-2';
  panel.appendChild(h2);
  panel.appendChild(spaceDiv);
  dlg.appendChild(panel);
  body.appendChild(dlg);
  doc.appendChild(head);
  doc.appendChild(body);
  doc.getElementById = (id) => {
    const find = (n) => {
      if (n.id === id) return n;
      for (const c of n.children || []) {
        const hit = find(c);
        if (hit) return hit;
      }
      return null;
    };
    return find(doc);
  };
  doc.createElement = (tag) => makeEl(tag);

  const memStore = new Map();
  const sandbox = {
    document: doc,
    WeakSet,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    JSON,
    Date,
    Math,
    RegExp,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => memStore.get(k) ?? null,
      setItem: (k, v) => memStore.set(k, String(v)),
      removeItem: (k) => memStore.delete(k),
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  vm.runInNewContext(fs.readFileSync(SETTINGS_PANEL_PATH, 'utf8'), sandbox);
  const panelMod = sandbox.__agPrismSettingsPanel;
  assert.ok(panelMod, 'settings-panel.js should register __agPrismSettingsPanel');
  assert.equal(panelMod.PRISM_SETTINGS_SCHEMA.mascot.default, 'off');
  assert.equal('thoughtTranslate' in panelMod.PRISM_SETTINGS_SCHEMA, false);
  assert.equal('periodicModelPicker' in panelMod.PRISM_SETTINGS_SCHEMA, false);
  assert.equal('telemetryModule' in panelMod.PRISM_SETTINGS_SCHEMA, false);
  assert.equal('autoUpdate' in panelMod.PRISM_SETTINGS_SCHEMA, false);

  panelMod.mountOrSyncSettingsSection({
    version: '1.0.8-beta.3',
    getLang: () => 'en',
    uiText: () => ({}),
    isZh: () => false,
    i18nCore: null,
    formatSettingsSummary: () => 'Obsidian · Crystal',
    resolveSettingRowActiveValue: (k) => panelMod.PRISM_SETTINGS_SCHEMA[k]?.default,
    isSettingButtonMatch: () => false,
    saveSetting: () => {},
    saveSettingsBatch: () => {},
    getThoughtTranslateMode: () => 'off',
    handledGroupClicks: new WeakSet(),
    runSettingsGroupGlide: () => {},
    runGuardedMut: (fn) => fn(),
    lazyFold: false,
  });
  const sec = doc.getElementById(panelMod.SETTINGS_SEC_ID);
  assert.ok(sec, 'Settings section must mount cleanly');
  assert.equal(sec.getAttribute('data-body-built'), '1', 'Expanded settings body must build cleanly with 0 errors');
});
