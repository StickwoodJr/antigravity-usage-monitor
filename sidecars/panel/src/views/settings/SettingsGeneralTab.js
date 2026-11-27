/**
 * @fileoverview Preferences Tab 1: `SettingsGeneralTab.js` ("常规").
 * Manages UI Language (`zh-CN` / `en-US` / `auto`), Theme Accent (`host` + 6 swatches),
 * Panel Font Scale (`sm` / `md` / `lg` / `xl`), Pricing Sync, and Plugin Updates.
 */

import { defineComponent } from '../../core/component.js';
import {
  applyAppearanceToRoot,
  normalizeClientFontScale,
  normalizeClientThemeAccent,
  resolveSettingsModernUi,
} from '../../core/appearance.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { isWindowOverlayMode } from '../../core/httpClient.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { normalizeI18nLanguage, setI18nLanguage, t } from '../../i18n/index.js';
import {
  normalizeClientUpdateMode,
  saveSettingsPatch,
  triggerCloudSync,
  triggerPluginUpdate,
} from '../../store/telemetryStore.js';
import { callSidecarApi } from '../../core/httpClient.js';
import { ThemeColorPicker } from '../../components/settings/ThemeColorPicker.js';
import { CustomSelect } from '../../components/ui/CustomSelect.js';
import { SegmentedControl } from '../../components/ui/SegmentedControl.js';
import { ToggleSwitch } from '../../components/ui/ToggleSwitch.js';

function getLanguageOptions() {
  return [
    { value: 'auto', label: t('settings.gen.langAuto') },
    { value: 'zh-CN', label: t('settings.gen.langZh') },
    { value: 'en-US', label: t('settings.gen.langEn') },
  ];
}

function getFontScaleOptions() {
  return [
    { value: 'sm', label: t('settings.gen.fontSm') },
    { value: 'md', label: t('settings.gen.fontMd') },
    { value: 'lg', label: t('settings.gen.fontLg') },
    { value: 'xl', label: t('settings.gen.fontXl') },
  ];
}

function getUpdateModeOptions() {
  return [
    { value: 'manual', label: t('settings.gen.updateManual') },
    { value: 'off', label: t('settings.gen.updateOff') },
  ];
}

function formatCloudSyncTimeText(tsMs, updatedAt) {
  if (Number(tsMs) > 0) {
    const d = new Date(Number(tsMs));
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return t('settings.gen.syncAt', { time: timeStr });
  }
  if (updatedAt) {
    return t('settings.gen.pubAt', { date: String(updatedAt).slice(0, 10) });
  }
  return t('settings.gen.defaultPricing');
}

