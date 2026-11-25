/**
 * @fileoverview 跨端会话按需迁移设置卡片 (`SessionMigrationCard.js`)。
 * 仅当本机检测到 ≥2 个 Antigravity 客户端目录时展示，支持自由勾选根会话以完整迁移或克隆副本到目标端。
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { isWindowOverlayMode } from '../../core/httpClient.js';
import { copyPlainTextToClipboard } from '../../core/stepInspector.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { isEnglishLocale, t } from '../../i18n/index.js';
import {
  executeSessionMigration,
  fetchSessionMigrationCatalog,
} from '../../store/telemetryStore.js';
import { CustomScrollbar } from '../ui/CustomScrollbar.js';
import { CustomSelect } from '../ui/CustomSelect.js';
import { createSearchInput } from '../ui/SearchInput.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';

const SMIG_OUTSIDE_PROJECT_ID = 'outside-of-project';

function smigGetClientLabel(clientId) {
  if (clientId === 'cli') return t('settings.oth.migClientCli');
  if (clientId === 'ide_legacy') return t('settings.oth.migClientIdeLegacy');
  return t('settings.oth.migClientDesktop');
}

function smigGetModeOptions() {
  return [
    { value: 'move', label: t('settings.oth.migModeMove') },
    { value: 'clone', label: t('settings.oth.migModeClone') },
  ];
}

function smigFormatAge(epochMs) {
  const ts = Number(epochMs || 0);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export const SessionMigrationCard = defineComponent({
  name: 'SessionMigrationCard',
  setup({ props, onCleanup }) {
    const loadCatalogFn =
      typeof props?.loadCatalog === 'function' ? props.loadCatalog : fetchSessionMigrationCatalog;
    const runMigrateFn =
      typeof props?.runMigrate === 'function' ? props.runMigrate : executeSessionMigration;

    let catalog = null;
    let hasLoadedOnce = false;
    let isLoading = false;
    let isMigrating = false;
    let destroyed = false;
    let bodyMounted = false;
    let sourceClient = '';
    let targetClient = '';
    let migrationMode = 'move';
    let targetProjectId = '';
    let searchQuery = '';
    const selectedIds = new Set();
    let lastResult = null;
    let copiedCmdId = '';
    let copiedTimer = null;

    let titleEl = null;
    let descEl = null;
    let refreshBtnText = null;
    let refreshBtn = null;
    let sourceLabelEl = null;
    let targetLabelEl = null;
    let modeLabelEl = null;
    let modeSeg = null;
    let modeHintEl = null;
    let projectLabelEl = null;
    let sourceSelect = null;
    let targetSelect = null;
    let projectSelect = null;
    let projectFieldWrap = null;
    let searchInput = null;
    let searchClearBtn = null;
    let toggleAllBtn = null;
    let selectedCountEl = null;
    let listEl = null;
    let listScrollbar = null;
    let migrateBtnText = null;
    let migrateBtn = null;
    let resultBoxEl = null;

    const rootEl = h('section', { className: 'panel smig-panel', hidden: true });

    function ensureBodyMounted() {
      if (bodyMounted) return;
      bodyMounted = true;

      titleEl = h('span', { text: t('settings.oth.migTitle') });
      descEl = h('p', { className: 'settings-hint-text smig-desc', text: t('settings.oth.migDesc') });
      refreshBtnText = h('span', { text: t('settings.oth.migRefreshBtn') });
      refreshBtn = h(
        'button',
        {
          type: 'button',
          className: 'btn-ghost-sm smig-refresh-btn',
          onClick: () => {
            void loadCatalog(true);
          },
        },
        [createSvgIcon('refresh', { size: 12 }), refreshBtnText]
      );

      sourceLabelEl = h('span', { className: 'form-label', text: t('settings.oth.migSourceLabel') });
      targetLabelEl = h('span', { className: 'form-label', text: t('settings.oth.migTargetLabel') });
      modeLabelEl = h('span', { className: 'form-label', text: t('settings.oth.migModeLabel') });
      modeSeg = SegmentedControl({
        ariaLabel: t('settings.oth.migModeLabel'),
        modelValue: migrationMode,
        options: smigGetModeOptions(),
        onUpdateModelValue: (val) => {
          if (!val || val === migrationMode) return;
          migrationMode = val;
          lastResult = null;
          syncModeControls();
          renderResultBox();
        },
      });
      modeSeg.el.classList?.add('smig-mode-seg');
      modeHintEl = h('span', {
        className: 'settings-hint-text smig-mode-hint',
        text: t('settings.oth.migModeMoveHint'),
      });
      projectLabelEl = h('span', { className: 'form-label', text: t('settings.oth.migProjectLabel') });

      sourceSelect = CustomSelect({
        ariaLabel: t('settings.oth.migSourceLabel'),
        modelValue: '',
        options: [],
        onUpdateModelValue: (val) => {
          if (!val || val === sourceClient) return;
          sourceClient = val;
          selectedIds.clear();
          lastResult = null;
          ensureValidTarget();
          syncControlsAndList();
        },
      });

      targetSelect = CustomSelect({
        ariaLabel: t('settings.oth.migTargetLabel'),
        modelValue: '',
        options: [],
        onUpdateModelValue: (val) => {
          if (!val || val === targetClient) return;
          targetClient = val;
          lastResult = null;
          syncControlsAndList();
        },
      });

      projectSelect = CustomSelect({
        ariaLabel: t('settings.oth.migProjectLabel'),
        modelValue: '',
        options: [],
        className: 'smig-project-select',
        onUpdateModelValue: (val) => {
          targetProjectId = String(val || '');
        },
      });

      projectFieldWrap = h('div', { className: 'form-row smig-field' }, [
        projectLabelEl,
        projectSelect.el,
      ]);

      const searchBox = createSearchInput({
        wrapClassName: 'smig-search-wrap',
        iconClassName: 'smig-search-icon',
        inputClassName: 'smig-search-input',
        clearClassName: 'smig-search-clear',
        placeholder: t('settings.oth.migSearchPlaceholder'),
        clearAriaLabel: t('select.clearSearch'),
        closeIconSize: 10,
        onInput: (val) => {
          searchQuery = String(val || '').trim();
          renderSessionList();
        },
        onClear: () => {
          searchQuery = '';
          renderSessionList();
          searchInput.focus?.();
        },
      });
      searchInput = searchBox.inputEl;
      searchClearBtn = searchBox.clearBtnEl;
      const searchWrap = searchBox.el;

      toggleAllBtn = h('button', {
        type: 'button',
        className: 'btn-ghost-sm smig-toggle-all-btn',
        text: t('settings.oth.migSelectAll'),
        onClick: () => {
          const selectable = getFilteredSessions().filter((s) => !s.isRunning);
          if (selectable.length === 0) return;
          const allSelected = selectable.every((s) => selectedIds.has(s.cascadeId));
          if (allSelected) {
            for (const s of selectable) selectedIds.delete(s.cascadeId);
          } else {
            for (const s of selectable) selectedIds.add(s.cascadeId);
          }
          renderSessionList();
        },
      });

      selectedCountEl = h('span', { className: 'smig-count-meta', text: '' });
      listEl = h('div', { className: 'smig-list', role: 'list' });
      listScrollbar = CustomScrollbar({
        className: 'smig-scroll-host',
        contentEl: listEl,
      });

      migrateBtnText = h('span', {
        text: t('settings.oth.migActionBtn', { count: 0 }),
      });
      migrateBtn = h(
        'button',
        {
          type: 'button',
          className: 'btn-primary smig-migrate-btn',
          disabled: true,
          onClick: () => {
            void handleMigrate();
          },
        },
        [createSvgIcon('copy', { size: 12 }), migrateBtnText]
      );

      resultBoxEl = h('div', { className: 'smig-result', hidden: true });

      const children = [
        h('div', { className: 'panel-header' }, [
          h('span', { className: 'panel-title' }, [
            createSvgIcon('layers', { size: 13 }),
            titleEl,
          ]),
          refreshBtn,
        ]),
        descEl,
        h('div', { className: 'smig-direction-grid' }, [
          h('div', { className: 'form-row smig-field' }, [sourceLabelEl, sourceSelect.el]),
          h('div', { className: 'form-row smig-field' }, [targetLabelEl, targetSelect.el]),
        ]),
        h('div', { className: 'smig-mode-block' }, [
          h('div', { className: 'settings-inline-row smig-mode-row' }, [
            modeLabelEl,
            modeSeg.el,
          ]),
          modeHintEl,
        ]),
        projectFieldWrap,
        h('div', { className: 'smig-toolbar' }, [
          searchWrap,
          toggleAllBtn,
          selectedCountEl,
        ]),
        listScrollbar.el,
        h('div', { className: 'smig-footer' }, [migrateBtn]),
        resultBoxEl,
      ];
      for (const child of children) {
        rootEl.appendChild(child);
      }
    }

    function getDetectedClients() {
      return Array.isArray(catalog?.clients) ? catalog.clients.filter((c) => c.exists) : [];
    }

    function getTargetClientsFor(srcId) {
      return getDetectedClients().filter((c) => c.canBeTarget && c.id !== srcId);
    }

    function ensureValidSelectionDefaults() {
      const detected = getDetectedClients();
      if (detected.length < 2) {
        sourceClient = '';
        targetClient = '';
        return;
      }
      const validSources = detected.filter((c) => getTargetClientsFor(c.id).length > 0);
      if (!validSources.some((c) => c.id === sourceClient)) {
        const cliClient = validSources.find((c) => c.id === 'cli' && c.sessionCount > 0);
        const firstWithSessions = validSources.find((c) => c.sessionCount > 0);
        sourceClient = (cliClient || firstWithSessions || validSources[0])?.id || '';
      }
      ensureValidTarget();

      const projects = Array.isArray(catalog?.desktopProjects) ? catalog.desktopProjects : [];
      if (!projects.some((p) => p.projectId === targetProjectId)) {
        const preferred = projects.find((p) => !p.isOutsideProject) || projects[0];
        targetProjectId = preferred?.projectId || SMIG_OUTSIDE_PROJECT_ID;
      }
    }

    function ensureValidTarget() {
      const targets = getTargetClientsFor(sourceClient);
      if (!targets.some((c) => c.id === targetClient)) {
        const preferDesktop = targets.find((c) => c.id === 'desktop');
        targetClient = (preferDesktop || targets[0])?.id || '';
      }
    }

    function getCurrentSourceSessions() {
      const list = catalog?.sessionsByClient?.[sourceClient];
      return Array.isArray(list) ? list : [];
    }

    function getFilteredSessions() {
      const all = getCurrentSourceSessions();
      if (!searchQuery) return all;
      const needle = searchQuery.toLowerCase();
      return all.filter((item) => {
        const haystack = [
          item.title,
          item.workspaceName,
          item.workspacePath,
          item.cascadeId,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      });
    }

    function resolveProjectDisplayLabel(projectId) {
      if (!projectId || projectId === SMIG_OUTSIDE_PROJECT_ID) {
        return t('settings.oth.migProjectOutside');
      }
      const projects = Array.isArray(catalog?.desktopProjects) ? catalog.desktopProjects : [];
      const found = projects.find((p) => p.projectId === projectId);
      return found?.name || projectId.slice(0, 8);
    }

    function syncModeControls() {
      if (!bodyMounted) return;
      modeSeg?.setProps({
        ariaLabel: t('settings.oth.migModeLabel'),
        modelValue: migrationMode,
        options: smigGetModeOptions(),
      });
      patchText(
        modeHintEl,
        migrationMode === 'clone'
          ? t('settings.oth.migModeCloneHint')
          : t('settings.oth.migModeMoveHint')
      );
    }

    function formatMigrationError(code) {
      if (code === 'source_locked') return t('settings.oth.migErrLocked');
      if (code === 'target_already_exists') return t('settings.oth.migErrExists');
      if (code === 'session_running') return t('settings.oth.migErrRunning');
      return t('settings.oth.migFailed', { reason: code || 'unknown_error' });
    }

    function syncControlsAndList() {
      const visible = Boolean(catalog?.available);
      patchAttr(rootEl, 'hidden', !visible);
      if (!visible) {
        props?.onLayoutChange?.();
        return;
      }
      ensureBodyMounted();
      syncModeControls();

      const detected = getDetectedClients();
      const sourceOptions = detected
        .filter((c) => getTargetClientsFor(c.id).length > 0)
        .map((c) => ({
          value: c.id,
          label: smigGetClientLabel(c.id),
          meta: String(c.sessionCount),
        }));
      const targetOptions = getTargetClientsFor(sourceClient).map((c) => ({
        value: c.id,
        label: smigGetClientLabel(c.id),
      }));
      const projectOptions = (catalog?.desktopProjects || []).map((p) =>
        p.isOutsideProject
          ? { value: p.projectId, label: t('settings.oth.migProjectOutside') }
          : {
              value: p.projectId,
              label: p.name || p.projectId.slice(0, 8),
              meta: p.workspacePath || '',
            }
      );

      sourceSelect.setProps({
        ariaLabel: t('settings.oth.migSourceLabel'),
        modelValue: sourceClient,
        options: sourceOptions,
      });
      targetSelect.setProps({
        ariaLabel: t('settings.oth.migTargetLabel'),
        modelValue: targetClient,
        options: targetOptions,
      });
      projectSelect.setProps({
        ariaLabel: t('settings.oth.migProjectLabel'),
        modelValue: targetProjectId,
        options: projectOptions,
      });
      patchAttr(projectFieldWrap, 'hidden', targetClient !== 'desktop');

      renderSessionList();
      renderResultBox();
      props?.onLayoutChange?.();
    }

    function renderSessionList() {
      const all = getCurrentSourceSessions();
      const filtered = getFilteredSessions();

      // 清理已不在当前来源中的选中 ID
      const validSet = new Set(all.filter((s) => !s.isRunning).map((s) => s.cascadeId));
      for (const id of [...selectedIds]) {
        if (!validSet.has(id)) selectedIds.delete(id);
      }

      const selectableFiltered = filtered.filter((s) => !s.isRunning);
      const allSelected =
        selectableFiltered.length > 0 &&
        selectableFiltered.every((s) => selectedIds.has(s.cascadeId));
      patchText(
        toggleAllBtn,
        allSelected ? t('settings.oth.migClearSel') : t('settings.oth.migSelectAll')
      );
      patchAttr(toggleAllBtn, 'disabled', selectableFiltered.length === 0 || isMigrating);
      patchText(
        selectedCountEl,
        t('settings.oth.migSelectedCount', {
          selected: selectedIds.size,
          total: filtered.length,
        })
      );

      while (listEl.firstChild) {
        listEl.removeChild(listEl.firstChild);
      }

      if (all.length === 0) {
        listEl.appendChild(h('div', { className: 'smig-empty', text: t('settings.oth.migEmpty') }));
      } else if (filtered.length === 0) {
        listEl.appendChild(
          h('div', { className: 'smig-empty', text: t('settings.oth.migNoMatch') })
        );
      } else {
        for (const item of filtered) {
          const checked = selectedIds.has(item.cascadeId);
          const disabled = Boolean(item.isRunning || isMigrating);
          const checkIcon = createSvgIcon('check', { size: 10 });
          patchAttr(checkIcon, 'hidden', !checked);
          const checkboxEl = h(
            'span',
            {
              className: `select-checkbox smig-checkbox${checked ? ' is-checked' : ''}`,
              'aria-hidden': 'true',
            },
            [checkIcon]
          );

          const toggleItem = () => {
            if (item.isRunning || isMigrating) return;
            if (selectedIds.has(item.cascadeId)) {
              selectedIds.delete(item.cascadeId);
            } else {
              selectedIds.add(item.cascadeId);
            }
            renderSessionList();
          };

          const metaParts = [t('settings.oth.migStepsUnit', { count: item.stepCount })];
          const age = smigFormatAge(item.lastModifiedMs);
          if (age) metaParts.push(age);

          const subChildren = [];
          if (item.workspacePath || item.workspaceName) {
            subChildren.push(
              h('span', {
                className: 'smig-item-ws',
                text: item.workspacePath || item.workspaceName,
                title: item.workspacePath || item.workspaceName,
              })
            );
          }
          if (item.isRunning) {
            subChildren.push(
              h('span', {
                className: 'smig-item-running',
                text: t('settings.oth.migRunningTag'),
              })
            );
          }

          const rowEl = h(
            'button',
            {
              type: 'button',
              role: 'checkbox',
              'aria-checked': checked ? 'true' : 'false',
              disabled,
              className: `smig-item${checked ? ' is-selected' : ''}${item.isRunning ? ' is-running' : ''}`,
              onClick: toggleItem,
            },
            [
              checkboxEl,
              h('span', { className: 'smig-item-body' }, [
                h('span', { className: 'smig-item-top' }, [
                  h('span', {
                    className: 'smig-item-title',
                    text: item.title || item.cascadeId.slice(0, 8),
                    title: item.title || item.cascadeId,
                  }),
                  h('span', { className: 'smig-item-meta', text: metaParts.join(' · ') }),
                ]),
                ...(subChildren.length > 0
                  ? [h('span', { className: 'smig-item-sub' }, subChildren)]
                  : []),
              ]),
            ]
          );
          listEl.appendChild(rowEl);
        }
      }

      listScrollbar?.refresh?.();

      patchAttr(migrateBtn, 'disabled', isMigrating || selectedIds.size === 0 || !targetClient);
      patchText(
        migrateBtnText,
        isMigrating
          ? t('settings.oth.migRunningBtn')
          : t('settings.oth.migActionBtn', { count: selectedIds.size })
      );
    }

    function renderResultBox() {
      if (!lastResult) {
        patchAttr(resultBoxEl, 'hidden', true);
        return;
      }
      patchAttr(resultBoxEl, 'hidden', false);
      patchClasses(resultBoxEl, {
        'is-ok': Boolean(lastResult.ok),
        'is-err': !lastResult.ok,
      });

      while (resultBoxEl.firstChild) {
        resultBoxEl.removeChild(resultBoxEl.firstChild);
      }

      if (!lastResult.ok) {
        resultBoxEl.appendChild(
          h('div', {
            className: 'smig-result-msg',
            text: formatMigrationError(lastResult.error),
          })
        );
        return;
      }

      const partialSuffix =
        lastResult.failedCount > 0
          ? t('settings.oth.migPartialWarn', { failed: lastResult.failedCount })
          : '';
      const baseMsg =
        lastResult.targetClient === 'cli'
          ? t('settings.oth.migDoneCli', { count: lastResult.migratedCount })
          : t('settings.oth.migDoneDesktop', {
              count: lastResult.migratedCount,
              project: resolveProjectDisplayLabel(lastResult.targetProjectId),
            });

      resultBoxEl.appendChild(
        h('div', { className: 'smig-result-msg', text: `${baseMsg}${partialSuffix}` })
      );

      if (lastResult.targetClient === 'desktop' && isWindowOverlayMode()) {
        resultBoxEl.appendChild(
          h('div', { className: 'smig-result-actions' }, [
            h(
              'button',
              {
                type: 'button',
                className: 'btn-secondary smig-result-btn',
                onClick: () => {
                  if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
                    window.location.reload();
                  }
                },
              },
              [createSvgIcon('refresh', { size: 11 }), h('span', { text: t('settings.oth.migReloadBtn') })]
            ),
          ])
        );
      }

      if (lastResult.targetClient === 'cli') {
        const okItems = (lastResult.results || []).filter((r) => r.ok && r.resumeCommand);
        if (okItems.length > 0) {
          const cmdWrap = h('div', { className: 'smig-cmd-list' });
          for (const item of okItems.slice(0, 6)) {
            const isCopied = copiedCmdId === item.newCascadeId;
            const copyBtn = h(
              'button',
              {
                type: 'button',
                className: 'btn-ghost-sm smig-cmd-copy',
                text: isCopied ? t('settings.oth.migCopied') : t('settings.oth.migCopyCmd'),
                onClick: async () => {
                  const ok = await copyPlainTextToClipboard(item.resumeCommand);
                  if (!ok || destroyed) return;
                  copiedCmdId = item.newCascadeId;
                  renderResultBox();
                  if (copiedTimer) clearTimeout(copiedTimer);
                  copiedTimer = setTimeout(() => {
                    copiedTimer = null;
                    if (!destroyed && copiedCmdId === item.newCascadeId) {
                      copiedCmdId = '';
                      renderResultBox();
                    }
                  }, 2000);
                },
              }
            );
            cmdWrap.appendChild(
              h('div', { className: 'smig-cmd-row' }, [
                h('code', { className: 'smig-cmd-code', text: item.resumeCommand }),
                copyBtn,
              ])
            );
          }
          resultBoxEl.appendChild(cmdWrap);
        }
      }
    }

    async function loadCatalog(force = false) {
      if (isLoading || (hasLoadedOnce && !force)) return;
      isLoading = true;
      if (refreshBtn) patchAttr(refreshBtn, 'disabled', true);
      try {
        const res = await loadCatalogFn();
        if (destroyed) return;
        hasLoadedOnce = true;
        if (res && typeof res === 'object') {
          catalog = res;
          ensureValidSelectionDefaults();
          syncControlsAndList();
        }
      } catch {
        // 本地目录或 API 暂不可用时静默隐藏卡片，避免干扰其他设置项
        if (!destroyed && !catalog) {
          patchAttr(rootEl, 'hidden', true);
        }
      } finally {
        isLoading = false;
        if (refreshBtn) patchAttr(refreshBtn, 'disabled', false);
      }
    }

    async function handleMigrate() {
      if (isMigrating || selectedIds.size === 0 || !sourceClient || !targetClient) return;
      isMigrating = true;
      lastResult = null;
      renderSessionList();
      renderResultBox();
      try {
        const payload = {
          sourceClient,
          targetClient,
          mode: migrationMode,
          cascadeIds: [...selectedIds],
          ...(targetClient === 'desktop' ? { targetProjectId } : {}),
        };
        const res = await runMigrateFn(payload);
        if (destroyed) return;
        lastResult = res || { ok: false, error: 'empty_response' };
        if (res?.ok) {
          selectedIds.clear();
          void loadCatalog(true);
        }
      } catch (err) {
        if (!destroyed) {
          lastResult = { ok: false, error: err?.message || 'request_failed' };
        }
      } finally {
        isMigrating = false;
        if (!destroyed) {
          renderSessionList();
          renderResultBox();
          props?.onLayoutChange?.();
        }
      }
    }

    function refreshLabels() {
      if (!bodyMounted) return;
      patchText(titleEl, t('settings.oth.migTitle'));
      patchText(descEl, t('settings.oth.migDesc'));
      patchText(refreshBtnText, t('settings.oth.migRefreshBtn'));
      patchText(sourceLabelEl, t('settings.oth.migSourceLabel'));
      patchText(targetLabelEl, t('settings.oth.migTargetLabel'));
      patchText(modeLabelEl, t('settings.oth.migModeLabel'));
      syncModeControls();
      patchText(projectLabelEl, t('settings.oth.migProjectLabel'));
      patchAttr(searchInput, 'placeholder', t('settings.oth.migSearchPlaceholder'));
      patchAttr(searchClearBtn, 'aria-label', t('select.clearSearch'));
      if (catalog?.available) {
        syncControlsAndList();
      }
    }

    onCleanup(() => {
      destroyed = true;
      if (copiedTimer) {
        clearTimeout(copiedTimer);
        copiedTimer = null;
      }
      modeSeg?.destroy?.();
      listScrollbar?.destroy?.();
      sourceSelect?.destroy?.();
      targetSelect?.destroy?.();
      projectSelect?.destroy?.();
    });

    return {
      el: rootEl,
      refs: {
        ensureLoaded: () => loadCatalog(false),
        reload: () => loadCatalog(true),
        refreshLabels,
      },
    };
  },
});
