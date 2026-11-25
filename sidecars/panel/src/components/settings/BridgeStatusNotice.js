/**
 * @fileoverview Shared CDP / Window Bridge diagnostic notice card (`BridgeStatusNotice.js`).
 * In this hardened fork, automatic OS launcher patching and UAC relaunch are disabled;
 * surfaces a manual `--remote-debugging-port=0` launch instruction when Antigravity runs
 * without an active `DevToolsActivePort` (`no_devtools_port` / `cdp_unreachable`).
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { isWindowOverlayMode } from '../../core/httpClient.js';
import {
  copyPlainTextToClipboard,
  createCopiedFeedbackController,
} from '../../core/stepInspector.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';

const LAUNCH_FLAG_TEXT = '--remote-debugging-port=0';

export const BridgeStatusNotice = defineComponent({
  name: 'BridgeStatusNotice',
  setup({ props, onCleanup }) {
    let contextMode = Boolean(props?.contextMode);
    const dismissible = Boolean(props?.dismissible);
    let lastPayload = {
      visible: false,
      windowBridge: null,
      hostPlatform: 'win32',
    };
    let dismissed = false;
    let destroyed = false;
    const copyFeedback = createCopiedFeedbackController({
      durationMs: 1800,
      onCleanup,
      onChange: () => {
        if (!destroyed) syncActionButtons();
      },
    });

    const headIconEl = createSvgIcon('warning', { size: 13, className: 'settings-bridge-icon' });
    const titleEl = h('strong', { className: 'settings-bridge-title', text: '' });
    const bodyEl = h('p', { className: 'settings-bridge-desc', text: '' });

    const dismissBtnEl = dismissible
      ? h(
          'button',
          {
            type: 'button',
            className: 'btn-ghost-sm settings-bridge-dismiss-btn',
            'aria-label': t('settings.bridge.dismissAria'),
            title: t('settings.bridge.dismissAria'),
            onClick: () => {
              dismissed = true;
              render();
              props?.onDismiss?.();
            },
          },
          [createSvgIcon('close', { size: 11 })]
        )
      : null;

    const relaunchBtnIconEl = createSvgIcon('refresh', { size: 11 });
    const relaunchBtnTextEl = h('span', {
      className: 'settings-bridge-relaunch-text',
      text: t('settings.bridge.relaunchBtn'),
    });
    const relaunchBtnEl = h(
      'button',
      {
        type: 'button',
        className: 'settings-bridge-relaunch-btn',
        hidden: true,
        disabled: true,
      },
      [relaunchBtnIconEl, relaunchBtnTextEl]
    );

    const copyBtnIconEl = createSvgIcon('copy', { size: 11 });
    const copyBtnTextEl = h('span', {
      className: 'settings-bridge-copy-text',
      text: t('settings.bridge.copyFlagBtn', { cmd: LAUNCH_FLAG_TEXT }),
    });
    const copyBtnEl = h(
      'button',
      {
        type: 'button',
        className: 'btn-ghost-sm settings-bridge-copy-btn',
        onClick: async () => {
          await copyPlainTextToClipboard(LAUNCH_FLAG_TEXT);
          if (destroyed) return;
          copyFeedback.trigger(true);
        },
      },
      [copyBtnIconEl, copyBtnTextEl]
    );

    const headLeftEl = h('div', { className: 'settings-bridge-head-main' }, [headIconEl, titleEl]);
    const headRowEl = h(
      'div',
      { className: 'settings-bridge-head' },
      dismissBtnEl ? [headLeftEl, dismissBtnEl] : [headLeftEl]
    );
    const actionsRowEl = h('div', { className: 'settings-bridge-actions' }, [
      relaunchBtnEl,
      copyBtnEl,
    ]);

    const rootEl = h(
      'div',
      {
        className: 'settings-bridge-notice',
        role: 'status',
        hidden: true,
      },
      [headRowEl, bodyEl, actionsRowEl]
    );

    function syncActionButtons() {
      // Automatic OS launcher patching & UAC relaunch are disabled in this hardened fork.
      patchAttr(relaunchBtnEl, 'hidden', true);
      patchAttr(relaunchBtnEl, 'disabled', true);
      patchText(relaunchBtnTextEl, t('settings.bridge.relaunchBtn'));

      const isCopied = copyFeedback.isCopied(true);
      patchSvgIcon(copyBtnIconEl, isCopied ? 'check' : 'copy');
      patchText(
        copyBtnTextEl,
        isCopied
          ? t('settings.bridge.copiedBtn')
          : t('settings.bridge.copyFlagBtn', { cmd: LAUNCH_FLAG_TEXT })
      );

      if (dismissBtnEl) {
        const aria = t('settings.bridge.dismissAria');
        patchAttr(dismissBtnEl, 'aria-label', aria);
        patchAttr(dismissBtnEl, 'title', aria);
      }
    }

    function render() {
      const wb = lastPayload.windowBridge;
      const state = String(wb?.state || '').trim();
      if (state === 'active') {
        dismissed = false;
      }
      const shouldShow =
        !dismissed &&
        Boolean(lastPayload.visible) &&
        !isWindowOverlayMode() &&
        (state === 'no_devtools_port' || state === 'cdp_unreachable');

      patchAttr(rootEl, 'hidden', !shouldShow);
      if (!shouldShow) return;

      const plat = String(lastPayload.hostPlatform || '').trim().toLowerCase();
      patchClasses(rootEl, {
        'is-restart': false,
        'is-warn': true,
      });
      patchSvgIcon(headIconEl, 'warning');

      const titleText = contextMode
        ? t('settings.bridge.ctxTitle')
        : state === 'cdp_unreachable'
          ? t('settings.bridge.unreachableTitle')
          : t('settings.bridge.noPortTitle');
      const bodyText =
        plat === 'darwin'
          ? t('settings.bridge.guideMac')
          : plat === 'linux'
            ? t('settings.bridge.guideLinux')
            : t('settings.bridge.guideWin');

      patchText(titleEl, titleText);
      patchText(bodyEl, bodyText);
      syncActionButtons();
    }

    function update(next = {}) {
      if (typeof next.contextMode === 'boolean') {
        contextMode = next.contextMode;
      }
      lastPayload = {
        ...lastPayload,
        ...next,
      };
      render();
    }

    onCleanup(() => {
      destroyed = true;
    });

    return {
      el: rootEl,
      refs: {
        update,
        refreshLabels: render,
        relaunchBtnEl,
        copyBtnEl,
        dismissBtnEl,
      },
    };
  },
});
