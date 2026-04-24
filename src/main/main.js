try { require("v8-compile-cache"); } catch {}
const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');

const windows = new Set();
const watchers = new Map();

// --- Sentry (main process) ---
// TODO: wire DEFAULT_SENTRY_DSN in the build config once the project's Sentry org is set up.
if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/electron/main');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: `formatpad@${require('../../package.json').version}`,
    environment: app.isPackaged ? 'production' : 'development',
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.breadcrumbs?.values) {
        for (const bc of event.breadcrumbs.values) {
          if (typeof bc.message === 'string') {
            bc.message = bc.message.replace(/[^/\\]+\.(?:env|key|pem)\b/gi, '<redacted>');
          }
        }
      }
      delete event.user;
      return event;
    },
  });
} else {
  console.info('[FormatPad] SENTRY_DSN not set — crash reporting disabled');
}

// --- Locale ---
const localeData = {
  en: require('../locales/en.json'),
  ko: require('../locales/ko.json'),
  zh: require('../locales/zh.json'),
  'zh-TW': require('../locales/zh-TW.json'),
  ja: require('../locales/ja.json'),
  es: require('../locales/es.json'),
  fr: require('../locales/fr.json'),
  de: require('../locales/de.json'),
  pt: require('../locales/pt.json'),
  ru: require('../locales/ru.json'),
  ar: require('../locales/ar.json'),
  hi: require('../locales/hi.json'),
  it: require('../locales/it.json'),
  nl: require('../locales/nl.json'),
  pl: require('../locales/pl.json'),
  tr: require('../locales/tr.json'),
  vi: require('../locales/vi.json'),
  th: require('../locales/th.json'),
  sv: require('../locales/sv.json'),
  da: require('../locales/da.json'),
  fi: require('../locales/fi.json'),
  nb: require('../locales/nb.json'),
  cs: require('../locales/cs.json'),
  el: require('../locales/el.json'),
  hu: require('../locales/hu.json'),
  ro: require('../locales/ro.json'),
  uk: require('../locales/uk.json'),
  id: require('../locales/id.json'),
  ms: require('../locales/ms.json'),
  he: require('../locales/he.json'),
};
let appLocale = 'en';
let appStrings = localeData.en;

const LCID_MAP = {
  1033:'en',1042:'ko',2052:'zh',1028:'zh-TW',1041:'ja',1034:'es',1036:'fr',
  1031:'de',1046:'pt',1049:'ru',1025:'ar',1081:'hi',1040:'it',1043:'nl',
  1045:'pl',1055:'tr',1066:'vi',1054:'th',1053:'sv',1030:'da',1035:'fi',
  1044:'nb',1029:'cs',1032:'el',1038:'hu',1048:'ro',1058:'uk',1057:'id',
  1086:'ms',1037:'he',
};

function resolveLocale(raw) {
  if (!raw) return null;
  if (localeData[raw]) return raw;
  const lcid = parseInt(raw);
  if (!isNaN(lcid) && LCID_MAP[lcid] && localeData[LCID_MAP[lcid]]) return LCID_MAP[lcid];
  return null;
}

function initLocale() {
  const log = [];
  const tryPaths = [
    path.join(path.dirname(app.getPath('exe')), 'resources', 'locale'),
    path.join(process.resourcesPath, 'locale'),
  ];
  let found = false;
  for (const p of tryPaths) {
    try {
      const raw = fs.readFileSync(p, 'utf-8').trim();
      const code = resolveLocale(raw);
      log.push(`file: ${p} | raw="${raw}" | resolved=${code}`);
      if (code) { appLocale = code; appStrings = localeData[code]; found = true; log.push(`SET: ${code}`); break; }
    } catch (e) { log.push(`file: ${p} | error: ${e.message}`); }
  }
  if (!found) {
    try {
      const { execSync } = require('child_process');
      const out = execSync('reg query "HKLM\\Software\\FormatPad" /v Locale 2>nul', { encoding: 'utf-8' });
      const m = out.match(/Locale\s+REG_SZ\s+(\S+)/);
      if (m) {
        const code = resolveLocale(m[1]);
        log.push(`reg: raw="${m[1]}" | resolved=${code}`);
        if (code) { appLocale = code; appStrings = localeData[code]; found = true; log.push(`SET: ${code}`); }
      }
    } catch (e) { log.push(`reg error: ${e.message}`); }
  }
  if (!found) {
    const sysLocale = app.getLocale();
    const sysCode = sysLocale.split('-')[0];
    log.push(`system: ${sysLocale} → ${sysCode}`);
    if (localeData[sysCode]) { appLocale = sysCode; appStrings = localeData[sysCode]; log.push(`SET: ${sysCode}`); }
  }
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'locale-debug.txt'), log.join('\n'), 'utf-8'); } catch {}
}

