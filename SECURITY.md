# FormatPad Security Baseline

_Generated during P0-10 security scan on 2026-04-24. Re-run on every major release._

## Electron hardening

| Setting | Value | Status |
|---------|-------|--------|
| `nodeIntegration` | `false` | PASS |
| `contextIsolation` | `true` | PASS |
| `sandbox` | `true` | PASS |

`src/main/main.js` line 181–186. All three are set to their secure values. The renderer
process is fully sandboxed with no direct Node.js access.

**Navigation hardening:** `will-navigate` events are blocked in `app.on('web-contents-created')`. Navigation is only permitted for `file:///` URLs that resolve to a supported extension (via `isSupportedFile()`). All other navigations are cancelled.

**Window opening:** `setWindowOpenHandler` returns `{ action: 'deny' }` for every request; http/https URLs are passed to `shell.openExternal` (the OS browser). Both `http://` and `https://` are forwarded. See Follow-ups #2.

**preload.js — contextBridge surface** (`window.formatpad`):

| Method | Proxies to | Risk class |
|--------|-----------|------------|
| `platform` | `process.platform` (static) | LOW |
| `getAppInfo()` | `get-app-info` — returns version + isPackaged | LOW |
| `getSystemTheme()` | `get-system-theme` | LOW |
| `openFileDialog()` | `open-file-dialog` — shows native file picker | LOW |
| `saveFile(filePath, content)` | `save-file` — writes to filePath | MEDIUM (see IPC handlers) |
| `saveFileAs(content)` | `save-file-as` — shows save dialog | LOW |
| `dropFile(p)` | `drop-file` — opens dropped file path | LOW (isSupportedFile check) |
| `getPathForFile(f)` | `webUtils.getPathForFile` — File → path | LOW |
| `openDefaultAppsSettings()` | `open-default-apps-settings` | LOW |
| `showSaveDialog()` | `show-save-dialog` | LOW |
| `onCheckBeforeClose(cb)` / `confirmClose()` | window close flow | LOW |
| `getLocale()` / `setLocale(code)` | locale read/write | LOW |
| `autoSaveRecovery(filePath, content)` | `auto-save-recovery` — SHA-256 keyed recovery dir | LOW |
| `clearRecovery(filePath)` | `clear-recovery` — deletes recovery file | LOW |
| `saveImage(filePath, buffer, ext)` | `save-image` — writes to `./assets/` subdir | LOW |
| `setTitle(title)` | `set-title` | LOW |
| `readFile(filePath)` | `read-file` — reads arbitrary path | MEDIUM |
| `openFolderDialog()` | `open-folder-dialog` — shows native picker | LOW |
| `readDirectory(dirPath)` / `watchDirectory` / `unwatchDirectory` | directory watch | MEDIUM |
| `onDirectoryChanged(cb)` | receives directory-change events | LOW |
| `createFile(filePath)` / `createFolder` / `renameFile` / `deleteFile` | filesystem mutations | MEDIUM |
| `searchFiles(dirPath, query, options)` | workspace search | MEDIUM |
| `buildLinkIndex` / `resolveWikiLink` / `getBacklinks` / `getFileNames` | wiki-link graph | MEDIUM |
| `revealInExplorer(targetPath)` | `shell.showItemInFolder` | LOW |
| `saveBinary` / `saveText` | save-dialog before write | LOW |
| `svgToPng(svg, w, h, bg)` | offscreen BrowserWindow render | LOW |
| `onShowUpdateDialog` / `onUpdateProgress` / `onUpdateError` / `updateAction` | auto-updater UI | LOW |

No Node.js or Electron internals are exposed directly. All MEDIUM-risk methods require
renderer code to supply a filesystem path; see IPC Handlers section for path-validation gap.

## Content Security Policy

**Electron desktop:** enforced by two mechanisms simultaneously (both must be satisfied):
1. `<meta http-equiv="Content-Security-Policy">` in `src/renderer/index.html` line 5.
2. `session.defaultSession.webRequest.onHeadersReceived` in `src/main/main.js` line 976.

