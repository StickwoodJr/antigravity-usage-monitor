/**
 * Persistent CDP Host Manager for Obsidian Prism UI channels (prism-cdp-host.mjs).
 * - Strictly read-only DevToolsActivePort discovery (never patches shortcuts, Registry, argv.json, app.asar, or relaunches Antigravity)
 * - Target.setDiscoverTargets push event watcher + persistent per-page CDP sessions with reload persistence
 * - Top-level main-frame executionContextId verification rejecting sub-iframe RPC calls
 * - Lazy OmniServer (127.0.0.1:0) and WallpaperService (0o600 config in DATA_DIR) lifecycle management
 *
 * Adapted for antigravity-usage-monitor (GPL-3.0-only) on 2026-11-26.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import {
  buildPrismChannel1Expression,
  buildPrismHomeStudioExpression,
  buildPrismMascotExpression,
  buildPrismOmniExpression,
  buildPrismSettingsExpression,
  buildPrismWallpaperExpression,
  buildRefreshConfigExpression,
  HOME_STUDIO_REMOVE_EXPRESSION,
  MASCOT_REMOVE_EXPRESSION,
  OMNI_REMOVE_EXPRESSION,
  WALLPAPER_REMOVE_EXPRESSION,
} from '../prism/prism-bundler.mjs';
import { OmniServer } from '../prism/omni/omni-server.mjs';
import { createWallpaperService } from '../prism/wallpaper/wallpaper-service.mjs';
import {
  mapPrismPatchToSettingsPatch,
  mapSettingsToPrismRuntimeConfig,
} from '../shared/settings-normalization.mjs';
import { setPrismBridgeHooks } from './api-actions.mjs';
import {
  DATA_DIR,
  SETTINGS_FILE,
  loadSettings,
  normalizeFullSettings,
  saveJson,
} from './config.mjs';
import { buildPrismHomeSnapshot } from './prism-home-adapter.mjs';
import { resolveDevToolsPortCandidates } from './window-bridge.mjs';

function persistNormalizedSettings(rawSettings) {
  const normalized = normalizeFullSettings(rawSettings);
  saveJson(SETTINGS_FILE, normalized);
  return normalized;
}

const FALLBACK_DEVTOOLS_PORT = 9222;
const CDP_HTTP_TIMEOUT_MS = 1200;

/**
 * Pure top-level main-frame verification helper for `Runtime.bindingCalled` events.
 * Rejects any binding invocation whose `executionContextId` does not belong to the tracked
 * default main-frame execution context set.
 *
 * @param {{ executionContextId?: number }} eventParams
 * @param {string} mainFrameId
 * @param {Set<number>} allowedContextIds
 * @returns {boolean}
 */
export function isAllowedMainFrameBindingEvent(eventParams, mainFrameId, allowedContextIds) {
  const ctxId = eventParams?.executionContextId;
  if (!Number.isInteger(ctxId) || !(allowedContextIds instanceof Set)) return false;
  if (mainFrameId === '') {
    // Allow only if the caller explicitly tracked the context ID before frame tree resolved
    return allowedContextIds.has(ctxId);
  }
  return allowedContextIds.has(ctxId);
}

/**
 * Resolves active CDP HTTP port candidates strictly read-only via DevToolsActivePort files
 * and standard fallback port probe (never touches OS shortcuts, Registry, argv.json, or launches IDE).
 */
function findReadOnlyDevToolsPorts() {
  const found = [];
  const seen = new Set();
  for (const filePath of resolveDevToolsPortCandidates()) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      const firstLine = content.split(/\r?\n/, 1)[0].trim();
      const port = Number.parseInt(firstLine, 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && !seen.has(port)) {
        seen.add(port);
        found.push(port);
      }
    } catch {
      // Missing or unreadable DevToolsActivePort candidate
    }
  }
  if (!seen.has(FALLBACK_DEVTOOLS_PORT)) {
    found.push(FALLBACK_DEVTOOLS_PORT);
  }
  return found;
}