function t(key) { return appStrings[key] || localeData.en[key] || key; }

// --- Single instance lock ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

app.on('second-instance', (_event, argv) => {
  const filePath = getFilePathFromArgs(argv);
  if (windows.size > 0) {
    const win = windows.values().next().value;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (filePath) loadMarkdownFile(win, filePath);
  } else if (filePath) {
    createWindow(filePath);
  } else {
    createWindow(null);
  }
});

// --- Supported file formats ---
// SUPPORTED_EXTS is the allow-list shown in open/save dialog filters (UX hint).
// isSupportedFile uses a binary block-list so that unknown text files still open.
const SUPPORTED_EXTS = ['md', 'markdown', 'mkd', 'mdx', 'mmd', 'json', 'yaml', 'yml', 'html', 'htm', 'xml', 'csv', 'tsv', 'toml', 'ini', 'conf', 'properties', 'env', 'log', 'txt'];
const BINARY_EXTS = new Set([
  'exe','dll','so','dylib','bin','msi','app','class','jar',
  'zip','rar','7z','tar','gz','bz2','xz',
  'png','jpg','jpeg','gif','bmp','ico','webp','tiff',
  'mp4','avi','mov','wmv','mkv','webm','mp3','wav','ogg','flac','m4a',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'db','sqlite',
]);
function isSupportedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return !BINARY_EXTS.has(ext);
}

// --- Arg parsing ---
function getFilePathFromArgs(argv) {
  const args = app.isPackaged ? argv.slice(1) : argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (!isSupportedFile(arg)) continue;
    const resolved = path.resolve(arg);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

// --- Window ---
function createWindow(filePath) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
    backgroundColor: '#1a1b26',
    title: 'FormatPad',
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Disable Electron's built-in Ctrl+Wheel zoom (handled in renderer)
  win.webContents.setVisualZoomLevelLimits(1, 1);

  win.once('ready-to-show', () => {
    win.show();
    if (filePath) loadMarkdownFile(win, filePath);
  });

  win.on('closed', () => {
    windows.delete(win);
    const entry = watchers.get(win.id);
    if (entry) {
      entry.watcher.close();
      if (entry.flushTimer) clearTimeout(entry.flushTimer);
      watchers.delete(win.id);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Unsaved changes protection
  win.on('close', (e) => {
    if (win._forceClose) return;
    e.preventDefault();
    win.webContents.send('check-before-close');
  });

  win.webContents.on('render-process-gone', () => {
    win._forceClose = true;
  });

  windows.add(win);
  return win;
}

// --- File loading ---
async function loadMarkdownFile(win, filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    if (win.isDestroyed()) return;
    const fileName = path.basename(filePath);
    win.setTitle(fileName + ' - FormatPad');
    win.webContents.send('load-markdown', {
      content,
      filePath,
      fileName,
      dirPath: path.dirname(filePath),
    });
  } catch (err) {
    dialog.showErrorBox('Error', 'Failed to read file:\n' + filePath + '\n\n' + err.message);
  }
}

// --- IPC: system / locale / title ---
ipcMain.handle('get-app-info', () => ({
  isPackaged: app.isPackaged,
  version: app.getVersion(),
}));

ipcMain.handle('get-system-theme', () => {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

ipcMain.handle('get-locale', async () => {
  let mtime = 0;
  try {
    const p = path.join(path.dirname(app.getPath('exe')), 'resources', 'locale');
    mtime = (await fsp.stat(p)).mtimeMs;
  } catch {}
  return { code: appLocale, mtime };
});

ipcMain.on('set-locale', (_event, code) => {
  if (localeData[code]) { appLocale = code; appStrings = localeData[code]; }
});

ipcMain.on('set-title', (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setTitle(title);
});

// --- IPC: Markdown file ops ---
ipcMain.handle('open-file-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    filters: [
      { name: 'Supported', extensions: SUPPORTED_EXTS },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    for (const fp of result.filePaths) {
      loadMarkdownFile(win, fp);
    }
    return true;
  }
  return false;
});

ipcMain.handle('save-file', async (_event, filePath, content) => {
  try {
    await fsp.writeFile(filePath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('save-file-as', async (event, content) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    filters: [
      { name: 'Supported', extensions: SUPPORTED_EXTS },
      { name: 'All Files', extensions: ['*'] },
    ],
    defaultPath: 'untitled.md',
  });
  if (!result.canceled && result.filePath) {
    try {
      await fsp.writeFile(result.filePath, content, 'utf-8');
      const fileName = path.basename(result.filePath);
      win.setTitle(fileName + ' - FormatPad');
      return result.filePath;
    } catch {
      return null;
    }
  }
  return null;
});

ipcMain.handle('open-default-apps-settings', async () => {
  try {
    await shell.openExternal('ms-settings:defaultapps?registeredAppMachine=FormatPad');
  } catch {
    await shell.openExternal('ms-settings:defaultapps');
  }
});

ipcMain.handle('show-save-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return 'cancel';
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [t('dialog.save'), t('dialog.dontSave'), t('dialog.cancel')],
    defaultId: 0,
    cancelId: 2,
    message: t('dialog.unsavedMsg'),
    detail: t('dialog.unsavedDetail'),
  });
  return ['save', 'discard', 'cancel'][response];
});

