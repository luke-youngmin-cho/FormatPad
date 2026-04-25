// FormatPad browser platform adapter.
// Shims window.formatpad so the Electron-shaped renderer runs unchanged in a browser.
//
// Workspace features (file tree / workspace search / wiki-link backlinks) work
// on Chromium-based browsers via the File System Access API. On browsers
// without FSA (Firefox / Safari), Open Folder surfaces a clear error rather
// than silently no-op'ing.

const FS_SUPPORTED =
  typeof window.showOpenFilePicker === 'function' &&
  typeof window.showSaveFilePicker === 'function';
const FSA_DIR_SUPPORTED = typeof window.showDirectoryPicker === 'function';

const SUPPORTED_EXTS = [
  'md','markdown','mkd','mdx','mmd',
  'json','jsonl','ndjson','yaml','yml',
  'html','htm','xml',
  'csv','tsv','toml','ini','conf','properties','env',
  'log','txt',
];
const TRUSTED_URL_HOSTS = new Set([
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'cdn.jsdelivr.net',
]);
const MAX_URL_BYTES = 10 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 20_000;
const IGNORED_DIRS = new Set(['node_modules','.git','.svn','__pycache__','dist','build','.next','.cache','.idea','.vscode']);
const BINARY_EXTS = new Set([
  'exe','dll','so','dylib','bin','msi','app','class','jar',
  'zip','rar','7z','tar','gz','bz2','xz',
  'png','jpg','jpeg','gif','bmp','ico','webp','tiff',
  'mp4','avi','mov','wmv','mkv','webm','mp3','wav','ogg','flac','m4a',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'db','sqlite',
]);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}
function isBinary(name) { return BINARY_EXTS.has(extOf(name)); }
function isMarkdown(name) { return /\.(md|markdown|mkd|mdx)$/i.test(name); }
function basenameNoExt(name) {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const b = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
}
function dirOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? '/' : p.slice(0, i);
}
function baseOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}
function safeDecode(value) {
  try { return decodeURIComponent(value || ''); }
  catch { return value || ''; }
}
function sanitizeFileName(name, fallback = 'shared.md') {
  const cleaned = (name || fallback)
    .split(/[\\/]/).pop()
    .replace(/[<>:"|?*\x00-\x1f]/g, '-')
    .trim();
  return cleaned || fallback;
}
function inferNameFromUrl(url, fallback = 'shared.md') {
  const pathName = safeDecode(url.pathname);
  const name = pathName.split('/').filter(Boolean).pop();
  return sanitizeFileName(name || fallback, fallback);
}
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}
function abortError(message) {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}
function isTrustedHost(hostname) {
  return TRUSTED_URL_HOSTS.has(String(hostname || '').toLowerCase());
}
function assertHttpsUrl(url) {
  if (url.protocol !== 'https:') throw new Error('HTTPS required for URL imports.');
  const decodedSearch = safeDecode(url.search);
  if (/(?:file:\/\/|data:)/i.test(decodedSearch)) {
    throw new Error('URL imports cannot contain file:// or data: query values.');
  }
}
function parseUrl(raw) {
  const url = new URL(String(raw || '').trim());
  assertHttpsUrl(url);
  return url;
}
function githubBlobToRaw(input) {
  let parts;
  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    parts = url.pathname.split('/').filter(Boolean);
  } catch {
    parts = String(input || '').split('/').filter(Boolean);
  }
  const blobIndex = parts.indexOf('blob');
  if (blobIndex !== 2 || parts.length < 5) return null;
  const owner = parts[0];
  const repo = parts[1];
  const ref = parts[3];
  const filePath = parts.slice(4).join('/');
  return {
    url: new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`),
    name: sanitizeFileName(filePath.split('/').pop() || `${repo}.md`),
  };
}
function gistIdFromInput(input) {
  const raw = String(input || '').trim();
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== 'gist.github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[1] : parts[0] || null;
  } catch {
    const parts = raw.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[1] : parts[0] || null;
  }
}

// Renderer treats filePath as an opaque string. Single-file opens use
// "web:<id>/<fileName>". Workspace entries use synthetic unix paths rooted
// at "/" so string ops in the renderer (split, substring on the last slash,
// etc.) work without modification.
const PATH_PREFIX = 'web:';
let handleCounter = 0;
const singleFileHandles = new Map(); // id -> FileSystemFileHandle

function registerSingleFileHandle(handle) {
  const id = String(++handleCounter);
  singleFileHandles.set(id, handle);
  return `${PATH_PREFIX}${id}/${handle.name}`;
}
function noHandlePath(fileName) {
  const id = `${++handleCounter}-nohandle`;
  return `${PATH_PREFIX}${id}/${fileName}`;
}
function singleFileHandleFromPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.startsWith(PATH_PREFIX)) return null;
  const id = filePath.slice(PATH_PREFIX.length).split('/')[0];
  return singleFileHandles.get(id) || null;
}

// Workspace state
const WORKSPACE_ROOT = '/';
let workspaceDirHandle = null;          // FileSystemDirectoryHandle for the picked root
const wsFileHandles = new Map();        // "/path/file.md" -> FileSystemFileHandle
const wsDirHandles = new Map();         // "/path" -> FileSystemDirectoryHandle
const wsTreeByPath = new Map();         // "/path" -> [children] (cached subtree at that dir)
let linkIndexForward = new Map();       // filePath -> [{raw, resolvedTarget, line, context}]
let linkIndexBack = new Map();          // filePath -> [{source, line, context}]
let linkIndexNames = new Map();         // baseName.toLowerCase() -> filePath
let linkIndexRootPath = null;           // last indexed root (sanity check)

function clearWorkspace() {
  workspaceDirHandle = null;
  wsFileHandles.clear();
  wsDirHandles.clear();
  wsTreeByPath.clear();
  linkIndexForward = new Map();
  linkIndexBack = new Map();
  linkIndexNames = new Map();
  linkIndexRootPath = null;
}

function joinWsPath(parent, name) {
  if (parent === WORKSPACE_ROOT) return '/' + name;
  return parent + '/' + name;
}

async function enumerateDirectory(dirHandle, dirPath, depth = 0) {
  if (depth > 8) return [];
  wsDirHandles.set(dirPath, dirHandle);
  const items = [];
  const dirs = [];
  const files = [];
  try {
    for await (const [name, entry] of dirHandle.entries()) {
      if (name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        if (IGNORED_DIRS.has(name)) continue;
        dirs.push({ name, entry });
      } else {
        files.push({ name, entry });
      }
    }
  } catch (err) {
    console.warn('Failed to read directory', dirPath, err);
    return [];
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const dirItems = await Promise.all(dirs.map(async ({ name, entry }) => {
    const subPath = joinWsPath(dirPath, name);
    const children = await enumerateDirectory(entry, subPath, depth + 1);
    return { name, path: subPath, isDirectory: true, children };
  }));
  for (const d of dirItems) items.push(d);

  for (const { name, entry } of files) {
    const fp = joinWsPath(dirPath, name);
    wsFileHandles.set(fp, entry);
    items.push({ name, path: fp, isDirectory: false });
  }

  wsTreeByPath.set(dirPath, items);
  return items;
}

async function readFileFromHandle(handle) {
  const f = await handle.getFile();
  return await f.text();
}

function gitFsError(err) {
  return { error: err?.name || err?.message || String(err) };
}

function normalizeGitFsPath(path) {
  const raw = String(path || '/').replace(/\\/g, '/');
  const parts = raw.split('/').filter(Boolean);
  if (parts.includes('..')) throw new Error('Parent paths are not allowed');
  return '/' + parts.join('/');
}

async function getGitFsDirHandle(dirPath, create = false) {
  if (!workspaceDirHandle) throw new Error('No workspace');
  const normalized = normalizeGitFsPath(dirPath);
  if (normalized === '/') return workspaceDirHandle;
  let handle = workspaceDirHandle;
  let cursor = '';
  for (const part of normalized.split('/').filter(Boolean)) {
    handle = await handle.getDirectoryHandle(part, { create });
    cursor += '/' + part;
    wsDirHandles.set(cursor || '/', handle);
  }
  return handle;
}

async function getGitFsFileHandle(filePath, create = false) {
  const normalized = normalizeGitFsPath(filePath);
  const parent = dirOf(normalized);
  const name = baseOf(normalized);
  const parentHandle = await getGitFsDirHandle(parent, create);
  const handle = await parentHandle.getFileHandle(name, { create });
  wsFileHandles.set(normalized, handle);
  return handle;
}

async function gitFsReadFile(filePath, options) {
  try {
    const handle = await getGitFsFileHandle(filePath, false);
    const file = await handle.getFile();
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding) return await file.text();
    return new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsWriteFile(filePath, data) {
  try {
    const normalized = normalizeGitFsPath(filePath);
    const handle = await getGitFsFileHandle(normalized, true);
    let payload = data;
    if (data?.type === 'Buffer' && Array.isArray(data.data)) payload = new Uint8Array(data.data);
    else if (Array.isArray(data)) payload = new Uint8Array(data);
    await saveViaHandle(handle, payload);
    wsFileHandles.set(normalized, handle);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsUnlink(filePath) {
  try {
    const normalized = normalizeGitFsPath(filePath);
    const parentHandle = await getGitFsDirHandle(dirOf(normalized), false);
    await parentHandle.removeEntry(baseOf(normalized));
    wsFileHandles.delete(normalized);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsReaddir(dirPath, options) {
  try {
    const normalized = normalizeGitFsPath(dirPath);
    const handle = await getGitFsDirHandle(normalized, false);
    const entries = [];
    for await (const [name, entry] of handle.entries()) {
      if (options?.withFileTypes) {
        entries.push({ name, type: entry.kind === 'directory' ? 'dir' : 'file' });
      } else {
        entries.push(name);
      }
    }
    return entries.sort((a, b) => String(a.name || a).localeCompare(String(b.name || b)));
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsMkdir(dirPath, options) {
  try {
    await getGitFsDirHandle(dirPath, !!options?.recursive || true);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsRmdir(dirPath) {
  try {
    const normalized = normalizeGitFsPath(dirPath);
    const parentHandle = await getGitFsDirHandle(dirOf(normalized), false);
    await parentHandle.removeEntry(baseOf(normalized), { recursive: false });
    wsDirHandles.delete(normalized);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsStat(targetPath) {
  try {
    const normalized = normalizeGitFsPath(targetPath);
    if (normalized === '/') {
      return { type: 'dir', size: 0, mode: 0o040000, mtimeMs: Date.now(), ctimeMs: Date.now() };
    }
    try {
      const handle = await getGitFsFileHandle(normalized, false);
      const file = await handle.getFile();
      return { type: 'file', size: file.size, mode: 0o100644, mtimeMs: file.lastModified, ctimeMs: file.lastModified };
    } catch {
      await getGitFsDirHandle(normalized, false);
      return { type: 'dir', size: 0, mode: 0o040000, mtimeMs: Date.now(), ctimeMs: Date.now() };
    }
  } catch (err) {
    return gitFsError(err);
  }
}

async function buildLinkIndexFull() {
  linkIndexForward = new Map();
  linkIndexBack = new Map();
  linkIndexNames = new Map();
  for (const [p] of wsFileHandles) {
    if (!isMarkdown(p)) continue;
    const name = basenameNoExt(baseOf(p)).toLowerCase();
    linkIndexNames.set(name, p);
  }
  const tasks = [];
  for (const [p, h] of wsFileHandles) {
    if (!isMarkdown(p)) continue;
    tasks.push(readFileFromHandle(h).then((content) => indexMarkdown(p, content)).catch(() => {}));
  }
  await Promise.all(tasks);
  linkIndexRootPath = WORKSPACE_ROOT;
}

function resolveLinkTarget(fromDir, target) {
  // Path-ish targets: resolve relative/absolute within workspace
  if (target.includes('/') || target.includes('\\') || /\.(md|markdown|mkd|mdx)$/i.test(target)) {
    const joined = target.startsWith('/') ? target : (fromDir === WORKSPACE_ROOT ? '/' + target : fromDir + '/' + target);
    // Normalize (resolve .. / .)
    const parts = joined.split('/').filter(Boolean);
    const out = [];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    const abs = '/' + out.join('/');
    if (wsFileHandles.has(abs)) return abs;
  }
  const normalized = target.toLowerCase().replace(/\.(md|markdown|mkd|mdx)$/i, '');
  return linkIndexNames.get(normalized) || null;
}

function indexMarkdown(filePath, content) {
  const fromDir = dirOf(filePath);
  const lines = content.split('\n');
  const links = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g)) {
      links.push({ raw: m[1].trim(), line: i + 1, context: line.substring(0, 200) });
    }
    for (const m of line.matchAll(/\[([^\]]*)\]\(([^)]+\.(?:md|markdown|mkd|mdx))\)/gi)) {
      links.push({ raw: m[2], line: i + 1, context: line.substring(0, 200) });
    }
  }
  const resolved = links.map((l) => ({ ...l, resolvedTarget: resolveLinkTarget(fromDir, l.raw) }));
  linkIndexForward.set(filePath, resolved);
  for (const link of resolved) {
    if (!link.resolvedTarget) continue;
    if (!linkIndexBack.has(link.resolvedTarget)) linkIndexBack.set(link.resolvedTarget, []);
    linkIndexBack.get(link.resolvedTarget).push({ source: filePath, line: link.line, context: link.context });
  }
}

// ==================== Single-file open / save ====================
let loadFileCb = null;
let urlConfirmCb = null;
let urlErrorCb = null;

async function fireLoad(file, handle) {
  const content = await file.text();
  const fileName = handle ? handle.name : file.name;
  const filePath = handle ? registerSingleFileHandle(handle) : noHandlePath(fileName);
  if (loadFileCb) loadFileCb({ filePath, dirPath: null, content });
}

async function openFileHandles(handles = []) {
  let opened = 0;
  for (const handle of handles || []) {
    if (!handle || handle.kind !== 'file') continue;
    const file = await handle.getFile();
    if (isBinary(file.name)) continue;
    await fireLoad(file, handle);
    opened++;
  }
  return opened > 0;
}

async function fireLoadText({ content, name, sourceUrl, source = 'url' }) {
  if (!loadFileCb) return;
  loadFileCb({
    filePath: null,
    dirPath: null,
    content,
    title: sanitizeFileName(name || 'shared.md'),
    source,
    sourceUrl,
    savedContent: '',
    forceUnsaved: true,
  });
}

async function confirmUrlFetch(detail) {
  if (urlConfirmCb) return await urlConfirmCb(detail);
  return window.confirm(detail.message || `Fetch file from ${detail.hostname}?`);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('URL fetch timed out after 20 seconds.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseTextWithLimit(response, maxBytes = MAX_URL_BYTES) {
  const failLarge = () => new Error(`URL import exceeds the ${formatBytes(maxBytes)} safety limit.`);
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw failLarge();
    return new TextDecoder().decode(buffer);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw failLarge();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock?.();
  }
}

async function fetchUrlTextContent(url, { skipHostConfirmation = false } = {}) {
  assertHttpsUrl(url);
  if (!skipHostConfirmation && !isTrustedHost(url.hostname)) {
    const ok = await confirmUrlFetch({
      kind: 'host',
      hostname: url.hostname,
      url: url.href,
      message: `Fetch file from ${url.hostname}?`,
    });
    if (!ok) throw abortError('URL import canceled.');
  }

  const response = await fetchWithTimeout(url.href);
  if (!response.ok) throw new Error(`URL fetch failed (${response.status} ${response.statusText}).`);

  const finalUrl = response.url ? new URL(response.url) : url;
  assertHttpsUrl(finalUrl);
  if (!skipHostConfirmation && !isTrustedHost(finalUrl.hostname) && finalUrl.hostname !== url.hostname) {
    const ok = await confirmUrlFetch({
      kind: 'host',
      hostname: finalUrl.hostname,
      url: finalUrl.href,
      message: `Fetch redirected file from ${finalUrl.hostname}?`,
    });
    if (!ok) throw abortError('URL import canceled.');
  }

  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_URL_BYTES) {
    throw new Error(`URL import is ${formatBytes(length)}, above the ${formatBytes(MAX_URL_BYTES)} safety limit.`);
  }

  return {
    content: await readResponseTextWithLimit(response),
    finalUrl,
  };
}

async function fetchTextUrl(url, { name, sourceUrl, skipHostConfirmation = false } = {}) {
  const { content, finalUrl } = await fetchUrlTextContent(url, { skipHostConfirmation });

  await fireLoadText({
    content,
    name: name || inferNameFromUrl(finalUrl),
    sourceUrl: sourceUrl || finalUrl.href,
  });
  return { success: true, count: 1 };
}

async function openGitHubBlob(input) {
  const raw = githubBlobToRaw(input);
  if (!raw) throw new Error('Invalid GitHub blob URL.');
  return await fetchTextUrl(raw.url, { name: raw.name, sourceUrl: raw.url.href, skipHostConfirmation: true });
}

async function openGist(input) {
  const gistId = gistIdFromInput(input);
  if (!gistId) throw new Error('Invalid Gist URL.');
  const apiUrl = new URL(`https://api.github.com/gists/${gistId}`);
  const response = await fetchWithTimeout(apiUrl.href, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`Gist fetch failed (${response.status} ${response.statusText}).`);
  const gist = await response.json();
  const files = Object.values(gist.files || {}).filter((file) => file?.raw_url);
  if (files.length === 0) throw new Error('Gist has no raw files to open.');

  let count = 0;
  for (const file of files) {
    const rawUrl = parseUrl(file.raw_url);
    await fetchTextUrl(rawUrl, {
      name: file.filename || inferNameFromUrl(rawUrl),
      sourceUrl: rawUrl.href,
      skipHostConfirmation: true,
    });
    count++;
  }
  return { success: true, count };
}

async function openUrlSource(input, options = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('URL is empty.');

  const githubRaw = githubBlobToRaw(raw);
  if (githubRaw) {
    return await fetchTextUrl(githubRaw.url, {
      name: options.name || githubRaw.name,
      sourceUrl: githubRaw.url.href,
      skipHostConfirmation: true,
    });
  }

  const gistId = gistIdFromInput(raw);
  if (gistId && /^(?:https:\/\/gist\.github\.com\/|[a-f0-9]{6,}|[^/]+\/[a-f0-9]{6,})/i.test(raw)) {
    return await openGist(raw);
  }

  const url = parseUrl(raw);
  return await fetchTextUrl(url, { name: options.name || inferNameFromUrl(url), sourceUrl: url.href });
}

async function openUrlFromParams(paramsLike) {
  const params = paramsLike instanceof URLSearchParams
    ? paramsLike
    : new URLSearchParams(String(paramsLike || '').replace(/^\?/, ''));
  if (params.has('github')) return await openGitHubBlob(params.get('github'));
  if (params.has('gist')) return await openGist(params.get('gist'));
  if (params.has('src')) return await openUrlSource(params.get('src'), { name: params.get('name') || undefined });
  return { success: false, count: 0 };
}

async function pickAndOpen() {
  if (FS_SUPPORTED) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Supported formats', accept: { 'text/*': SUPPORTED_EXTS.map((e) => '.' + e) } }],
      });
      for (const h of handles) {
        const f = await h.getFile();
        await fireLoad(f, h);
      }
      return true;
    } catch (e) {
      if (e?.name === 'AbortError') return false;
    }
  }
  return await new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = SUPPORTED_EXTS.map((e) => '.' + e).join(',');
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    input.addEventListener('change', async () => {
      for (const f of input.files) await fireLoad(f, null);
      finish(input.files.length > 0);
    });
    input.addEventListener('cancel', () => finish(false));
    window.addEventListener('focus', () => setTimeout(() => finish(false), 300), { once: true });
    input.click();
  });
}

function downloadBlob(fileName, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function defaultSaveName() {
  const m = (document.title || '').match(/^(?:•\s*)?(.+?)\s*-\s*FormatPad$/);
  if (m && m[1] && m[1] !== 'FormatPad') return m[1];
  return 'untitled.txt';
}

async function saveViaHandle(handle, content) {
  const w = await handle.createWritable();
  await w.write(content);
  await w.close();
}

async function saveFile(filePath, content) {
  if (filePath === 'localStorage:fp-user-snippets') {
    localStorage.setItem('fp-user-snippets', content);
    return true;
  }
  // Workspace file?
  const wsHandle = wsFileHandles.get(filePath);
  if (wsHandle) {
    try { await saveViaHandle(wsHandle, content); return true; }
    catch (err) { console.warn('workspace saveFile failed', err); return false; }
  }
  // Single-file open via FSA?
  const single = singleFileHandleFromPath(filePath);
  if (single) {
    try { await saveViaHandle(single, content); return true; }
    catch (err) { console.warn('single-file saveFile failed', err); return false; }
  }
  const fallbackName = sanitizeFileName(baseOf(filePath || '') || defaultSaveName(), defaultSaveName());
  downloadBlob(fallbackName, new Blob([content], { type: 'text/plain;charset=utf-8' }));
  return true;
}

async function saveFileAs(content) {
  const suggested = defaultSaveName();
  if (FS_SUPPORTED) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'Supported formats', accept: { 'text/plain': SUPPORTED_EXTS.map((e) => '.' + e) } }],
      });
      await saveViaHandle(handle, content);
      return registerSingleFileHandle(handle);
    } catch (e) {
      if (e?.name === 'AbortError') return null;
    }
  }
  const name = window.prompt('Save file as:', suggested);
  if (!name) return null;
  downloadBlob(name, new Blob([content], { type: 'text/plain;charset=utf-8' }));
  return noHandlePath(name);
}

// ==================== Workspace ====================
async function openFolderDialog() {
  if (!FSA_DIR_SUPPORTED) {
    window.alert('Open Folder requires a Chromium-based browser (Chrome, Edge, Arc, Opera).\n\nFirefox and Safari do not yet support the File System Access API needed to browse a folder in place.');
    return null;
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    clearWorkspace();
    workspaceDirHandle = dir;
    await enumerateDirectory(dir, WORKSPACE_ROOT);
    return WORKSPACE_ROOT;
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    console.warn('openFolderDialog failed', e);
    window.alert('Failed to open folder: ' + (e?.message || e));
    return null;
  }
}

async function readDirectory(dirPath) {
  if (!workspaceDirHandle) return [];
  // Re-enumerate on every call so the Refresh button picks up external changes.
  // For the root, walk the whole tree; for a subdir, just that subtree.
  if (dirPath === WORKSPACE_ROOT || dirPath === '/') {
    wsFileHandles.clear();
    wsDirHandles.clear();
    wsTreeByPath.clear();
    const items = await enumerateDirectory(workspaceDirHandle, WORKSPACE_ROOT);
    return items;
  }
  const handle = wsDirHandles.get(dirPath);
  if (!handle) return [];
  const items = await enumerateDirectory(handle, dirPath);
  return items;
}

async function readFile(filePath) {
  const handle = wsFileHandles.get(filePath);
  if (!handle) return { error: 'File not found in workspace' };
  try {
    const content = await readFileFromHandle(handle);
    return {
      content,
      filePath,
      fileName: baseOf(filePath),
      dirPath: dirOf(filePath),
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

async function searchFiles(_dirPath, query, options) {
  if (!query || !workspaceDirHandle) return [];
  const { regex = false, caseSensitive = false, extensions = null } = options || {};
  let pattern = null;
  if (regex) {
    try { pattern = new RegExp(query, caseSensitive ? 'g' : 'gi'); }
    catch { return []; }
  }
  const extSet = (Array.isArray(extensions) && extensions.length > 0)
    ? new Set(extensions.map((e) => String(e).toLowerCase().replace(/^\*?\./, '')).filter(Boolean))
    : null;
  const needle = caseSensitive ? query : query.toLowerCase();
  const results = [];

  const tasks = [];
  for (const [fullPath, handle] of wsFileHandles) {
    const fileName = baseOf(fullPath);
    if (isBinary(fileName)) continue;
    if (extSet && !extSet.has(extOf(fileName))) continue;
    tasks.push((async () => {
      let content;
      try { content = await readFileFromHandle(handle); }
      catch { return; }
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let found;
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
          relativePath: fullPath.startsWith('/') ? fullPath.slice(1) : fullPath,
          matches,
        });
      }
    })());
  }
  await Promise.all(tasks);
  return results;
}

async function buildLinkIndex(_dirPath) {
  if (!workspaceDirHandle) return { fileCount: 0 };
  await buildLinkIndexFull();
  return { fileCount: linkIndexNames.size };
}

async function resolveWikiLink(_dirPath, targetName) {
  if (!workspaceDirHandle) return null;
  if (linkIndexRootPath !== WORKSPACE_ROOT) await buildLinkIndexFull();
  return resolveLinkTarget(WORKSPACE_ROOT, targetName);
}

async function getBacklinks(_dirPath, filePath) {
  if (!workspaceDirHandle) return { linked: [], unlinked: [] };
  if (linkIndexRootPath !== WORKSPACE_ROOT) await buildLinkIndexFull();
  const linked = (linkIndexBack.get(filePath) || []).map((b) => ({
    sourcePath: b.source,
    sourceTitle: basenameNoExt(baseOf(b.source)),
    line: b.line,
    context: b.context,
  }));
  const unlinked = [];
  if (linkIndexNames.size <= 1000) {
    const baseName = basenameNoExt(baseOf(filePath));
    const searchTerm = baseName.toLowerCase();
    const linkedSources = new Set(linked.map((l) => l.sourcePath));
    const tasks = [];
    for (const [, fpath] of linkIndexNames) {
      if (fpath === filePath || linkedSources.has(fpath)) continue;
      const handle = wsFileHandles.get(fpath);
      if (!handle) continue;
      tasks.push(readFileFromHandle(handle).then((content) => {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(searchTerm)) {
            unlinked.push({
              sourcePath: fpath,
              sourceTitle: basenameNoExt(baseOf(fpath)),
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
}

async function getFileNames(_dirPath) {
  if (!workspaceDirHandle) return [];
  if (linkIndexRootPath !== WORKSPACE_ROOT) await buildLinkIndexFull();
  const names = [];
  for (const [, fpath] of linkIndexNames) {
    names.push({ baseName: basenameNoExt(baseOf(fpath)), filePath: fpath });
  }
  return names;
}

// Mutation ops — FSA supports create/remove but not direct rename. Renames go
// via read-then-write-then-remove. Best-effort: surface errors as an alert.
async function createFile(filePath) {
  if (!workspaceDirHandle) return { error: 'No workspace' };
  const parent = dirOf(filePath);
  const name = baseOf(filePath);
  const parentHandle = parent === WORKSPACE_ROOT ? workspaceDirHandle : wsDirHandles.get(parent);
  if (!parentHandle) return { error: 'Parent directory not found' };
  try {
    const fh = await parentHandle.getFileHandle(name, { create: true });
    wsFileHandles.set(filePath, fh);
    return { success: true };
  } catch (err) {
    const msg = err?.message || String(err);
    window.alert('Failed to create file: ' + msg);
    return { error: msg };
  }
}

async function createFolder(folderPath) {
  if (!workspaceDirHandle) return { error: 'No workspace' };
  const parent = dirOf(folderPath);
  const name = baseOf(folderPath);
  const parentHandle = parent === WORKSPACE_ROOT ? workspaceDirHandle : wsDirHandles.get(parent);
  if (!parentHandle) return { error: 'Parent directory not found' };
  try {
    const dh = await parentHandle.getDirectoryHandle(name, { create: true });
    wsDirHandles.set(folderPath, dh);
    return { success: true };
  } catch (err) {
    const msg = err?.message || String(err);
    window.alert('Failed to create folder: ' + msg);
    return { error: msg };
  }
}

async function renameFile(oldPath, newPath) {
  if (!workspaceDirHandle) return { error: 'No workspace' };
  const fileHandle = wsFileHandles.get(oldPath);
  if (!fileHandle) return { error: 'File not found in workspace' };
  // FSA doesn't expose rename directly; copy-then-delete within the same parent.
  if (dirOf(oldPath) !== dirOf(newPath)) {
    const msg = 'Rename across folders is not supported in the browser.';
    window.alert(msg);
    return { error: msg };
  }
  const parent = dirOf(newPath);
  const parentHandle = parent === WORKSPACE_ROOT ? workspaceDirHandle : wsDirHandles.get(parent);
  if (!parentHandle) return { error: 'Parent directory not found' };
  const newName = baseOf(newPath);
  const oldName = baseOf(oldPath);
  try {
    const content = await readFileFromHandle(fileHandle);
    const newHandle = await parentHandle.getFileHandle(newName, { create: true });
    await saveViaHandle(newHandle, content);
    await parentHandle.removeEntry(oldName);
    wsFileHandles.delete(oldPath);
    wsFileHandles.set(newPath, newHandle);
    return { success: true };
  } catch (err) {
    const msg = err?.message || String(err);
    window.alert('Failed to rename: ' + msg);
    return { error: msg };
  }
}

async function deleteFile(filePath) {
  if (!workspaceDirHandle) return { error: 'No workspace' };
  const parent = dirOf(filePath);
  const name = baseOf(filePath);
  const parentHandle = parent === WORKSPACE_ROOT ? workspaceDirHandle : wsDirHandles.get(parent);
  if (!parentHandle) return { error: 'Parent directory not found' };
  // Confirm since FSA delete is permanent (no Trash on web).
  if (!window.confirm(`Permanently delete "${name}"?\n\n(Browsers do not support Trash — this cannot be undone.)`)) {
    return { error: 'Canceled' };
  }
  try {
    await parentHandle.removeEntry(name, { recursive: true });
    wsFileHandles.delete(filePath);
    wsDirHandles.delete(filePath);
    return { success: true };
  } catch (err) {
    const msg = err?.message || String(err);
    window.alert('Failed to delete: ' + msg);
    return { error: msg };
  }
}

// ==================== Close flow ====================
function webShowSaveDialog() {
  const save = window.confirm('You have unsaved changes.\n\nOK = Save\nCancel = choose Discard or keep editing');
  if (save) return 'save';
  const discard = window.confirm('Discard unsaved changes?\n\nOK = Discard\nCancel = keep editing');
  return discard ? 'discard' : 'cancel';
}

// ==================== SVG → PNG ====================
function svgToPngBrowser(svgString, w, h, bg) {
  const width = Math.min(Math.max(parseInt(w, 10) || 1200, 100), 8192);
  const height = Math.min(Math.max(parseInt(h, 10) || 800, 100), 8192);
  const bgColor = (typeof bg === 'string' && bg.trim()) || '#ffffff';
  return new Promise((resolve) => {
    const img = new Image();
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((pngBlob) => {
          URL.revokeObjectURL(url);
          if (!pngBlob) return resolve(false);
          downloadBlob('diagram.png', pngBlob);
          resolve(true);
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        resolve(false);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
    img.src = url;
  });
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ==================== Adapter object ====================
const adapter = {
  platform: 'web',
  fsaDirSupported: FSA_DIR_SUPPORTED,

  onLoadMarkdown(cb) { loadFileCb = cb; },
  setUrlConfirmHandler(cb) { urlConfirmCb = cb; },
  setUrlErrorHandler(cb) { urlErrorCb = cb; },
  openUrl: openUrlSource,
  openUrlFromParams,
  async fetchUrlText(raw, options = {}) {
    const url = parseUrl(raw);
    const { content, finalUrl } = await fetchUrlTextContent(url, options);
    return { content, url: finalUrl.href };
  },
  openTextFromUrl: fireLoadText,
  showUrlError(err) {
    const message = err?.message || String(err);
    if (err?.name === 'AbortError') return;
    if (urlErrorCb) { urlErrorCb(err); return; }
    window.alert(message);
  },
  openFileDialog() { pickAndOpen(); },
  openFileHandles,
  getPathForFile(file) { return file; },
  dropFile(fileOrPath) {
    if (fileOrPath && typeof fileOrPath.text === 'function') fireLoad(fileOrPath, null);
  },

  readFile,
  saveFile,
  saveFileAs,

  setTitle(title) { document.title = title; },

  getLocale() {
    const raw = navigator.language || 'en';
    const direct = raw.toLowerCase();
    const short = direct.split('-')[0];
    const known = ['en','ko','zh','zh-tw','ja','es','fr','de','pt','ru','ar','hi','it','nl','pl','tr','vi','th','sv','da','fi','nb','cs','el','hu','ro','uk','id','ms','he'];
    let code = 'en';
    for (const c of [direct, short]) {
      const match = known.find((k) => k === c);
      if (match) { code = match === 'zh-tw' ? 'zh-TW' : match; break; }
    }
    return Promise.resolve({ code, mtime: 0 });
  },
  setLocale() {},

  getSystemTheme() {
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return Promise.resolve(dark ? 'dark' : 'light');
  },

  onCheckBeforeClose() {},
  showSaveDialog() { return Promise.resolve(webShowSaveDialog()); },
  confirmClose() {},

  autoSaveRecovery() { return Promise.resolve(); },
  clearRecovery() { return Promise.resolve(); },

  saveImage(_filePath, buffer, ext) {
    const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
    return Promise.resolve(`data:${mime};base64,${bytesToBase64(buffer)}`);
  },
  saveText(name, text) { downloadBlob(name, new Blob([text], { type: 'text/plain;charset=utf-8' })); return Promise.resolve(name); },
  saveBinary(name, buffer) { downloadBlob(name, new Blob([buffer])); return Promise.resolve(name); },
  svgToPng(svg, w, h, bg) { return svgToPngBrowser(svg, w, h, bg); },

  // Workspace
  openFolderDialog,
  readDirectory,
  gitFs: {
    readFile: gitFsReadFile,
    writeFile: gitFsWriteFile,
    unlink: gitFsUnlink,
    readdir: gitFsReaddir,
    mkdir: gitFsMkdir,
    rmdir: gitFsRmdir,
    stat: gitFsStat,
    lstat: gitFsStat,
  },
  watchDirectory() { return Promise.resolve(); },
  unwatchDirectory() { return Promise.resolve(); },
  onDirectoryChanged() { /* no file watcher on web; Refresh button re-reads */ },
  createFile,
  createFolder,
  renameFile,
  deleteFile,
  searchFiles,
  buildLinkIndex,
  resolveWikiLink,
  getBacklinks,
  getFileNames,
  revealInExplorer() {
    window.alert('"Reveal in File Explorer" is not available in the browser.');
  },
  getAppInfo() { return Promise.resolve({ isPackaged: true, version: process.env.APP_VERSION || '' }); },
  openDefaultAppsSettings() { /* button is hidden on web */ },

  // Auto-updater — desktop-only
  onShowUpdateDialog() {},
  onUpdateProgress() {},
  onUpdateError() {},
  updateAction() {},
};

window.formatpad = adapter;

// Any workspace path persisted from a prior desktop session on the same origin
// would be meaningless here (no FSA handle). Clear once.
try {
  if (localStorage.getItem('fp-workspace-path')) {
    localStorage.removeItem('fp-workspace-path');
  }
} catch {}

// beforeunload guard: renderer installs a dirty-state probe.
let dirtyProbe = null;
adapter.__setDirtyProbe = (fn) => { dirtyProbe = fn; };
window.addEventListener('beforeunload', (e) => {
  try {
    if (dirtyProbe && dirtyProbe()) {
      e.preventDefault();
      e.returnValue = '';
    }
  } catch {}
});
