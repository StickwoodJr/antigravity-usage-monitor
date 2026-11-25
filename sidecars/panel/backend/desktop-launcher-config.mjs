/**
 * @fileoverview Hardened desktop launcher helpers (read-only path/arg inspection only).
 *
 * All automatic/scripted OS launcher, shortcut, `.desktop`, `autostart`, Windows Registry,
 * PowerShell execution, and UAC relaunch mutations are permanently disabled in this fork.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, win32 as pathWin32 } from 'node:path';

export const REMOTE_DEBUG_LAUNCH_FLAG = '--remote-debugging-port=0';

const REMOTE_DEBUG_ANY_RE = /(?:^|\s)--remote-debugging-port(?:=|\s|$)/i;
const REMOTE_DEBUG_MANAGED_ZERO_RE = /(?:^|\s+)--remote-debugging-port=(?:"0"|'0'|0)(?=\s|$)/gi;

function createDisabledLauncherResult() {
  return {
    ok: false,
    supported: false,
    disabled: true,
    reason: 'disabled_in_hardened_fork',
    updatedPaths: [],
    configuredPaths: [],
    readOnlyPaths: [],
    discoveredDirs: [],
  };
}

/**
 * 解析 Windows PowerShell 5.1 可执行文件绝对路径（仅只读路径解析，不执行任何进程）。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {(p: string) => boolean} [existsFn=existsSync]
 * @returns {string}
 */
export function resolveWindowsPowerShellExecutable(env = process.env, existsFn = existsSync) {
  const sysRoot = String(env?.SystemRoot || env?.WINDIR || 'C:\\Windows').trim();
  if (sysRoot) {
    const candidate = pathWin32.join(
      sysRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    try {
      if (existsFn(candidate)) return candidate;
    } catch {
      // Ignore filesystem probe errors
    }
  }
  return 'powershell.exe';
}

/**
 * 在命令行参数字符串中幂等补齐或移除托管的 `--remote-debugging-port=0`，保留用户自定义的其它参数或自定义端口。
 *
 * @param {unknown} rawArgs
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ changed: boolean, configured: boolean, alreadyConfigured?: boolean, removed?: boolean, args: string }}
 */
export function ensureRemoteDebugFlagInArgs(rawArgs, { enabled = true } = {}) {
  const current = String(rawArgs ?? '').trim();
  if (enabled) {
    if (REMOTE_DEBUG_ANY_RE.test(current)) {
      return {
        changed: false,
        configured: true,
        alreadyConfigured: true,
        args: current,
      };
    }
    const nextArgs = current
      ? `${current} ${REMOTE_DEBUG_LAUNCH_FLAG}`
      : REMOTE_DEBUG_LAUNCH_FLAG;
    return {
      changed: true,
      configured: true,
      args: nextArgs,
    };
  }

  if (!REMOTE_DEBUG_MANAGED_ZERO_RE.test(current)) {
    REMOTE_DEBUG_MANAGED_ZERO_RE.lastIndex = 0;
    return {
      changed: false,
      configured: REMOTE_DEBUG_ANY_RE.test(current),
      args: current,
    };
  }
  REMOTE_DEBUG_MANAGED_ZERO_RE.lastIndex = 0;
  const stripped = current.replace(REMOTE_DEBUG_MANAGED_ZERO_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  return {
    changed: stripped !== current,
    configured: REMOTE_DEBUG_ANY_RE.test(stripped),
    removed: stripped !== current,
    args: stripped,
  };
}

/**
 * 纯字符串辅助：计算 Run 命令行字符串增删 `--remote-debugging-port=0` 后的结果（不触碰系统注册表）。
 *
 * @param {unknown} rawValue
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ matched: boolean, changed: boolean, configured: boolean, value: string }}
 */
export function patchWindowsRunRegistryCommand(rawValue, { enabled = true } = {}) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const m = raw.match(/^\s*(?:"([^"]+)"|([^\s"]+))([\s\S]*)$/);
  if (!m) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const exePath = String(m[1] || m[2] || '').trim();
  const exeLeaf = exePath.split(/[\\/]/).pop() || '';
  if (exeLeaf.toLowerCase() !== 'antigravity.exe') {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const quotedExe = m[1] ? `"${exePath}"` : /\s/.test(exePath) ? `"${exePath}"` : exePath;
  const patchedArgs = ensureRemoteDebugFlagInArgs(m[3] || '', { enabled });
  const nextValue = patchedArgs.args ? `${quotedExe} ${patchedArgs.args}` : quotedExe;
  return {
    matched: true,
    changed: nextValue !== raw,
    configured: patchedArgs.configured,
    value: nextValue,
  };
}