ipcMain.on('confirm-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.destroy();
});

ipcMain.on('drop-file', (event, filePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && filePath && fs.existsSync(filePath)) loadMarkdownFile(win, filePath);
});

// --- Read file (for file tree) ---
ipcMain.handle('read-file', async (_event, filePath) => {
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return { content, filePath, fileName: path.basename(filePath), dirPath: path.dirname(filePath) };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Image paste ---
ipcMain.handle('save-image', async (_event, filePath, buffer, ext) => {
  try {
    const dir = filePath ? path.dirname(filePath) : app.getPath('pictures');
    const assetsDir = path.join(dir, 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });
    const name = 'image-' + Date.now() + '.' + ext;
    const dest = path.join(assetsDir, name);
    await fsp.writeFile(dest, Buffer.from(buffer));
    return './assets/' + name;
  } catch { return null; }
});

// --- Auto-save recovery ---
async function getRecoveryDir() {
  const dir = path.join(app.getPath('userData'), 'recovery');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function recoveryId(filePath) {
  if (!filePath) return 'untitled';
  return crypto.createHash('sha256').update(filePath).digest('hex').substring(0, 16);
}

ipcMain.handle('auto-save-recovery', async (_event, filePath, content) => {
  try {
    const id = recoveryId(filePath);
    const dir = await getRecoveryDir();
    await fsp.writeFile(path.join(dir, id + '.json'), JSON.stringify({
      filePath: filePath || null, content, timestamp: Date.now(),
    }), 'utf-8');
  } catch {}
});

ipcMain.handle('clear-recovery', async (_event, filePath) => {
  try {
    const dir = await getRecoveryDir();
    const p = path.join(dir, recoveryId(filePath) + '.json');
    await fsp.unlink(p).catch(() => {});
  } catch {}
});

async function checkRecovery(win) {
  if (win.isDestroyed()) return;
  try {
    const dir = path.join(app.getPath('userData'), 'recovery');
    const allFiles = await fsp.readdir(dir).catch(() => null);
    if (!allFiles) return;
    const files = allFiles.filter(f => f.endsWith('.json'));
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const raw = await fsp.readFile(fullPath, 'utf-8');
        const data = JSON.parse(raw);
        if (Date.now() - data.timestamp > 7 * 24 * 60 * 60 * 1000) {
          await fsp.unlink(fullPath).catch(() => {}); continue;
        }
        const name = data.filePath ? path.basename(data.filePath) : t('untitled');
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: t('recovery.title'),
          message: t('recovery.message').replace('{0}', name),
          detail: t('recovery.detail').replace('{0}', new Date(data.timestamp).toLocaleString()),
          buttons: [t('recovery.recover'), t('recovery.discard')],
          defaultId: 0, cancelId: 1,
        });
        if (response === 0) {
          let savedContent = '';
          if (data.filePath) {
            savedContent = await fsp.readFile(data.filePath, 'utf-8').catch(() => '');
          }
          win.webContents.send('load-markdown', {
            content: data.content, filePath: data.filePath,
            fileName: name, dirPath: data.filePath ? path.dirname(data.filePath) : null,
            savedContent,
          });
          if (data.filePath) win.setTitle(name + ' - FormatPad');
        }
        await fsp.unlink(fullPath).catch(() => {});
        if (response === 0) break;
      } catch { await fsp.unlink(fullPath).catch(() => {}); }
    }
  } catch {}
}

