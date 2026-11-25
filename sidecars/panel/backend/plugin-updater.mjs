/**
 * @fileoverview 云端价格表同步与插件双通道更新器（Git Fast-Forward / Release ZIP 覆盖）。
 *
 * 核心能力与多重防御不变量：
 * 1. `syncCloudCatalog`：定期或手动从 GitHub 主干拉取最新 `pricing-catalog.json`，
 *    经 Schema 与可信域名白名单清洗后落盘至 `DATA_DIR/remote_pricing_cache.json` 并热更新内存价格字典；
 * 2. `performPluginUpdate` 严格执行以下防降级与防损坏门禁：
 *    - 开发仓库自动更新隔离：非 `.gemini/config/plugins/` 目录一律禁止后台自动更新（`dev_repo_auto_disabled`），
 *      且若手动更新撞上正在进行的后台自动检查，等待自动检查结束后再执行手动更新；
 *    - 全量工作区干净度门禁（含未跟踪文件）：执行 `git status --porcelain`（不带 `--untracked-files=no`），
 *      只要存在任何已修改或未跟踪文件（`??`），立即终止（`dirty_worktree`），绝不执行 `git stash`；
 *    - 分支门禁：仅允许 `main` 或 `release/*` 发布分支执行快进更新（`not_on_main_branch`），防止污染特性分支或游离 HEAD；
 *    - 强制远端版本门禁（Git 通道）：必须且只能从 `git show origin/<branch>:plugin.json` 解析出合法 SemVer，
 *      严禁回退使用缓存的 `cloudSyncState.latestPluginVersion`；仅当 `remoteVersion > previousVersion` 时才继续；
 *    - 提交拓扑与核心文件门禁：通过 `git merge-base --is-ancestor HEAD origin/<branch>` 确认本地无分叉提交（`diverged_worktree`）；
 *    - ZIP 通道安全覆盖与多余旧文件裁剪：覆盖前备份关键文件，覆盖后清理新版已删除的旧源码文件，异常回滚时同步删除残留新文件。
 */

import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  CLOUD_CATALOG_URLS,
  CLOUD_SYNC_RETRY_COOLDOWN_MS,
  CLOUD_SYNC_TTL_MS,
  DATA_DIR,
  DEFAULT_DOWNLOAD_URL,
  LEGACY_GITHUB_REPOS,
  LS_ADDR,
  OFFICIAL_GITHUB_REPO,
  PLUGIN_ROOT,
  REMOTE_CATALOG_CACHE_FILE,
  cloudSyncState,
  loadJson,
  lsRuntimeEndpoint,
  pluginUpdateState,
  saveJson,
} from './config.mjs';
import {
  compareSemver,
  getCloudStatus,
  isValidSemver,
  readInstalledPluginVersion,
  rebuildActiveCatalog,
  sanitizeCatalogPayload,
} from './pricing-catalog.mjs';

/**
 * 以 Promise 形式安全执行外部子进程命令（默认隐藏 Windows 控制台窗口并设置 25 秒超时）。
 *
 * @param {string} cmd 可执行文件名
 * @param {string[]} args 参数列表
 * @param {object} [opts] `execFile` 附加选项
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runExecFile(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (typeof execFile !== 'function') {
      reject(new Error('execFile unavailable in current environment'));
      return;
    }
    execFile(cmd, args, { windowsHide: true, timeout: 25000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message || '').trim();
        reject(new Error(detail || err.message));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

let customSidecarRestartHandler = null;

/**
 * 注册自定义运行时热重载回调（例如 `main.mjs` 的 `Worker` 热替换或 `bridge-daemon.mjs` 的平滑退出），
 * 避免直接调用 `process.exit(0)` 导致宿主 `SidecarApp` 固定端口失联。
 *
 * @param {(() => void)|null} handler
 */
export function setSidecarRestartHandler(handler) {
  customSidecarRestartHandler = typeof handler === 'function' ? handler : null;
}

/**
 * 更新完成后调度 Sidecar 运行时热重载（若未注册自定义处理器，则回退平滑退出供父监督器拉起）。
 * 在单元测试环境（`!LS_ADDR || LS_ADDR === 'test.invalid'`）下自动跳过。
 *
 * @param {number} [delayMs=350] 延迟毫秒数，确保当前 HTTP 响应先发回前端
 */
