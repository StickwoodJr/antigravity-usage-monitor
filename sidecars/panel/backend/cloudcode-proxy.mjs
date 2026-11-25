/**
 * @fileoverview Hard-disabled local CloudCode proxy module (`cloudcode-proxy.mjs`).
 *
 * The local MITM HTTP server, Windows registry proxy query, and upstream URL
 * redirection are hard-disabled in this hardened fork. Pure URL/catalog/payload
 * helpers and exported controller symbols are preserved as safe no-ops.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_UPSTREAM_CLOUDCODE_URL = 'https://daily-cloudcode-pa.googleapis.com';

const CC_PROXY_UPSTREAM_URL_RE = /https:\/\/[a-z0-9.-]*cloudcode-pa\.googleapis\.com/gi;
const CC_PROXY_CHECKPOINTER_KEY = 'CASCADE_USE_EXPERIMENT_CHECKPOINTER';
const CC_PROXY_CHECKPOINTER_PREFIX = `${CC_PROXY_CHECKPOINTER_KEY}/`;
const CC_PROXY_MAX_LOG_READ_BYTES = 512 * 1024;

function createDisabledCloudCodeProxyStatus() {
  return {
    state: 'disabled',
    active: false,
    disabled: true,
    ruleCount: 0,
    appliedModels: [],
    upstreamUrl: '',
    localUrl: '',
    syncedAtMs: 0,
    error: '',
  };
}

function isCcProxyLoopbackHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
}

export function isValidUpstreamCloudCodeUrl(rawUrl, { allowHttp = false } = {}) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      return false;
    }
    if (!allowHttp && isCcProxyLoopbackHost(parsed.hostname)) {
      return false;
    }
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function readLogFileTailUtf8(filePath, sizeBytes, fsTailOps = null) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= CC_PROXY_MAX_LOG_READ_BYTES) {
    return readFileSync(filePath, 'utf8');
  }
  const openFn = fsTailOps?.openSync || openSync;
  const readFn = fsTailOps?.readSync || readSync;
  const closeFn = fsTailOps?.closeSync || closeSync;
  const start = Math.max(0, sizeBytes - CC_PROXY_MAX_LOG_READ_BYTES);
  const length = sizeBytes - start;
  const fd = openFn(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = readFn(fd, buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeFn(fd);
  }
}

function getCcProxyLogCandidateDirs(env, platform, homeDir) {
  const safeEnv = env || {};
  const home = String(homeDir || '').trim();
  if (platform === 'win32') {
    return [
      safeEnv.APPDATA ? join(safeEnv.APPDATA, 'Antigravity', 'logs') : '',
      safeEnv.LOCALAPPDATA ? join(safeEnv.LOCALAPPDATA, 'Antigravity', 'logs') : '',
      home ? join(home, '.gemini', 'antigravity', 'logs') : '',
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return [
      home ? join(home, 'Library', 'Application Support', 'Antigravity', 'logs') : '',
      home ? join(home, '.gemini', 'antigravity', 'logs') : '',
    ].filter(Boolean);
  }
  return [
    home ? join(home, '.config', 'Antigravity', 'logs') : '',
    home ? join(home, '.gemini', 'antigravity', 'logs') : '',
  ].filter(Boolean);
}

/**
 * 探测宿主真实上游 CloudCode URL（只读检查环境变量与本地日志，严格排除本地回环地址）。
 *
 * @param {object} [opts]
 * @returns {string}
 */
export function detectUpstreamCloudCodeUrl({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  fsTailOps = null,
} = {}) {
  const envUrl = String(env?.ANTIGRAVITY_CLOUDCODE_URL || env?.CLOUDCODE_URL || '').trim();
  if (isValidUpstreamCloudCodeUrl(envUrl)) {
    return envUrl.replace(/\/+$/, '');
  }

  for (const dir of getCcProxyLogCandidateDirs(env, platform, homeDir)) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir)
        .filter((name) => /\.log$/i.test(String(name || '')))
        .map((name) => {
          const fullPath = join(dir, String(name));
          const st = statSync(fullPath);
          return { fullPath, mtimeMs: Number(st?.mtimeMs || 0), size: Number(st?.size || 0) };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const item of entries.slice(0, 5)) {
        const text = readLogFileTailUtf8(item.fullPath, item.size, fsTailOps);
        const matches = text.match(CC_PROXY_UPSTREAM_URL_RE);
        if (matches && matches.length > 0) {
          for (let i = matches.length - 1; i >= 0; i -= 1) {
            const candidate = matches[i].replace(/\/+$/, '');
            if (isValidUpstreamCloudCodeUrl(candidate)) {
              return candidate;
            }
          }
        }
      }
    } catch {
      // 忽略单个日志目录读取异常
    }
  }

  return DEFAULT_UPSTREAM_CLOUDCODE_URL;
}