// --- Workspace: File tree & directory operations ---
const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', 'dist', 'build', '.next', '.cache', '.idea', '.vscode']);

async function readDirectoryTree(dirPath, depth) {
  if (depth > 8) return [];
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const items = [];
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => e.isFile() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));

    // Fan out subdirectory reads in parallel — same event loop tick benefits a tree
    // with many siblings at each level.
    const dirItems = await Promise.all(dirs.map(async (dir) => {
      if (IGNORED_DIRS.has(dir.name)) return null;
      const sub = path.join(dirPath, dir.name);
      return {
        name: dir.name,
        path: sub,
        isDirectory: true,
        children: await readDirectoryTree(sub, depth + 1),
      };
    }));
    for (const di of dirItems) if (di) items.push(di);

    for (const file of files) {
      items.push({
        name: file.name,
        path: path.join(dirPath, file.name),
        isDirectory: false,
      });
    }
    return items;
  } catch {
    return [];
  }
}

ipcMain.handle('open-folder-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('read-directory', async (_event, dirPath) => {
  return await readDirectoryTree(dirPath, 0);
});

ipcMain.handle('watch-directory', async (event, dirPath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const id = win.id;
  const existing = watchers.get(id);
  if (existing) {
    existing.watcher.close();
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    watchers.delete(id);
  }
  try {
    // Coalesce rapid-fire events from bulk operations (save-many, git checkout, etc.).
    // Dedupe same filename within a 120ms window, flush as a batch to the renderer.
    const pending = new Map(); // filename -> last eventType
    let flushTimer = null;
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const entry = watchers.get(id);
        if (entry) entry.flushTimer = null;
        if (win.isDestroyed()) return;
        const batch = [];
        for (const [filename, eventType] of pending) batch.push({ eventType, filename });
        pending.clear();
        if (batch.length === 0) return;
        // Keep backward-compatible single-event shape by dispatching individually,
        // but the dedupe + 120ms delay collapses storms.
        for (const ev of batch) win.webContents.send('directory-changed', ev);
      }, 120);
    };
    const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
      if (win.isDestroyed()) return;
      pending.set(filename || '', eventType);
      scheduleFlush();
      const entry = watchers.get(id);
      if (entry) entry.flushTimer = flushTimer;
    });
    watcher.on('error', () => {});
    watchers.set(id, { watcher, flushTimer: null });
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('unwatch-directory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const id = win.id;
  const entry = watchers.get(id);
  if (entry) {
    entry.watcher.close();
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    watchers.delete(id);
  }
});