/**
 * 纯字符串辅助：计算协议命令行字符串增删 `--remote-debugging-port=0` 后的结果（不触碰系统注册表）。
 *
 * @param {unknown} rawValue
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ matched: boolean, changed: boolean, configured: boolean, value: string }}
 */
export function patchWindowsShellOpenCommand(rawValue, { enabled = true } = {}) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const m = raw.match(/^\s*(?:"([^"]+)"|([^\s"]+))([\s\S]*)$/);
  if (!m) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const exePath = String(m[1] || m[2] || '').trim();
  const exeLeaf = exePath.split(/[\\/]/).pop() || '';
  if (exeLeaf.toLowerCase() !== 'antigravity.exe') {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const quotedExe = m[1] ? `"${exePath}"` : /\s/.test(exePath) ? `"${exePath}"` : exePath;
  const rest = String(m[3] || '').trim();

  if (enabled) {
    if (REMOTE_DEBUG_ANY_RE.test(rest)) {
      return { matched: true, changed: false, configured: true, value: raw };
    }
    const nextValue = rest
      ? `${quotedExe} ${REMOTE_DEBUG_LAUNCH_FLAG} ${rest}`
      : `${quotedExe} ${REMOTE_DEBUG_LAUNCH_FLAG}`;
    return {
      matched: true,
      changed: nextValue !== raw,
      configured: true,
      value: nextValue,
    };
  }

  const stripped = ensureRemoteDebugFlagInArgs(rest, { enabled: false });
  const nextValue = stripped.args ? `${quotedExe} ${stripped.args}` : quotedExe;
  return {
    matched: true,
    changed: nextValue !== raw,
    configured: stripped.configured,
    value: nextValue,
  };
}

function isLinuxAntigravityDesktopLeaf(leaf) {
  const lower = String(leaf || '').trim().toLowerCase();
  if (!lower || lower.includes('ide')) return false;
  return /^(?:google[-_])?antigravity(?:$|[-_.\d]|(?:\.appimage$))/i.test(lower);
}

function isWindowsVendorSubdirName(dirName) {
  const lower = String(dirName || '').trim().toLowerCase();
  if (!lower) return false;
  return lower.includes('antigravity') || /^google(?:\b|[\s_-]|$)/i.test(lower);
}

