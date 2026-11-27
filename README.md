<div align="center">

<img src="assets/logo.svg" alt="Antigravity Usage & Speed Monitor Logo" width="84" />

# Antigravity Usage & Speed Monitor

Local usage, speed, context, and quota monitor for Google Antigravity 2.0, Antigravity IDE, and Antigravity CLI, with no external npm dependencies.

[![Release](https://img.shields.io/github/v/release/StickwoodJr/antigravity-usage-monitor?style=flat-square&color=2A5E76&label=release)](https://github.com/StickwoodJr/antigravity-usage-monitor/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/StickwoodJr/antigravity-usage-monitor/total?style=flat-square&color=0ea5e9)](https://github.com/StickwoodJr/antigravity-usage-monitor/releases)
[![Stars](https://img.shields.io/github/stars/StickwoodJr/antigravity-usage-monitor?style=flat-square&color=f59e0b)](https://github.com/StickwoodJr/antigravity-usage-monitor/stargazers)
[![License](https://img.shields.io/github/license/StickwoodJr/antigravity-usage-monitor?style=flat-square&color=3b82f6)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm%20packages-10b981?style=flat-square)](#local-development)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-6366f1?style=flat-square)](#client-support)

English · [简体中文](README.zh-CN.md)

[Security Hardening](#hardened-security-fork) · [Features](#features) · [Screenshots](#screenshots) · [Client Support](#client-support) · [Installation](#installation) · [Usage](#usage) · [Development](#local-development)

<br />

<img src="assets/preview.png" alt="Antigravity Usage Monitor Preview" width="100%" />

<br />

[Latest Release](https://github.com/StickwoodJr/antigravity-usage-monitor/releases/latest) · [Download ZIP (`usage-monitor.zip`)](https://github.com/StickwoodJr/antigravity-usage-monitor/releases/latest/download/usage-monitor.zip)

</div>

---

## Hardened Security Fork

This repository (`StickwoodJr/antigravity-usage-monitor`) is a security-hardened fork of `yuhuan-dev/antigravity-usage-monitor`. It preserves the full telemetry UI, standalone web server, sidebar panel, and all window mount modes (`dual`, `composer`, `sidebar`), while removing intrusive host mutations, credential harvesting, traffic interception, and unverified self-update paths:

1. **No Silent OS Shortcut / Registry / `argv.json` Patching or UAC Relaunch**: Removed `windows-shortcut-provision.ps1` and disabled all automatic `.lnk`, `.desktop`, autostart, Windows Registry (`HKCU\Run`, `HKCU\Software\Classes`), and `~/.antigravity-ide/argv.json` writes as well as `-Verb RunAs` / WMI UAC relaunches. All mount modes (`dual`, `composer`, `sidebar`) remain supported—launch Antigravity manually with `--remote-debugging-port=0` if you want the titlebar or composer overlay capsule.
2. **No OAuth Credential Vault, Win32 Credential Store Access, or Binary OAuth Secret Extraction**: Removed `account-credentials.ps1`, Windows Credential Manager (`CredReadW`) / DPAPI vault access, and PE binary scanning for OAuth client secrets. Multi-account credential switching is hard-disabled (`disabled_in_hardened_fork`).
3. **No CloudCode MITM Proxy / `SetCloudCodeURL` Interception**: Hard-disabled the local CloudCode MITM proxy server, Windows proxy registry lookups, and `SetCloudCodeURL` RPC redirection.
4. **Mandatory SHA-256 + Zip Slip/Symlink Verification & No Silent Startup GitHub Fetches**: Removed the unverified `codeload.github.com` branch-ZIP fallback, silent startup GitHub fetches, and background auto-updates (`pluginUpdateMode` defaults to `'off'`, and `'auto'` is disallowed). Manual ZIP updates from `StickwoodJr/antigravity-usage-monitor` require a matching `.sha256` checksum and pass pure-Node PKZIP Zip Slip (`..`/absolute paths) and symlink validation.
5. **Opt-In CLI `statusLine`**: `enableCliStatusLine` defaults to `false`, so `~/.gemini/antigravity-cli/settings.json` is never modified unless you explicitly opt in.

> [!TIP]
> **Safe Usage Options**:
> - **Sidebar Only mode**: Works inside Antigravity with zero extra flags or host changes.
> - **Standalone Web Server**: Run `node sidecars/panel/standalone.mjs --port 8787` (binds to `127.0.0.1` by default) and open `http://localhost:8787` in your browser.
> - **Topbar / Dual / Composer Overlay Capsule**: Close Antigravity and launch it manually with `--remote-debugging-port=0` so the local CDP bridge attaches without modifying OS shortcuts or registry entries.

---

## Features

- **Live Metrics & Customizable Layout**: Tracks output speed (`tok/s`), time-to-first-token (`TTFT`), session average speed, step/session USD cost, cache hit rate, tightest remaining quota, and session tokens. You can choose and reorder the overview metric cards (4 shown by default out of 9 options) and section blocks.
- **10-Category Context Breakdown**: Shows the token breakdown of the latest request across assistant replies, tool results, user messages, subagent notifications, checkpoints, system prompts, system tools, MCP tools, skills, and user rules, with a switcher between the main agent and spawned subagents.
- **Quota Pool Tracking, Lease Reservation & Burn-Rate Reference**: Reads 5-hour and weekly quotas, reset timers, and cycle consumption across `Gemini`, `Gemini 4 Argon`, `Gemini 4 Carbon`, and `Claude & GPT` pools (plus Ultra `5x / 20x` tier badges), renders an in-flight lease reservation segment with an account-isolated per-model burn-rate & equivalent full-pool cost popover (`?`), and preserves cached quota data with a stale notice when upstream is temporarily unavailable.
- **Main Agent, Subagents, Swarm & SSH Isolation**: Merges main agent, subagent, and Native Swarm worker steps in chronological order (or filters by individual agent), renders optional turn rails, expands running tasks inline, and isolates per-window caches and quotas across multiple SSH Remote windows (`endpointId`).
- **Call Details, Timing Tooltips & Anomaly Chips**: Includes **By Step** and **By Model** tabs (with multi-model LOESS throughput/TTFT fit charts), clickable column sorting, hover TTFT/duration stage breakdowns, accent-highlighted compaction rows with diagnostic tooltips, and an optional live search & 9-category anomaly/compaction/low-cache/slow-TTFT filter toolbar. Supports 2–14 configurable columns and custom token DSL strings such as `context:in:cache`.
- **Historical Usage, Project Attribution & Heatmap**: Summarizes tokens, uncached input vs. cache-read savings, thinking/output split, smooth hourly/daily trend curves (switching automatically to a GitHub-style daily calendar heatmap over `>90` days), **Model / Project (Workspace) / Session** rankings, client attribution (`Desktop App` / `IDE` / `CLI`), and monthly bar charts with pointer-following breakdown popovers across `Today`, `1d`, `7d`, `14d`, `30d`, `All`, or custom date/time ranges.
- **Native `.xlsx` / Markdown Exports & Settings Backup**: Exports multi-sheet localized Excel (`.xlsx`) workbooks and Markdown summaries for both Usage Statistics and Call Details directly to `~/Downloads` with an in-app reveal toast, plus portable JSON preference backup/import.
- **Cross-Client Session Migration**: Built-in opt-in session migrator (`Preferences → Other`) moves or clones conversations across `Antigravity CLI` ↔ `Desktop App / IDE` and `Legacy IDE (.db)` with isolated UUID rewriting to prevent cross-client mirror collisions or double billing.
- **Multi-Client Capsules & CLI `statusLine` Modes**: Integrates as a titlebar or composer capsule (with ring quota gauges and main-agent context lock) and auxiliary sidebar in Antigravity 2.0, a titlebar/composer capsule in Antigravity IDE, a single-line 24-bit ANSI `statusLine` in Antigravity CLI (`--style pill|bar|compact`, `--preset compact|balanced|full`, `--json`), and a standalone local web UI.
- **No `app.asar` or OS Launcher Modification**: Titlebar/composer injection runs in memory over local CDP (`DevToolsActivePort`) when you manually launch Antigravity with `--remote-debugging-port=0`, without touching installation binaries, `app.asar`, OS shortcuts, registry entries, or `~/.antigravity-ide/argv.json`.
- **Context Window Inspection & CLI Override**: Displays per-model context windows and 10-category token breakdowns across main agents, subagents, and CLI (`AGY_CLI_AUTO_COMPACT_OVERRIDE`), without routing traffic through any local CloudCode MITM proxy.
- **Appearance, Offline Storage & Verified Updates**: Supports `zh-CN` / `en-US` / host language, borderless Modern UI, `sm / md / lg / xl` font scaling, 6 theme accents plus host matching, offline reading from CLI SQLite + WAL, `annotations/*.pbtxt`, `transcript.jsonl`, and `.deep_stats_cache.json`, explicit GitHub [`pricing-catalog.json`](pricing-catalog.json) sync, and SHA-256 verified manual release updates (`off` / `manual`).
- **Obsidian Prism Optical UI & Host Enhancements**: Unifies the entire extension and Antigravity workbench under Obsidian Prism (`v1.0.8-beta.3`, GPL-3.0-only by `@RMvdesi`):
  - **4 Optical Themes & 5 Accent Tones**: `Obsidian Dark`, `Warm Charcoal`, `Daylight Crystal`, and `Warm Alabaster`, paired with `Follow Host`, `Cobalt`, `Iris`, `Amber`, or `Mono` accents, 3 corner scales, custom code fonts & ligatures, 3 ambient/motion scene presets (`Full Optical`, `Deep Focus`, `Silent Eco`), spring physics, cursor-reactive Prism rim, 5-step ink streaming, 3-state `0fps` edge aura, toggleable WebGL2 ripple, and toggleable smooth caret.
  - **Home-Screen Studio Dashboard & Quota Pace Forecast**: Embeds an Obsidian Prism Overview / Models / Quotas Studio panel directly onto the Antigravity home screen backed by Usage Monitor's unified backend (`prism-home-adapter.mjs`), plus linear 5-hour & weekly quota depletion pace badges (`Healthy` / `Tight` / `Low`) and an `Open Usage Monitor` quick action.
  - **Workbench, Reasoning Slider & Optional Modules**: Adds the cut-crystal Orchestrator Reasoning Effort Slider & per-model effort memory, sticky code headers & manual fold (`>= 48` lines), Prompt Outline rail (`Alt+Up/Down` & Fold Steps), 24-variable cross-origin sidecar theme sync, Omni local streaming file viewer, plus strictly opt-in Custom Wallpapers Beta and Interactive Pixel Mascots (both off by default, injecting zero bytes when disabled).

> [!NOTE]
> **Attribution & License**: Portions of the optical design system and host UI enhancements are ported and adapted from [`RMvdesi/obsidian-prism`](https://github.com/RMvdesi/obsidian-prism) under **GPL-3.0-only**. See [`NOTICE`](NOTICE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for complete copyright and license attributions.

---

## Screenshots

### IDE & CLI

<table>
  <tr>
    <td align="center">
      <img src="assets/ide-preview.png" alt="Antigravity IDE Titlebar Capsule and Hover Overview" width="100%" />
      <br />
      <b>Antigravity IDE</b>
      <br />
      <sub>Titlebar capsule and hover popover showing step cost, context usage, and pool quotas</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="assets/cli-preview.png" alt="Antigravity CLI Native statusLine Capsule" width="100%" />
      <br />
      <b>Antigravity CLI (<code>agy</code>)</b>
      <br />
      <sub>Single-line 24-bit ANSI bottom <code>statusLine</code> with active count, TPS, TTFT, step cost, and color-coded quota/context pill gauges</sub>
    </td>
  </tr>
</table>

### Panel Tabs

<table>
  <tr>
    <td align="center" width="33.3%">
      <img src="assets/context.png" alt="Live Overview and Quotas" />
      <br />
      <b>Live Overview</b>
      <br />
      <sub>TPS, TTFT, 10-category context bar, quota pools with lease reservation, and live Swarm/subagent tasks</sub>
    </td>
    <td align="center" width="33.3%">
      <img src="assets/analytics.png" alt="Usage Statistics" />
      <br />
      <b>Usage Statistics</b>
      <br />
      <sub>Token totals, cache hit rate, smooth trend chart, and Model / Project / Session rankings</sub>
    </td>
    <td align="center" width="33.3%">
      <img src="assets/subagents.png" alt="Call Details and Subagents" />
      <br />
      <b>Call Details</b>
      <br />
      <sub>Sortable main, Swarm, and subagent step rows with turn rail, compaction highlight, tokens, and cost</sub>
    </td>
  </tr>
</table>

---

## Client Support

| Client | Status Capsule / Bar | Panel UI | Offline SQLite &amp; Logs | Context Limit Config | Modifies `app.asar` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Antigravity 2.0 (Desktop)** | Titlebar / Composer (manual CDP flag) | Popover + Right Sidebar | Yes | Read-only catalog (CDP hook disabled by default) | No |
| **Antigravity IDE** | Titlebar / Composer (manual CDP flag) | Capsule Popover | Yes | Read-only catalog (CDP hook disabled by default) | No |
| **Antigravity CLI (`agy`)** | Opt-in Native ANSI `statusLine` | Standalone Web (`--port`) | Yes (`node:sqlite` + `.pbtxt`) | `AGY_CLI_AUTO_COMPACT_OVERRIDE` | No |
| **SSH Remote / Headless Linux** | Per-Endpoint Capsule / ANSI `statusLine` | SSH Overlay / `--token` Web | Yes | Per-Endpoint Env | No |

> [!NOTE]
> Automatic shortcut, registry, and `~/.antigravity-ide/argv.json` patching and UAC relaunch are disabled in this hardened fork. Use **Sidebar Only** mode or the **Standalone Web Server** with zero extra flags, or manually launch **Antigravity Desktop / IDE** with `--remote-debugging-port=0` if you want the **Dual-mount** (titlebar) or **Composer** overlay capsule.

---

## Installation

Keep the folder name as `usage-monitor`. **No `npm install` is needed.**

### Option 1: Release ZIP

Download [`usage-monitor.zip`](https://github.com/StickwoodJr/antigravity-usage-monitor/releases/latest/download/usage-monitor.zip) and extract it into `~/.gemini/config/plugins/` so the directory path is `~/.gemini/config/plugins/usage-monitor`.

<details>
<summary>Windows PowerShell command for ZIP installation</summary>

```powershell
$pluginsDir = "$env:USERPROFILE\.gemini\config\plugins"
New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
Invoke-WebRequest -Uri "https://github.com/StickwoodJr/antigravity-usage-monitor/releases/latest/download/usage-monitor.zip" -OutFile "$env:TEMP\usage-monitor.zip"
Expand-Archive -Path "$env:TEMP\usage-monitor.zip" -DestinationPath $pluginsDir -Force
```

</details>

### Option 2: Git Clone

```powershell
# Windows (PowerShell)
git clone --filter=blob:none --single-branch https://github.com/StickwoodJr/antigravity-usage-monitor.git "$env:USERPROFILE\.gemini\config\plugins\usage-monitor"
```

```bash
# macOS / Linux
git clone --filter=blob:none --single-branch https://github.com/StickwoodJr/antigravity-usage-monitor.git ~/.gemini/config/plugins/usage-monitor
```

Or ask Antigravity directly:

```text
Clone https://github.com/StickwoodJr/antigravity-usage-monitor with --filter=blob:none --single-branch to ~/.gemini/config/plugins/usage-monitor and enable the plugin
```

---

## Usage

1. Open **Customizations → Installed** in the left sidebar and enable `usage-monitor`.
2. **Sidebar Mode (Zero Flags / Safest)**:
   - Switch **Mount Mode** to **Sidebar Only** (or use the right auxiliary sidebar pane directly in **Dual-mount** mode) without passing any extra launch flags.
3. **Antigravity 2.0 (Desktop) & Antigravity IDE (Topbar / Composer Capsule)**:
   - Launch Antigravity manually with `--remote-debugging-port=0` to attach the titlebar or composer capsule (**hover** for summary, **click** for the 4-tab popover, **right-click** to refresh).
   - Keep **Mount Mode** on **Dual-mount** (default) or **Composer**.
4. **Antigravity CLI (`agy`)**:
   - CLI `statusLine` is **disabled by default** (`enableCliStatusLine: false`) so `~/.gemini/antigravity-cli/settings.json` is never modified silently.
   - Opt in explicitly via `/statusline` in `agy` or **Preferences → Structure → Mount & Capsule Bar**.
5. **Standalone Web Server (Headless / Remote)**:

```bash
# 1. Start on the host (listens on 127.0.0.1:8787 by default)
node ~/.gemini/config/plugins/usage-monitor/sidecars/panel/standalone.mjs --port 8787

# 2. Forward the port locally and open http://localhost:8787
ssh -L 8787:127.0.0.1:8787 user@your-server
```

<details>
<summary>Standalone CLI flags, background auto-start, and non-loopback token auth</summary>

- **Auto-start with `agy`**: Set `USAGE_MONITOR_STANDALONE_PORT=8787` or `"standalonePort": 8787` in `~/.gemini/antigravity-cli/sidecar_data/usage-monitor/panel/data/settings.json` to start the web UI together with the MCP sidecar supervisor.
- **Non-loopback auth**: Binding to `0.0.0.0` or a LAN address requires `--token <secret>` (or `USAGE_MONITOR_STANDALONE_TOKEN`); starting on a non-loopback address without a token is rejected.
- **Overrides**: Supports `--data-dir`, `--app-data-dir`, `--gemini-dir`, `--ls-addr`, and `--csrf-token`.
- **Offline fallback**: When `agy` is not running, the backend reads `~/.gemini/antigravity-cli` (`conversation_summaries.db`, `conversations/*.db`, `annotations/*.pbtxt`, and `transcript.jsonl`) and switches to live RPC once `agy` starts.

</details>

---

## Configuration & Calculation Notes

<details>
<summary>UI options: mount mode, capsule slots, token formats, model IDs, and context limits</summary>

- **Mount Mode & Width**: Switch between **Dual-mount (Top Bar + Sidebar)**, **Composer**, and **Sidebar only**. Popover width defaults to **Auto Fit** (expands within window bounds for wide tables) or a fixed width (`440–1080 px`).
- **Capsule Slots**: Choose 1–5 metric slots and reorder them (default: Output Speed, TTFT, Context Usage), plus an optional toggle for the active-session indicator.
- **Call Details Table & Token Format**: Toggle agent badges, turn rail (off by default), and speed color grading (off by default). Choose `Ctx / Think / Reply`, `In / Out / Cache` (with per-item USD tooltips), or custom format strings like `context:new:cache` or `in:out:cache`.
- **Model Name Format**: Choose **Compact short alias** (`argon-4-high`), **Full raw ID**, or **Trimmed raw ID** (strips `gemini-` / `claude-` / `gpt-` prefixes while keeping `·compact` suffixes intact). Orchestrator series IDs have a separate setting.
- **Per-Model Context Limits**: Configure limits per model across thinking levels or follow host defaults under **Preferences → Other → Model Context Settings**. App/IDE applies saved rules at startup; CLI sets `AGY_CLI_AUTO_COMPACT_OVERRIDE`.

</details>

<details>
<summary>Model identification, compaction inference, and cost estimation rules</summary>

- **Model Resolution**: Read from each step's raw usage payload or matching generator metadata; explicit models are never overwritten. When an automatic compaction step omits the model field, it is inferred from adjacent steps in the same conversation (checking prior steps first, then following steps, preferring the same provider) for display and estimation, or shown as unknown compaction if none exist.
- **Cost Calculation**: If a model or price entry cannot be resolved, step cost is shown as pending while tokens still count toward totals; session totals sum all resolved steps. USD numbers are estimated from public per-million-token API pricing in [`pricing-catalog.json`](pricing-catalog.json) for reference only and do **not** reflect subscription quota consumption.
- **Cache & Speed Averages**: Upgrading re-checks cached entries against raw trajectory data while preserving token counts and valid timings. Compaction steps display request TPS in step tables but are excluded from session speed and TTFT averages.

</details>

<details>
<summary>Updating and data directory</summary>

- **In-Panel Update**: Update checking defaults to `Off` (no silent startup GitHub fetch, and background `Auto` updates are disabled). You can switch to `Manual` under **Preferences → General** and trigger updates explicitly; ZIP updates require a matching `.sha256` checksum and pass Zip Slip / symlink validation.
- **Manual Git Update**:
  - Windows: `git -C "$env:USERPROFILE\.gemini\config\plugins\usage-monitor" pull --ff-only`
  - macOS / Linux: `git -C ~/.gemini/config/plugins/usage-monitor pull --ff-only`
  - Toggle the plugin off and back on in **Customizations → Installed**.
- **Data Persistence**: Settings and parsed caches live in `~/.gemini/antigravity/sidecar_data/usage-monitor/` (or `sidecars/panel/.data/` in standalone mode), so updates keep existing history intact.

</details>

---

## Local Development

All backend and frontend modules use pure Node.js ESM and a lightweight custom reactive component & incremental DOM patch engine (`defineComponent` + `domPatch`, with Shadow DOM isolation for host overlays) and **no external npm dependencies** (Node.js 22.5+ is recommended for built-in `node:sqlite`).

```bash
cd sidecars/panel

# Rebuild app.js and styles.css after modifying src/
npm run build

# Run unit and integration tests
npm test
```

## Contributing & License

Issues and pull requests are welcome. If you modify files under `sidecars/panel/src/`, please rebuild via `npm run build` and make sure `npm test` passes.

Licensed under the [GNU General Public License v3.0](LICENSE).

## Star History

<a href="https://www.star-history.com/#StickwoodJr/antigravity-usage-monitor&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=StickwoodJr/antigravity-usage-monitor&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=StickwoodJr/antigravity-usage-monitor&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=StickwoodJr/antigravity-usage-monitor&type=Date" />
  </picture>
</a>
