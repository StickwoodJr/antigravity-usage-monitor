/**
 * Dev-only Offline Optical UI Preview Workbench (`npm run workbench`).
 * Serves sidecars/panel/styles.css and sidecars/panel/prism/style.css interactively across
 * Obsidian Dark, Warm Charcoal, Daylight Crystal, and Warm Alabaster themes + 5 accent tones.
 * Excluded from release ZIP bundles.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = path.resolve(SCRIPT_DIR, '..');
const PORT = Number.parseInt(process.env.PORT || '4177', 10) || 4177;

const MIME_MAP = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const WORKBENCH_HTML = `<!doctype html>
<html lang="en" data-ag-cs-style="1" data-ag-cs-theme="dark" data-ag-cs-palette="obsidian" data-ag-cs-light-preset="crystal" data-ag-cs-accent="follow" data-ag-cs-corners="balanced">
<head>
  <meta charset="utf-8" />
  <title>Obsidian Prism × Usage Monitor — Optical Preview Workbench</title>
  <link rel="stylesheet" href="/styles.css" />
  <link rel="stylesheet" href="/prism/style.css" />
  <style>
    body { margin: 0; padding: 20px; font-family: var(--font-sans, system-ui, sans-serif); background: var(--background, #0B0B0E); color: var(--foreground, #F2F2F5); }
    .wb-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px 16px; border-radius: var(--ag-cs-r-lg, 12px); border: 1px solid var(--ag-cs-border-1, rgba(255,255,255,.1)); background: var(--ag-cs-tonal-2, rgba(22,22,28,.8)); margin-bottom: 18px; }
    .wb-btn { height: 28px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--ag-cs-border-2, rgba(255,255,255,.14)); background: var(--ag-cs-pill-bg, rgba(255,255,255,.06)); color: var(--foreground); cursor: pointer; font-size: 12px; }
    .wb-btn[data-active="1"] { background: color-mix(in srgb, var(--primary, #669DF6) 24%, transparent); border-color: var(--primary, #669DF6); font-weight: 600; }
    .wb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
    .wb-card { padding: 16px; border-radius: var(--ag-cs-r-lg, 12px); border: 1px solid var(--card-border, rgba(255,255,255,.1)); background: var(--card, #141418); }
  </style>
</head>
<body>
  <div class="wb-bar">
    <strong>Obsidian Prism Optical Workbench</strong>
    <button class="wb-btn" data-theme="dark" data-palette="obsidian" data-light="crystal" data-active="1">Obsidian Dark</button>
    <button class="wb-btn" data-theme="dark" data-palette="warm" data-light="crystal">Warm Charcoal</button>
    <button class="wb-btn" data-theme="light" data-palette="obsidian" data-light="crystal">Daylight Crystal</button>
    <button class="wb-btn" data-theme="light" data-palette="warm" data-light="alabaster">Warm Alabaster</button>
    <span style="opacity:.4">|</span>
    <button class="wb-btn" data-accent="follow" data-active="1">Follow</button>
    <button class="wb-btn" data-accent="cobalt">Cobalt</button>
    <button class="wb-btn" data-accent="iris">Iris</button>
    <button class="wb-btn" data-accent="amber">Amber</button>
    <button class="wb-btn" data-accent="mono">Mono</button>
  </div>
  <div class="wb-grid">
    <div class="wb-card">
      <h3>Home-Screen Studio Preview</h3>
      <p style="color:var(--muted-foreground);font-size:12.5px">Live CSS variables verified across Usage Monitor &amp; Host surfaces.</p>
      <div class="ag-cs-home-stat" style="margin-top:10px;padding:12px;border-radius:var(--ag-cs-r-md);border:1px solid var(--border)">
        <div class="ag-cs-home-stat-label">TOTAL TOKENS</div>
        <div class="ag-cs-home-stat-value" style="font-size:24px;font-weight:600">12.4M</div>
      </div>
    </div>
    <div class="wb-card">
      <h3>Quota Depletion Pace Preview</h3>
      <div class="quota-pool-card" style="margin-top:10px;padding:12px;border-radius:var(--ag-cs-r-md);border:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span>Gemini Pool (5h + Weekly)</span>
          <span style="color:var(--success,#50A37B);font-size:12px;font-weight:600">Healthy</span>
        </div>
      </div>
    </div>
  </div>
  <script>
    const html = document.documentElement;
    document.querySelectorAll('[data-theme]').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('[data-theme]').forEach((x) => x.removeAttribute('data-active'));
        b.setAttribute('data-active', '1');
        html.setAttribute('data-ag-cs-theme', b.dataset.theme);
        html.setAttribute('data-ag-cs-palette', b.dataset.palette);
        html.setAttribute('data-ag-cs-light-preset', b.dataset.light);
        html.setAttribute('data-theme', b.dataset.theme);
        html.setAttribute('data-ag-prism-palette', b.dataset.palette);
      });
    });
    document.querySelectorAll('[data-accent]').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('[data-accent]').forEach((x) => x.removeAttribute('data-active'));
        b.setAttribute('data-active', '1');
        html.setAttribute('data-ag-cs-accent', b.dataset.accent);
        html.setAttribute('data-ag-prism-accent', b.dataset.accent);
      });
    });
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/' || urlPath === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(WORKBENCH_HTML);
    return;
  }
  const rel = urlPath.replace(/^\/+/, '');
  if (rel.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const target = path.resolve(PANEL_DIR, rel);
  if (!target.startsWith(PANEL_DIR) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(target).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Obsidian Prism offline workbench listening at http://127.0.0.1:${PORT}/`);
});