function splitLinuxExecTokens(cmdBody) {
  const tokens = [];
  const re = /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']+)+/g;
  let m;
  while ((m = re.exec(cmdBody)) !== null) {
    tokens.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function stripOuterQuotes(tok) {
  if (
    (tok.startsWith('"') && tok.endsWith('"')) ||
    (tok.startsWith("'") && tok.endsWith("'"))
  ) {
    return tok.slice(1, -1);
  }
  return tok;
}

/**
 * 纯字符串辅助：计算 Linux XDG `.desktop` 文本中 `Exec=` 行的转换结果（不写磁盘）。
 *
 * @param {string} rawText
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ matched: boolean, changed: boolean, configured: boolean, text: string }}
 */
export function patchLinuxDesktopEntryText(rawText, { enabled = true } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { matched: false, changed: false, configured: false, text: String(rawText || '') };
  }
  const eol = rawText.includes('\r\n') ? '\r\n' : '\n';
  const lines = rawText.split(/\r?\n/);
  let matched = false;
  let changed = false;
  let configured = false;

  const nextLines = lines.map((line) => {
    const execMatch = line.match(/^(\s*Exec\s*=\s*)(.+)$/);
    if (!execMatch) return line;
    const prefix = execMatch[1];
    const cmdBody = execMatch[2].trim();
    const tokens = splitLinuxExecTokens(cmdBody);
    if (!tokens.length) return line;

    let binIdx = 0;
    const firstLeaf = (stripOuterQuotes(tokens[0].raw).split('/').pop() || '').toLowerCase();
    if (firstLeaf === 'env') {
      binIdx = 1;
      while (binIdx < tokens.length) {
        const unquoted = stripOuterQuotes(tokens[binIdx].raw);
        if (unquoted === '-u' || unquoted === '--unset') {
          binIdx += 2;
          continue;
        }
        if (
          unquoted === '-S' ||
          unquoted === '-i' ||
          unquoted === '--ignore-environment' ||
          unquoted.startsWith('--unset=') ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(unquoted)
        ) {
          binIdx += 1;
          continue;
        }
        break;
      }
    }
    if (binIdx >= tokens.length) return line;

    const exeTok = tokens[binIdx];
    const exeLeaf = stripOuterQuotes(exeTok.raw).split('/').pop() || '';
    if (!isLinuxAntigravityDesktopLeaf(exeLeaf)) {
      return line;
    }

    matched = true;
    const headThroughExe = cmdBody.slice(0, exeTok.end).trim();
    const rest = cmdBody.slice(exeTok.end).trim();

    if (enabled) {
      if (REMOTE_DEBUG_ANY_RE.test(rest)) {
        configured = true;
        return line;
      }
      configured = true;
      changed = true;
      const doubleDashMatch = rest.match(/^(.*?)(?:^|\s)(--(?:\s+.*)?)$/);
      if (doubleDashMatch) {
        const beforeDash = doubleDashMatch[1].trim();
        const fromDash = doubleDashMatch[2].trim();
        const mid = beforeDash
          ? `${beforeDash} ${REMOTE_DEBUG_LAUNCH_FLAG}`
          : REMOTE_DEBUG_LAUNCH_FLAG;
        return `${prefix}${headThroughExe} ${mid} ${fromDash}`;
      }
      const fieldCodeMatch = rest.match(/^(.*?)\s*(%[fFuUdDnNickvm](?:\s+%[fFuUdDnNickvm])*)\s*$/);
      if (fieldCodeMatch) {
        const beforeCodes = fieldCodeMatch[1].trim();
        const codes = fieldCodeMatch[2].trim();
        const mid = beforeCodes
          ? `${beforeCodes} ${REMOTE_DEBUG_LAUNCH_FLAG}`
          : REMOTE_DEBUG_LAUNCH_FLAG;
        return `${prefix}${headThroughExe} ${mid} ${codes}`;
      }
      return rest
        ? `${prefix}${headThroughExe} ${rest} ${REMOTE_DEBUG_LAUNCH_FLAG}`
        : `${prefix}${headThroughExe} ${REMOTE_DEBUG_LAUNCH_FLAG}`;
    }

    const stripped = ensureRemoteDebugFlagInArgs(rest, { enabled: false });
    configured = configured || stripped.configured;
    if (!stripped.changed) return line;
    changed = true;
    return stripped.args ? `${prefix}${headThroughExe} ${stripped.args}` : `${prefix}${headThroughExe}`;
  });

  return {
    matched,
    changed,
    configured,
    text: changed ? nextLines.join(eol) : rawText,
  };
}

function stripAppImageMountPathEntries(rawVal, { omitIfEmpty = false } = {}) {
  const str = String(rawVal ?? '');
  if (!str || !str.includes('/.mount_')) {
    return str;
  }
  const parts = str.split(':').filter((entry) => {
    const trimmed = entry.trim();
    return trimmed && !trimmed.startsWith('/tmp/.mount_') && !trimmed.includes('/.mount_');
  });
  if (parts.length === 0 && omitIfEmpty) {
    return null;
  }
  return parts.join(':');
}

/**
 * 清理 Sidecar / MCP 子进程继承的宿主会话私有环境变量。
 *
 * @param {Record<string, string|undefined>} [baseEnv=process.env]
 * @returns {Record<string, string>}
 */
export function buildSanitizedDesktopRelaunchEnv(baseEnv = process.env) {
  const clean = {};
  for (const [key, val] of Object.entries(baseEnv || {})) {
    if (val === undefined || val === null) continue;
    if (
      /^(?:ANTIGRAVITY_|CHROME_DEVTOOLS_MCP_|USAGE_MONITOR_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|APPIMAGE$|APPDIR$|OWD$|ARGV0$|APPIMAGE_EXTRACT_AND_RUN$)/i.test(
        key
      )
    ) {
      continue;
    }
    if (key === 'LD_LIBRARY_PATH') {
      const cleanedLib = stripAppImageMountPathEntries(val, { omitIfEmpty: true });
      if (cleanedLib !== null) {
        clean[key] = cleanedLib;
      }
      continue;
    }
    if (key === 'PATH' && String(val).includes('/.mount_')) {
      const cleanedPath = stripAppImageMountPathEntries(val, { omitIfEmpty: false });
      if (cleanedPath) {
        clean[key] = cleanedPath;
      }
      continue;
    }
    clean[key] = String(val);
  }
  return clean;
}

/**
 * 只读定位本机 Antigravity Desktop（或 IDE）主程序路径。
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   existsFn?: (p: string) => boolean,
 * }} [options]
 * @returns {{ found: boolean, kind: 'desktop'|'ide'|'', executablePath: string, appBundlePath: string }}
 */
export function resolveDesktopHostExecutable({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  existsFn = existsSync,
} = {}) {
  const safeExists = (p) => {
    try {
      return Boolean(p && existsFn(p));
    } catch {
      return false;
    }
  };

  if (platform === 'linux') {
    const appImagePath = String(env?.APPIMAGE || '').trim();
    if (appImagePath && safeExists(appImagePath)) {
      const leaf = basename(appImagePath);
      if (isLinuxAntigravityDesktopLeaf(leaf)) {
        return { found: true, kind: 'desktop', executablePath: appImagePath, appBundlePath: '' };
      }
    }
  }

  const hintPaths = [
    String(env?.USAGE_MONITOR_HOST_EXE || '').trim(),
    String(env?.ANTIGRAVITY_AGENTAPI_EXE || '').trim(),
    String(env?.CHROME_DEVTOOLS_MCP_JS || '').trim(),
  ].filter(Boolean);

  for (const rawHint of hintPaths) {
    if (platform === 'darwin') {
      const appIdx = rawHint.toLowerCase().indexOf('.app/');
      const bundleCand =
        appIdx >= 0
          ? rawHint.slice(0, appIdx + 4)
          : rawHint.toLowerCase().endsWith('.app')
            ? rawHint
            : '';
      if (bundleCand && safeExists(bundleCand)) {
        const isIde = /antigravity\s*ide\.app$/i.test(bundleCand);
        const macBin = join(
          bundleCand,
          'Contents',
          'MacOS',
          isIde ? 'Antigravity IDE' : 'Antigravity'
        );
        return {
          found: true,
          kind: isIde ? 'ide' : 'desktop',
          executablePath: safeExists(macBin) ? macBin : bundleCand,
          appBundlePath: bundleCand,
        };
      }
    }

    if (platform === 'win32' && /\.exe$/i.test(rawHint) && !/language_server/i.test(rawHint)) {
      if (safeExists(rawHint)) {
        const isIde = /antigravity\s*ide\.exe$/i.test(rawHint);
        return {
          found: true,
          kind: isIde ? 'ide' : 'desktop',
          executablePath: rawHint,
          appBundlePath: '',
        };
      }
    }

    let cur = rawHint;
    for (let depth = 0; depth < 8 && cur && dirname(cur) !== cur; depth += 1) {
      const base = basename(cur).toLowerCase();
      if (base === 'resources') {
        const installRoot = dirname(cur);
        if (platform === 'win32') {
          const desktopExe = join(installRoot, 'Antigravity.exe');
          if (safeExists(desktopExe)) {
            return { found: true, kind: 'desktop', executablePath: desktopExe, appBundlePath: '' };
          }
          const ideExe = join(installRoot, 'Antigravity IDE.exe');
          if (safeExists(ideExe)) {
            return { found: true, kind: 'ide', executablePath: ideExe, appBundlePath: '' };
          }
        } else if (platform === 'linux') {
          for (const binName of ['antigravity', 'Antigravity']) {
            const linuxExe = join(installRoot, binName);
            if (safeExists(linuxExe) && !installRoot.startsWith('/tmp/.mount_')) {
              return { found: true, kind: 'desktop', executablePath: linuxExe, appBundlePath: '' };
            }
          }
        }
      }
      cur = dirname(cur);
    }
  }

  if (platform === 'win32') {
    const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    const programFiles = env?.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = String(env?.['ProgramFiles(x86)'] || '').trim();
    const winCandidates = [
      join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      join(programFiles, 'Antigravity', 'Antigravity.exe'),
      ...(programFilesX86 ? [join(programFilesX86, 'Antigravity', 'Antigravity.exe')] : []),
      join(localAppData, 'Antigravity', 'Antigravity.exe'),
    ];
    for (const cand of winCandidates) {
      if (safeExists(cand)) {
        return { found: true, kind: 'desktop', executablePath: cand, appBundlePath: '' };
      }
    }
  } else if (platform === 'darwin') {
    const macBundles = [
      join(homeDir, 'Applications', 'Antigravity.app'),
      '/Applications/Antigravity.app',
    ];
    for (const bundlePath of macBundles) {
      if (safeExists(bundlePath)) {
        const macBin = join(bundlePath, 'Contents', 'MacOS', 'Antigravity');
        return {
          found: true,
          kind: 'desktop',
          executablePath: safeExists(macBin) ? macBin : bundlePath,
          appBundlePath: bundlePath,
        };
      }
    }
  } else {
    const linuxCandidates = [
      '/opt/Antigravity/antigravity',
      '/opt/Antigravity/Antigravity',
      '/opt/antigravity/antigravity',
      '/usr/share/antigravity/antigravity',
      '/usr/bin/antigravity',
      '/usr/bin/google-antigravity',
      '/usr/local/bin/antigravity',
      join(homeDir, '.local', 'bin', 'antigravity'),
    ];
    for (const cand of linuxCandidates) {
      if (safeExists(cand)) {
        return { found: true, kind: 'desktop', executablePath: cand, appBundlePath: '' };
      }
    }
  }

  return { found: false, kind: '', executablePath: '', appBundlePath: '' };
}

/**
 * 纯内存只读检查单个 Windows `.lnk` 二进制 Buffer 是否指向 `Antigravity.exe` 及是否已包含调试端口参数。
 *
 * @param {Buffer} buf
 * @returns {{ matched: boolean, hasDebugPort: boolean }}
 */
export function inspectWindowsLnkBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32 || buf.length > 65536) {
    return { matched: false, hasDebugPort: false };
  }
  const ascii = buf.toString('latin1').toLowerCase();
  const utf16 = buf.toString('utf16le').toLowerCase();
  const hasIde = ascii.includes('antigravity ide.exe') || utf16.includes('antigravity ide.exe');
  if (hasIde) {
    return { matched: false, hasDebugPort: false };
  }
  const hasDesktopExe =
    ascii.includes('\\antigravity.exe') ||
    utf16.includes('\\antigravity.exe') ||
    ascii.includes('/antigravity.exe') ||
    utf16.includes('/antigravity.exe');
  if (!hasDesktopExe) {
    return { matched: false, hasDebugPort: false };
  }
  const hasDebugPort =
    ascii.includes('--remote-debugging-port') || utf16.includes('--remote-debugging-port');
  return { matched: true, hasDebugPort };
}