ipcMain.handle('create-file', async (_event, filePath) => {
  try {
    const exists = await fsp.access(filePath).then(() => true).catch(() => false);
    if (exists) return { error: 'File already exists' };
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, '', 'utf-8');
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('create-folder', async (_event, folderPath) => {
  try {
    const exists = await fsp.access(folderPath).then(() => true).catch(() => false);
    if (exists) return { error: 'Folder already exists' };
    await fsp.mkdir(folderPath, { recursive: true });
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('rename-file', async (_event, oldPath, newPath) => {
  try {
    await fsp.rename(oldPath, newPath);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('delete-file', async (_event, filePath) => {
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Workspace: Cross-file search ---
ipcMain.handle('search-files', async (_event, dirPath, query, options) => {
  if (!query || !dirPath) return [];
  const { regex = false, caseSensitive = false, extensions = null } = options || {};
  let pattern;
  if (regex) {
    try { pattern = new RegExp(query, caseSensitive ? 'g' : 'gi'); }
    catch { return []; }
  }
  // null/empty → all text files (= !isBinary). Otherwise exact-match the lowercase ext.
  const extSet = (Array.isArray(extensions) && extensions.length > 0)
    ? new Set(extensions.map(e => String(e).toLowerCase().replace(/^\*?\./, '')).filter(Boolean))
    : null;

  const results = [];
  const needle = caseSensitive ? query : query.toLowerCase();

  async function processFile(fullPath, fileName) {
    try {
      const content = await fsp.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let found = false;
        if (pattern) {
          pattern.lastIndex = 0;
          found = pattern.test(line);
        } else {
          found = caseSensitive ? line.includes(query) : line.toLowerCase().includes(needle);
        }
        if (found) {
          matches.push({ lineNumber: i + 1, lineText: line.substring(0, 200) });
          if (matches.length >= 50) break;
        }
      }
      if (matches.length > 0) {
        results.push({
          filePath: fullPath,
          fileName,
          relativePath: path.relative(dirPath, fullPath),
          matches,
        });
      }
    } catch {}
  }

  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    const subWalks = [];
    const fileTasks = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) subWalks.push(walk(fullPath));
      } else if (entry.isFile() && isSupportedFile(fullPath)) {
        if (extSet) {
          const ext = path.extname(entry.name).toLowerCase().slice(1);
          if (!extSet.has(ext)) continue;
        }
        fileTasks.push(processFile(fullPath, entry.name));
      }
    }
    await Promise.all(fileTasks);
    await Promise.all(subWalks);
  }

  await walk(dirPath);
  return results;
});

// --- Link Index (wiki-links, backlinks, graph) ---
const linkIndex = {
  forward: new Map(),
  back: new Map(),
  fileNames: new Map(),
  workspacePath: null,
};

function clearBacklinksFor(filePath) {
  const oldLinks = linkIndex.forward.get(filePath) || [];
  for (const link of oldLinks) {
    const backList = linkIndex.back.get(link.resolvedTarget);
    if (backList) {
      linkIndex.back.set(link.resolvedTarget, backList.filter(b => b.source !== filePath));
    }
  }
}

function indexFile(filePath, content) {
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext).toLowerCase();
  linkIndex.fileNames.set(baseName, filePath);

  clearBacklinksFor(filePath);

  const links = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g)) {
      links.push({ raw: m[1].trim(), line: i + 1, context: line.substring(0, 200) });
    }
    for (const m of line.matchAll(/\[([^\]]*)\]\(([^)]+\.(?:md|markdown|mkd|mdx))\)/gi)) {
      links.push({ raw: m[2], line: i + 1, context: line.substring(0, 200) });
    }
  }

  const dir = path.dirname(filePath);
  const resolved = links.map(l => {
    const resolvedTarget = resolveLinkTarget(dir, l.raw);
    return { ...l, resolvedTarget };
  });

  linkIndex.forward.set(filePath, resolved);

  for (const link of resolved) {
    if (!link.resolvedTarget) continue;
    if (!linkIndex.back.has(link.resolvedTarget)) linkIndex.back.set(link.resolvedTarget, []);
    linkIndex.back.get(link.resolvedTarget).push({ source: filePath, line: link.line, context: link.context });
  }
}

