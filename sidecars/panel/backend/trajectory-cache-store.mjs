/**
 * @fileoverview Shared lazy-loaded, $O(1)$ case-insensitive, 30s-throttled trajectory cache store
 * reused by both the local sidecar (`config.mjs`) and remote SSH endpoints (`endpoint-registry.mjs`).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { inferCompactionStepModels, normalizeCachedStep } from '../trajectory-metrics.mjs';
import { isPlainObject } from './http-helpers.mjs';
import { writeTrajectoryCacheFile } from './trajectory-cache-file.mjs';

export const CACHE_RUNNING_SAVE_INTERVAL_MS = 30_000;

/**
 * Normalizes and repairs raw trajectory cache JSON into an unprototyped map.
 *
 * @param {unknown} rawLoaded
 * @returns {{ cacheObj: Record<string, any>, migrated: boolean }}
 */
export function hydrateTrajectoryCacheObject(rawLoaded) {
  const cacheObj = Object.create(null);
  let migrated = rawLoaded !== null && rawLoaded !== undefined && !isPlainObject(rawLoaded);
  if (isPlainObject(rawLoaded)) {
    for (const [id, entry] of Object.entries(rawLoaded)) {
      if (!id || !isPlainObject(entry)) {
        migrated = true;
        continue;
      }
      const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
      if (!Array.isArray(entry.steps)) migrated = true;
      const objectSteps = rawSteps.filter((s) => isPlainObject(s));
      if (objectSteps.length !== rawSteps.length) migrated = true;
      const normalizedSteps = objectSteps.map((s) => {
        const norm = normalizeCachedStep(s);
        if (norm !== s) migrated = true;
        return norm;
      });
      const finalSteps = inferCompactionStepModels(normalizedSteps);
      for (let i = 0; i < finalSteps.length; i += 1) {
        if (finalSteps[i] !== normalizedSteps[i]) {
          migrated = true;
          break;
        }
      }
      const nextEntry = { ...entry, steps: finalSteps };
      const idLower = String(id).trim().toLowerCase();
      if (
        typeof nextEntry.rootConversationId === 'string' &&
        nextEntry.rootConversationId.trim().toLowerCase() === idLower
      ) {
        delete nextEntry.rootConversationId;
        migrated = true;
      }
      if (
        typeof nextEntry.parentConversationId === 'string' &&
        nextEntry.parentConversationId.trim().toLowerCase() === idLower
      ) {
        delete nextEntry.parentConversationId;
        migrated = true;
      }
      cacheObj[id] = nextEntry;
    }
  }
  return { cacheObj, migrated };
}

/**
 * Creates an isolated trajectory cache store with lazy first-read hydration,
 * case-insensitive canonical key index, and 30-second throttled disk flushes.
 *
 * @param {{
 *   cacheFilePath: string,
 *   loadJsonFn: (filePath: string, fallback: any) => any,
 *   writeCacheFn?: (filePath: string, cacheObj: Record<string, any>) => boolean,
 *   shouldBypassThrottleFn?: (allowThrottleInTest: boolean) => boolean,
 *   registerExitHook?: boolean,
 * }} options
 */