function shouldCcProxyBypassHost(hostname, noProxyRaw) {
  const target = String(hostname || '').trim().toLowerCase();
  const list = String(noProxyRaw || '').trim();
  if (!target || !list) return false;
  for (const part of list.split(/[;,]/)) {
    const raw = part.trim().toLowerCase();
    if (!raw) continue;
    if (raw === '*') return true;
    const rule = raw.replace(/^\*\./, '.').replace(/:\d+$/, '');
    if (!rule) continue;
    if (rule.startsWith('.')) {
      if (target.endsWith(rule) || target === rule.slice(1)) return true;
    } else if (target === rule || target.endsWith(`.${rule}`)) {
      return true;
    }
  }
  return false;
}

export async function detectSystemHttpsProxy(targetHostname = '', { env = process.env } = {}) {
  const noProxy = env?.NO_PROXY || env?.no_proxy || '';
  if (shouldCcProxyBypassHost(targetHostname, noProxy)) return '';
  const envProxy = String(
    env?.HTTPS_PROXY || env?.https_proxy || env?.ALL_PROXY || env?.all_proxy || ''
  ).trim();
  if (envProxy) return /^https?:\/\//i.test(envProxy) ? envProxy : `http://${envProxy}`;
  return '';
}

function parseCcProxyPositiveLimit(rawValue) {
  const num = Number(rawValue);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

/**
 * 从模型目录（`GetAvailableModels` 或 `/v1internal:fetchAvailableModels` 的 `models` 映射）中
 * 提取各模型上游原始的 `CASCADE_USE_EXPERIMENT_CHECKPOINTER.max_token_limit`。
 *
 * @param {Record<string, any>|null|undefined} modelsMap
 * @returns {Record<string, number>}
 */
export function extractUpstreamCheckpointDefaults(modelsMap) {
  const defaultsByModelId = {};
  if (!modelsMap || typeof modelsMap !== 'object' || Array.isArray(modelsMap)) {
    return defaultsByModelId;
  }
  for (const entry of Object.values(modelsMap)) {
    const modelId = typeof entry?.model === 'string' ? entry.model.trim() : '';
    if (!modelId) continue;
    const rawStr = entry?.modelExperiments?.experiments?.[CC_PROXY_CHECKPOINTER_KEY]?.stringValue;
    if (typeof rawStr !== 'string' || !rawStr.trim()) continue;
    try {
      const parsed = JSON.parse(rawStr);
      const lim = parseCcProxyPositiveLimit(parsed?.max_token_limit ?? parsed?.maxTokenLimit);
      if (lim !== null) {
        defaultsByModelId[modelId] = lim;
      }
    } catch {
      // 忽略非法 JSON
    }
  }
  return defaultsByModelId;
}

/**
 * 按解析后的 `rulesByModelId`（键为 `MODEL_*` 枚举 ID，值为数值 token 上限或命名档位）
 * 原地改写 `/v1internal:fetchAvailableModels` 响应体中的 `CASCADE_USE_EXPERIMENT_CHECKPOINTER`。
 *
 * @param {any} fetchResp
 * @param {Record<string, number|string>} rulesByModelId
 * @returns {{ modified: boolean, applied: Array<{ modelKey: string, modelId: string, prevLimit: number|null, nextRule: number|string }>, defaultsByModelId: Record<string, number> }}
 */
export function rewriteFetchAvailableModelsPayload(fetchResp, rulesByModelId) {
  const models = fetchResp?.models;
  const defaultsByModelId = extractUpstreamCheckpointDefaults(models);
  if (
    !models ||
    typeof models !== 'object' ||
    Array.isArray(models) ||
    !rulesByModelId ||
    typeof rulesByModelId !== 'object'
  ) {
    return { modified: false, applied: [], defaultsByModelId };
  }

  const applied = [];
  for (const [modelKey, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== 'object') continue;
    const modelId = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (!modelId || !Object.prototype.hasOwnProperty.call(rulesByModelId, modelId)) continue;
    const rule = rulesByModelId[modelId];
    const isNumericRule = typeof rule === 'number' && Number.isSafeInteger(rule) && rule > 0;
    const isNamedRule = typeof rule === 'string' && rule.trim().length > 0;
    if (!isNumericRule && !isNamedRule) continue;

    if (!entry.modelExperiments || typeof entry.modelExperiments !== 'object') {
      entry.modelExperiments = {};
    }
    if (!entry.modelExperiments.experiments || typeof entry.modelExperiments.experiments !== 'object') {
      entry.modelExperiments.experiments = {};
    }
    const expMap = entry.modelExperiments.experiments;
    const ckKeys = Object.keys(expMap).filter(
      (k) => k === CC_PROXY_CHECKPOINTER_KEY || k.startsWith(CC_PROXY_CHECKPOINTER_PREFIX)
    );
    if (!ckKeys.includes(CC_PROXY_CHECKPOINTER_KEY)) {
      ckKeys.unshift(CC_PROXY_CHECKPOINTER_KEY);
    }

    const prevLimit = defaultsByModelId[modelId] ?? null;
    if (isNumericRule) {
      for (const ckKey of ckKeys) {
        const prevRaw = expMap[ckKey]?.stringValue;
        let ckObj = {};
        if (typeof prevRaw === 'string' && prevRaw.trim()) {
          try {
            const parsed = JSON.parse(prevRaw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              ckObj = parsed;
            }
          } catch {
            ckObj = {};
          }
        }
        ckObj.max_token_limit = String(rule);
        delete ckObj.maxTokenLimit;
        expMap[ckKey] = {
          ...(expMap[ckKey] && typeof expMap[ckKey] === 'object' ? expMap[ckKey] : {}),
          stringValue: JSON.stringify(ckObj),
        };
      }
    } else {
      const variantKey = `${CC_PROXY_CHECKPOINTER_PREFIX}context-window_${rule.trim()}`;
      const variantRaw = expMap[variantKey]?.stringValue;
      if (typeof variantRaw !== 'string' || !variantRaw.trim()) {
        continue;
      }
      for (const ckKey of ckKeys) {
        expMap[ckKey] = {
          ...(expMap[ckKey] && typeof expMap[ckKey] === 'object' ? expMap[ckKey] : {}),
          stringValue: variantRaw,
        };
      }
    }

    if (Array.isArray(entry.ignoreExperiments)) {
      entry.ignoreExperiments = entry.ignoreExperiments.filter(
        (x) =>
          x !== CC_PROXY_CHECKPOINTER_KEY &&
          !String(x || '').startsWith(CC_PROXY_CHECKPOINTER_PREFIX) &&
          x !== 'checkpoint-variant'
      );
    }

    applied.push({ modelKey, modelId, prevLimit, nextRule: rule });
  }

  return { modified: applied.length > 0, applied, defaultsByModelId };
}

/**
 * 创建硬禁用的 CloudCode 代理控制器（不启动本地服务、不注册或更改宿主上游地址）。
 */
export function createCloudCodeProxyController() {
  let upstreamDefaults = {};

  function getStatus() {
    return createDisabledCloudCodeProxyStatus();
  }

  function getUpstreamDefaults() {
    return { ...upstreamDefaults };
  }

  function seedUpstreamDefaultsFromCatalog(catalogModels) {
    const extracted = extractUpstreamCheckpointDefaults(catalogModels);
    if (Object.keys(extracted).length > 0) {
      upstreamDefaults = { ...upstreamDefaults, ...extracted };
    }
  }

  async function reconcile() {
    return getStatus();
  }

  async function stop() {
    return getStatus();
  }

  return {
    reconcile,
    stop,
    getStatus,
    getUpstreamDefaults,
    seedUpstreamDefaultsFromCatalog,
  };
}

let defaultCloudCodeProxyController = null;

export function getDefaultCloudCodeProxy() {
  if (!defaultCloudCodeProxyController) {
    defaultCloudCodeProxyController = createCloudCodeProxyController();
  }
  return defaultCloudCodeProxyController;
}

export function getDefaultCloudCodeProxyStatus() {
  return defaultCloudCodeProxyController
    ? defaultCloudCodeProxyController.getStatus()
    : createDisabledCloudCodeProxyStatus();
}

export function getDefaultCloudCodeUpstreamDefaults() {
  if (!defaultCloudCodeProxyController) return {};
  return defaultCloudCodeProxyController.getUpstreamDefaults();
}

export function reconcileDefaultCloudCodeProxy(opts) {
  return getDefaultCloudCodeProxy().reconcile(opts);
}

export function stopDefaultCloudCodeProxy() {
  return defaultCloudCodeProxyController
    ? defaultCloudCodeProxyController.stop()
    : Promise.resolve(createDisabledCloudCodeProxyStatus());
}