function resolveLinkTarget(fromDir, target) {
  if (target.includes('/') || target.includes('\\') || /\.(md|markdown|mkd|mdx)$/i.test(target)) {
    const abs = path.resolve(fromDir, target);
    try { if (fs.existsSync(abs)) return abs; } catch {}
  }
  const normalized = target.toLowerCase().replace(/\.(md|markdown|mkd|mdx)$/i, '');
  const found = linkIndex.fileNames.get(normalized);
  if (found) return found;
  for (const [name, fpath] of linkIndex.fileNames) {
    if (name === normalized) return fpath;
  }
  return null;
}

async function buildFullIndex(dirPath) {
  linkIndex.forward.clear();
  linkIndex.back.clear();
  linkIndex.fileNames.clear();
  linkIndex.workspacePath = dirPath;

  // First pass: register all file names so wiki-link resolution has complete scope.
  async function registerNames(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    const subs = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) subs.push(registerNames(fullPath));
      } else if (entry.isFile() && /\.(md|markdown|mkd|mdx)$/i.test(entry.name)) {
        const ext = path.extname(entry.name);
        linkIndex.fileNames.set(path.basename(entry.name, ext).toLowerCase(), fullPath);
      }
    }
    await Promise.all(subs);
  }

  // Second pass: index each file's outgoing links.
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    const fileTasks = [];
    const subWalks = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) subWalks.push(walk(fullPath));
      } else if (entry.isFile() && /\.(md|markdown|mkd|mdx)$/i.test(entry.name)) {
        fileTasks.push(
          fsp.readFile(fullPath, 'utf-8')
             .then(content => indexFile(fullPath, content))
             .catch(() => {})
        );
      }
    }
    await Promise.all(fileTasks);
    await Promise.all(subWalks);
  }

  await registerNames(dirPath);
  await walk(dirPath);
}

ipcMain.handle('build-link-index', async (_event, dirPath) => {
  await buildFullIndex(dirPath);
  return { fileCount: linkIndex.fileNames.size };
});

ipcMain.handle('resolve-wiki-link', async (_event, dirPath, targetName) => {
  if (linkIndex.workspacePath !== dirPath) await buildFullIndex(dirPath);
  return resolveLinkTarget(dirPath, targetName);
});

ipcMain.handle('get-backlinks', async (_event, dirPath, filePath) => {
  if (linkIndex.workspacePath !== dirPath) await buildFullIndex(dirPath);

  const linked = (linkIndex.back.get(filePath) || []).map(b => ({
    sourcePath: b.source,
    sourceTitle: path.basename(b.source, path.extname(b.source)),
    line: b.line,
    context: b.context,
  }));

  const unlinked = [];
  if (linkIndex.fileNames.size <= 1000) {
    const baseName = path.basename(filePath, path.extname(filePath));
    const searchTerm = baseName.toLowerCase();
    const linkedSources = new Set(linked.map(l => l.sourcePath));

    // Scan candidate files in parallel — up to 1000 files, previously serialized.
    const tasks = [];
    for (const [, fpath] of linkIndex.fileNames) {
      if (fpath === filePath || linkedSources.has(fpath)) continue;
      tasks.push(fsp.readFile(fpath, 'utf-8').then((content) => {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(searchTerm)) {
            unlinked.push({
              sourcePath: fpath,
              sourceTitle: path.basename(fpath, path.extname(fpath)),
              line: i + 1,
              context: lines[i].substring(0, 200),
            });
            return;
          }
        }
      }).catch(() => {}));
    }
    await Promise.all(tasks);
  }

  return { linked, unlinked };
});

ipcMain.handle('get-file-names', async (_event, dirPath) => {
  if (linkIndex.workspacePath !== dirPath) await buildFullIndex(dirPath);
  const names = [];
  for (const [, filePath] of linkIndex.fileNames) {
    names.push({ baseName: path.basename(filePath, path.extname(filePath)), filePath });
  }
  return names;
});

// --- Save arbitrary binary / text payload from renderer via save dialog ---
ipcMain.handle('save-binary', async (event, defaultName, buffer) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const ext = path.extname(defaultName).slice(1) || 'bin';
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return false;
  try { await fsp.writeFile(result.filePath, Buffer.from(buffer)); return result.filePath; }
  catch (err) { dialog.showErrorBox('Save failed', err.message); return false; }
});