export function scheduleSidecarRestart(delayMs = 350) {
  const activeAddr = lsRuntimeEndpoint.addr || LS_ADDR;
  if (!activeAddr || activeAddr === 'test.invalid') return;
  if (typeof customSidecarRestartHandler === 'function') {
    const fn = customSidecarRestartHandler;
    setTimeout(() => {
      try {
        fn();
      } catch {
        // 忽略自定义热重载回调异常
      }
    }, delayMs);
    return;
  }
  if (typeof process?.exit !== 'function') return;
  setTimeout(() => {
    try {
      process.exit(0);
    } catch {
      // 忽略退出异常
    }
  }, delayMs);
}

/**
 * 在解压后的临时目录中定位包含 `plugin.json` 的插件根目录（兼容顶层平铺或单层子目录包装）。
 *
 * @param {string} extractDir 解压目标目录
 * @returns {string|null}
 */
function locateExtractedPluginRoot(extractDir) {
  if (existsSync(join(extractDir, 'plugin.json'))) return extractDir;
  try {
    for (const name of readdirSync(extractDir)) {
      const sub = join(extractDir, name);
      if (existsSync(join(sub, 'plugin.json'))) {
        return sub;
      }
    }
  } catch {
    // 忽略目录读取错误
  }
  return null;
}

/**
 * `cpSync` 安全过滤函数：严格禁止覆盖 `.git`、`.data`、`node_modules`、`plan` 或临时更新目录。
 *
 * @param {string} srcPath
 * @returns {boolean}
 */
function isSafeCopyPath(srcPath) {
  const name = basename(String(srcPath || '')).toLowerCase();
  if (
    name === '.git' ||
    name === '.data' ||
    name === 'node_modules' ||
    name === 'plan' ||
    name.startsWith('.update-staging-')
  ) {
    return false;
  }
  return true;
}

/**
 * 递归清理 `targetDir` 中在 `referenceDir` 已不存在的多余文件/目录（保护 `.git`/`.data`/`node_modules`/`plan`）。
 * 用于 ZIP 升级后清理旧版废弃源码文件，以及在覆盖中途异常回滚时清除半途写入的新增文件。
 *
 * @param {string} targetDir
 * @param {string} referenceDir
 */
function pruneExtraneousFiles(targetDir, referenceDir) {
  if (!existsSync(targetDir) || !existsSync(referenceDir)) return;
  let names = [];
  try {
    names = readdirSync(targetDir);
  } catch {
    return;
  }
  for (const name of names) {
    const targetChild = join(targetDir, name);
    if (!isSafeCopyPath(targetChild)) continue;
    const refChild = join(referenceDir, name);
    if (!existsSync(refChild)) {
      try {
        rmSync(targetChild, { recursive: true, force: true });
      } catch {
        // 忽略单项删除异常
      }
    } else {
      pruneExtraneousFiles(targetChild, refChild);
    }
  }
}

/**
 * 若本地 Git 仓库的 `origin` 仍指向已迁移的旧官方仓库地址，返回同协议的新官方仓库地址；
 * 对于非旧官方仓库（如已是新地址或用户自建 Fork）返回空字符串，不做改动。
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function resolveMigratedGitRemoteUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  for (const legacyRepo of LEGACY_GITHUB_REPOS) {
    const escaped = legacyRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^https://github\\.com/${escaped}(?:\\.git)?/?$`, 'i').test(trimmed)) {
      return `https://github.com/${OFFICIAL_GITHUB_REPO}.git`;
    }
    if (new RegExp(`^git@github\\.com:${escaped}(?:\\.git)?/?$`, 'i').test(trimmed)) {
      return `git@github.com:${OFFICIAL_GITHUB_REPO}.git`;
    }
    if (new RegExp(`^ssh://git@github\\.com/${escaped}(?:\\.git)?/?$`, 'i').test(trimmed)) {
      return `ssh://git@github.com/${OFFICIAL_GITHUB_REPO}.git`;
    }
  }
  return '';
}

/**
 * 在真实运行环境下对目标目录的核心 JS 文件执行 `node --check` 语法预检。
 *
 * @param {string} rootDir 插件根目录或解压目录
 */
