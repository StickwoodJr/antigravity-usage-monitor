import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isAllowedMainFrameBindingEvent } from '../backend/prism-cdp-host.mjs';
import { sanitizeSecretText } from '../backend/redact.mjs';
import { OmniServer, isBlockedUncPath, isSensitiveFilePath } from '../prism/omni/omni-server.mjs';
import { createWallpaperService, validateWallpaperMediaPath } from '../prism/wallpaper/wallpaper-service.mjs';

test('redact.mjs redacts tokens, embedded basic-auth URLs, and secret query parameters', () => {
  const sample =
    'https://user:s3cr3t@example.com/a?token=abc123&safe=1 sk-proj1234567890 AIzaSyD123456789012345 Bearer mySecretJwtToken';
  const cleaned = sanitizeSecretText(sample);
  assert.doesNotMatch(cleaned, /s3cr3t/);
  assert.doesNotMatch(cleaned, /abc123/);
  assert.doesNotMatch(cleaned, /sk-proj1234567890/);
  assert.doesNotMatch(cleaned, /AIzaSyD123456789012345/);
  assert.doesNotMatch(cleaned, /mySecretJwtToken/);
  assert.match(cleaned, /safe=1/);
});

test('isAllowedMainFrameBindingEvent rejects sub-iframe or unknown executionContextIds', () => {
  const allowed = new Set([1, 4]);
  assert.equal(isAllowedMainFrameBindingEvent({ executionContextId: 1 }, 'main-frame', allowed), true);
  assert.equal(isAllowedMainFrameBindingEvent({ executionContextId: 2 }, 'main-frame', allowed), false);
  assert.equal(isAllowedMainFrameBindingEvent({}, 'main-frame', allowed), false);
  assert.equal(isAllowedMainFrameBindingEvent({ executionContextId: 1 }, 'main-frame', null), false);
});

test('OmniServer blocks sensitive credential files and UNC paths', async () => {
  assert.equal(isSensitiveFilePath('/home/user/.env'), true);
  assert.equal(isSensitiveFilePath('/home/user/.env.production'), true);
  assert.equal(isSensitiveFilePath('/home/user/.ssh/id_ed25519'), true);
  assert.equal(isSensitiveFilePath('/etc/shadow'), true);
  assert.equal(isSensitiveFilePath('/workspace/project/src/index.js'), false);
  assert.equal(isBlockedUncPath('\\\\evil-server\\share\\file.txt'), true);
  assert.equal(isBlockedUncPath('C:\\workspace\\notes.md'), false);

  const srv = new OmniServer({ port: 0 });
  assert.equal(srv.running, false);
  const res = await srv.handleRpcAction('resolvePath', { rawPath: '/home/user/.ssh/id_rsa' });
  assert.equal(res.isSensitive, true);
  const readRes = await srv.handleRpcAction('readTextSlice', { rawPath: '/home/user/.ssh/id_rsa' });
  assert.equal(readRes.ok, false);
  assert.equal(readRes.status, 403);
  assert.equal(srv.running, false, 'Blocked path resolution must not leave server running unnecessarily');
});

test('WallpaperService enforces safe media validation and stays stopped (0 ports) when disabled', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'ag-wp-sec-'));
  try {
    const svgPath = path.join(workDir, 'bad.svg');
    writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const svgCheck = validateWallpaperMediaPath(svgPath);
    assert.equal(svgCheck.ok, false);
    assert.equal(svgCheck.code, 'unsupported-extension');

    const pngPath = path.join(workDir, 'real.png');
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const symPath = path.join(workDir, 'link.png');
    symlinkSync(pngPath, symPath);
    const symCheck = validateWallpaperMediaPath(symPath);
    assert.equal(symCheck.ok, false);
    assert.equal(symCheck.code, 'symlink-not-allowed');

    const svc = createWallpaperService({ configPath: path.join(workDir, 'wallpaper.json') });
    const st = await svc.handleAction('status', {});
    assert.equal(st.ok, true);
    assert.equal(st.enabled, false);
    assert.equal(st.serverRunning, false, 'Wallpaper HTTP server must remain stopped when disabled');
    await svc.dispose();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