export const SettingsGeneralTab = defineComponent({
  name: 'SettingsGeneralTab',
  setup({ props, onCleanup }) {
    let draftLanguage = 'auto';
    let draftThemeAccent = 'host';
    let draftFontScale = 'md';
    let draftModernUi = true;
    let draftPluginUpdateMode = 'off';
    let latestSettings = null;
    let latestCloudStatus = null;
    let appearanceTimer = null;
    let appearanceSaveSeq = 0;
    let cloudTimer = null;

    const appearanceStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const cloudStatusMsg = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });

    function showAppearanceFeedback(text, autoClearMs = 1500) {
      if (appearanceTimer) {
        clearTimeout(appearanceTimer);
        appearanceTimer = null;
      }
      patchText(appearanceStatusText, text);
      if (text && autoClearMs > 0) {
        appearanceTimer = setTimeout(() => {
          appearanceTimer = null;
          patchText(appearanceStatusText, '');
        }, autoClearMs);
      }
    }

    function showCloudFeedback(text, autoClearMs = 3500) {
      if (cloudTimer) {
        clearTimeout(cloudTimer);
        cloudTimer = null;
      }
      patchText(cloudStatusMsg, text);
      if (text && autoClearMs > 0) {
        cloudTimer = setTimeout(() => {
          cloudTimer = null;
          patchText(cloudStatusMsg, '');
        }, autoClearMs);
      }
    }

    // --- Card 1: 界面与外观 ---
    const appearanceTitleEl = h('span', { text: t('settings.gen.appearanceTitle') });
    const langLabelEl = h('span', { className: 'form-label', text: t('settings.gen.language') });
    const accentLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.gen.themeAccent'),
    });
    const fontLabelEl = h('span', { className: 'form-label', text: t('settings.gen.fontScale') });
    const fontHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.gen.fontHint'),
    });
    const modernUiLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.gen.modernUi'),
    });
    const modernUiHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.gen.modernUiHint'),
    });

    const languageSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.language'),
      modelValue: draftLanguage,
      options: getLanguageOptions(),
      onUpdateModelValue: async (val) => {
        const nextLang = normalizeI18nLanguage(val);
        draftLanguage = nextLang;
        setI18nLanguage(nextLang);
        languageSwitch.setValue(nextLang);
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ language: nextLang });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const themeColorPicker = ThemeColorPicker({
      modelValue: draftThemeAccent,
      onUpdateModelValue: async (val) => {
        const nextAccent = normalizeClientThemeAccent(val);
        draftThemeAccent = nextAccent;
        themeColorPicker.refs.setValue(nextAccent);
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ themeAccent: nextAccent });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const fontScaleSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.fontScale'),
      modelValue: draftFontScale,
      options: getFontScaleOptions(),
      onUpdateModelValue: async (val) => {
        const nextScale = normalizeClientFontScale(val);
        draftFontScale = nextScale;
        fontScaleSwitch.setValue(nextScale);
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ fontScale: nextScale });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
          props.onLayoutChange?.();
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const modernUiSwitch = ToggleSwitch({
      ariaLabelKey: 'settings.gen.modernUi',
      preset: 'modernUi',
      modelValue: 'on',
      onUpdateModelValue: async (val) => {
        const nextModernUi = val !== 'off';
        draftModernUi = nextModernUi;
        modernUiSwitch.setValue(nextModernUi ? 'on' : 'off');
        if (!isWindowOverlayMode() && typeof document !== 'undefined' && document.documentElement) {
          applyAppearanceToRoot(
            document.documentElement,
            {
              ...(latestSettings || {}),
              themeAccent: draftThemeAccent,
              fontScale: draftFontScale,
              modernUi: nextModernUi,
              experimentalModernUi: nextModernUi,
            },
            { includeFontScale: true }
          );
        }
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ modernUi: nextModernUi });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
          props.onLayoutChange?.();
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const appearancePanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          appearanceTitleEl,
        ]),
        appearanceStatusText,
      ]),
      h('div', { className: 'form-row' }, [langLabelEl, languageSwitch.el]),
      h('div', { className: 'form-row' }, [accentLabelEl, themeColorPicker.el]),
      h('div', { className: 'form-row' }, [fontLabelEl, fontScaleSwitch.el, fontHintEl]),
      h('div', { className: 'form-row' }, [modernUiLabelEl, modernUiSwitch.el, modernUiHintEl]),
    ]);

    // --- Card 1B: Obsidian Prism Optical UI & Host Modules ---
    let draftPrismPalette = 'obsidian';
    let draftPrismLightPreset = 'crystal';
    let draftPrismAccent = 'follow';
    let draftPrismCorners = 'balanced';
    let draftPrismMotion = 'ultra';
    let draftPrismCodeFont = 'default';
    let draftPrismLigatures = false;
    let draftPrismHomeRipple = true;
    let draftPrismSmoothCaret = true;
    let draftPrismEffortSlider = 'auto';
    let draftPrismWorkbench = 'on';
    let draftPrismHomeStudio = 'on';
    let draftPrismOmni = 'on';
    let draftPrismMascot = 'off';
    let draftPrismWallpaper = false;

    const prismStatusEl = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const prismTitleEl = h('span', { text: t('settings.prism.title') });

    function applyLocalPrismPreview(partial) {
      if (isWindowOverlayMode() || typeof document === 'undefined' || !document.documentElement) {
        return;
      }
      applyAppearanceToRoot(
        document.documentElement,
        {
          ...(latestSettings || {}),
          prismPalette: draftPrismPalette,
          prismLightPreset: draftPrismLightPreset,
          prismAccentTone: draftPrismAccent,
          prismCornerStyle: draftPrismCorners,
          prismMotionLevel: draftPrismMotion,
          prismCodeFont: draftPrismCodeFont,
          prismCodeLigatures: draftPrismLigatures,
          ...partial,
        },
        { includeFontScale: true }
      );
    }

    async function savePrismPatch(patch) {
      applyLocalPrismPreview(patch);
      patchText(prismStatusEl, t('settings.saving'));
      try {
        await saveSettingsPatch(patch);
        patchText(prismStatusEl, t('settings.saved'));
        setTimeout(() => {
          if (prismStatusEl.textContent === t('settings.saved')) patchText(prismStatusEl, '');
        }, 1400);
      } catch {
        if (latestSettings) renderSettings(latestSettings);
        patchText(prismStatusEl, t('settings.saveFailed'));
      }
    }

    const mkPresetBtn = (key, labelKey, patchObj) =>
      h(
        'button',
        {
          type: 'button',
          className: 'prism-preset-btn',
          'data-prism-preset': key,
          'aria-pressed': 'false',
          onClick: () => void savePrismPatch(patchObj),
        },
        [h('span', { text: t(labelKey) })]
      );

    const presetFullBtn = mkPresetBtn('full', 'settings.prism.presetFull', {
      prismMotionLevel: 'ultra',
      prismHomeRipple: true,
      prismSmoothCaret: true,
      prismAmbientIntensity: '100',
    });
    const presetFocusBtn = mkPresetBtn('focus', 'settings.prism.presetFocus', {
      prismMotionLevel: 'standard',
      prismHomeRipple: false,
      prismSmoothCaret: true,
      prismAmbientIntensity: '35',
    });
    const presetEcoBtn = mkPresetBtn('eco', 'settings.prism.presetEco', {
      prismMotionLevel: 'off',
      prismHomeRipple: false,
      prismSmoothCaret: false,
      prismAmbientIntensity: '0',
    });

    const mkPalCard = (id, titleKey, descKey, dotBg, patchKey, patchVal) =>
      h(
        'button',
        {
          type: 'button',
          className: 'prism-palette-card',
          'data-pal-id': id,
          'aria-pressed': 'false',
          onClick: () => void savePrismPatch({ [patchKey]: patchVal }),
        },
        [
          h('span', { className: 'prism-palette-dot', style: `background: ${dotBg};` }),
          h('span', { style: 'display:flex;flex-direction:column;min-width:0;' }, [
            h('strong', { style: 'font-size: var(--fs-sm); font-weight: 600;', text: t(titleKey) }),
            h('span', { className: 'text-muted', style: 'font-size: var(--fs-2xs);', text: t(descKey) }),
          ]),
        ]
      );

    const palObsidianCard = mkPalCard(
      'obsidian',
      'settings.prism.palObsidian',
      'settings.prism.palObsidianDesc',
      'linear-gradient(135deg, #09090B 0%, #669DF6 100%)',
      'prismPalette',
      'obsidian'
    );
    const palWarmCard = mkPalCard(
      'warm',
      'settings.prism.palWarm',
      'settings.prism.palWarmDesc',
      'linear-gradient(135deg, #10100F 0%, #D97757 100%)',
      'prismPalette',
      'warm'
    );
    const palCrystalCard = mkPalCard(
      'crystal',
      'settings.prism.lightCrystal',
      'settings.prism.lightCrystalDesc',
      'linear-gradient(135deg, #E8EEF6 0%, #2563EB 100%)',
      'prismLightPreset',
      'crystal'
    );
    const palAlabasterCard = mkPalCard(
      'alabaster',
      'settings.prism.lightAlabaster',
      'settings.prism.lightAlabasterDesc',
      'linear-gradient(135deg, #EBE6DC 0%, #C25934 100%)',
      'prismLightPreset',
      'alabaster'
    );

    const prismAccentCtrl = SegmentedControl({
      ariaLabel: t('settings.prism.accent'),
      modelValue: draftPrismAccent,
      options: [
        { value: 'follow', label: t('settings.prism.accentFollow') },
        { value: 'cobalt', label: t('settings.prism.accentCobalt') },
        { value: 'iris', label: t('settings.prism.accentIris') },
        { value: 'amber', label: t('settings.prism.accentAmber') },
        { value: 'mono', label: t('settings.prism.accentMono') },
      ],
      onUpdateModelValue: (val) => {
        draftPrismAccent = val;
        void savePrismPatch({ prismAccentTone: val });
      },
    });

    const prismCornersCtrl = SegmentedControl({
      ariaLabel: t('settings.prism.corners'),
      modelValue: draftPrismCorners,
      options: [
        { value: 'sharp', label: t('settings.prism.cornersSharp') },
        { value: 'balanced', label: t('settings.prism.cornersBalanced') },
        { value: 'soft', label: t('settings.prism.cornersSoft') },
      ],
      onUpdateModelValue: (val) => {
        draftPrismCorners = val;
        void savePrismPatch({ prismCornerStyle: val });
      },
    });

    const prismMotionCtrl = SegmentedControl({
      ariaLabel: t('settings.prism.motion'),
      modelValue: draftPrismMotion,
      options: [
        { value: 'off', label: t('settings.prism.motionOff') },
        { value: 'subtle', label: t('settings.prism.motionSubtle') },
        { value: 'standard', label: t('settings.prism.motionStandard') },
        { value: 'ultra', label: t('settings.prism.motionUltra') },
      ],
      onUpdateModelValue: (val) => {
        draftPrismMotion = val;
        void savePrismPatch({ prismMotionLevel: val });
      },
    });

    const prismCodeFontSelect = CustomSelect({
      modelValue: draftPrismCodeFont,
      icon: 'code',
      options: [
        { value: 'default', label: t('settings.prism.fontDefault') },
        { value: 'jetbrains', label: t('settings.prism.fontJetbrains') },
        { value: 'cascadia', label: t('settings.prism.fontCascadia') },
        { value: 'sfmono', label: t('settings.prism.fontSfmono') },
      ],
      onUpdateModelValue: (val) => {
        draftPrismCodeFont = val;
        void savePrismPatch({ prismCodeFont: val });
      },
    });

    const prismMascotSelect = CustomSelect({
      modelValue: draftPrismMascot,
      icon: 'sparkles',
      options: [
        { value: 'off', label: t('settings.prism.mascotOff') },
        { value: 'crab', label: t('settings.prism.mascotCrab') },
        { value: 'quad-minis', label: t('settings.prism.mascotQuad') },
      ],
      onUpdateModelValue: (val) => {
        draftPrismMascot = val;
        void savePrismPatch({ prismMascot: val });
      },
    });

    const mkOptSwitch = (labelKey, onChange) =>
      ToggleSwitch({
        ariaLabelKey: labelKey,
        modelValue: 'on',
        onUpdateModelValue: (val) => onChange(val !== 'off'),
      });

    const ligaturesSwitch = mkOptSwitch('settings.prism.ligatures', (on) => {
      draftPrismLigatures = on;
      void savePrismPatch({ prismCodeLigatures: on });
    });
    const homeRippleSwitch = mkOptSwitch('settings.prism.homeRipple', (on) => {
      draftPrismHomeRipple = on;
      void savePrismPatch({ prismHomeRipple: on });
    });
    const smoothCaretSwitch = mkOptSwitch('settings.prism.smoothCaret', (on) => {
      draftPrismSmoothCaret = on;
      void savePrismPatch({ prismSmoothCaret: on });
    });
    const effortSliderSwitch = mkOptSwitch('settings.prism.effortSlider', (on) => {
      draftPrismEffortSlider = on ? 'auto' : 'off';
      void savePrismPatch({ prismEffortSlider: draftPrismEffortSlider });
    });
    const workbenchSwitch = mkOptSwitch('settings.prism.workbench', (on) => {
      draftPrismWorkbench = on ? 'on' : 'off';
      void savePrismPatch({ prismWorkbenchEnhancer: draftPrismWorkbench });
    });
    const homeStudioSwitch = mkOptSwitch('settings.prism.homeStudio', (on) => {
      draftPrismHomeStudio = on ? 'on' : 'off';
      void savePrismPatch({ prismHomeStudio: draftPrismHomeStudio });
    });
    const omniSwitch = mkOptSwitch('settings.prism.omni', (on) => {
      draftPrismOmni = on ? 'on' : 'off';
      void savePrismPatch({ prismOmniModule: draftPrismOmni });
    });
    const wallpaperSwitch = mkOptSwitch('settings.prism.wallpaper', (on) => {
      draftPrismWallpaper = on;
      patchAttr(wallpaperControlsRow, 'hidden', !on);
      void savePrismPatch({ prismWallpaperEnabled: on });
    });

    const wallpaperInfoEl = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-xs);',
      text: t('settings.prism.wallpaperNone'),
    });
    const wallpaperPickBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          try {
            const res = await callSidecarApi('/api/prism/wallpaper', {
              method: 'POST',
              body: { action: 'pick-media' },
            });
            if (res?.config?.mediaPath) {
              patchText(wallpaperInfoEl, res.config.mediaPath);
            }
          } catch {
            // ignore picker errors
          }
        },
      },
      [h('span', { text: t('settings.prism.wallpaperPick') })]
    );
    const wallpaperClearBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          try {
            await callSidecarApi('/api/prism/wallpaper', {
              method: 'POST',
              body: { action: 'clear-media' },
            });
            patchText(wallpaperInfoEl, t('settings.prism.wallpaperNone'));
          } catch {
            // ignore clear errors
          }
        },
      },
      [h('span', { text: t('settings.prism.wallpaperClear') })]
    );
    const wallpaperControlsRow = h(
      'div',
      { className: 'form-row', hidden: true, style: 'flex-wrap: wrap; gap: 6px;' },
      [wallpaperPickBtn, wallpaperClearBtn, wallpaperInfoEl]
    );

    const prismPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sparkles', { size: 13 }),
          prismTitleEl,
        ]),
        prismStatusEl,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.presets') }),
        h('div', { className: 'prism-preset-bar' }, [presetFullBtn, presetFocusBtn, presetEcoBtn]),
      ]),
      h('div', { className: 'form-row', style: 'align-items: flex-start;' }, [
        h('span', { className: 'form-label', text: t('settings.prism.palette') }),
        h('div', { className: 'prism-palette-swatches' }, [
          palObsidianCard,
          palWarmCard,
          palCrystalCard,
          palAlabasterCard,
        ]),
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.accent') }),
        prismAccentCtrl.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.corners') }),
        prismCornersCtrl.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.motion') }),
        prismMotionCtrl.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.codeFont') }),
        prismCodeFontSelect.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.ligatures') }),
        ligaturesSwitch.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.homeRipple') }),
        homeRippleSwitch.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.smoothCaret') }),
        smoothCaretSwitch.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.effortSlider') }),
        effortSliderSwitch.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.workbench') }),
        workbenchSwitch.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.homeStudio') }),
        homeStudioSwitch.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.omni') }),
        omniSwitch.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.mascot') }),
        prismMascotSelect.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: t('settings.prism.wallpaper') }),
        wallpaperSwitch.el,
      ]),
      wallpaperControlsRow,
      h('div', { className: 'prism-attribution-box', text: t('settings.prism.attribution') }),
    ]);

    // --- Card 2: 版本更新 ---
    const updateTitleEl = h('span', { text: t('settings.gen.updateTitle') });
    const updateModeLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.gen.updateMode'),
    });
    const pricingCellLabelEl = h('span', {
      className: 'cell-label',
      text: t('settings.gen.pricingLabel'),
    });
    const versionCellLabelEl = h('span', {
      className: 'cell-label',
      text: t('settings.gen.versionLabel'),
    });

    const autoUpdateSelect = CustomSelect({
      modelValue: 'off',
      icon: 'refresh',
      options: getUpdateModeOptions(),
      onUpdateModelValue: async (val) => {
        const normalizedMode = normalizeClientUpdateMode(val);
        const nextMode = normalizedMode === 'auto' ? 'manual' : normalizedMode;
        draftPluginUpdateMode = nextMode;
        autoUpdateSelect.setValue(nextMode);
        if (latestCloudStatus) {
          renderCloudStatus(latestCloudStatus);
        }
        showCloudFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({
            pluginUpdateMode: nextMode,
            autoUpdatePlugin: false,
          });
          showCloudFeedback(t('settings.saved'), 1800);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (latestCloudStatus) renderCloudStatus(latestCloudStatus);
          showCloudFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const pricingCountVal = h('strong', { className: 'cell-value', text: '—' });
    const pricingSyncSub = h('span', { className: 'cell-sub', text: t('quota.loading') });
    const versionVal = h('strong', { className: 'cell-value', text: 'v1.4.4' });
    const versionSub = h('span', { className: 'cell-sub', text: t('settings.gen.checkingBtn') });

    const syncPricingBtnText = h('span', { text: t('settings.gen.syncBtn') });
    const syncPricingBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          patchAttr(syncPricingBtn, 'disabled', true);
          patchText(syncPricingBtnText, t('settings.gen.syncingBtn'));
          showCloudFeedback(t('settings.gen.syncingMsg'), 0);
          try {
            const res = await triggerCloudSync();
            const cs = res?.cloudStatus;
            if (res?.ok && cs) {
              showCloudFeedback(t('settings.gen.syncedMsg', { count: cs.modelCount }), 3500);
            } else {
              showCloudFeedback(cs?.lastSyncError || t('settings.gen.syncFallbackMsg'), 4500);
            }
          } catch (err) {
            showCloudFeedback(err?.message || t('settings.gen.syncFallbackMsg'), 4500);
          } finally {
            patchAttr(syncPricingBtn, 'disabled', false);
            patchText(syncPricingBtnText, t('settings.gen.syncBtn'));
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), syncPricingBtnText]
    );

    const updatePluginBtnText = h('span', { text: t('settings.gen.checkUpdateBtn') });
    const updatePluginBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          patchAttr(updatePluginBtn, 'disabled', true);
          try {
            if (!latestCloudStatus?.updateAvailable) {
              patchText(updatePluginBtnText, t('settings.gen.checkingBtn'));
              showCloudFeedback(t('settings.gen.checkingMsg'), 0);
              const syncRes = await triggerCloudSync();
              const cs = syncRes?.cloudStatus || latestCloudStatus;
              if (cs) {
                latestCloudStatus = cs;
                renderCloudStatus(cs);
              }
              if (!syncRes?.ok && cs?.lastSyncError) {
                showCloudFeedback(
                  t('settings.gen.checkFailedMsg', { err: cs.lastSyncError }),
                  5000
                );
                return;
              }
              if (!cs?.updateAvailable) {
                const curVer = cs?.currentPluginVersion || '1.4.4';
                showCloudFeedback(t('settings.gen.upToDateMsg', { ver: curVer }), 4500);
                return;
              }
            }
            patchText(updatePluginBtnText, t('capsule.updating'));
            showCloudFeedback(t('settings.gen.downloadingMsg'), 0);
            const res = await triggerPluginUpdate();
            if (res?.cloudStatus) {
              latestCloudStatus = res.cloudStatus;
            }
            if (res?.ok) {
              showCloudFeedback(res.message || t('settings.gen.updatedRestartMsg'), 5000);
            } else {
              showCloudFeedback(res?.message || t('settings.gen.updateSkippedMsg'), 5500);
            }
          } catch (err) {
            showCloudFeedback(err?.message || t('settings.gen.updateFailedMsg'), 5000);
          } finally {
            patchAttr(updatePluginBtn, 'disabled', false);
            renderCloudStatus(latestCloudStatus);
          }
        },
      },
      [createSvgIcon('arrow-down', { size: 12 }), updatePluginBtnText]
    );

    const cloudPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('bolt', { size: 13 }),
          updateTitleEl,
        ]),
        cloudStatusMsg,
      ]),
      h('div', { className: 'form-row' }, [updateModeLabelEl, autoUpdateSelect.el]),
      h('div', { className: 'dual-grid' }, [
        h('div', { className: 'matrix-cell' }, [
          pricingCellLabelEl,
          pricingCountVal,
          pricingSyncSub,
        ]),
        h('div', { className: 'matrix-cell' }, [versionCellLabelEl, versionVal, versionSub]),
      ]),
      h('div', { className: 'cloud-actions-row' }, [syncPricingBtn, updatePluginBtn]),
    ]);

    const rootEl = h('div', { className: 'settings-tab-stack' }, [
      appearancePanel,
      prismPanel,
      cloudPanel,
    ]);

    function renderSettings(settings) {
      if (!settings) return;
      latestSettings = settings;
      draftLanguage = normalizeI18nLanguage(settings.language);
      draftThemeAccent = normalizeClientThemeAccent(settings.themeAccent);
      draftFontScale = normalizeClientFontScale(settings.fontScale);
      draftModernUi = resolveSettingsModernUi(settings);
      const normalizedUpdateMode = normalizeClientUpdateMode(
        settings.pluginUpdateMode,
        settings.autoUpdatePlugin
      );
      draftPluginUpdateMode = normalizedUpdateMode === 'auto' ? 'manual' : normalizedUpdateMode;

      draftPrismPalette = settings.prismPalette === 'warm' ? 'warm' : 'obsidian';
      draftPrismLightPreset = settings.prismLightPreset === 'alabaster' ? 'alabaster' : 'crystal';
      draftPrismAccent = settings.prismAccentTone || 'follow';
      draftPrismCorners = settings.prismCornerStyle || 'balanced';
      draftPrismMotion = settings.prismMotionLevel || 'ultra';
      draftPrismCodeFont = settings.prismCodeFont || 'default';
      draftPrismLigatures = settings.prismCodeLigatures === true;
      draftPrismHomeRipple = settings.prismHomeRipple !== false;
      draftPrismSmoothCaret = settings.prismSmoothCaret !== false;
      draftPrismEffortSlider = settings.prismEffortSlider || 'auto';
      draftPrismWorkbench = settings.prismWorkbenchEnhancer === 'off' ? 'off' : 'on';
      draftPrismHomeStudio = settings.prismHomeStudio === 'off' ? 'off' : 'on';
      draftPrismOmni = settings.prismOmniModule === 'off' ? 'off' : 'on';
      draftPrismMascot = settings.prismMascot || 'off';
      draftPrismWallpaper = settings.prismWallpaperEnabled === true;

      patchAttr(palObsidianCard, 'aria-pressed', String(draftPrismPalette === 'obsidian'));
      patchAttr(palWarmCard, 'aria-pressed', String(draftPrismPalette === 'warm'));
      patchAttr(palCrystalCard, 'aria-pressed', String(draftPrismLightPreset === 'crystal'));
      patchAttr(palAlabasterCard, 'aria-pressed', String(draftPrismLightPreset === 'alabaster'));
      patchAttr(
        presetFullBtn,
        'aria-pressed',
        String(draftPrismMotion === 'ultra' && draftPrismHomeRipple && draftPrismSmoothCaret)
      );
      patchAttr(
        presetFocusBtn,
        'aria-pressed',
        String(draftPrismMotion === 'standard' && !draftPrismHomeRipple && draftPrismSmoothCaret)
      );
      patchAttr(
        presetEcoBtn,
        'aria-pressed',
        String(draftPrismMotion === 'off' && !draftPrismHomeRipple && !draftPrismSmoothCaret)
      );

      prismAccentCtrl.setValue(draftPrismAccent);
      prismCornersCtrl.setValue(draftPrismCorners);
      prismMotionCtrl.setValue(draftPrismMotion);
      prismCodeFontSelect.setValue(draftPrismCodeFont);
      prismMascotSelect.setValue(
        ['off', 'crab', 'quad-minis'].includes(draftPrismMascot) ? draftPrismMascot : 'crab'
      );
      ligaturesSwitch.setValue(draftPrismLigatures ? 'on' : 'off');
      homeRippleSwitch.setValue(draftPrismHomeRipple ? 'on' : 'off');
      smoothCaretSwitch.setValue(draftPrismSmoothCaret ? 'on' : 'off');
      effortSliderSwitch.setValue(draftPrismEffortSlider === 'off' ? 'off' : 'on');
      workbenchSwitch.setValue(draftPrismWorkbench);
      homeStudioSwitch.setValue(draftPrismHomeStudio);
      omniSwitch.setValue(draftPrismOmni);
      wallpaperSwitch.setValue(draftPrismWallpaper ? 'on' : 'off');
      patchAttr(wallpaperControlsRow, 'hidden', !draftPrismWallpaper);

      languageSwitch.setProps({
        modelValue: draftLanguage,
        options: getLanguageOptions(),
      });
      themeColorPicker.refs.setValue(draftThemeAccent);
      fontScaleSwitch.setProps({
        modelValue: draftFontScale,
        options: getFontScaleOptions(),
      });
      modernUiSwitch.setProps({
        modelValue: draftModernUi ? 'on' : 'off',
      });
      autoUpdateSelect.setProps({
        modelValue: draftPluginUpdateMode,
        options: getUpdateModeOptions(),
      });
    }

    function renderCloudStatus(cs) {
      if (!cs) return;
      latestCloudStatus = cs;
      const srcLabel =
        cs.source === 'remote'
          ? t('settings.gen.srcRemote')
          : cs.source === 'local'
            ? t('settings.gen.srcLocal')
            : t('settings.gen.srcDefault');
      patchText(pricingCountVal, t('settings.gen.modelCount', { count: cs.modelCount || 0 }));
      patchText(
        pricingSyncSub,
        `${srcLabel} · ${formatCloudSyncTimeText(cs.lastSyncedAtMs, cs.catalogUpdatedAt)}`
      );

      const curVer = cs.currentPluginVersion || '1.4.4';
      const latVer = cs.latestPluginVersion || curVer;
      const modeTag = cs.installMode === 'git' ? 'Git' : 'ZIP';
      patchText(versionVal, `v${curVer}`);
      if (cs.updateAvailable && draftPluginUpdateMode !== 'off') {
        patchText(versionSub, t('settings.gen.canUpgradeSub', { ver: latVer, mode: modeTag }));
        patchClasses(versionSub, { 'accent-ok': true });
        patchText(updatePluginBtnText, t('settings.gen.upgradeToBtn', { ver: latVer }));
        patchClasses(updatePluginBtn, { 'btn-primary': true, 'btn-secondary': false });
      } else if (draftPluginUpdateMode === 'off') {
        patchText(versionSub, t('settings.gen.updateOffSub', { mode: modeTag }));
        patchClasses(versionSub, { 'accent-ok': false });
        patchText(
          updatePluginBtnText,
          cs.updateAvailable
            ? t('settings.gen.manualUpgradeBtn', { ver: latVer })
            : t('settings.gen.checkUpdateBtn')
        );
        patchClasses(updatePluginBtn, { 'btn-primary': false, 'btn-secondary': true });
      } else {
        patchText(versionSub, t('settings.gen.latestSub', { mode: modeTag }));
        patchClasses(versionSub, { 'accent-ok': false });
        patchText(updatePluginBtnText, t('settings.gen.checkUpdateBtn'));
        patchClasses(updatePluginBtn, { 'btn-primary': false, 'btn-secondary': true });
      }

      if (
        !cloudTimer &&
        (cs.lastUpdateError || (cs.lastUpdateResult?.ok === false && cs.lastUpdateResult?.message))
      ) {
        showCloudFeedback(cs.lastUpdateError || cs.lastUpdateResult.message, 5500);
      }
    }

    function refreshLabels() {
      patchText(appearanceTitleEl, t('settings.gen.appearanceTitle'));
      patchText(langLabelEl, t('settings.gen.language'));
      patchText(accentLabelEl, t('settings.gen.themeAccent'));
      patchText(fontLabelEl, t('settings.gen.fontScale'));
      patchText(fontHintEl, t('settings.gen.fontHint'));
      patchText(modernUiLabelEl, t('settings.gen.modernUi'));
      patchText(modernUiHintEl, t('settings.gen.modernUiHint'));
      patchText(updateTitleEl, t('settings.gen.updateTitle'));
      patchText(updateModeLabelEl, t('settings.gen.updateMode'));
      patchText(pricingCellLabelEl, t('settings.gen.pricingLabel'));
      patchText(versionCellLabelEl, t('settings.gen.versionLabel'));
      if (!syncPricingBtn.hasAttribute('disabled')) {
        patchText(syncPricingBtnText, t('settings.gen.syncBtn'));
      }
      languageSwitch.setProps({
        modelValue: draftLanguage,
        options: getLanguageOptions(),
      });
      themeColorPicker.refs.refreshLabels();
      fontScaleSwitch.setProps({
        modelValue: draftFontScale,
        options: getFontScaleOptions(),
      });
      modernUiSwitch.setProps({
        modelValue: draftModernUi ? 'on' : 'off',
      });
      autoUpdateSelect.setProps({
        modelValue: draftPluginUpdateMode,
        options: getUpdateModeOptions(),
      });
      if (latestCloudStatus) {
        renderCloudStatus(latestCloudStatus);
      } else {
        patchText(pricingSyncSub, t('quota.loading'));
      }
    }

    onCleanup(() => {
      if (appearanceTimer) clearTimeout(appearanceTimer);
      if (cloudTimer) clearTimeout(cloudTimer);
      languageSwitch.destroy();
      themeColorPicker.destroy();
      fontScaleSwitch.destroy();
      modernUiSwitch.destroy();
      autoUpdateSelect.destroy();
      prismAccentCtrl.destroy();
      prismCornersCtrl.destroy();
      prismMotionCtrl.destroy();
      prismCodeFontSelect.destroy();
      prismMascotSelect.destroy();
      ligaturesSwitch.destroy();
      homeRippleSwitch.destroy();
      smoothCaretSwitch.destroy();
      effortSliderSwitch.destroy();
      workbenchSwitch.destroy();
      homeStudioSwitch.destroy();
      omniSwitch.destroy();
      wallpaperSwitch.destroy();
    });

    return {
      el: rootEl,
      refs: {
        languageSwitch,
        themeColorPicker,
        fontScaleSwitch,
        modernUiSwitch,
        autoUpdateSelect,
        syncPricingBtn,
        updatePluginBtn,
        renderSettings,
        renderCloudStatus,
        refreshLabels,
      },
    };
  },
});