async function verifyPluginJsSyntax(rootDir) {
  const activeAddr = lsRuntimeEndpoint.addr || LS_ADDR;
  if (!activeAddr || activeAddr === 'test.invalid') return;
  const nodeBin = process?.execPath || 'node';
  const filesToCheck = [
    join(rootDir, 'sidecars', 'panel', 'main.mjs'),
    join(rootDir, 'sidecars', 'panel', 'bridge-daemon.mjs'),
    join(rootDir, 'sidecars', 'panel', 'mcp-entry.mjs'),
    join(rootDir, 'sidecars', 'panel', 'app.js'),
  ];
  for (const file of filesToCheck) {
    if (existsSync(file)) {
      await runExecFile(nodeBin, ['--check', file]);
    }
  }
}

/**
 * 解析 `.sha256` 校验文本（支持 `<hex>  <filename>`、`<hex> *<filename>` 或纯 `<hex>`），
 * 返回小写 64 位十六进制摘要；格式不合法时返回 `null`。
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function parseSha256ChecksumText(text) {
  if (typeof text !== 'string') return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return null;
  const match = lines[0].match(/^([0-9a-fA-F]{64})(?:[ \t]+\*?(.+))?$/);
  return match ? match[1].toLowerCase() : null;
}

function safeHexDigestEqual(actualHex, expectedHex) {
  const actualBuf = Buffer.from(actualHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== 32 || expectedBuf.length !== 32) return false;
  if (typeof timingSafeEqual === 'function') {
    return timingSafeEqual(actualBuf, expectedBuf);
  }
  let diff = 0;
  for (let i = 0; i < 32; i += 1) {
    diff |= actualBuf[i] ^ expectedBuf[i];
  }
  return diff === 0;
}

/**
 * 校验更新包 Buffer 的 SHA-256 摘要是否与 `.sha256` 文本完全一致。
 *
 * @param {Buffer|Uint8Array} buf
 * @param {unknown} checksumText
 * @returns {{ ok: boolean, reason?: string, expected: string|null, actual: string|null }}
 */
export function verifyZipSha256(buf, checksumText) {
  if (!buf || (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array))) {
    return { ok: false, reason: 'invalid_buffer', expected: null, actual: null };
  }
  const expected = parseSha256ChecksumText(checksumText);
  if (!expected) {
    return { ok: false, reason: 'malformed_sha256', expected: null, actual: null };
  }
  const actual = createHash('sha256').update(buf).digest('hex');
  const matched = safeHexDigestEqual(actual, expected);
  return matched
    ? { ok: true, expected, actual }
    : { ok: false, reason: 'sha256_mismatch', expected, actual };
}

function isUnsafeZipEntryName(entryName) {
  if (!entryName || entryName.includes('\0')) return true;
  if (/^[\\/]/.test(entryName)) return true;
  if (/^[A-Za-z]:/.test(entryName)) return true;
  const segments = entryName.split(/[/\\]/);
  return segments.includes('..');
}

/**
 * 纯 Node.js 解析 PKZIP End-of-Central-Directory (0x06054b50) 与 Central Directory (0x02014b50)，
 * 拦截缺少中央目录、Zip Slip 路径穿越、绝对路径、盘符、NUL 字节以及 Unix 符号链接条目。
 *
 * @param {Buffer} buf
 * @returns {{ ok: boolean, reason?: string, entryName?: string, entryCount?: number, entries?: string[] }}
 */
export function validateZipEntriesSafe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    return { ok: false, reason: 'invalid_zip_buffer' };
  }

  const minOffset = Math.max(0, buf.length - 22 - 65535);
  let eocdOffset = -1;
  for (let off = buf.length - 22; off >= minOffset; off -= 1) {
    if (buf.readUInt32LE(off) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(off + 20);
      if (off + 22 + commentLen === buf.length) {
        eocdOffset = off;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    return { ok: false, reason: 'missing_eocd' };
  }

  const diskNumber = buf.readUInt16LE(eocdOffset + 4);
  const cdDiskNumber = buf.readUInt16LE(eocdOffset + 6);
  const diskEntries = buf.readUInt16LE(eocdOffset + 8);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (
    diskNumber !== 0 ||
    cdDiskNumber !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0 ||
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    cdOffset + cdSize > eocdOffset
  ) {
    return { ok: false, reason: 'invalid_central_directory' };
  }

  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  const entries = [];

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > cdEnd || buf.readUInt32LE(cursor) !== 0x02014b50) {
      return { ok: false, reason: 'invalid_central_directory' };
    }
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const externalAttr = buf.readUInt32LE(cursor + 38);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    if (cursor + 46 + nameLen + extraLen + commentLen > cdEnd) {
      return { ok: false, reason: 'truncated_central_directory' };
    }

    const entryName = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    if (isUnsafeZipEntryName(entryName)) {
      return { ok: false, reason: 'unsafe_zip_entry_path', entryName };
    }

    if (((externalAttr >>> 16) & 0o170000) === 0o120000) {
      return { ok: false, reason: 'symlink_entry_forbidden', entryName };
    }

    if (localHeaderOffset + 30 > cdOffset || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      return { ok: false, reason: 'invalid_local_header', entryName };
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    if (localHeaderOffset + 30 + localNameLen > cdOffset) {
      return { ok: false, reason: 'invalid_local_header', entryName };
    }
    const localName = buf
      .subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLen)
      .toString('utf8');
    if (isUnsafeZipEntryName(localName) || localName !== entryName) {
      return { ok: false, reason: 'unsafe_zip_entry_path', entryName: localName || entryName };
    }

    entries.push(entryName);
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  if (cursor !== cdEnd) {
    return { ok: false, reason: 'invalid_central_directory' };
  }

  return { ok: true, entryCount: totalEntries, entries };
}