async function fetchLocalJson(url, timeoutMs = CDP_HTTP_TIMEOUT_MS) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(tm);
  }
}

function isHostTargetCandidate(target) {
  if (!target || target.type !== 'page') return false;
  const wsUrl = String(target.webSocketDebuggerUrl || '');
  if (!wsUrl) return false;
  const url = String(target.url || '').toLowerCase();
  const title = String(target.title || '').trim();
  if (/^(?:devtools:\/\/|data:|chrome:|chrome-extension:|edge:|blob:|plugin:)/.test(url)) {
    return false;
  }
  if (/^(?:untitled|launchpad)$/i.test(title) || /\/launchpad(?:\.html)?(?:[?#]|$)/i.test(url)) {
    return false;
  }
  if (/^https?:/.test(url)) {
    const m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/[^?#]*)?/i.exec(url);
    if (!m) return false;
    if (/^\/(?:viewer(?:\/|$)|sandbox(?:\/|$)|stream(?:\/|$)|api(?:\/|$))/.test((m[1] || '/').toLowerCase())) {
      return false;
    }
  }
  return true;
}

class MinimalCdpSocket {
  constructor(wsUrl, { onEvent = null, onClose = null } = {}) {
    this.wsUrl = wsUrl;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async connect(timeoutMs = 2500) {
    if (typeof globalThis.WebSocket === 'function') {
      const ws = new globalThis.WebSocket(this.wsUrl);
      this.ws = ws;
      await new Promise((resolve, reject) => {
        const tm = setTimeout(() => {
          try { ws.close(); } catch {}
          reject(new Error('CDP connect timeout'));
        }, timeoutMs);
        ws.addEventListener('open', () => { clearTimeout(tm); resolve(); }, { once: true });
        ws.addEventListener('error', (err) => { clearTimeout(tm); reject(err?.error || new Error('CDP websocket error')); }, { once: true });
      });
      ws.addEventListener('message', (ev) => this._handleIncomingText(String(ev.data || '')));
      ws.addEventListener('close', () => this._handleClosed());
      return;
    }

    // Zero-dependency RFC6455 loopback fallback for Node < 22 without global WebSocket
    const u = new URL(this.wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    await new Promise((resolve, reject) => {
      let settled = false;
      const tm = setTimeout(() => {
        if (!settled) { settled = true; req.destroy(); reject(new Error('CDP connect timeout')); }
      }, timeoutMs);
      const req = http.request({
        hostname: u.hostname,
        port: Number(u.port || 80),
        path: `${u.pathname}${u.search}`,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
      });
      req.on('upgrade', (_res, socket, head) => {
        if (settled) { socket.destroy(); return; }
        settled = true;
        clearTimeout(tm);
        let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
        const rawWs = {
          readyState: 1,
          send: (text) => {
            const payload = Buffer.from(String(text), 'utf8');
            const mask = crypto.randomBytes(4);
            let hdr;
            if (payload.length < 126) {
              hdr = Buffer.alloc(6);
              hdr[0] = 0x81;
              hdr[1] = 0x80 | payload.length;
              mask.copy(hdr, 2);
            } else if (payload.length < 65536) {
              hdr = Buffer.alloc(8);
              hdr[0] = 0x81;
              hdr[1] = 0x80 | 126;
              hdr.writeUInt16BE(payload.length, 2);
              mask.copy(hdr, 4);
            } else {
              hdr = Buffer.alloc(14);
              hdr[0] = 0x81;
              hdr[1] = 0x80 | 127;
              hdr.writeBigUInt64BE(BigInt(payload.length), 2);
              mask.copy(hdr, 10);
            }
            const masked = Buffer.allocUnsafe(payload.length);
            for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
            socket.write(Buffer.concat([hdr, masked]));
          },
          close: () => { try { rawWs.readyState = 3; socket.destroy(); } catch {} },
        };
        this.ws = rawWs;
        socket.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 2) {
            const b0 = buf[0];
            const b1 = buf[1];
            let len = b1 & 0x7f;
            let off = 2;
            if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            const masked = (b1 & 0x80) !== 0;
            const mOff = masked ? off : 0;
            off += masked ? 4 : 0;
            if (buf.length < off + len) break;
            const frame = Buffer.from(buf.subarray(off, off + len));
            if (masked) for (let i = 0; i < len; i++) frame[i] ^= buf[mOff + (i & 3)];
            buf = buf.subarray(off + len);
            const opcode = b0 & 0x0f;
            if (opcode === 0x8) { rawWs.close(); break; }
            if (opcode === 0x9) {
              const pong = Buffer.alloc(2 + frame.length);
              pong[0] = 0x8a; pong[1] = 0x80 | Math.min(125, frame.length);
              try { socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])); } catch {}
              continue;
            }
            if (opcode === 0x1 || opcode === 0x0) this._handleIncomingText(frame.toString('utf8'));
          }
        });
        socket.on('close', () => { rawWs.readyState = 3; this._handleClosed(); });
        socket.on('error', () => { rawWs.readyState = 3; this._handleClosed(); });
        resolve();
      });
      req.on('error', (err) => { if (!settled) { settled = true; clearTimeout(tm); reject(err); } });
      req.end();
    });
  }

  _handleIncomingText(rawText) {
    try {
      const msg = JSON.parse(rawText);
      if (msg && Number.isInteger(msg.id)) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.tm);
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP command failed'));
          else p.resolve(msg.result);
        }
      } else if (msg && typeof msg.method === 'string') {
        this.onEvent?.(msg.method, msg.params || {});
      }
    } catch {
      // Ignore malformed CDP frames
    }
  }

  _handleClosed() {
    this.closed = true;
    for (const [, p] of this.pending.entries()) {
      clearTimeout(p.tm);
      p.reject(new Error('CDP socket closed'));
    }
    this.pending.clear();
    this.onClose?.();
  }

  send(method, params = {}, timeoutMs = 4000) {
    if (!this.ws || this.closed || this.ws.readyState !== 1) {
      return Promise.reject(new Error('CDP socket not open'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const tm = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, tm });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(tm);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  close() {
    this.closed = true;
    for (const [, p] of this.pending.entries()) {
      clearTimeout(p.tm);
      p.reject(new Error('CDP socket closed'));
    }
    this.pending.clear();
    try {
      this.ws?.close?.();
    } catch {}
    this.ws = null;
  }
}

/**
 * Creates the Obsidian Prism persistent CDP Host & Lazy Service Coordinator.
 *
 * @param {{
 *   onTargetEvent?: () => void,
 *   onOpenMonitor?: () => void,
 *   onSettingsUpdatedExternally?: (settings: object) => void,
 * }} [options]
 */
export function createPrismCdpHost(options = {}) {
  let stopped = false;
  let started = false;
  let browserSocket = null;
  let browserPort = 0;
  let rescanTimer = null;

  /** @type {Map<string, object>} */
  const pageSessions = new Map();

  let omniServer = null;
  let omniStartPromise = null;
  let wallpaperService = null;
  let broadcastPromise = null;
  let broadcastQueued = false;

  function getRuntimeConfig(settings = null) {
    const s = settings && typeof settings === 'object' ? settings : loadSettings();
    return mapSettingsToPrismRuntimeConfig(s);
  }

  async function ensureWallpaperService(forceCreate = false) {
    const rtCfg = getRuntimeConfig();
    if (!forceCreate && !rtCfg.wallpaperEnabled) {
      return null;
    }
    if (!wallpaperService) {
      wallpaperService = createWallpaperService({
        configPath: join(DATA_DIR, 'wallpaper.json'),
      });
    }
    return wallpaperService;
  }

  async function getWallpaperSnapshot(forceCreate = false) {
    const svc = await ensureWallpaperService(forceCreate);
    if (!svc) return { enabled: false, serverRunning: false, mediaPath: '' };
    return svc.getConfigSync();
  }

  async function ensureOmniServer(forceStart = false) {
    const rtCfg = getRuntimeConfig();
    if (!forceStart && rtCfg.omniModule === 'off') {
      return null;
    }
    if (omniServer && omniServer.running) {
      return omniServer.getServerInfo();
    }
    if (omniStartPromise) return omniStartPromise;
    omniStartPromise = (async () => {
      try {
        if (!omniServer) {
          omniServer = new OmniServer({ port: 0 });
        }
        return await omniServer.start();
      } catch {
        return null;
      } finally {
        omniStartPromise = null;
      }
    })();
    return omniStartPromise;
  }

  async function stopLazyServices() {
    if (omniServer) {
      const srv = omniServer;
      omniServer = null;
      await srv.stop().catch(() => {});
    }
    if (wallpaperService) {
      const ws = wallpaperService;
      wallpaperService = null;
      await Promise.resolve(ws.dispose()).catch(() => {});
    }
  }

  async function evaluateOnSession(session, expr) {
    if (!expr || session.closed || !session.socket) return null;
    try {
      const res = await session.socket.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: false,
      });
      return res?.result?.value ?? null;
    } catch {
      return null;
    }
  }

  async function resolveSessionRpc(session, globalFnName, id, resultObj) {
    if (!session || session.closed) return;
    const expr = `(() => { try { window[${JSON.stringify(globalFnName)}]?.(${JSON.stringify(id)}, ${JSON.stringify(resultObj)}); } catch {} })()`;
    await evaluateOnSession(session, expr);
  }

  async function syncLazyChannelsOnSession(session, runtimeCfg) {
    if (!session || session.closed) return;
    if ((runtimeCfg.homeLayout || 'studio') === 'studio') {
      const expr = buildPrismHomeStudioExpression(runtimeCfg);
      if (expr) await evaluateOnSession(session, expr);
    } else {
      await evaluateOnSession(session, HOME_STUDIO_REMOVE_EXPRESSION);
    }

    if (runtimeCfg.mascot && runtimeCfg.mascot !== 'off') {
      const expr = buildPrismMascotExpression(runtimeCfg);
      if (expr) await evaluateOnSession(session, expr);
    } else {
      await evaluateOnSession(session, MASCOT_REMOVE_EXPRESSION);
    }

    if (runtimeCfg.omniModule !== 'off') {
      const meta = await ensureOmniServer(true);
      const expr = buildPrismOmniExpression(runtimeCfg, meta);
      if (expr) await evaluateOnSession(session, expr);
    } else {
      await evaluateOnSession(session, OMNI_REMOVE_EXPRESSION);
    }

    if (runtimeCfg.wallpaperEnabled) {
      const wpSnap = await getWallpaperSnapshot(true);
      const expr = buildPrismWallpaperExpression(runtimeCfg, wpSnap);
      if (expr) await evaluateOnSession(session, expr);
    } else if (session.settingsRequested) {
      const wpSnap = await getWallpaperSnapshot(false);
      const expr = buildPrismWallpaperExpression(runtimeCfg, wpSnap, { forceForSettings: true });
      if (expr) await evaluateOnSession(session, expr);
    } else {
      await evaluateOnSession(session, WALLPAPER_REMOVE_EXPRESSION);
    }
  }

  async function injectAllChannelsIntoSession(session) {
    if (stopped || session.closed) return;
    const runtimeCfg = getRuntimeConfig();
    const ch1 = buildPrismChannel1Expression(runtimeCfg);
    try {
      if (ch1.expression) {
        const res = await session.socket.send('Page.addScriptToEvaluateOnNewDocument', {
          source: ch1.expression,
        });
        session.newDocScriptId = res?.identifier || null;
      }
    } catch {}
    await evaluateOnSession(session, ch1.expression);
    await syncLazyChannelsOnSession(session, runtimeCfg);
  }

  async function handleBindingCall(session, params) {
    if (!isAllowedMainFrameBindingEvent(params, session.mainFrameId, session.allowedMainContextIds)) {
      return;
    }
    const name = String(params?.name || '');
    let msg = null;
    try {
      msg = JSON.parse(String(params?.payload || '{}'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (name === '__agPrismSetting') {
      if (msg.action === 'request-settings-panel') {
        session.settingsRequested = true;
        const runtimeCfg = getRuntimeConfig();
        const setExpr = buildPrismSettingsExpression(runtimeCfg);
        if (setExpr) await evaluateOnSession(session, setExpr);
        const wpSnap = await getWallpaperSnapshot(true);
        const wpExpr = buildPrismWallpaperExpression(runtimeCfg, wpSnap, { forceForSettings: true });
        if (wpExpr) await evaluateOnSession(session, wpExpr);
        return;
      }
      if (msg.action === 'request-home-studio-panel') {
        const runtimeCfg = getRuntimeConfig();
        const expr = buildPrismHomeStudioExpression(runtimeCfg);
        if (expr) await evaluateOnSession(session, expr);
        return;
      }
      let prismPatch = null;
      if (msg.action === 'patch-batch' && msg.entries && typeof msg.entries === 'object') {
        prismPatch = msg.entries;
      } else if (typeof msg.key === 'string') {
        prismPatch = { [msg.key]: msg.value };
      }
      if (prismPatch) {
        const mappedPatch = mapPrismPatchToSettingsPatch(prismPatch);
        if (Object.keys(mappedPatch).length > 0) {
          const updated = persistNormalizedSettings({ ...loadSettings(), ...mappedPatch });
          options.onSettingsUpdatedExternally?.(updated);
          await broadcastSettingsUpdate(updated);
        }
      }
      return;
    }

    if (name === '__agPrismHomeCall') {
      const reqId = msg.id;
      const input = msg.input && typeof msg.input === 'object' ? msg.input : {};
      if (input.action === 'open-monitor') {
        try {
          options.onOpenMonitor?.();
        } catch {}
        await resolveSessionRpc(session, '__agPrismHomeResolve', reqId, { ok: true, opened: true });
        return;
      }
      try {
        const snap = await buildPrismHomeSnapshot({
          range: input.range || 'all',
          workspace: input.workspace || 'all',
          includeArchived: input.includeArchived !== false,
          force: Boolean(input.force),
        });
        await resolveSessionRpc(session, '__agPrismHomeResolve', reqId, snap);
      } catch (err) {
        await resolveSessionRpc(session, '__agPrismHomeResolve', reqId, {
          ok: false,
          error: String(err?.message || err),
        });
      }
      return;
    }

    if (name === '__agPrismOmniCall') {
      const reqId = msg.id;
      const action = String(msg.action || 'getServerInfo');
      try {
        await ensureOmniServer(true);
        if (!omniServer) {
          await resolveSessionRpc(session, '__agPrismOmniResolve', reqId, {
            ok: false,
            error: 'Omni server unavailable',
          });
          return;
        }
        const res = await omniServer.handleRpcAction(action, msg);
        await resolveSessionRpc(session, '__agPrismOmniResolve', reqId, res);
      } catch (err) {
        await resolveSessionRpc(session, '__agPrismOmniResolve', reqId, {
          ok: false,
          error: String(err?.message || err),
        });
      }
      return;
    }

    if (name === '__agPrismWallpaperCall') {
      const reqId = msg.id;
      const action = String(msg.action || 'status');
      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      try {
        const svc = await ensureWallpaperService(true);
        const res = await svc.handleAction(action, payload);
        if (typeof res?.config?.enabled === 'boolean') {
          const cur = loadSettings();
          if (cur.prismWallpaperEnabled !== res.config.enabled) {
            const next = persistNormalizedSettings({ ...cur, prismWallpaperEnabled: res.config.enabled });
            await broadcastSettingsUpdate(next);
          }
        }
        await resolveSessionRpc(session, '__agPrismWallpaperResolve', reqId, res);
      } catch (err) {
        await resolveSessionRpc(session, '__agPrismWallpaperResolve', reqId, {
          ok: false,
          error: String(err?.message || err),
        });
      }
    }
  }

  async function attachPageTarget(target) {
    const targetId = String(target?.targetId || target?.id || '');
    const wsUrl = String(target?.webSocketDebuggerUrl || '');
    if (!targetId || !wsUrl || pageSessions.has(targetId) || stopped) return;

    const session = {
      targetId,
      wsUrl,
      socket: null,
      mainFrameId: '',
      allowedMainContextIds: new Set(),
      settingsRequested: false,
      newDocScriptId: null,
      closed: false,
    };
    pageSessions.set(targetId, session);

    const sock = new MinimalCdpSocket(wsUrl, {
      onEvent(method, params) {
        if (method === 'Page.frameNavigated' && !params?.frame?.parentId && params?.frame?.id) {
          session.mainFrameId = String(params.frame.id);
        } else if (method === 'Runtime.executionContextCreated') {
          const ctx = params?.context;
          const aux = ctx?.auxData;
          if (
            ctx &&
            Number.isInteger(ctx.id) &&
            aux?.isDefault === true &&
            (!session.mainFrameId || aux?.frameId === session.mainFrameId)
          ) {
            session.allowedMainContextIds.add(ctx.id);
          }
        } else if (method === 'Runtime.executionContextDestroyed') {
          if (Number.isInteger(params?.executionContextId)) {
            session.allowedMainContextIds.delete(params.executionContextId);
          }
        } else if (method === 'Runtime.executionContextsCleared') {
          session.allowedMainContextIds.clear();
        } else if (method === 'Runtime.bindingCalled') {
          void handleBindingCall(session, params);
        } else if (method === 'Page.domContentEventFired' || method === 'Page.loadEventFired') {
          void injectAllChannelsIntoSession(session);
        }
      },
      onClose() {
        session.closed = true;
        pageSessions.delete(targetId);
      },
    });
    session.socket = sock;

    try {
      await sock.connect(2500);
      if (stopped) {
        sock.close();
        return;
      }
      await sock.send('Page.enable');
      await sock.send('Runtime.enable');
      try {
        const tree = await sock.send('Page.getFrameTree');
        if (tree?.frameTree?.frame?.id) {
          session.mainFrameId = String(tree.frameTree.frame.id);
        }
      } catch {}
      for (const bName of ['__agPrismSetting', '__agPrismHomeCall', '__agPrismOmniCall', '__agPrismWallpaperCall']) {
        await sock.send('Runtime.addBinding', { name: bName }).catch(() => {});
      }
      await injectAllChannelsIntoSession(session);
    } catch {
      session.closed = true;
      sock.close();
      pageSessions.delete(targetId);
    }
  }

  async function broadcastSettingsUpdate(nextSettings = null) {
    if (stopped) return;
    if (broadcastPromise) {
      broadcastQueued = true;
      return broadcastPromise;
    }
    broadcastPromise = (async () => {
      do {
        broadcastQueued = false;
        const runtimeCfg = getRuntimeConfig(nextSettings);
        const refreshExpr = buildRefreshConfigExpression(runtimeCfg);
        for (const session of [...pageSessions.values()]) {
          if (session.closed) continue;
          await evaluateOnSession(session, refreshExpr);
          await syncLazyChannelsOnSession(session, runtimeCfg);
        }
        if (runtimeCfg.omniModule === 'off' && omniServer) {
          const srv = omniServer;
          omniServer = null;
          await srv.stop().catch(() => {});
        }
        if (!runtimeCfg.wallpaperEnabled && wallpaperService && !wallpaperService.isEnabledSync()) {
          const ws = wallpaperService;
          wallpaperService = null;
          await Promise.resolve(ws.dispose()).catch(() => {});
        }
      } while (broadcastQueued && !stopped);
    })();
    try {
      await broadcastPromise;
    } finally {
      broadcastPromise = null;
    }
  }

  async function scanAndAttachTargets() {
    if (stopped) return;
    const ports = findReadOnlyDevToolsPorts();
    for (const port of ports) {
      if (stopped) return;
      const list = await fetchLocalJson(`http://127.0.0.1:${port}/json/list`);
      if (!Array.isArray(list) || list.length === 0) continue;

      if (!browserSocket || browserSocket.closed || browserPort !== port) {
        const ver = await fetchLocalJson(`http://127.0.0.1:${port}/json/version`);
        const bWs = ver?.webSocketDebuggerUrl;
        if (bWs) {
          browserSocket?.close?.();
          const sock = new MinimalCdpSocket(bWs, {
            onEvent(method, params) {
              if (
                method === 'Target.targetCreated' ||
                method === 'Target.targetInfoChanged' ||
                method === 'Target.targetDestroyed'
              ) {
                try {
                  options.onTargetEvent?.(method, params);
                } catch {}
                if (method === 'Target.targetDestroyed' && params?.targetId) {
                  const dead = pageSessions.get(String(params.targetId));
                  if (dead) {
                    dead.closed = true;
                    dead.socket?.close?.();
                    pageSessions.delete(String(params.targetId));
                  }
                } else if (isHostTargetCandidate(params?.targetInfo)) {
                  void scanAndAttachTargets();
                }
              }
            },
            onClose() {
              if (browserSocket === sock) {
                browserSocket = null;
                browserPort = 0;
              }
            },
          });
          try {
            await sock.connect(2000);
            await sock.send('Target.setDiscoverTargets', { discover: true });
            browserSocket = sock;
            browserPort = port;
          } catch {
            sock.close();
          }
        }
      }

      for (const t of list) {
        if (isHostTargetCandidate(t)) {
          await attachPageTarget(t);
        }
      }
      break;
    }
  }

  function schedulePoll(ms = 5000) {
    if (stopped) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(async () => {
      if (stopped) return;
      if (!browserSocket || browserSocket.closed) {
        await scanAndAttachTargets().catch(() => {});
      }
      schedulePoll(5000);
    }, ms);
    if (typeof rescanTimer.unref === 'function') rescanTimer.unref();
  }

  function start() {
    if (started || stopped) return;
    started = true;
    try {
      setPrismBridgeHooks({
        onSettingsChanged: (nextSettings) => {
          void broadcastSettingsUpdate(nextSettings);
        },
        onWallpaperAction: async (action, payload) => {
          const svc = await ensureWallpaperService(true);
          const res = await svc.handleAction(action, payload);
          if (typeof res?.config?.enabled === 'boolean') {
            const cur = loadSettings();
            if (cur.prismWallpaperEnabled !== res.config.enabled) {
              const updated = persistNormalizedSettings({ ...cur, prismWallpaperEnabled: res.config.enabled });
              await broadcastSettingsUpdate(updated);
            }
          }
          return res;
        },
        getOmniStatus: () => ({
          running: Boolean(omniServer?.running),
          ...(omniServer?.running ? omniServer.getServerInfo() : { port: 0, baseUrl: '' }),
        }),
      });
    } catch {
      // Optional hook binding
    }
    void scanAndAttachTargets().catch(() => {});
    schedulePoll(4500);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(rescanTimer);
    rescanTimer = null;
    try {
      setPrismBridgeHooks({ onSettingsChanged: null, onWallpaperAction: null, getOmniStatus: null });
    } catch {}
    browserSocket?.close?.();
    browserSocket = null;
    browserPort = 0;
    for (const s of pageSessions.values()) {
      s.closed = true;
      s.socket?.close?.();
    }
    pageSessions.clear();
    await stopLazyServices();
  }

  return {
    start,
    stop,
    scanAndAttachTargets,
    broadcastSettingsUpdate,
    getStatus: () => ({
      started,
      stopped,
      attachedPages: pageSessions.size,
      browserConnected: Boolean(browserSocket && !browserSocket.closed),
      omniRunning: Boolean(omniServer?.running),
      wallpaperRunning: Boolean(wallpaperService?.getConfigSync?.()?.serverRunning),
    }),
  };
}