/**
 * 纯 Node.js 只读扫描快捷方式配置状态（不修改文件、不拉起子进程）。
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   homeDir?: string,
 *   extraDirs?: string[],
 *   fsOps?: {
 *     readdirFn?: typeof readdirSync,
 *     statFn?: typeof statSync,
 *     readFn?: typeof readFileSync,
 *   }|null,
 * }} [options]
 */
export function probeWindowsShortcutsFast({
  env = process.env,
  homeDir = homedir(),
  extraDirs = [],
  fsOps = null,
} = {}) {
  const readdirFn = fsOps?.readdirFn || readdirSync;
  const statFn = fsOps?.statFn || statSync;
  const readFn = fsOps?.readFn || readFileSync;

  const zhDesktop = '\u684C\u9762';
  const userProfile = String(env?.USERPROFILE || homeDir || '').trim();
  const appData = String(env?.APPDATA || (homeDir ? pathWin32.join(homeDir, 'AppData', 'Roaming') : '')).trim();
  const publicRoot = String(env?.PUBLIC || 'C:\\Users\\Public').trim();
  const programData = String(env?.ProgramData || 'C:\\ProgramData').trim();

  const flatDirs = [];
  if (Array.isArray(extraDirs)) {
    for (const d of extraDirs) {
      const clean = String(d || '').trim();
      if (clean) flatDirs.push(clean);
    }
  }
  if (userProfile) {
    flatDirs.push(pathWin32.join(userProfile, 'Desktop'), pathWin32.join(userProfile, zhDesktop));
  }
  for (const od of [env?.OneDrive, env?.OneDriveConsumer, env?.OneDriveCommercial]) {
    const cleanOd = String(od || '').trim();
    if (cleanOd) {
      flatDirs.push(pathWin32.join(cleanOd, 'Desktop'), pathWin32.join(cleanOd, zhDesktop));
    }
  }
  if (appData) {
    flatDirs.push(
      pathWin32.join(appData, 'Microsoft', 'Windows', 'Start Menu'),
      pathWin32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
      pathWin32.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
    );
  }
  if (publicRoot) {
    flatDirs.push(pathWin32.join(publicRoot, 'Desktop'), pathWin32.join(publicRoot, zhDesktop));
  }

  const programRoots = [];
  if (appData) {
    programRoots.push(pathWin32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  if (programData) {
    programRoots.push(pathWin32.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }

  const seenDirs = new Set();
  const candidateLnks = [];
  const seenLnks = new Set();

  const collectTopLevelLnks = (dirPath, expandVendorSubdirs = false) => {
    if (!dirPath) return;
    const normDir = dirPath.toLowerCase();
    if (seenDirs.has(normDir)) return;
    seenDirs.add(normDir);
    let entries = [];
    try {
      entries = readdirFn(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = String(ent?.name || '');
      if (!name) continue;
      if (ent.isFile?.() && name.toLowerCase().endsWith('.lnk')) {
        const full = pathWin32.join(dirPath, name);
        const key = full.toLowerCase();
        if (!seenLnks.has(key)) {
          seenLnks.add(key);
          candidateLnks.push(full);
        }
      } else if (
        expandVendorSubdirs &&
        ent.isDirectory?.() &&
        isWindowsVendorSubdirName(name)
      ) {
        collectTopLevelLnks(pathWin32.join(dirPath, name), false);
      }
    }
  };

  for (const d of flatDirs) collectTopLevelLnks(d, false);
  for (const p of programRoots) collectTopLevelLnks(p, true);

  const matchedPaths = [];
  const configuredPaths = [];
  const unconfiguredPaths = [];

  for (const lnkPath of candidateLnks) {
    try {
      const st = statFn(lnkPath);
      if (!st || st.size < 32 || st.size > 65536) continue;
      const buf = readFn(lnkPath);
      const res = inspectWindowsLnkBuffer(buf);
      if (!res.matched) continue;
      matchedPaths.push(lnkPath);
      if (res.hasDebugPort) {
        configuredPaths.push(lnkPath);
      } else {
        unconfiguredPaths.push(lnkPath);
      }
    } catch {
      // Ignore unreadable or malformed shortcut
    }
  }

  return {
    matchedPaths,
    configuredPaths,
    unconfiguredPaths,
    allConfigured: matchedPaths.length > 0 && unconfiguredPaths.length === 0,
  };
}

/**
 * Disabled in hardened fork: OS launcher/shortcut/registry/desktop entry provisioning is prohibited.
 *
 * @returns {Promise<{
 *   ok: false,
 *   supported: false,
 *   disabled: true,
 *   reason: 'disabled_in_hardened_fork',
 *   updatedPaths: [],
 *   configuredPaths: [],
 *   readOnlyPaths: [],
 *   discoveredDirs: [],
 * }>}
 */
export async function ensureDesktopLaunchEntriesConfigured() {
  return createDisabledLauncherResult();
}

/**
 * Disabled in hardened fork: PowerShell/UAC relaunch script generation is removed.
 *
 * @returns {string}
 */
export function buildWindowsRelaunchInnerScript() {
  return '';
}

/**
 * Disabled in hardened fork: automated host relaunch and UAC elevation are prohibited.
 *
 * @returns {Promise<{
 *   ok: false,
 *   supported: false,
 *   disabled: true,
 *   reason: 'disabled_in_hardened_fork',
 *   updatedPaths: [],
 *   configuredPaths: [],
 *   readOnlyPaths: [],
 *   discoveredDirs: [],
 * }>}
 */
export async function triggerDesktopHostRelaunch() {
  return createDisabledLauncherResult();
}