/**
 * 执行插件本体更新（仅支持手动更新，已禁用后台自动更新）。
 *
 * @param {{ isAuto?: boolean }} [options]
 * @returns {Promise<object>} 更新结果对象
 */
export async function performPluginUpdate({ isAuto = false } = {}) {
  if (isAuto) {
    const previousVersion = readInstalledPluginVersion();
    const result = {
      ok: false,
      skipped: true,
      reason: 'auto_update_disabled_in_hardened_fork',
      previousVersion,
      currentVersion: previousVersion,
      message: 'Background auto-updates are disabled; please use manual update',
      updatedAtMs: Date.now(),
    };
    pluginUpdateState.lastResult = result;
    return result;
  }

  if (pluginUpdateState.inFlight) {
    return pluginUpdateState.inFlight;
  }

  pluginUpdateState.inFlightIsAuto = false;
  pluginUpdateState.inFlight = (async () => {
    pluginUpdateState.isUpdating = true;
    pluginUpdateState.lastError = null;
    const previousVersion = readInstalledPluginVersion();
    const hasGit = existsSync(join(PLUGIN_ROOT, '.git'));
    const normalizedRoot = PLUGIN_ROOT.replace(/\\/g, '/').toLowerCase();
    const isInstalledPluginDir = normalizedRoot.includes('/.gemini/config/plugins/');

    try {
      if (hasGit) {
        // 0. 开发仓库（非 ~/.gemini/config/plugins/）一律禁止后台自动更新
        if (isAuto && !isInstalledPluginDir) {
          const msg = 'Local dev repository detected; background silent update is disabled';
          const result = {
            ok: false,
            skipped: true,
            mode: 'git',
            reason: 'dev_repo_auto_disabled',
            previousVersion,
            currentVersion: previousVersion,
            message: msg,
            updatedAtMs: Date.now(),
          };
          pluginUpdateState.lastResult = result;
          return result;
        }

        // 1. 全量工作区检查（包含未跟踪文件 ??）：只要存在任何未提交改动或新增未跟踪文件，立即中止
        const statusRes = await runExecFile('git', ['-C', PLUGIN_ROOT, 'status', '--porcelain']);
        const isDirty = statusRes.stdout.trim().length > 0;
        if (isDirty) {
          const msg = isInstalledPluginDir
            ? 'Local files have modifications; update skipped'
            : 'Development directory has uncommitted changes; update skipped';
          pluginUpdateState.lastError = isAuto ? null : msg;
          pluginUpdateState.lastResult = {
            ok: false,
            skipped: true,
            mode: 'git',
            reason: 'dirty_worktree',
            previousVersion,
            currentVersion: previousVersion,
            message: msg,
            updatedAtMs: Date.now(),
          };
          return pluginUpdateState.lastResult;
        }

        // 2. 分支检查：仅当处于 main 或 release/* 发布分支时才允许快进拉取，防止污染特性分支或游离 HEAD
        const branchRes = await runExecFile('git', [
          '-C',
          PLUGIN_ROOT,
          'rev-parse',
          '--abbrev-ref',
          'HEAD',
        ]);
        const currentBranch = branchRes.stdout.trim();
        const isAllowedBranch =
          !currentBranch ||
          currentBranch === 'main' ||
          /^release\/[0-9A-Za-z._-]+$/.test(currentBranch);
        if (!isAllowedBranch) {
          const msg = `Current branch is ${currentBranch}; update skipped`;
          pluginUpdateState.lastError = isAuto ? null : msg;
          pluginUpdateState.lastResult = {
            ok: false,
            skipped: true,
            mode: 'git',
            reason: 'not_on_main_branch',
            branch: currentBranch,
            previousVersion,
            currentVersion: previousVersion,
            message: msg,
            updatedAtMs: Date.now(),
          };
          return pluginUpdateState.lastResult;
        }

        const targetBranch = currentBranch || 'main';
        const remoteRef = `origin/${targetBranch}`;

        // 3. 存量旧仓库远程地址平滑迁移：若 origin 仍指向已更换的旧官方仓库，自动切换至新仓库地址
        try {
          const remoteUrlRes = await runExecFile('git', [
            '-C',
            PLUGIN_ROOT,
            'remote',
            'get-url',
            'origin',
          ]);
          const migratedRemoteUrl = resolveMigratedGitRemoteUrl(remoteUrlRes.stdout);
          if (migratedRemoteUrl) {
            await runExecFile('git', [
              '-C',
              PLUGIN_ROOT,
              'remote',
              'set-url',
              'origin',
              migratedRemoteUrl,
            ]);
          }
        } catch {
          // 忽略非标准 remote 配置异常，不阻断常规拉取
        }

        // 4. 只读拉取远端分支引用，并严格从 origin/<branch>:plugin.json 读取远端版本号（严禁回退使用缓存版本）
        await runExecFile('git', ['-C', PLUGIN_ROOT, 'fetch', 'origin', targetBranch, '--tags']);

        let remoteVersion = '';
        try {
          const showRes = await runExecFile('git', [
            '-C',
            PLUGIN_ROOT,
            'show',
            `${remoteRef}:plugin.json`,
          ]);
          const parsedManifest = JSON.parse(showRes.stdout || '{}');
          const rawVer =
            typeof parsedManifest?.version === 'string' ? parsedManifest.version.trim() : '';
          if (isValidSemver(rawVer)) {
            remoteVersion = rawVer.replace(/^v/i, '');
          }
        } catch {
          remoteVersion = '';
        }

        // 5. 强制版本门禁：远端版本无法确认或不高于当前版本时，严禁执行 git pull 降级/覆盖
        if (!remoteVersion || compareSemver(remoteVersion, previousVersion) <= 0) {
          const msg = `Already up to date (v${previousVersion})`;
          const result = {
            ok: false,
            skipped: true,
            upToDate: true,
            mode: 'git',
            reason: 'already_up_to_date',
            previousVersion,
            currentVersion: previousVersion,
            remoteVersion: remoteVersion || previousVersion,
            message: msg,
            updatedAtMs: Date.now(),
          };
          pluginUpdateState.lastResult = result;
          return result;
        }

        // 6. 提交拓扑预检：确保当前 HEAD 是远端分支的祖先提交（无本地超前或分叉提交）
        try {
          await runExecFile('git', [
            '-C',
            PLUGIN_ROOT,
            'merge-base',
            '--is-ancestor',
            'HEAD',
            remoteRef,
          ]);
        } catch {
          const msg = 'Local branch has unpushed commits; update skipped';
          pluginUpdateState.lastError = isAuto ? null : msg;
          pluginUpdateState.lastResult = {
            ok: false,
            skipped: true,
            mode: 'git',
            reason: 'diverged_worktree',
            previousVersion,
            currentVersion: previousVersion,
            message: msg,
            updatedAtMs: Date.now(),
          };
          return pluginUpdateState.lastResult;
        }

        // 7. 确认全部门禁通过后，执行快进合并并校验 JS 语法
        await runExecFile('git', ['-C', PLUGIN_ROOT, 'pull', '--ff-only', 'origin', targetBranch]);
        await verifyPluginJsSyntax(PLUGIN_ROOT);
        rebuildActiveCatalog();
        const currentVersion = readInstalledPluginVersion();
        const result = {
          ok: true,
          mode: 'git',
          previousVersion,
          currentVersion,
          restarting: true,
          message: `Upgraded to v${currentVersion}; restarting panel…`,
          updatedAtMs: Date.now(),
        };
        pluginUpdateState.lastResult = result;
        scheduleSidecarRestart();
        return result;
      }

      // Release ZIP 归档更新通道（适用于无 .git 的压缩包安装目录）
      const targetVersion = cloudSyncState.latestPluginVersion || '';
      if (!isValidSemver(targetVersion) || compareSemver(targetVersion, previousVersion) <= 0) {
        const msg = `Already up to date (v${previousVersion})`;
        const result = {
          ok: false,
          skipped: true,
          upToDate: true,
          mode: 'zip',
          reason: 'already_up_to_date',
          previousVersion,
          currentVersion: previousVersion,
          remoteVersion: targetVersion || previousVersion,
          message: msg,
          updatedAtMs: Date.now(),
        };
        pluginUpdateState.lastResult = result;
        return result;
      }

      const zipUrl = cloudSyncState.downloadUrl || DEFAULT_DOWNLOAD_URL;
      if (!zipUrl) {
        throw new Error('No valid update download URL configured');
      }

      const stagingDir = join(DATA_DIR, `.update-staging-${Date.now()}`);
      const zipFile = join(stagingDir, 'bundle.zip');
      const extractDir = join(stagingDir, 'extracted');
      const backupDir = join(stagingDir, 'backup');
      try {
        mkdirSync(extractDir, { recursive: true });
        const res = await fetch(zipUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(25000),
        });
        if (!res.ok || (res.status !== undefined && res.status !== 200)) {
          throw new Error(`Failed to download update package (HTTP ${res.status ?? 'unknown'})`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        // 校验 ZIP 文件头魔数 ('PK') 与最小合法体积
        if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
          throw new Error('Downloaded update package failed format check');
        }

        // 强制 SHA-256 校验：必须存在且成功返回 HTTP 200 的 .sha256 校验文件
        const shaUrl = `${zipUrl}.sha256`;
        const shaRes = await fetch(shaUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        });
        if (!shaRes.ok || (shaRes.status !== undefined && shaRes.status !== 200)) {
          throw new Error(`Failed to download SHA-256 checksum (HTTP ${shaRes.status ?? 'unknown'})`);
        }
        const shaText = await shaRes.text();
        const shaCheck = verifyZipSha256(buf, shaText);
        if (!shaCheck.ok) {
          throw new Error(
            shaCheck.reason === 'malformed_sha256'
              ? 'Update package SHA-256 checksum file is malformed'
              : 'Update package SHA-256 mismatch; update rejected'
          );
        }

        // 解压前强制校验 PKZIP Central Directory，防止 Zip Slip 路径穿越与符号链接攻击
        const zipSafety = validateZipEntriesSafe(buf);
        if (!zipSafety.ok) {
          throw new Error(`Update package entry safety check failed (${zipSafety.reason})`);
        }

        writeFileSync(zipFile, buf);

        if (process.platform === 'win32') {
          await runExecFile('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipFile.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`,
          ]);
        } else {
          await runExecFile('unzip', ['-oq', zipFile, '-d', extractDir]);
        }

        const extractedRoot = locateExtractedPluginRoot(extractDir);
        if (
          !extractedRoot ||
          !existsSync(join(extractedRoot, 'sidecars', 'panel', 'main.mjs')) ||
          !existsSync(join(extractedRoot, 'sidecars', 'panel', 'app.js')) ||
          !existsSync(join(extractedRoot, 'sidecars', 'panel', 'styles.css')) ||
          !existsSync(join(extractedRoot, 'sidecars', 'panel', 'index.html'))
        ) {
          throw new Error('Update package is missing core plugin files');
        }

        const extractedManifest = loadJson(join(extractedRoot, 'plugin.json'), null);
        const rawExtractedVer =
          typeof extractedManifest?.version === 'string'
            ? extractedManifest.version.trim()
            : '';
        const extractedVer = isValidSemver(rawExtractedVer)
          ? rawExtractedVer.replace(/^v/i, '')
          : '';
        if (!extractedVer || compareSemver(extractedVer, previousVersion) <= 0) {
          throw new Error(
            `Downloaded version (v${extractedVer || 'unknown'}) is not newer than installed version (v${previousVersion}); downgrade rejected`
          );
        }

        // 覆盖前先对解压目录执行 JS 语法预检，防止损坏代码覆盖现有安装
        await verifyPluginJsSyntax(extractedRoot);

        // 备份当前插件根目录关键文件，覆盖后清理已废弃旧文件；若覆盖途中异常则完整回滚并移除残留新文件
        mkdirSync(backupDir, { recursive: true });
        cpSync(PLUGIN_ROOT, backupDir, { recursive: true, force: true, filter: isSafeCopyPath });
        try {
          cpSync(extractedRoot, PLUGIN_ROOT, {
            recursive: true,
            force: true,
            filter: isSafeCopyPath,
          });
          pruneExtraneousFiles(PLUGIN_ROOT, extractedRoot);
        } catch (copyErr) {
          try {
            cpSync(backupDir, PLUGIN_ROOT, {
              recursive: true,
              force: true,
              filter: isSafeCopyPath,
            });
            pruneExtraneousFiles(PLUGIN_ROOT, backupDir);
          } catch {
            // 忽略回滚二级异常
          }
          throw copyErr;
        }

        try {
          rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // 忽略临时目录清理错误
        }

        rebuildActiveCatalog();
        const currentVersion = readInstalledPluginVersion();
        const result = {
          ok: true,
          mode: 'zip',
          previousVersion,
          currentVersion,
          restarting: true,
          message: `Downloaded and updated to v${currentVersion}; reloading panel…`,
          updatedAtMs: Date.now(),
        };
        pluginUpdateState.lastResult = result;
        scheduleSidecarRestart();
        return result;
      } catch (err) {
        try {
          rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // 忽略临时目录清理错误
        }
        throw err;
      }
    } catch (err) {
      const errMsg = err?.message || 'Plugin update failed';
      pluginUpdateState.lastError = errMsg;
      const result = {
        ok: false,
        mode: hasGit ? 'git' : 'zip',
        previousVersion,
        currentVersion: readInstalledPluginVersion(),
        message: errMsg,
        updatedAtMs: Date.now(),
      };
      pluginUpdateState.lastResult = result;
      return result;
    } finally {
      pluginUpdateState.isUpdating = false;
      pluginUpdateState.inFlightIsAuto = false;
      pluginUpdateState.inFlight = null;
    }
  })();
  return pluginUpdateState.inFlight;
}

