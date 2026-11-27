import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  buildPrismChannel1Expression,
  buildPrismHomeStudioExpression,
  buildPrismMascotExpression,
  buildPrismOmniExpression,
  buildPrismSettingsExpression,
  buildPrismWallpaperExpression,
  buildRefreshConfigExpression,
} from '../prism/prism-bundler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME_STUDIO_PATH = path.resolve(__dirname, '../prism/home-studio-panel.js');
const UI_RUNTIME_PATH = path.resolve(__dirname, '../prism/ui-runtime.js');

test('prism-bundler compiles all channels cleanly and emits 0 bytes when mascot & wallpaper are off', () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'ag-prism-cache-'));
  const cachePath = path.join(workDir, '.prism-bundle-cache.json');
  try {
    const ch1First = buildPrismChannel1Expression(
      { palette: 'obsidian', lightPreset: 'crystal', accentTone: 'cobalt', mascot: 'off', wallpaperEnabled: false, language: 'en' },
      { cachePath, forceRecompile: true }
    );
    assert.equal(ch1First.fromCache, false);
    assert.ok(ch1First.byteLength > 200_000);
    assert.doesNotThrow(() => new vm.Script(ch1First.expression));

    // Disk cache hit check + tamper invalidation check
    const rawCache = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(rawCache);
    assert.equal(parsed.channel1.codeHash, ch1First.codeHash);

    // Off-by-default zero-byte emission check
    assert.equal(buildPrismMascotExpression({ mascot: 'off' }), '');
    assert.equal(buildPrismWallpaperExpression({ wallpaperEnabled: false }), '');

    // Enabled compilation checks
    const mcOn = buildPrismMascotExpression({ mascot: 'crab' });
    const wpOn = buildPrismWallpaperExpression({ wallpaperEnabled: true }, { enabled: true });
    const hs = buildPrismHomeStudioExpression({ homeLayout: 'studio' });
    const st = buildPrismSettingsExpression();
    const om = buildPrismOmniExpression({ omniModule: 'on' }, { baseUrl: 'http://127.0.0.1:9999', token: 'tok' });
    const rf = buildRefreshConfigExpression({ palette: 'warm', accentTone: 'iris' });

    for (const [name, code] of [
      ['mascot', mcOn],
      ['wallpaper', wpOn],
      ['homeStudio', hs],
      ['settings', st],
      ['omni', om],
      ['refresh', rf],
    ]) {
      assert.ok(code.length > 0, `${name} should produce non-empty expression when enabled`);
      assert.doesNotThrow(() => new vm.Script(code), `${name} should parse cleanly with vm.Script`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('home-studio-panel.js integrates with __agPrismHomeCall backend snapshot', () => {
  const src = fs.readFileSync(HOME_STUDIO_PATH, 'utf8');
  assert.match(src, /__agPrismHomeCall/);
  assert.match(src, /__agPrismHomeResolve/);
  assert.match(src, /data-ag-open-monitor/);
  assert.doesNotThrow(() => new vm.Script(src));
});

test('ui-runtime.js defaults mascot to off, identifies usage-monitor coexistence owner, and disables excluded modules', () => {
  const src = fs.readFileSync(UI_RUNTIME_PATH, 'utf8');
  assert.match(src, /owner:\s*'usage-monitor'/);
  assert.match(src, /getTelemetryMode\s*=\s*\(\)\s*=>\s*'off'/);
  assert.match(src, /getPeriodicPickerMode\s*=\s*\(\)\s*=>\s*'off'/);
  assert.match(src, /getThoughtTranslateMode\s*=\s*\(\)\s*=>\s*'off'/);
  assert.match(src, /\.ag-usage-overlay-host/);
  assert.doesNotThrow(() => new vm.Script(src));
});