ipcMain.handle('svg-to-png', async (event, svgString, width, height, backgroundColor) => {
  const w = Math.min(Math.max(parseInt(width, 10) || 1200, 100), 8192);
  const h = Math.min(Math.max(parseInt(height, 10) || 800, 100), 8192);
  const bg = (typeof backgroundColor === 'string' && backgroundColor.trim()) || '#ffffff';
  let off = null;
  try {
    off = new BrowserWindow({
      width: w,
      height: h,
      show: false,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
    });
    const html = `<!DOCTYPE html><html><head><style>html,body{margin:0;padding:0;background:${bg};width:100%;height:100%;}body{display:flex;align-items:center;justify-content:center;}svg{display:block;width:100%;height:100%;max-width:100%;max-height:100%;}</style></head><body>${svgString}</body></html>`;
    await off.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 150));
    const image = await off.webContents.capturePage();
    off.destroy();
    off = null;
    const pngBuf = image.toPNG();
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      defaultPath: 'diagram.png',
      filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await fsp.writeFile(result.filePath, pngBuf);
    return result.filePath;
  } catch (err) {
    if (off) try { off.destroy(); } catch {}
    dialog.showErrorBox('PNG export failed', err.message);
    return false;
  }
});

ipcMain.handle('save-text', async (event, defaultName, text) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const ext = path.extname(defaultName).slice(1) || 'txt';
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return false;
  try { await fsp.writeFile(result.filePath, text, 'utf-8'); return result.filePath; }
  catch (err) { dialog.showErrorBox('Save failed', err.message); return false; }
});

// --- Reveal a file or directory in the OS file manager ---
ipcMain.handle('reveal-in-explorer', async (_event, targetPath) => {
  try {
    const stat = await fsp.stat(targetPath);
    if (stat.isDirectory()) {
      await shell.openPath(targetPath);
    } else {
      shell.showItemInFolder(targetPath);
    }
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Renderer CSP — must match the <meta> tag in index.html.
const RENDERER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self' https://api.github.com https://api.githubusercontent.com https://plausible.io; " +
  "worker-src 'self' blob:; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none';";

// --- Navigation + new-window hardening ---
app.on('web-contents-created', (_event, contents) => {
  // Block all navigation; only file-drop (file:/// → supported file) is allowed.
  contents.on('will-navigate', (navEvent, url) => {
    navEvent.preventDefault();
    if (url.startsWith('file:///')) {
      const filePath = decodeURIComponent(url.replace('file:///', '').replace(/\//g, '\\'));
      if (isSupportedFile(filePath)) {
        const win = BrowserWindow.fromWebContents(contents);
        if (win) loadMarkdownFile(win, filePath);
      }
    }
  });

  // Block new windows that try to navigate outside the app; open http/https externally.
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
});

// --- App lifecycle ---
app.whenReady().then(async () => {
  initLocale();

  // Belt-and-suspenders CSP: set via response header in addition to the <meta> tag.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [RENDERER_CSP],
      },
    });
  });

  // If an installer is currently mid-install, bail out before showing any UI.
  try {
    const { checkUpdateInProgress } = require('./updater');
    if (checkUpdateInProgress()) {
      await dialog.showMessageBox({
        type: 'info',
        title: t('update.inProgressTitle'),
        message: t('update.inProgressMessage'),
        buttons: ['OK'],
      });
      app.quit();
      return;
    }
  } catch {}

  const filePath = getFilePathFromArgs(process.argv);
  const win = createWindow(filePath);
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => { if (!win.isDestroyed()) checkRecovery(win); }, 2000);
    setTimeout(() => {
      if (!win.isDestroyed()) {
        try {
          const { checkForUpdates } = require('./updater');
          checkForUpdates(win, t);
        } catch {}
      }
    }, 4000);
  });
});

ipcMain.on('update-action', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  try {
    const { handleUpdateAction } = require('./updater');
    handleUpdateAction(win, action);
  } catch {}
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (windows.size === 0) createWindow(null);
});