**Effective CSP:**
```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' https://api.github.com https://api.githubusercontent.com https://plausible.io;
worker-src 'self' blob:;
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

| Check | Result |
|-------|--------|
| `unsafe-eval` anywhere | NONE FOUND — PASS |
| `<script src="http://...">` | NONE — PASS |
| Non-HTTPS external scripts | NONE — PASS |

**`unsafe-inline` on `style-src`:** Accepted. The theme engine generates inline `<style>` blocks dynamically at runtime; removing this would require a nonce-based approach or a full style-in-JS rewrite. Documented as Follow-up #3.

**P0-10 fix applied:** `RENDERER_CSP` constant in `main.js` was missing `https://plausible.io`
relative to the meta tag, silently blocking analytics in the desktop app. Fixed by adding the
origin to the constant (comment already stated the two must match).

**Web build:** CSP is enforced via the meta tag only (no server-side headers). GitHub Pages
serves static files without custom headers. This is expected — the meta tag provides the same
policy. A future improvement would add a `_headers` or `vercel.json` to serve a CSP header from
the web host (Follow-up #4).

## localStorage / IndexedDB surface

All keys use the `fp-` prefix convention. Inventory as of P0-10:

| Key | What it stores | Contains secret/PII? | Encrypted? |
|-----|---------------|---------------------|-----------|
| `fp-workspace-path` | Last opened folder path | No | No |
| `fp-zoom` | Zoom level 0–200% | No | No |
| `fp-mmd-theme` | Mermaid diagram theme name | No | No |
| `fp-diff-pretty` | Diff mode flag | No | No |
| `fp-diff-other` | Right-pane diff text | No (document content only) | No |
| `fp-sidebar-visible` | Sidebar open/closed | No | No |
| `fp-sidebar-width` | Sidebar width in pixels | No | No |
| `fp-sidebar-panel` | Active sidebar panel | No | No |
| `fp-view-mode` | Editor/split/preview mode | No | No |
| `fp-divider-ratio` | Editor/preview split ratio | No | No |
| `fp-locale` | UI language code | No | No |
| `fp-locale-mtime` | Locale file mtime | No | No |
| `fp-last-schema` | Last JSON schema text | No (user JSON schema) | No |
| `fp-search-exts` | Selected search file extensions | No | No |
| `fp-toc-visible` | TOC legacy flag | No | No |
| `fp-first-run` | First-run sentinel | No | No |
| `theme-id` | Active theme ID | No | No |
| `custom-themes` | Custom theme JSON blob | No | No |
| `sentry-opt-out` | Crash reporting opt-out flag | No | No |
| `analytics-opt-out` | Analytics opt-out flag | No | No |

**Result: No secrets, tokens, or PII are stored in localStorage.**

**Anticipated P1-1 (AI provider keys):** When AI API keys are added in Phase 1, they
**MUST NOT** go into `localStorage`. Required approach:
- **Desktop (Electron):** use `safeStorage.encryptString` / `safeStorage.decryptString`
  (OS-level key store: Keychain on macOS, Credential Manager on Windows, libsecret on Linux).
- **Web:** store in IndexedDB with a clearly labelled opt-in UI banner warning the user that
  keys are stored unencrypted in the browser's origin storage. Never auto-save to localStorage.

## URL handling

**Current state (v1.x):** No `?src=` URL loading, no GitHub/Gist drag-drop (P1-7 not built).

**Implemented protections:**
- All renderer navigations blocked by `will-navigate` handler.
- `setWindowOpenHandler` forwards http/https to the OS browser — no inline rendering of external URLs.
- The auto-updater fetches only from `https://api.github.com/repos/luke-youngmin-cho/FormatPad/releases/latest` (hardcoded HTTPS, no user-configurable endpoint). Response is parsed as JSON with no eval. Installer download goes to `os.tmpdir()`.

**Policy for P1-7 (GitHub / Gist URL drop — not yet built):**
- Only HTTPS URLs accepted. `http://` must be rejected with a user-visible warning.
- Allowlist for direct fetch without a CORS warning: `raw.githubusercontent.com`, `gist.githubusercontent.com`.
- All other domains: require explicit user confirmation ("This will load content from an external URL").
- Fetched content **must not** be auto-saved to disk. Only the active editor buffer should be populated.
- Validate that the URL does not redirect to a non-allowlisted host before loading.

## IPC handlers

All `ipcMain` channels as of P0-10. No handler executes arbitrary shell commands.

| Channel | Type | What it does | Sender-frame check | Path validation |
|---------|------|-------------|-------------------|----------------|
| `get-app-info` | handle | Return version + isPackaged | — | — |
| `get-system-theme` | handle | Return system dark/light | — | — |
| `get-locale` | handle | Return locale code + mtime | — | — |
| `set-locale` | on | Write locale pref | — | — |
| `set-title` | on | Set window title | reads `event.sender` | — |
| `open-file-dialog` | handle | Native open dialog | reads `event.sender` | Dialog enforces |
| `save-file` | handle | `fsp.writeFile(filePath, …)` | — | **None** (see note) |
| `save-file-as` | handle | Save dialog then write | reads `event.sender` | Dialog enforces |
| `open-default-apps-settings` | handle | `shell.openExternal(ms-settings:…)` | — | Hardcoded URI |
| `show-save-dialog` | handle | Message box (save/discard) | reads `event.sender` | — |
| `confirm-close` | on | `win.destroy()` | reads `event.sender` | — |
| `drop-file` | on | Load dropped file | reads `event.sender` | `isSupportedFile()` check |
| `read-file` | handle | `fsp.readFile(filePath)` | — | **None** |
| `save-image` | handle | Write to `./assets/` subdir of open file | — | Subdir is `path.join(dir,'assets')` |
| `auto-save-recovery` | handle | Write to userData/recovery (SHA-256 key) | — | Writes only to userData |
| `clear-recovery` | handle | Delete from userData/recovery | — | Writes only to userData |
| `open-folder-dialog` | handle | Native folder dialog | reads `event.sender` | Dialog enforces |
| `read-directory` | handle | Recursive tree read (max depth 8) | — | **None** |
| `watch-directory` | handle | `fs.watch` on dirPath | reads `event.sender` | **None** |
| `unwatch-directory` | handle | Stop current watcher | reads `event.sender` | — |
| `create-file` | handle | `fsp.writeFile(filePath, '')` | — | **None** |
| `create-folder` | handle | `fsp.mkdir(folderPath)` | — | **None** |
| `rename-file` | handle | `fsp.rename(old, new)` | — | **None** |
| `delete-file` | handle | `shell.trashItem(filePath)` | — | **None** |
| `search-files` | handle | Regex search across dirPath | — | **None** |
| `build-link-index` | handle | Read all .md in dirPath | — | **None** |
| `resolve-wiki-link` | handle | Path lookup within dirPath | — | **None** |
| `get-backlinks` | handle | Read ≤1000 .md files | — | **None** |
| `get-file-names` | handle | List .md names in dirPath | — | **None** |
| `save-binary` | handle | Save dialog then binary write | reads `event.sender` | Dialog enforces |
| `svg-to-png` | handle | Offscreen BrowserWindow render | reads `event.sender` | Validates dimensions |
| `save-text` | handle | Save dialog then text write | reads `event.sender` | Dialog enforces |
| `reveal-in-explorer` | handle | `shell.showItemInFolder` | — | **None** |
| `update-action` | on | Trigger update download/skip | reads `event.sender` | Validates action enum |

**Path-validation gap (Medium):** Handlers that accept a `filePath` / `dirPath` argument
do not validate that the path stays within any workspace root. A compromised renderer
could issue IPC calls to read or write arbitrary filesystem locations permitted to the
Electron process. The mitigations in place are: `sandbox: true` (renderer cannot escape
via Node APIs), strict CSP (no inline scripts, no external scripts), and DOMPurify on
all rendered HTML. Addressed in Follow-up #1.

**No arbitrary command execution:** Confirmed — no `exec`, `execFile`, `spawn`, or
`child_process` calls exist anywhere in the main process code.

## Dependency audit

Run: `npm audit --omit=dev --audit-level=high` (exit 0)

```
uuid  <14.0.0
Severity: moderate
uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided
https://github.com/advisories/GHSA-w5hq-g745-h8pq
fix available via `npm audit fix --force`
Will install mermaid@9.1.7, which is a breaking change
node_modules/uuid
  mermaid  >=9.2.0-rc1
  Depends on vulnerable versions of uuid

2 moderate severity vulnerabilities
```

`npm audit --omit=dev --audit-level=critical` → **exit 0** (no critical or high findings).

**Triage:**
- The uuid buffer-bounds check issue (GHSA-w5hq-g745-h8pq) only manifests when an optional
  second `buf` argument is passed with a length < 16 bytes. FormatPad does not call uuid
  directly; it is a transitive dep of mermaid. Severity: **moderate**, exploitability: low
  (no user-supplied buf argument in the call path).
- Fixing requires downgrading mermaid to 9.1.7 (breaking), which would lose diagram features.
  Tracked as Follow-up #5.

**js-yaml 4.1.1 — `load()` safety:** In js-yaml v4.x the default `load()` function uses
`DEFAULT_SCHEMA` (equivalent to the old v3 `safeLoad` / `DEFAULT_SAFE_SCHEMA`). JavaScript-type
constructors (`!!js/function`, `!!js/regexp`, `!!js/undefined`) were removed in v4.0. The
`safeLoad` export is a deprecated compatibility alias for `load`. **No code change required.**

**smol-toml:** Simple recursive-descent TOML parser with no known deserialization issues.
No `eval` or dynamic code execution in the parser. **PASS.**

**DOMPurify 3.4.0:** Used for all HTML preview rendering with an explicit allowlist.
`FORCE_BODY` + `WHOLE_DOCUMENT: false` mode. No known issues. **PASS.**

## Follow-ups

1. **(Medium) IPC path sandbox validation** — File operation handlers (`save-file`,
   `read-file`, `create-file`, `create-folder`, `rename-file`, `delete-file`, `read-directory`,
   `watch-directory`, `search-files`, `build-link-index`, `get-backlinks`, etc.) do not
   constrain paths to the user-opened workspace. Add a `isPathSafe(p, workspaceRoot)` guard
   that resolves both paths and checks `resolved.startsWith(workspaceRoot)`. Handlers that
   may legitimately act outside the workspace (e.g. `save-file` for files opened via dialog
   from anywhere) should track the set of user-opened paths separately.
   Priority: **P1**. Owner: maintainer.

2. **(Low) `setWindowOpenHandler` allows http:// external links** — Current code opens both
   `http://` and `https://` links via `shell.openExternal`. Consider logging a warning or
   showing a "this link uses plain HTTP" dialog before opening. Low exploitability since the
   link must appear in a document the user opened.
   Priority: **P2**. Owner: maintainer.

3. **(Low) `style-src 'unsafe-inline'` in CSP** — Required for the dynamic theme engine.
   To remove it, nonce-based injection or a CSS-in-JS approach would be needed. Not
   practically exploitable given `script-src 'self'` blocks injected script execution.
   Priority: **P3**. Owner: maintainer (if ever doing a theme engine rewrite).

4. **(Low) Web build has no server-side CSP header** — GitHub Pages does not support custom
   response headers. The meta-tag CSP applies, but a `_headers` file (Netlify/Cloudflare
   Pages) or equivalent could add belt-and-suspenders enforcement at the HTTP layer if the
   deployment target ever changes.
   Priority: **P3**. Owner: maintainer.

5. **(Moderate dep) uuid < 14.0.0 via mermaid** — Upgrade path requires mermaid 9.1.7
   (breaking). Evaluate when mermaid publishes a non-breaking uuid-14 compatible release.
   Priority: **P2**. Owner: maintainer.

6. **(Future / P1-1) AI provider key storage** — When AI keys are added, they **must** use
   `safeStorage` on desktop and an explicit user-consent flow on web (IndexedDB, with a
   banner making clear that keys are stored in the browser origin). localStorage is
   explicitly prohibited for key material.
   Priority: **P0 for P1-1**. Owner: whoever implements P1-1.

7. **(Low) macOS app not signed with Apple Developer ID** — First-launch GateKeeper warning.
   Users must run `xattr -cr` or use "Open Anyway". Not a code vulnerability; requires an
   Apple Developer subscription and notarization pipeline.
   Priority: **P2** (before macOS public launch). Owner: project lead.

8. **(Informational) Consider Snyk / Socket** — Automated SCA tooling for continuous
   dependency monitoring. Not configured currently. Could be wired into CI as a follow-on
   to the bundle-size gate added in P0-2.
   Priority: **P3**. Owner: maintainer.