/**
 * 同步云端 `pricing-catalog.json` 目录（加固分支绝不触发后台自动更新）。
 *
 * @param {{ force?: boolean, urls?: string[] }} [options]
 * @returns {Promise<ReturnType<typeof getCloudStatus>>}
 */
export async function syncCloudCatalog({ force = false, urls = CLOUD_CATALOG_URLS } = {}) {
  if (cloudSyncState.inFlight) return cloudSyncState.inFlight;
  const now = Date.now();
  if (!force) {
    if (cloudSyncState.fetchedAtMs > 0 && now - cloudSyncState.fetchedAtMs < CLOUD_SYNC_TTL_MS) {
      return getCloudStatus();
    }
    if (
      cloudSyncState.lastAttemptMs > 0 &&
      now - cloudSyncState.lastAttemptMs < CLOUD_SYNC_RETRY_COOLDOWN_MS
    ) {
      return getCloudStatus();
    }
  }

  cloudSyncState.inFlight = (async () => {
    cloudSyncState.isSyncing = true;
    cloudSyncState.lastAttemptMs = Date.now();
    let lastErr = null;
    try {
      for (const url of urls) {
        try {
          const sep = url.includes('?') ? '&' : '?';
          const reqUrl = force ? `${url}${sep}_t=${Date.now()}` : url;
          const res = await fetch(reqUrl, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'Cache-Control': 'no-cache',
            },
            signal: AbortSignal.timeout(4500),
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const raw = await res.json();
          const sanitized = sanitizeCatalogPayload(raw);
          if (!sanitized) {
            throw new Error('Invalid cloud catalog schema');
          }
          const persisted = {
            ...sanitized,
            fetchedAtMs: Date.now(),
            sourceUrl: url,
          };
          saveJson(REMOTE_CATALOG_CACHE_FILE, persisted);
          cloudSyncState.fetchedAtMs = persisted.fetchedAtMs;
          cloudSyncState.sourceUrl = url;
          cloudSyncState.lastError = null;
          rebuildActiveCatalog();
          return getCloudStatus();
        } catch (err) {
          lastErr = err;
        }
      }
      cloudSyncState.lastError = lastErr?.message || 'Cloud pricing catalog sync failed';
      return getCloudStatus();
    } finally {
      cloudSyncState.isSyncing = false;
      cloudSyncState.inFlight = null;
    }
  })();

  return cloudSyncState.inFlight;
}