export function createTrajectoryCacheStore({
  cacheFilePath,
  loadJsonFn,
  writeCacheFn = null,
  shouldBypassThrottleFn = () => false,
  registerExitHook = false,
}) {
  let cacheObj = Object.create(null);
  const byLower = new Map();
  let loadedOnce = false;
  const state = {
    needsSave: false,
    lastSavedAtMs: 0,
    flushTimer: null,
  };

  function defaultWriteCache(targetPath, dataObj) {
    if (!targetPath) return true;
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeTrajectoryCacheFile(targetPath, dataObj);
      return true;
    } catch (err) {
      console.error(`Failed writing trajectory cache ${targetPath}: ${err.message}`);
      return false;
    }
  }

  const doWrite = writeCacheFn || defaultWriteCache;

  function ensureLoaded() {
    if (loadedOnce) return;
    loadedOnce = true;
    if (!cacheFilePath) return;
    const loaded = loadJsonFn(cacheFilePath, {});
    const hydrated = hydrateTrajectoryCacheObject(loaded);
    cacheObj = hydrated.cacheObj;
    for (const key of Object.keys(cacheObj)) {
      byLower.set(key.toLowerCase(), key);
    }
    if (hydrated.migrated) {
      state.needsSave = true;
    }
  }

  function cancelFlushTimer() {
    if (state.flushTimer) {
      try {
        clearTimeout(state.flushTimer);
      } catch {
        // Ignore sandbox missing clearTimeout
      }
      state.flushTimer = null;
    }
  }

  function flushTrajectoryCacheNow() {
    ensureLoaded();
    cancelFlushTimer();
    if (!cacheFilePath) {
      state.needsSave = false;
      return true;
    }
    const ok = doWrite(cacheFilePath, cacheObj);
    state.needsSave = !ok;
    if (ok) {
      state.lastSavedAtMs = Date.now();
    }
    return ok;
  }

  function persistTrajectoryCacheIfNeeded({
    hasRunningSessions = false,
    allowThrottleInTest = false,
  } = {}) {
    if (!cacheFilePath) {
      state.needsSave = false;
      return;
    }
    if (shouldBypassThrottleFn(allowThrottleInTest) || typeof setTimeout !== 'function') {
      flushTrajectoryCacheNow();
      return;
    }
    const nowMs = Date.now();
    const elapsedMs = nowMs - (state.lastSavedAtMs || 0);
    if (
      !hasRunningSessions ||
      state.lastSavedAtMs === 0 ||
      elapsedMs >= CACHE_RUNNING_SAVE_INTERVAL_MS
    ) {
      flushTrajectoryCacheNow();
      return;
    }
    state.needsSave = true;
    if (!state.flushTimer) {
      const delayMs = Math.max(100, CACHE_RUNNING_SAVE_INTERVAL_MS - elapsedMs);
      const timer = setTimeout(() => {
        state.flushTimer = null;
        if (state.needsSave) {
          flushTrajectoryCacheNow();
        }
      }, delayMs);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
      state.flushTimer = timer;
    }
  }

  function clearCache() {
    if (cacheFilePath && !doWrite(cacheFilePath, {})) {
      return false;
    }
    cancelFlushTimer();
    loadedOnce = true;
    for (const key of Object.keys(cacheObj)) {
      delete cacheObj[key];
    }
    byLower.clear();
    state.needsSave = false;
    state.lastSavedAtMs = 0;
    return true;
  }

  if (registerExitHook && typeof process !== 'undefined' && typeof process?.once === 'function') {
    process.once('exit', () => {
      if (loadedOnce && state.needsSave) {
        flushTrajectoryCacheNow();
      }
    });
  }

  return {
    cacheFilePath,
    cacheState: state,
    cancelFlushTimer,
    getCachedTrajectory(cascadeId) {
      ensureLoaded();
      return cacheObj[cascadeId];
    },
    getCachedTrajectoryEntryByLower(cascadeId) {
      if (!cascadeId) return null;
      ensureLoaded();
      const direct = cacheObj[cascadeId];
      if (direct) return { id: String(cascadeId), entry: direct };
      const canon = byLower.get(String(cascadeId).toLowerCase());
      if (canon && cacheObj[canon]) {
        return { id: canon, entry: cacheObj[canon] };
      }
      return null;
    },
    listCachedTrajectoryEntries() {
      ensureLoaded();
      return Object.entries(cacheObj);
    },
    setCachedTrajectory(cascadeId, entry) {
      ensureLoaded();
      const lower = String(cascadeId || '').toLowerCase();
      const prevCanon = lower ? byLower.get(lower) : undefined;
      if (
        prevCanon &&
        prevCanon !== cascadeId &&
        Object.prototype.hasOwnProperty.call(cacheObj, prevCanon)
      ) {
        delete cacheObj[prevCanon];
      }
      cacheObj[cascadeId] = entry;
      if (lower) {
        byLower.set(lower, String(cascadeId));
      }
    },
    removeCachedTrajectory(cascadeId) {
      ensureLoaded();
      const lower = String(cascadeId || '').toLowerCase();
      if (lower && byLower.get(lower) === cascadeId) {
        byLower.delete(lower);
      }
      delete cacheObj[cascadeId];
    },
    hasPendingTrajectoryCacheSave() {
      ensureLoaded();
      return state.needsSave;
    },
    persistTrajectoryCacheIfNeeded,
    flushTrajectoryCacheNow,
    clearCache,
  };
}
