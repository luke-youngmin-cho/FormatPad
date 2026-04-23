import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { undo as cmUndo, redo as cmRedo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { html as htmlLang } from '@codemirror/lang-html';
import yamljs from 'js-yaml';
import Papa from 'papaparse';
import { parse as tomlParse } from 'smol-toml';
import DOMPurify from 'dompurify';
import svgPanZoom from 'svg-pan-zoom';
import { SpreadsheetGrid } from './spreadsheet-grid.js';
import { JSONEditor } from './json-editor.js';
import ini from 'ini';
import { jsonrepair } from 'jsonrepair';
import { JSONPath } from 'jsonpath-plus';
import Ajv from 'ajv';
import TurndownService from 'turndown';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { autocompletion } from '@codemirror/autocomplete';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import hljs from 'highlight.js';
import katex from 'katex';
import { t, setLocale, getLocaleCode, LANGUAGES } from './i18n.js';
import {
  builtinThemes, applyThemeColors,
  getSavedThemeId, saveThemeId,
  getCustomThemes, addCustomTheme, updateCustomThemeColors,
  updateCustomThemeName, deleteCustomTheme,
  CUSTOMIZE_GROUPS, deriveFullColors,
} from './themes.js';

// ==================== KaTeX extension for marked ====================
const katexBlock = {
  name: 'katexBlock',
  level: 'block',
  start(src) { return src.indexOf('$$'); },
  tokenizer(src) {
    const match = src.match(/^\$\$\s*\n([\s\S]*?)\n\s*\$\$/);
    if (match) return { type: 'katexBlock', raw: match[0], text: match[1].trim() };
  },
  renderer(token) {
    try { return '<div class="katex-block">' + katex.renderToString(token.text, { displayMode: true, throwOnError: false }) + '</div>'; }
    catch { return '<div class="katex-block katex-error">' + token.text + '</div>'; }
  },
};
const katexInline = {
  name: 'katexInline',
  level: 'inline',
  start(src) { return src.indexOf('$'); },
  tokenizer(src) {
    const match = src.match(/^\$([^\$\n]+?)\$/);
    if (match) return { type: 'katexInline', raw: match[0], text: match[1] };
  },
  renderer(token) {
    try { return katex.renderToString(token.text, { displayMode: false, throwOnError: false }); }
    catch { return '<code class="katex-error">' + token.text + '</code>'; }
  },
};

// ==================== Highlight extension for marked ====================
const highlightInline = {
  name: 'highlight',
  level: 'inline',
  start(src) { return src.indexOf('=='); },
  tokenizer(src) {
    const match = src.match(/^==((?!=).+?)==/);
    if (match) return { type: 'highlight', raw: match[0], text: match[1] };
  },
  renderer(token) {
    return '<mark>' + token.text + '</mark>';
  },
};

// ==================== Wiki Link extension for marked ====================
const wikiLink = {
  name: 'wikiLink',
  level: 'inline',
  start(src) { return src.indexOf('[['); },
  tokenizer(src) {
    const match = src.match(/^\[\[([^\]\|]+?)(?:\|([^\]]+?))?\]\]/);
    if (match) return { type: 'wikiLink', raw: match[0], target: match[1].trim(), display: (match[2] || match[1]).trim() };
  },
  renderer(token) {
    const escaped = token.target.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const display = token.display.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<a class="wiki-link" data-wiki-target="' + escaped + '">' + display + '</a>';
  },
};

// ==================== Mermaid code block renderer ====================
let mermaidReady = false;
let mermaidModule = null;
const mermaidRenderer = {
  code(text, lang) {
    if (lang === 'mermaid') return '<div class="mermaid-block" data-mermaid="' + text.replace(/"/g, '&quot;') + '">' + text + '</div>';
    return false;
  },
};

// ==================== Markdown Parser ====================
const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang === 'mermaid') return code;
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    },
  }),
  gfmHeadingId(),
  { gfm: true, breaks: false, extensions: [katexBlock, katexInline, highlightInline, wikiLink], renderer: mermaidRenderer }
);

// ==================== DOM ====================
const contentEl = document.getElementById('content');
const welcomeEl = document.getElementById('welcome');
const fileInfoEl = document.getElementById('file-info');
const workspaceEl = document.getElementById('workspace');
const editorPaneEl = document.getElementById('editor-pane');
const previewPaneEl = document.getElementById('preview-pane');
const dividerEl = document.getElementById('divider');
const statusCursorEl = document.getElementById('status-cursor');
const statusSelectionEl = document.getElementById('status-selection');
const statusWordsEl = document.getElementById('status-words');
const statusReadTimeEl = document.getElementById('status-readtime');
const statusZoomEl = document.getElementById('status-zoom');
const tabListEl = document.getElementById('tab-list');
const sidebarEl = document.getElementById('sidebar');
const fileTreeEl = document.getElementById('file-tree');
const searchInputEl = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
const searchStatusEl = document.getElementById('search-status');
const tocNav = document.getElementById('toc');
const backlinksContentEl = document.getElementById('backlinks-content');

// ==================== State ====================
let tocScrolling = false;
let tocScrollHandler = null;
let autoSaveTimer = null;
let debounceTimer = null;
let editorMouseDown = false;

// Tab state
const tabs = [];
let activeTabId = null;
let tabIdCounter = 0;
let switchingTabs = false;

function getRecoveryKey(tab) {
  return tab.filePath || ('untitled-' + tab.id);
}

// CodeMirror stores the doc with LF only (CRLF/CR are normalized on input),
// so editor.state.doc.toString() always returns LF-joined text. Keep the
// "last saved" reference in the same form — otherwise a freshly-opened
// Windows file looks dirty the moment we re-compare on tab switch.
function normalizeLineEndings(s) {
  return s == null ? '' : String(s).replace(/\r\n?/g, '\n');
}

// Sidebar state
let sidebarVisible = true;
let sidebarActivePanel = 'files';

// Workspace/file tree state
let workspacePath = localStorage.getItem('fp-workspace-path') || null;
const expandedPaths = new Set();

// Search state
let searchRegex = false;
let searchCaseSensitive = false;
let searchDebounceTimer = null;

// Context menu state
let contextMenuTarget = null;
let contextMenuIsDir = false;

// ==================== Zoom ====================
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;
const ZOOM_DEFAULT = 100;
let zoomLevel = parseInt(localStorage.getItem('fp-zoom'), 10) || ZOOM_DEFAULT;

function applyZoom(level) {
  zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
  const scale = zoomLevel / 100;
  const scroller = document.querySelector('.cm-scroller');
  if (scroller) scroller.style.fontSize = (14 * scale) + 'px';
  contentEl.style.fontSize = (16 * scale) + 'px';
  // CSS `zoom` is non-standard and breaks intrinsic width measurement of children,
  // which made wide markdown content (long pre/inline-code paragraphs) refuse to
  // wrap. Stick to font-size scaling only — images/SVGs don't grow with zoom now,
  // but text reflows correctly at every zoom level.
  contentEl.style.zoom = '';
  localStorage.setItem('fp-zoom', zoomLevel);
  statusZoomEl.textContent = zoomLevel + '%';
}

// Global Ctrl+Z/Y override for structured viewers (grid, JSON editor).
// Their inline inputs would otherwise swallow the shortcut and keep CodeMirror's
// undo stack unreachable. After undo/redo we re-run renderPreview to rebuild the
// structured view from the new document text.
// Exception: diff panel textareas manage their own undo — left side syncs to
// CodeMirror via the 'input' event (which fires on native undo), right side
// has an independent history that must not be hijacked.
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  const tab = getActiveTab();
  if (!tab) return;
  const structuredViews = new Set(['csv', 'tsv', 'json', 'jsonl', 'yaml', 'toml', 'ini']);
  if (!structuredViews.has(tab.viewType)) return;
  const key = e.key.toLowerCase();
  const isUndo = key === 'z' && !e.shiftKey;
  const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
  if (!isUndo && !isRedo) return;
  const active = document.activeElement;
  if (active && active.closest && active.closest('.diff-text')) return; // native textarea undo/redo
  e.preventDefault();
  e.stopPropagation();
  if (active instanceof HTMLElement) active.blur();
  if (isUndo) cmUndo(editor);
  else cmRedo(editor);
}, true);

// Use capture phase on document to intercept before CodeMirror handles it
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  if (!workspaceEl.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
  applyZoom(zoomLevel + delta);
}, { passive: false, capture: true });

statusZoomEl.addEventListener('click', () => applyZoom(ZOOM_DEFAULT));

// ==================== Theme ====================
let currentThemeId = getSavedThemeId() || (window.formatpad?.getSystemTheme ? null : 'tokyo-night');
let editingCustomId = null;

function getThemeById(id) {
  if (builtinThemes[id]) return builtinThemes[id];
  const customs = getCustomThemes();
  if (customs[id]) return customs[id];
  return builtinThemes['github-light'];
}

async function initTheme() {
  if (!currentThemeId) {
    const sys = await window.formatpad.getSystemTheme();
    currentThemeId = 'tokyo-night';
  }
  const theme = getThemeById(currentThemeId);
  applyThemeColors(theme.colors);
  saveThemeId(currentThemeId);
}

function switchTheme(id) {
  currentThemeId = id;
  saveThemeId(id);
  editingCustomId = null;
  const theme = getThemeById(id);
  applyThemeColors(theme.colors);
  renderThemePanel();
}

// ==================== Theme Panel ====================
const themePanel = document.getElementById('theme-panel');
const themeListEl = document.getElementById('theme-list');
const customizeFieldsEl = document.getElementById('customize-fields');

// Keep the fixed-position theme panel aligned with the bottom of the top-bar
// stack. The stack height varies (format-bar hides when no tab is open, and
// tab-bar collapses to its 1px border when tabs.length === 0), so a hardcoded
// top leaves a visible gap. Publish the live bottom via a CSS variable that
// #theme-panel reads. ResizeObserver catches tab-bar row wrap + format-bar
// show/hide; the window listener covers viewport resize.
function updateTopBarsBottom() {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar) return;
  const bottom = tabBar.getBoundingClientRect().bottom;
  document.documentElement.style.setProperty('--top-bars-bottom', bottom + 'px');
}
{
  const ro = new ResizeObserver(updateTopBarsBottom);
  ro.observe(document.getElementById('toolbar'));
  ro.observe(document.getElementById('format-bar'));
  ro.observe(document.getElementById('tab-bar'));
  window.addEventListener('resize', updateTopBarsBottom);
  // Initial measurement — wait one frame so the layout has settled.
  requestAnimationFrame(updateTopBarsBottom);
}

document.getElementById('btn-theme').addEventListener('click', () => {
  themePanel.classList.toggle('hidden');
  if (!themePanel.classList.contains('hidden')) {
    updateTopBarsBottom();
    renderThemePanel();
  }
});
document.getElementById('theme-panel-close').addEventListener('click', () => themePanel.classList.add('hidden'));
document.addEventListener('mousedown', (e) => {
  if (!themePanel.classList.contains('hidden') && !themePanel.contains(e.target) && !e.target.closest('#btn-theme')) {
    themePanel.classList.add('hidden');
  }
});

document.getElementById('btn-add-theme').addEventListener('click', () => {
  const newId = addCustomTheme('My Theme', currentThemeId);
  switchTheme(newId);
  editingCustomId = newId;
  renderThemePanel();
});

function renderThemePanel() {
  renderThemeList();
  renderCustomizeFields();
}

function renderThemeList() {
  themeListEl.innerHTML = '';
  const builtinLabel = document.createElement('div');
  builtinLabel.className = 'theme-section-label';
  builtinLabel.textContent = t('builtIn');
  themeListEl.appendChild(builtinLabel);
  for (const [id, theme] of Object.entries(builtinThemes)) {
    themeListEl.appendChild(createThemeItem(id, theme, false));
  }
  const customs = getCustomThemes();
  if (Object.keys(customs).length > 0) {
    const customLabel = document.createElement('div');
    customLabel.className = 'theme-section-label';
    customLabel.textContent = t('myThemes');
    themeListEl.appendChild(customLabel);
    for (const [id, theme] of Object.entries(customs)) {
      themeListEl.appendChild(createThemeItem(id, theme, true));
    }
  }
}

function createThemeItem(id, theme, isCustom) {
  const item = document.createElement('div');
  item.className = 'theme-item' + (id === currentThemeId ? ' active' : '');
  const c = theme.colors;
  const swatch = document.createElement('div');
  swatch.className = 'theme-swatch';
  swatch.innerHTML = `
    <div class="theme-swatch-quarter" style="background:${c.bgPrimary}"></div>
    <div class="theme-swatch-quarter" style="background:${c.accentColor}"></div>
    <div class="theme-swatch-quarter" style="background:${c.syntaxKeyword}"></div>
    <div class="theme-swatch-quarter" style="background:${c.syntaxString}"></div>`;
  const name = document.createElement('span');
  name.className = 'theme-item-name';
  name.textContent = theme.name;
  item.appendChild(swatch);
  item.appendChild(name);
  if (isCustom) {
    const actions = document.createElement('div');
    actions.className = 'theme-item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'theme-action-btn';
    editBtn.title = t('tooltip.editTheme');
    editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); switchTheme(id); editingCustomId = id; renderThemePanel(); });
    const delBtn = document.createElement('button');
    delBtn.className = 'theme-action-btn';
    delBtn.title = t('tooltip.deleteTheme');
    delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></svg>';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteCustomTheme(id); if (currentThemeId === id) switchTheme('github-light'); editingCustomId = null; renderThemePanel(); });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    item.appendChild(actions);
  }
  item.addEventListener('click', () => { switchTheme(id); if (isCustom) { editingCustomId = id; renderThemePanel(); } });
  return item;
}

function renderCustomizeFields() {
  customizeFieldsEl.innerHTML = '';
  if (!editingCustomId) { customizeFieldsEl.classList.add('hidden'); return; }
  customizeFieldsEl.classList.remove('hidden');
  const customs = getCustomThemes();
  const theme = customs[editingCustomId];
  if (!theme) return;
  const nameRow = document.createElement('div');
  nameRow.className = 'customize-name-row';
  nameRow.innerHTML = `<label>${t('themeName')}</label>`;
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'customize-name-input';
  nameInput.value = theme.name;
  nameInput.addEventListener('change', () => { updateCustomThemeName(editingCustomId, nameInput.value); renderThemeList(); });
  nameRow.appendChild(nameInput);
  customizeFieldsEl.appendChild(nameRow);
  for (const group of CUSTOMIZE_GROUPS) {
    const div = document.createElement('div');
    div.className = 'customize-group';
    div.innerHTML = `<div class="customize-group-label">${t(group.i18n)}</div>`;
    for (const field of group.fields) {
      let val = theme.colors[field.key] || '#888888';
      if (val.startsWith('rgba') || val.startsWith('rgb')) val = '#888888';
      const row = document.createElement('div');
      row.className = 'customize-row';
      row.innerHTML = `<label>${t(field.i18n)}</label><input type="color" value="${val}" data-key="${field.key}">`;
      row.querySelector('input').addEventListener('input', (e) => { onCustomColorChange(field.key, e.target.value); });
      div.appendChild(row);
    }
    customizeFieldsEl.appendChild(div);
  }
}

function onCustomColorChange(key, value) {
  if (!editingCustomId) return;
  const customs = getCustomThemes();
  const theme = customs[editingCustomId];
  if (!theme) return;
  const updated = { ...theme.colors, [key]: value };
  const isDark = theme.type === 'dark';
  const full = deriveFullColors(updated, isDark);
  updateCustomThemeColors(editingCustomId, full);
  applyThemeColors(full);
}

// ==================== Wiki-link autocomplete ====================
let cachedFileNames = [];

async function refreshFileNameCache() {
  if (!workspacePath) { cachedFileNames = []; return; }
  try {
    const names = await window.formatpad.getFileNames(workspacePath);
    cachedFileNames = names.map(n => n.baseName);
  } catch { cachedFileNames = []; }
}

function wikiLinkCompletions(context) {
  // Match [[ followed by any non-] characters
  const before = context.matchBefore(/\[\[[^\]]*$/);
  if (!before) return null;

  const prefix = before.text.slice(2); // text after [[
  const filtered = cachedFileNames
    .filter(name => name.toLowerCase().includes(prefix.toLowerCase()))
    .sort((a, b) => {
      // Exact start match first
      const aStarts = a.toLowerCase().startsWith(prefix.toLowerCase());
      const bStarts = b.toLowerCase().startsWith(prefix.toLowerCase());
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.localeCompare(b);
    })
    .slice(0, 20)
    .map(name => ({
      label: name,
      apply: name + ']]',
      type: 'file',
    }));

  return {
    from: before.from + 2,
    options: filtered,
    filter: false,
  };
}

// ==================== Format routing ====================
function getViewType(filePath) {
  const name = (filePath || '').toLowerCase();
  if (/\.(md|markdown|mkd|mdx)$/.test(name)) return 'markdown';
  if (/\.mmd$/.test(name)) return 'mermaid';
  if (/\.(jsonl|ndjson)$/.test(name)) return 'jsonl';
  if (/\.json$/.test(name)) return 'json';
  if (/\.ya?ml$/.test(name)) return 'yaml';
  if (/\.(html?|htm)$/.test(name)) return 'html';
  if (/\.xml$/.test(name)) return 'xml';
  if (/\.csv$/.test(name)) return 'csv';
  if (/\.tsv$/.test(name)) return 'tsv';
  if (/\.toml$/.test(name)) return 'toml';
  if (/\.(ini|conf)$/.test(name)) return 'ini';
  if (/\.properties$/.test(name)) return 'properties';
  if (/(^|[\\/])\.env$/.test(name) || /\.env$/.test(name)) return 'env';
  return 'plain';
}

function getLangExtension(viewType) {
  switch (viewType) {
    case 'markdown':
    case 'mermaid':
      return markdown({ base: markdownLanguage, codeLanguages: languages });
    case 'json': return json();
    case 'yaml': return yaml();
    case 'xml':  return xml();
    case 'html': return htmlLang();
    default: return null;
  }
}

const BINARY_EXTS = new Set([
  'exe','dll','so','dylib','bin','msi','app','class','jar',
  'zip','rar','7z','tar','gz','bz2','xz',
  'png','jpg','jpeg','gif','bmp','ico','webp','tiff',
  'mp4','avi','mov','wmv','mkv','webm','mp3','wav','ogg','flac','m4a',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'db','sqlite',
]);

function isSupportedFormat(filename) {
  const name = (filename || '').toLowerCase();
  const m = name.match(/\.([^./\\]+)$/);
  const ext = m ? m[1] : '';
  if (!ext) return true; // no extension — Dockerfile, Makefile, dotfiles, etc.
  return !BINARY_EXTS.has(ext);
}

// ==================== CodeMirror Editor ====================
function createEditorState(content, viewType = 'markdown') {
  const langExt = getLangExtension(viewType);
  return EditorState.create({
    doc: content,
    extensions: [
      basicSetup,
      syntaxHighlighting(classHighlighter),
      ...(langExt ? [langExt] : []),
      autocompletion({ override: [wikiLinkCompletions], activateOnTyping: true }),
      EditorView.lineWrapping,
      EditorView.domEventHandlers({
        drop(e) {
          const linkName = e.dataTransfer.getData('application/x-fp-link');
          if (!linkName) return false;
          e.preventDefault();
          const pos = editor.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos !== null) {
            const insert = '[[' + linkName + ']]';
            editor.dispatch({ changes: { from: pos, insert } });
            editor.focus();
          }
          return true;
        },
        dragover(e) {
          if (e.dataTransfer.types.includes('application/x-fp-link')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            return true;
          }
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (switchingTabs) return;
        if (update.docChanged) onEditorChange();
        if (update.selectionSet && !editorMouseDown) {
          syncPreviewToEditor();
        }
        if (update.selectionSet && !editorMouseDown) updateStatusBar();
      }),
      keymap.of([
        { key: 'Mod-s', run: () => { saveFile(); return true; } },
        { key: 'Mod-Shift-s', run: () => { saveFileAs(); return true; } },
      ]),
    ],
  });
}

const editor = new EditorView({
  state: createEditorState(''),
  parent: document.getElementById('editor'),
});

// Bidirectional scroll sync uses a pair of short one-shot blocks so whichever
// direction is actively driving briefly silences the other.
// - P2E (preview→editor) gets blocked while the editor scrolls the preview.
//   500ms covers markdown's smooth scrollIntoView (~400ms) plus the trailing
//   scroll events it emits.
// - E2P (editor→preview) gets blocked while the preview scrolls the editor.
//   150ms is enough for EditorView.scrollIntoView — it's instant — and keeps
//   the forward path responsive to cursor moves that follow a preview scroll.
const BLOCK_P2E_MS = 500;
const BLOCK_E2P_MS = 150;
let blockEditorToPreview = false;  // set by preview→editor sync
let blockPreviewToEditor = false;  // set by editor→preview sync
let blockE2PTimer = null;
let blockP2ETimer = null;

function blockEditorToPreviewBriefly(ms = BLOCK_E2P_MS) {
  blockEditorToPreview = true;
  if (blockE2PTimer) clearTimeout(blockE2PTimer);
  blockE2PTimer = setTimeout(() => { blockEditorToPreview = false; blockE2PTimer = null; }, ms);
}
function blockPreviewToEditorBriefly(ms = BLOCK_P2E_MS) {
  blockPreviewToEditor = true;
  if (blockP2ETimer) clearTimeout(blockP2ETimer);
  blockP2ETimer = setTimeout(() => { blockPreviewToEditor = false; blockP2ETimer = null; }, ms);
}

// Sync preview highlight + status bar (called outside of drag)
function syncPreviewToEditor() {
  if (blockEditorToPreview) { updateStatusBar(); return; }
  const pos = editor.state.selection.main.head;
  const line = editor.state.doc.lineAt(pos).number - 1;
  const tab = getActiveTab();
  const viewType = tab?.viewType;
  if (!viewType) { updateStatusBar(); return; }
  blockPreviewToEditorBriefly();
  if (viewType === 'markdown') {
    highlightPreviewLine(line);
  } else {
    syncPreviewStructured(viewType, line);
  }
  updateStatusBar();
}

// Reverse direction: preview scroll → editor scroll. Triggered by a capture-
// phase listener on previewPaneEl (scroll doesn't bubble, but does fire in
// capture). Maps the preview's top-most visible "line" back to a document
// line and parks the editor's viewport there.
function syncEditorToPreview() {
  if (blockPreviewToEditor) return;
  if (switchingTabs) return;
  const tab = getActiveTab();
  if (!tab) return;
  const viewType = tab.viewType;
  if (!viewType) return;
  const targetLine = computePreviewTopLine(viewType);
  if (targetLine == null) return;
  blockEditorToPreviewBriefly();
  try {
    const docLines = editor.state.doc.lines;
    const lineNo = Math.max(1, Math.min(docLines, targetLine + 1));
    const line = editor.state.doc.line(lineNo);
    editor.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }) });
  } catch {}
}

// Inverse of syncPreviewStructured/highlightPreviewLine. Returns a 0-based
// editor line, or null if we can't derive one for this viewer.
function computePreviewTopLine(viewType) {
  if (viewType === 'markdown') {
    const paneTop = previewPaneEl.getBoundingClientRect().top;
    const elems = contentEl.querySelectorAll('[data-source-line]');
    for (const el of elems) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom >= paneTop) {
        const n = parseInt(el.getAttribute('data-source-line'), 10);
        return Number.isNaN(n) ? 0 : n;
      }
    }
    return 0;
  }
  if ((viewType === 'csv' || viewType === 'tsv') && currentGrid?.scrollEl && currentGrid.theadEl) {
    const rowH = currentGrid.measuredRowHeight || 24;
    const topRow = Math.floor(currentGrid.scrollEl.scrollTop / rowH);
    return Math.max(0, topRow + 1); // +1 for header line in source
  }
  if (viewType === 'jsonl' && currentGrid?.scrollEl && currentGrid.theadEl) {
    const rowH = currentGrid.measuredRowHeight || 24;
    const topRow = Math.floor(currentGrid.scrollEl.scrollTop / rowH);
    return Math.max(0, topRow); // JSONL source has no header row
  }
  const jeditScroll = contentEl.querySelector('.jedit-scroll');
  let container;
  if (jeditScroll) container = jeditScroll;
  else if (contentEl.scrollHeight > contentEl.clientHeight) container = contentEl;
  else container = previewPaneEl;
  const max = container.scrollHeight - container.clientHeight;
  if (max <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, container.scrollTop / max));
  return Math.round(ratio * Math.max(0, editor.state.doc.lines - 1));
}

// Scroll doesn't bubble, but capture-phase listeners catch every descendant
// (contentEl, .jedit-scroll, .sgrid-scroll). One handler covers all viewers.
previewPaneEl.addEventListener('scroll', syncEditorToPreview, { capture: true, passive: true });

// Non-markdown formats don't have per-element line mapping. Use row-based
// sync for grid viewers (CSV/TSV/JSONL) and proportional scroll everywhere
// else — good enough to put "roughly the same place" in view without
// building a full line→element map for every format.
function syncPreviewStructured(viewType, editorLine) {
  const totalLines = editor.state.doc.lines;
  if (totalLines <= 0) return;

  // CSV/TSV: line 0 is the header row, line N+1 is data row N.
  if ((viewType === 'csv' || viewType === 'tsv') && currentGrid) {
    scrollGridToRow(currentGrid, Math.max(0, editorLine - 1));
    return;
  }
  // JSONL: each editor line is one data record (no header in source).
  if (viewType === 'jsonl' && currentGrid) {
    scrollGridToRow(currentGrid, Math.max(0, editorLine));
    return;
  }

  const ratio = totalLines > 1 ? editorLine / (totalLines - 1) : 0;
  const clamped = Math.max(0, Math.min(1, ratio));

  // Tree viewers (JSON editable / YAML / TOML / INI read-only) keep their
  // scroll inside .jedit-scroll, not on contentEl itself.
  const jeditScroll = contentEl.querySelector('.jedit-scroll');
  if (jeditScroll) {
    const max = jeditScroll.scrollHeight - jeditScroll.clientHeight;
    if (max > 0) jeditScroll.scrollTop = max * clamped;
    return;
  }

  // XML / HTML / plain / etc. — scroll whichever ancestor actually owns the
  // overflow. contentEl is usually the scroller, but preview-pane wraps it
  // when the viewer renders non-scrolling content (e.g. mermaid SVG).
  const target = contentEl.scrollHeight > contentEl.clientHeight ? contentEl : previewPaneEl;
  const max = target.scrollHeight - target.clientHeight;
  if (max > 0) target.scrollTop = max * clamped;
}

function scrollGridToRow(grid, rowIdx) {
  if (!grid || !grid.scrollEl || !grid.theadEl) return;
  const rows = grid.data || [];
  if (rows.length === 0) return;
  const clamped = Math.max(0, Math.min(rows.length - 1, rowIdx));
  const rowH = grid.measuredRowHeight || 24;
  const headerH = grid.theadEl.getBoundingClientRect().height;
  const viewportH = grid.scrollEl.clientHeight;
  const targetTop = clamped * rowH;
  const curTop = grid.scrollEl.scrollTop;
  if (targetTop < curTop) {
    grid.scrollEl.scrollTop = Math.max(0, targetTop - headerH - 2);
  } else if (targetTop + rowH > curTop + viewportH - headerH) {
    grid.scrollEl.scrollTop = targetTop - (viewportH - rowH) + headerH + 2;
  }
  if (grid.virtEnabled && typeof grid.renderVirtWindow === 'function') {
    grid.renderVirtWindow();
  }
}

// Track mouse state on editor — block all updateListener side effects during drag
document.getElementById('editor').addEventListener('mousedown', () => { editorMouseDown = true; });
document.addEventListener('mouseup', () => {
  if (editorMouseDown) {
    editorMouseDown = false;
    syncPreviewToEditor();
  }
});

// ==================== Tab Management ====================
function getActiveTab() {
  return tabs.find(tb => tb.id === activeTabId) || null;
}

function findTabByPath(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return tabs.find(tb => tb.filePath && tb.filePath.replace(/\\/g, '/').toLowerCase() === normalized) || null;
}

function createTab(filePath, dirPath, content, savedContent) {
  const existing = filePath ? findTabByPath(filePath) : null;
  if (existing) {
    switchToTab(existing.id);
    return existing;
  }
  const viewType = getViewType(filePath);
  const normContent = normalizeLineEndings(content);
  const normSaved = savedContent !== undefined ? normalizeLineEndings(savedContent) : normContent;
  const tab = {
    id: 'tab-' + (++tabIdCounter),
    filePath: filePath || null,
    dirPath: dirPath || null,
    viewType,
    pinned: false,
    lastSavedContent: normSaved,
    isModified: normContent !== normSaved,
    editorState: createEditorState(normContent, viewType),
    scrollTop: { editor: 0, preview: 0 },
    lastAutoSavedContent: null,
  };
  tabs.push(tab);
  switchToTab(tab.id);
  return tab;
}

function switchToTab(tabId) {
  const currentTab = getActiveTab();
  if (currentTab && currentTab.id !== tabId) {
    currentTab.editorState = editor.state;
    currentTab.isModified = editor.state.doc.toString() !== currentTab.lastSavedContent;
    const scroller = document.querySelector('.cm-scroller');
    currentTab.scrollTop.editor = scroller ? scroller.scrollTop : 0;
    currentTab.scrollTop.preview = contentEl.scrollTop;
  }

  activeTabId = tabId;
  const newTab = getActiveTab();
  if (!newTab) return;

  switchingTabs = true;
  editor.setState(newTab.editorState);
  switchingTabs = false;

  // The rAF scroll restore below will fire a preview scroll event. Without
  // this block the capture-phase listener would treat it as user intent and
  // drag the editor to line 0.
  blockPreviewToEditorBriefly();

  requestAnimationFrame(() => {
    const scroller = document.querySelector('.cm-scroller');
    if (scroller) scroller.scrollTop = newTab.scrollTop.editor;
    contentEl.scrollTop = newTab.scrollTop.preview;
  });

  renderPreview(editor.state.doc.toString());
  updateFormatBar(newTab.viewType);
  applyDiffWorkspaceMode();
  renderTabBar();
  updateTitle();
  updateStatusBar();
  welcomeEl.classList.add('hidden');
  // Sidebar follows the active tab regardless of viewType — renderPreview only
  // refreshes the outline for markdown, so structured-view tabs would otherwise
  // keep the previous markdown's TOC/backlinks pinned.
  buildTOC();
  if (sidebarActivePanel === 'backlinks') refreshBacklinks();

  // Auto-detect workspace from file
  if (newTab.dirPath && !workspacePath) {
    workspacePath = newTab.dirPath;
    localStorage.setItem('fp-workspace-path', workspacePath);
    loadFileTree();
    window.formatpad.watchDirectory(workspacePath);
    window.formatpad.buildLinkIndex(workspacePath).then(() => refreshFileNameCache());
  }
}

async function closeTab(tabId) {
  const tab = tabs.find(tb => tb.id === tabId);
  if (!tab) return;

  if (tab.isModified) {
    if (activeTabId !== tabId) switchToTab(tabId);
    const result = await window.formatpad.showSaveDialog();
    if (result === 'save') {
      await saveFile();
      if (getActiveTab()?.isModified) return;
    } else if (result === 'cancel') {
      return;
    } else {
      window.formatpad.clearRecovery(getRecoveryKey(tab));
    }
  } else {
    window.formatpad.clearRecovery(getRecoveryKey(tab));
  }

  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    activeTabId = null;
    switchingTabs = true;
    editor.setState(createEditorState(''));
    switchingTabs = false;
    contentEl.innerHTML = '';
    if (tocScrollHandler) { contentEl.removeEventListener('scroll', tocScrollHandler); tocScrollHandler = null; }
    tocNav.innerHTML = '';
    welcomeEl.classList.remove('hidden');
    updateFormatBar(null);
    document.body.classList.remove('json-diff-mode');
    updateTitle();
    renderTabBar();
    return;
  }

  if (activeTabId === tabId) {
    const newIdx = Math.min(idx, tabs.length - 1);
    switchToTab(tabs[newIdx].id);
  } else {
    renderTabBar();
  }
}

const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-4.5a2 2 0 0 1-.1-.6V5a2 2 0 0 0-2-2H8.6a2 2 0 0 0-2 2v6.9a2 2 0 0 1-.1.6L5 17z"/></svg>';

function renderTabBar() {
  tabListEl.innerHTML = '';
  // Keep pinned tabs at the front of the row, preserving their relative order.
  const ordered = [...tabs].sort((a, b) => (b.pinned === true) - (a.pinned === true));
  for (const tab of ordered) {
    const el = document.createElement('div');
    el.className = 'tab-item'
      + (tab.id === activeTabId ? ' active' : '')
      + (tab.isModified ? ' modified' : '')
      + (tab.pinned ? ' pinned' : '');
    el.draggable = !tab.pinned;
    el.dataset.tabId = tab.id;

    if (tab.isModified) {
      const dot = document.createElement('span');
      dot.className = 'tab-modified-dot';
      el.appendChild(dot);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    const name = tab.filePath ? tab.filePath.split(/[/\\]/).pop() : t('untitled');
    nameSpan.textContent = name;
    nameSpan.title = tab.filePath || t('untitled');

    const pinBtn = document.createElement('button');
    pinBtn.className = 'tab-pin-btn';
    pinBtn.innerHTML = ICON_PIN;
    pinBtn.title = tab.pinned ? t('context.unpin') : t('context.pin');
    pinBtn.addEventListener('click', (e) => { e.stopPropagation(); tab.pinned = !tab.pinned; renderTabBar(); });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = t('tooltip.closeTab');
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });

    el.appendChild(nameSpan);
    el.appendChild(pinBtn);
    el.appendChild(closeBtn);

    el.addEventListener('click', () => switchToTab(tab.id));
    el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showTabContextMenu(e.clientX, e.clientY, tab.id); });

    // Drag reorder
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', tab.id); el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over-tab'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over-tab'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over-tab');
      const draggedId = e.dataTransfer.getData('text/plain');
      const draggedIdx = tabs.findIndex(tb => tb.id === draggedId);
      const targetIdx = tabs.findIndex(tb => tb.id === tab.id);
      if (draggedIdx !== -1 && targetIdx !== -1 && draggedIdx !== targetIdx) {
        const [moved] = tabs.splice(draggedIdx, 1);
        tabs.splice(targetIdx, 0, moved);
        renderTabBar();
      }
    });

    tabListEl.appendChild(el);
  }
  requestAnimationFrame(assignTabRows);
}

function assignTabRows() { /* no-op: simple VSCode-style flat multi-row tabs */ }

// ==================== Tab context menu ====================
let tabContextTargetId = null;

function showTabContextMenu(x, y, tabId) {
  const menu = document.getElementById('tab-context-menu');
  const tab = tabs.find(tb => tb.id === tabId);
  if (!tab) return;
  tabContextTargetId = tabId;
  document.getElementById('tctx-pin').textContent = tab.pinned ? t('context.unpin') : t('context.pin');
  document.getElementById('tctx-reveal').style.display = tab.filePath ? '' : 'none';
  const others = tabs.filter(tb => tb.id !== tabId && !tb.pinned).length;
  document.getElementById('tctx-close-others').style.display = others > 0 ? '' : 'none';
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 4) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 4) + 'px';
}

document.addEventListener('click', () => document.getElementById('tab-context-menu').classList.add('hidden'));

document.getElementById('tctx-close').addEventListener('click', () => {
  if (tabContextTargetId) closeTab(tabContextTargetId);
});
document.getElementById('tctx-close-others').addEventListener('click', () => {
  if (!tabContextTargetId) return;
  const targets = tabs.filter(tb => tb.id !== tabContextTargetId && !tb.pinned).map(tb => tb.id);
  (async () => { for (const id of targets) await closeTab(id); })();
});
document.getElementById('tctx-close-all').addEventListener('click', () => {
  const targets = tabs.filter(tb => !tb.pinned).map(tb => tb.id);
  (async () => { for (const id of targets) await closeTab(id); })();
});
document.getElementById('tctx-pin').addEventListener('click', () => {
  const tab = tabs.find(tb => tb.id === tabContextTargetId);
  if (!tab) return;
  tab.pinned = !tab.pinned;
  renderTabBar();
});
document.getElementById('tctx-reveal').addEventListener('click', () => {
  const tab = tabs.find(tb => tb.id === tabContextTargetId);
  if (tab?.filePath) window.formatpad.revealInExplorer(tab.filePath);
});

// ==================== Editor change handling ====================
function onEditorChange() {
  if (switchingTabs) return;
  const tab = getActiveTab();
  if (!tab) return;
  const content = editor.state.doc.toString();
  const wasModified = tab.isModified;
  tab.isModified = content !== tab.lastSavedContent;
  tab.editorState = editor.state;
  if (wasModified !== tab.isModified) {
    updateTitle();
    renderTabBar();
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => renderPreview(content), 200);
}

function updateTitle() {
  const tab = getActiveTab();
  if (!tab) {
    fileInfoEl.textContent = '';
    fileInfoEl.title = '';
    window.formatpad.setTitle('FormatPad');
    return;
  }
  const name = tab.filePath ? tab.filePath.split(/[/\\]/).pop() : t('untitled');
  fileInfoEl.textContent = (tab.isModified ? '• ' : '') + name;
  fileInfoEl.title = tab.filePath || '';
  window.formatpad.setTitle((tab.isModified ? '• ' : '') + name + ' - FormatPad');
}

function showSaveFlash() {
  fileInfoEl.classList.add('saved-flash');
  setTimeout(() => fileInfoEl.classList.remove('saved-flash'), 1500);
}

// ==================== Preview ====================
let skipNextRenderPreview = false;
let currentGrid = null;
let currentJsonEditor = null;
// Last rendered (tabId, viewType, content) — lets renderPreview skip redundant re-renders
// when CodeMirror's debounced updateListener fires with the same content (common after
// undo/redo races or focus changes).
let lastRendered = { tabId: null, viewType: null, content: null };

function invalidateRenderCache() { lastRendered = { tabId: null, viewType: null, content: null }; }

function disposeStructuredViewers() {
  if (currentGrid) {
    try { currentGrid.destroy(); } catch {}
    currentGrid = null;
  }
  if (currentJsonEditor) {
    try { currentJsonEditor.destroy(); } catch {}
    currentJsonEditor = null;
  }
  currentDiffPanel = null;
  // Don't invalidate render cache here — disposeStructuredViewers runs inside
  // renderPreview itself, and wiping would cancel the cache we're about to populate.
  // Callers that genuinely change state (mode toggles, theme swaps) invalidate directly.
}

const FORMAT_BAR_VIEWS = new Set(['markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'toml', 'ini', 'html', 'xml', 'mermaid', 'env']);
let jsonViewMode = 'tree'; // 'tree' | 'diff'
let currentDiffPanel = null; // { el, recompute } — valid while diff panel is mounted
// Set when the left diff textarea echoes into CodeMirror — the debounced renderPreview
// would otherwise trigger a second recompute for the same keystroke.
let suppressNextDiffRecompute = false;
let mmdTheme = localStorage.getItem('fp-mmd-theme') || 'dark';

function updateFormatBar(viewType) {
  const bar = document.getElementById('format-bar');
  if (!bar) return;
  // Hide bar only when no tab is active. Otherwise show bar (possibly empty).
  bar.hidden = !viewType;
  for (const group of bar.querySelectorAll('.fmt-group')) {
    const views = (group.dataset.view || '').split(',').map(s => s.trim());
    group.hidden = !views.includes(viewType);
  }
  if (viewType === 'json') {
    const diffBtn = document.getElementById('fmt-json-diff');
    if (diffBtn) diffBtn.classList.toggle('fmt-active', jsonViewMode === 'diff');
  }
}

function renderPreview(content) {
  if (skipNextRenderPreview) { skipNextRenderPreview = false; return; }
  const tab = getActiveTab();
  const viewType = tab?.viewType || 'markdown';
  // Diff panel keeps its own text input state — skip full re-render, just recompute diff.
  if (viewType === 'json' && jsonViewMode === 'diff' && currentDiffPanel && contentEl.contains(currentDiffPanel.el)) {
    if (suppressNextDiffRecompute) { suppressNextDiffRecompute = false; return; }
    currentDiffPanel.recompute();
    return;
  }
  // Skip redundant renders when debounced update fires with identical state.
  // We deliberately skip for formats with side effects (html iframe, mermaid render)
  // that own their refresh lifecycle.
  const tabId = tab?.id ?? null;
  if (
    lastRendered.tabId === tabId &&
    lastRendered.viewType === viewType &&
    lastRendered.content === content
  ) {
    return;
  }
  lastRendered = { tabId, viewType, content };
  disposeStructuredViewers();
  // Markdown typography lives under .markdown-body in base.css; keep that class for
  // the markdown view and drop it for structured views (JSON tree, CSV grid, etc.)
  // where those rules would interfere.
  contentEl.className = 'view-' + viewType + (viewType === 'markdown' ? ' markdown-body' : '');

  if (viewType === 'html')    { renderHTMLPreview(content); return; }
  if (viewType === 'mermaid') { renderMermaidPreview(content); return; }
  if (viewType === 'json')    { renderJSONPreview(content); return; }
  if (viewType === 'jsonl')   { renderJSONLPreview(content); return; }
  if (viewType === 'yaml')    { renderYAMLPreview(content); return; }
  if (viewType === 'csv')     { renderDelimitedPreview(content, ',', 'CSV'); return; }
  if (viewType === 'tsv')     { renderDelimitedPreview(content, '\t', 'TSV'); return; }
  if (viewType === 'toml')    { renderTOMLPreview(content); return; }
  if (viewType === 'ini')     { renderINIPreview(content); return; }
  if (viewType === 'properties') { renderPropertiesPreview(content); return; }
  if (viewType === 'xml')     { renderXMLPreview(content); return; }
  if (viewType === 'env')     { renderEnvPreview(content); return; }
  if (viewType !== 'markdown') {
    contentEl.innerHTML = '<div class="preview-placeholder">No structured preview for this format.</div>';
    return;
  }

  const parsedHtml = marked.parse(content);
  contentEl.innerHTML = parsedHtml;

  contentEl.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href');
    if (href.startsWith('http')) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    } else if (/\.(md|markdown|mkd|mdx)$/i.test(href)) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (tab?.dirPath) {
          const fullPath = tab.dirPath.replace(/\\/g, '/') + '/' + decodeURIComponent(href);
          openFileInTab(fullPath);
        }
      });
    }
  });

  contentEl.querySelectorAll('a.wiki-link').forEach((link) => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const target = link.dataset.wikiTarget;
      if (!workspacePath) return;
      const resolved = await window.formatpad.resolveWikiLink(workspacePath, target);
      if (resolved) {
        openFileInTab(resolved);
      }
    });
  });

  contentEl.querySelectorAll('pre').forEach((pre) => {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = t('copy');
    copyBtn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      if (code) {
        navigator.clipboard.writeText(code.textContent).then(() => {
          copyBtn.textContent = t('copied');
          setTimeout(() => { copyBtn.textContent = t('copy'); }, 2000);
        });
      }
    });
    pre.appendChild(copyBtn);
  });

  // Resolve relative image paths
  const dirPath = tab?.dirPath;
  if (dirPath) {
    contentEl.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (src && !src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('file:') && !src.startsWith('/')) {
        img.src = 'file:///' + dirPath.replace(/\\/g, '/') + '/' + src;
      }
    });
  }

  // Wrap every markdown <table> in a scroll container. Without this wrapper
  // Chromium's table sizing (display:block + width:max-content) propagates the
  // table's intrinsic width up through flex ancestors, preventing the preview
  // pane from shrinking when the window is narrowed.
  contentEl.querySelectorAll('table').forEach((tbl) => {
    if (tbl.parentElement?.classList.contains('md-table-scroll')) return;
    const wrap = document.createElement('div');
    wrap.className = 'md-table-scroll';
    tbl.parentNode.insertBefore(wrap, tbl);
    wrap.appendChild(tbl);
  });

  renderMermaidBlocks();
  buildPreviewLineMap(content);

  const pos = editor.state.selection.main.head;
  const curLine = editor.state.doc.lineAt(pos).number - 1;
  highlightPreviewLine(curLine);

  buildTOC();
  if (sidebarActivePanel === 'backlinks') refreshBacklinks();
}

function renderHTMLPreview(content) {
  const clean = DOMPurify.sanitize(content, {
    FORBID_TAGS: ['style', 'meta', 'base', 'link'],
    FORBID_ATTR: ['srcdoc', 'formaction', 'onerror', 'onload', 'onclick'],
    ADD_ATTR: ['target'],
  });
  const csp = "default-src 'none'; img-src data: https: http: file:; style-src 'unsafe-inline'; font-src data:;";
  const wrapped = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '"><style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:16px;margin:0;color:#222;}</style></head><body>' + clean + '</body></html>';
  contentEl.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%;height:100%;border:none;background:white;';
  iframe.sandbox = '';
  iframe.srcdoc = wrapped;
  contentEl.appendChild(iframe);
}

function renderMermaidPreview(content) {
  const esc = content.replace(/"/g, '&quot;');
  contentEl.innerHTML =
    '<div class="mermaid-toolbar">' +
      '<button class="mermaid-action" data-action="reset" title="Reset view">⤢</button>' +
      '<button class="mermaid-action" data-action="svg" title="Save SVG">SVG</button>' +
      '<button class="mermaid-action" data-action="png" title="Save PNG">PNG</button>' +
    '</div>' +
    '<div class="mermaid-block" data-mermaid="' + esc + '">' + escapeHtml(content) + '</div>';
  renderMermaidBlocks().then(() => {
    const block = contentEl.querySelector('.mermaid-block');
    const svg = block?.querySelector('svg');
    if (!svg) return;
    // Snapshot original SVG string before svgPanZoom wraps it in a group.
    const originalSvgText = block.innerHTML;
    let svgSize = { w: 1200, h: 800 };
    try { const bbox = svg.getBBox(); svgSize = { w: Math.ceil(Math.max(400, bbox.width)) * 2, h: Math.ceil(Math.max(300, bbox.height)) * 2 }; } catch {}
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    let panZoom = null;
    try {
      panZoom = svgPanZoom(svg, { zoomEnabled: true, controlIconsEnabled: false, fit: true, center: true, minZoom: 0.3, maxZoom: 10 });
    } catch { /* keep static */ }
    contentEl.querySelectorAll('.mermaid-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'reset' && panZoom) { panZoom.resetZoom(); panZoom.resetPan(); panZoom.fit(); panZoom.center(); }
        else if (action === 'svg') { saveSVG(originalSvgText); }
        else if (action === 'png') { exportSVGToPNG(originalSvgText, svgSize); }
      });
    });
  });
}

async function saveSVG(svgString) {
  try { await window.formatpad.saveText('diagram.svg', svgString); } catch {}
}

async function exportSVGToPNG(svgString, size) {
  const w = size?.w || 1200;
  const h = size?.h || 800;
  let text = svgString;
  if (!/xmlns=/.test(text)) text = text.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  text = text.replace(/<svg\b([^>]*)>/i, (m, attrs) => {
    let a = attrs;
    if (!/\swidth=/i.test(a)) a += ' width="' + w + '"';
    if (!/\sheight=/i.test(a)) a += ' height="' + h + '"';
    return '<svg' + a + '>';
  });
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim() || '#ffffff';
  try { await window.formatpad.svgToPng(text, w, h, bg); }
  catch (err) { console.error('svgToPng failed', err); }
}

// ==================== JSON / YAML / TOML / INI tree view ====================
function mountJSONEditor(content, parseFn, label, { readOnly = false, toggleable = false } = {}) {
  contentEl.innerHTML = '';
  try {
    currentJsonEditor = new JSONEditor(contentEl, {
      content,
      readOnly,
      toggleable,
      parse: parseFn,
      onChange: (serialized) => {
        skipNextRenderPreview = true;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: serialized } });
      },
    });
  } catch (err) {
    contentEl.innerHTML = '<div class="preview-error">Invalid ' + label + ': ' + escapeHtml(err.message) + '</div>';
  }
}

function renderJSONPreview(content) {
  if (jsonViewMode === 'diff')  { renderJSONDiffPreview(content); return; }
  mountJSONEditor(content, JSON.parse, 'JSON', { readOnly: false, toggleable: true });
}

// Line-level LCS diff. Returns array of ops: {op: 'equal'|'del'|'add', a?, b?}.
function lcsLineDiff(a, b) {
  const n = a.length, m = b.length;
  // Large inputs: skip alignment, just mark each side distinctly.
  // 250_000 ≈ 500×500 lines — above this the O(n·m) DP freezes the UI.
  if (n * m > 250_000) {
    const out = [];
    for (const l of a) out.push({ op: 'del', a: l });
    for (const l of b) out.push({ op: 'add', b: l });
    return out;
  }
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { out.unshift({ op: 'equal', a: a[i - 1], b: b[j - 1] }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { out.unshift({ op: 'del', a: a[i - 1] }); i--; }
    else { out.unshift({ op: 'add', b: b[j - 1] }); j--; }
  }
  while (i > 0) { out.unshift({ op: 'del', a: a[i - 1] }); i--; }
  while (j > 0) { out.unshift({ op: 'add', b: b[j - 1] }); j--; }
  return out;
}

function tryPrettyJSON(text) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try { return JSON.stringify(JSON.parse(trimmed), null, 2); }
  catch { return text; }
}

function renderJSONDiffPreview(content) {
  contentEl.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'json-diff-panel';
  panel.innerHTML = `
    <div class="json-diff-header">
      <span class="json-diff-title">${escapeHtml(t('diff.panelTitle'))}</span>
      <span class="json-diff-stats" aria-live="polite"></span>
      <span class="json-diff-spacer"></span>
      <label class="json-diff-toggle" title="${escapeHtml(t('diff.prettyToggle'))}">
        <input type="checkbox" class="json-diff-pretty" checked />
        <span>${escapeHtml(t('diff.prettyLabel'))}</span>
      </label>
      <button class="json-diff-btn json-diff-clear">${escapeHtml(t('diff.clear'))}</button>
      <button class="json-diff-btn json-diff-close" title="${escapeHtml(t('modal.close'))}">&times;</button>
    </div>
    <div class="json-diff-sbs">
      <div class="diff-pane diff-left">
        <div class="diff-pane-label">${escapeHtml(t('diff.currentLabel'))}</div>
        <div class="diff-pane-body">
          <div class="diff-bg" data-side="left"></div>
          <textarea class="diff-text" wrap="off" spellcheck="false"></textarea>
        </div>
      </div>
      <div class="diff-pane diff-right">
        <div class="diff-pane-label">${escapeHtml(t('diff.targetLabel'))}</div>
        <div class="diff-pane-body">
          <div class="diff-bg" data-side="right"></div>
          <textarea class="diff-text" wrap="off" spellcheck="false" placeholder="${escapeHtml(t('diff.placeholder'))}"></textarea>
        </div>
      </div>
    </div>
  `;
  contentEl.appendChild(panel);

  const leftTa  = panel.querySelector('.diff-left textarea');
  const rightTa = panel.querySelector('.diff-right textarea');
  const leftBg  = panel.querySelector('.diff-left .diff-bg');
  const rightBg = panel.querySelector('.diff-right .diff-bg');
  const statsEl = panel.querySelector('.json-diff-stats');
  const prettyCb = panel.querySelector('.json-diff-pretty');

  const savedPretty = localStorage.getItem('fp-diff-pretty');
  if (savedPretty !== null) prettyCb.checked = savedPretty === 'true';

  rightTa.value = localStorage.getItem('fp-diff-other') || '';

  function renderSideBg(bg, side, lines, ops) {
    // Per-side: each of its lines gets a diff-line div with coloring.
    // Walk ops; for 'left' include equal+del only (skip add). For 'right' include equal+add only (skip del).
    const cls = new Array(lines.length);
    let idx = 0;
    for (const op of ops) {
      if (side === 'left') {
        if (op.op === 'equal')    { cls[idx++] = ''; }
        else if (op.op === 'del') { cls[idx++] = 'diff-del'; }
      } else {
        if (op.op === 'equal')    { cls[idx++] = ''; }
        else if (op.op === 'add') { cls[idx++] = 'diff-add'; }
      }
    }
    // Reconcile existing children instead of full rebuild — saves N node allocations per recompute.
    const want = lines.length;
    for (let i = 0; i < want; i++) {
      const desiredClass = 'diff-line' + (cls[i] ? ' ' + cls[i] : '');
      // Render text or nbsp placeholder so the div has height even when empty
      const desiredText = lines[i] === '' ? ' ' : lines[i];
      let div = bg.children[i];
      if (!div) {
        div = document.createElement('div');
        div.className = desiredClass;
        div.textContent = desiredText;
        bg.appendChild(div);
      } else {
        if (div.className !== desiredClass) div.className = desiredClass;
        if (div.textContent !== desiredText) div.textContent = desiredText;
      }
    }
    while (bg.children.length > want) bg.removeChild(bg.lastChild);
  }

  function recompute() {
    const editorText = editor.state.doc.toString();
    const leftRaw = leftTa.value;
    const rightRaw = rightTa.value;
    localStorage.setItem('fp-diff-other', rightRaw);
    localStorage.setItem('fp-diff-pretty', String(prettyCb.checked));
    // Left: show editor content. Don't overwrite if user is actively editing the left textarea.
    if (document.activeElement !== leftTa) {
      leftTa.value = prettyCb.checked ? tryPrettyJSON(editorText) : editorText;
    }
    // Right: auto pretty when not focused
    const rightText = prettyCb.checked ? tryPrettyJSON(rightRaw) : rightRaw;
    if (prettyCb.checked && rightText !== rightRaw && document.activeElement !== rightTa) {
      rightTa.value = rightText;
    }
    const aLines = leftTa.value.split('\n');
    const bLines = rightTa.value.split('\n');
    const ops = lcsLineDiff(aLines, bLines);
    renderSideBg(leftBg,  'left',  aLines, ops);
    renderSideBg(rightBg, 'right', bLines, ops);
    let adds = 0, dels = 0;
    for (const op of ops) { if (op.op === 'add') adds++; else if (op.op === 'del') dels++; }
    if (!rightRaw.trim() && !leftRaw.trim()) statsEl.textContent = t('diff.empty');
    else if (adds === 0 && dels === 0) statsEl.textContent = t('diff.noDiff');
    else statsEl.textContent = `+${adds} / -${dels}`;
    syncScrollNow();
  }

  // Diff recompute is debounced — unthrottled was the primary bottleneck the user felt.
  let recomputeTimer = null;
  function scheduleRecompute() {
    if (recomputeTimer) clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => { recomputeTimer = null; recompute(); }, 150);
  }

  // Left textarea edits flow back to the CodeMirror doc.
  // The dispatch triggers the debounced renderPreview → currentDiffPanel.recompute() path.
  // Suppress that echo so recompute fires exactly once per keystroke (debounced).
  leftTa.addEventListener('input', () => {
    suppressNextDiffRecompute = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: leftTa.value } });
    scheduleRecompute();
  });

  // Scroll sync: textarea ↔ its BG (vertical + horizontal)
  const syncBg = (ta, bg) => { bg.scrollTop = ta.scrollTop; bg.scrollLeft = ta.scrollLeft; };
  // Cross-pane sync: when one textarea scrolls, scroll the other to match
  const crossSync = (src, dst) => {
    if (Math.abs(dst.scrollTop - src.scrollTop) > 1) dst.scrollTop = src.scrollTop;
  };
  let syncing = false;
  leftTa.addEventListener('scroll', () => {
    syncBg(leftTa, leftBg);
    if (syncing) return;
    syncing = true;
    crossSync(leftTa, rightTa);
    syncBg(rightTa, rightBg);
    syncing = false;
  });
  rightTa.addEventListener('scroll', () => {
    syncBg(rightTa, rightBg);
    if (syncing) return;
    syncing = true;
    crossSync(rightTa, leftTa);
    syncBg(leftTa, leftBg);
    syncing = false;
  });
  function syncScrollNow() {
    syncBg(leftTa, leftBg);
    syncBg(rightTa, rightBg);
  }

  rightTa.addEventListener('input', scheduleRecompute);
  prettyCb.addEventListener('change', recompute);

  // Drag-drop files (both sides)
  const stopEvt = (e) => { e.preventDefault(); e.stopPropagation(); };
  const wireDropArea = (ta, onText) => {
    ta.addEventListener('dragenter', (e) => { stopEvt(e); ta.classList.add('dragover'); });
    ta.addEventListener('dragover',  (e) => { stopEvt(e); ta.classList.add('dragover'); });
    ta.addEventListener('dragleave', () => ta.classList.remove('dragover'));
    ta.addEventListener('drop', async (e) => {
      stopEvt(e);
      ta.classList.remove('dragover');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      try { onText(await file.text()); } catch {}
    });
  };
  wireDropArea(rightTa, (text) => { rightTa.value = text; recompute(); });
  wireDropArea(leftTa,  (text) => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
    leftTa.value = text;
    recompute();
  });

  panel.querySelector('.json-diff-clear').addEventListener('click', () => {
    // Route the clear through the textarea's native input pipeline so the
    // browser records it in the undo stack. Assigning .value = '' would
    // clear instantly but leave Ctrl+Z unable to bring the text back.
    rightTa.focus();
    if (rightTa.value.length > 0) {
      rightTa.setSelectionRange(0, rightTa.value.length);
      const ok = document.execCommand('insertText', false, '');
      if (!ok || rightTa.value.length > 0) {
        // Fallback: older engines / contentEditable quirks — at least clear.
        rightTa.value = '';
      }
    }
    recompute();
  });
  panel.querySelector('.json-diff-close').addEventListener('click', () => setJsonViewMode('tree'));

  currentDiffPanel = { el: panel, recompute };
  recompute();
}

function parseJsonlLines(text) {
  const lines = text.split(/\r?\n/);
  const objs = [];
  const lineIdx = []; // which source line each object came from
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    try { objs.push(JSON.parse(l)); lineIdx.push(i); } catch { /* skip invalid line */ }
  }
  return { objs, lineIdx };
}
function renderJSONLPreview(content) {
  const { objs } = parseJsonlLines(content);
  if (objs.length === 0) {
    contentEl.innerHTML = '<div class="preview-placeholder">No valid JSONL lines found.</div>';
    return;
  }
  const allPlainObjects = objs.every(x => x && typeof x === 'object' && !Array.isArray(x));
  if (!allPlainObjects) {
    // heterogeneous JSONL — show as JSON array in read-only tree
    mountJSONEditor(JSON.stringify(objs, null, 2), JSON.parse, 'JSONL', { readOnly: true });
    return;
  }
  const keys = [...new Set(objs.flatMap(o => Object.keys(o)))];
  const fmtCell = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  const rows = [keys, ...objs.map(o => keys.map(k => fmtCell(o[k])))];
  const csvText = Papa.unparse(rows);
  contentEl.innerHTML = '';
  currentGrid = new SpreadsheetGrid(contentEl, {
    content: csvText,
    delimiter: ',',
    onChange: (csv) => {
      try {
        const parsed = Papa.parse(csv, { skipEmptyLines: false });
        const rowArr = parsed.data.filter(r => !(r.length === 1 && r[0] === ''));
        if (rowArr.length === 0) return;
        const hdr = rowArr[0];
        const outLines = rowArr.slice(1).map(row => JSON.stringify(rowToObject(hdr, row)));
        skipNextRenderPreview = true;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: outLines.join('\n') } });
      } catch {}
    },
  });
}
function rowToObject(hdr, row) {
  const obj = {};
  hdr.forEach((h, i) => {
    const v = row[i];
    if (v === undefined || v === '') { obj[h] = ''; return; }
    const s = String(v);
    if (s === 'null') obj[h] = null;
    else if (s === 'true') obj[h] = true;
    else if (s === 'false') obj[h] = false;
    else if (/^-?\d+$/.test(s) && Number.isFinite(+s)) obj[h] = +s;
    else if (/^-?\d*\.\d+$/.test(s) || /^-?\d+\.\d*$/.test(s)) obj[h] = +s;
    else if (/^[{[]/.test(s)) { try { obj[h] = JSON.parse(s); } catch { obj[h] = s; } }
    else obj[h] = s;
  });
  return obj;
}
function renderYAMLPreview(content) { mountJSONEditor(content, (c) => yamljs.load(c), 'YAML', { readOnly: true }); }
function renderTOMLPreview(content) { mountJSONEditor(content, tomlParse, 'TOML', { readOnly: true }); }

// ==================== CSV / TSV table view ====================
function renderDelimitedPreview(content, delimiter, label) {
  contentEl.innerHTML = '';
  try {
    currentGrid = new SpreadsheetGrid(contentEl, {
      content,
      delimiter,
      onChange: (serialized) => {
        skipNextRenderPreview = true;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: serialized } });
      },
    });
  } catch (err) {
    contentEl.innerHTML = '<div class="preview-error">Invalid ' + label + ': ' + escapeHtml(err.message) + '</div>';
  }
}

// ==================== XML DOM tree view ====================
function buildXMLNode(node) {
  const wrap = document.createElement('div');
  wrap.className = 'xml-node';
  if (node.nodeType !== 1) return wrap; // only elements
  const elements = Array.from(node.children);
  const attrs = Array.from(node.attributes || []).map(a =>
    ' <span class="xml-attr-name">' + escapeHtml(a.name) + '</span>=<span class="xml-attr-value">"' + escapeHtml(a.value) + '"</span>'
  ).join('');
  const text = elements.length === 0 ? (node.textContent || '').trim() : '';

  if (elements.length > 0) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.innerHTML = '<span class="xml-tag">&lt;' + escapeHtml(node.tagName) + attrs + '&gt;</span>';
    details.appendChild(summary);
    const inner = document.createElement('div');
    inner.className = 'xml-children';
    for (const child of elements) inner.appendChild(buildXMLNode(child));
    details.appendChild(inner);
    wrap.appendChild(details);
  } else {
    const line = document.createElement('div');
    line.className = 'xml-leaf';
    const content = text ? '<span class="xml-text">' + escapeHtml(text) + '</span>' : '';
    line.innerHTML = '<span class="xml-tag">&lt;' + escapeHtml(node.tagName) + attrs + (text ? '&gt;' : '/&gt;') + '</span>' + content + (text ? '<span class="xml-tag">&lt;/' + escapeHtml(node.tagName) + '&gt;</span>' : '');
    wrap.appendChild(line);
  }
  return wrap;
}

function renderXMLPreview(content) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(content, 'application/xml');
  const perr = doc.querySelector('parsererror');
  if (perr) {
    contentEl.innerHTML = '<div class="preview-error">Invalid XML: ' + escapeHtml(perr.textContent || '') + '</div>';
    return;
  }
  contentEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'xml-tree';
  wrap.appendChild(buildXMLNode(doc.documentElement));
  contentEl.appendChild(wrap);
}

// ==================== .env key-value view ====================
const SENSITIVE_ENV_RE = /(SECRET|TOKEN|KEY|PASSWORD|PASS|API|AUTH|CREDENTIAL|PRIVATE|CERT|SIGNATURE|HASH)/i;

function parseDotenv(content) {
  const parsed = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quoted = /^["']/.test(value);
    if (!quoted) {
      const cmt = value.indexOf(' #');
      if (cmt >= 0) value = value.slice(0, cmt);
    }
    value = value.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    }
    parsed[m[1]] = value;
  }
  return parsed;
}

function expandDotenv(parsed) {
  const out = {};
  const resolve = (v) => String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => parsed[k] !== undefined ? parsed[k] : '');
  for (const [k, v] of Object.entries(parsed)) out[k] = resolve(v);
  return out;
}

function renderEnvPreview(content) {
  const parsed = expandDotenv(parseDotenv(content));
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    contentEl.innerHTML = '<div class="preview-placeholder">No key=value entries found.</div>';
    return;
  }
  renderKeyValueTable(entries, { maskSensitive: true });
}

const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M17.94 17.94A10 10 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9 9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const ICON_EYE_ON  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_COPY    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

function renderKeyValueTable(entries, opts = {}) {
  const maskSensitive = !!opts.maskSensitive;
  const table = document.createElement('table');
  table.className = 'data-table env-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Key</th><th>Value</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const [key, value] of entries) {
    const tr = document.createElement('tr');
    const kTd = document.createElement('td');
    kTd.textContent = key;
    kTd.className = 'env-key';
    const vTd = document.createElement('td');
    vTd.className = 'env-value';
    const sensitive = maskSensitive && SENSITIVE_ENV_RE.test(key);
    const valueSpan = document.createElement('span');
    valueSpan.className = 'env-value-text' + (sensitive ? ' masked' : '');
    valueSpan.dataset.raw = value;
    valueSpan.textContent = sensitive ? '••••••••' : String(value);
    vTd.appendChild(valueSpan);
    if (sensitive) {
      const toggle = document.createElement('button');
      toggle.className = 'env-action';
      const updateToggle = () => {
        const masked = valueSpan.classList.contains('masked');
        toggle.innerHTML = masked ? ICON_EYE_OFF : ICON_EYE_ON;
        toggle.classList.toggle('active', !masked);
        toggle.title = masked ? 'Reveal' : 'Hide';
        toggle.setAttribute('aria-pressed', String(!masked));
      };
      updateToggle();
      toggle.addEventListener('click', () => {
        const masked = valueSpan.classList.toggle('masked');
        valueSpan.textContent = masked ? '••••••••' : valueSpan.dataset.raw;
        updateToggle();
      });
      vTd.appendChild(toggle);
    }
    const copyBtn = document.createElement('button');
    copyBtn.className = 'env-action';
    copyBtn.title = 'Copy value';
    copyBtn.innerHTML = ICON_COPY;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(String(value));
        copyBtn.innerHTML = ICON_CHECK;
        copyBtn.classList.add('active');
        setTimeout(() => { copyBtn.innerHTML = ICON_COPY; copyBtn.classList.remove('active'); }, 1200);
      } catch {}
    });
    vTd.appendChild(copyBtn);
    tr.appendChild(kTd);
    tr.appendChild(vTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  contentEl.innerHTML = '';
  contentEl.appendChild(table);
}

// ==================== .ini / .properties ====================
function renderINIPreview(content) {
  mountJSONEditor(content, (c) => ini.parse(c), 'INI', { readOnly: true });
}

function renderPropertiesPreview(content) {
  const entries = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (!m) continue;
    entries.push([m[1], m[2]]);
  }
  if (entries.length === 0) {
    contentEl.innerHTML = '<div class="preview-placeholder">No properties entries found.</div>';
    return;
  }
  renderKeyValueTable(entries, { maskSensitive: true });
}

// ==================== Editor↔Preview line sync ====================
function buildPreviewLineMap(source) {
  const tokens = marked.lexer(source);
  const children = Array.from(contentEl.children);
  let charOffset = 0;
  let childIdx = 0;
  for (const token of tokens) {
    if (token.type === 'space') { charOffset += token.raw.length; continue; }
    const line = source.substring(0, charOffset).split('\n').length - 1;
    if (childIdx < children.length) {
      children[childIdx].setAttribute('data-source-line', line);
      childIdx++;
    }
    charOffset += token.raw.length;
  }
}

function highlightPreviewLine(editorLine) {
  if (tocScrolling) return;
  const prev = contentEl.querySelector('.line-highlight');
  if (prev) prev.classList.remove('line-highlight');
  const elements = contentEl.querySelectorAll('[data-source-line]');
  let closest = null;
  for (const el of elements) {
    const line = parseInt(el.getAttribute('data-source-line'));
    if (line <= editorLine) closest = el;
    else break;
  }
  if (closest) {
    closest.classList.add('line-highlight');
    if (!editorMouseDown) {
      const rect = closest.getBoundingClientRect();
      const paneRect = previewPaneEl.getBoundingClientRect();
      if (rect.bottom < paneRect.top || rect.top > paneRect.bottom) {
        closest.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }
}

// ==================== Outline (per-format TOC) ====================
// Each builder returns null (= "outline not supported for this format") or [] (= "no
// items found") or an array of {label, level, line?, target?, sourceLine?}. `target`
// is a DOM node for markdown preview-pane scrolling. `line` is a 1-based editor line
// (other formats jump the editor caret).
function buildOutlineMarkdown() {
  const headings = contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
  return Array.from(headings).map((h) => ({
    label: h.textContent,
    level: parseInt(h.tagName.charAt(1)) - 1,
    target: h,
    sourceLine: parseInt(h.getAttribute('data-source-line') || (h.closest('[data-source-line]') || {}).getAttribute?.('data-source-line')),
  }));
}
function buildOutlineHtml(text) {
  const items = [];
  const re = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(text)) && items.length < 200) {
    const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    items.push({
      label,
      level: parseInt(m[1].charAt(1)) - 1,
      line: text.substring(0, m.index).split('\n').length,
    });
  }
  return items;
}
// Walks a parsed JSON/YAML tree depth-first, capping items + max nesting depth.
// `level` doubles as both the visual indent and the toc-item.toc-level-N CSS class.
function walkObjectOutline(obj, items, opts) {
  const { maxItems = 200, maxDepth = 5, level = 0 } = opts;
  if (items.length >= maxItems || level > maxDepth) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (items.length >= maxItems) return;
      const v = obj[i];
      const isObj = v !== null && typeof v === 'object';
      items.push({ label: '[' + i + ']', level });
      if (isObj) walkObjectOutline(v, items, { ...opts, level: level + 1 });
    }
    return;
  }
  for (const k of Object.keys(obj)) {
    if (items.length >= maxItems) return;
    const v = obj[k];
    const isObj = v !== null && typeof v === 'object';
    items.push({ label: k, level });
    if (isObj) walkObjectOutline(v, items, { ...opts, level: level + 1 });
  }
}
function buildOutlineJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (parsed === null || typeof parsed !== 'object') return [];
  const items = [];
  walkObjectOutline(parsed, items, {});
  return items;
}
function buildOutlineYaml(text) {
  let parsed;
  try { parsed = yamljs.load(text); } catch { return []; }
  if (parsed === null || typeof parsed !== 'object') return [];
  const items = [];
  walkObjectOutline(parsed, items, {});
  return items;
}
function buildOutlineSectioned(text) {
  const items = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && items.length < 200; i++) {
    const m = lines[i].trim().match(/^\[([^\]]+)\]/);
    if (m) {
      const path = m[1];
      items.push({ label: path, level: Math.min(path.split('.').length - 1, 5), line: i + 1 });
    }
  }
  return items;
}
function buildOutlineXml(text) {
  const items = [];
  const re = /^\s*<([A-Za-z_][\w:.-]*)/gm;
  let m;
  while ((m = re.exec(text)) && items.length < 200) {
    const tag = m[1];
    if (tag.startsWith('?') || tag.startsWith('!')) continue;
    items.push({ label: tag, level: 0, line: text.substring(0, m.index).split('\n').length });
  }
  return items;
}
function buildOutlineKeyValue(text, sep) {
  const items = [];
  const lines = text.split('\n');
  const re = sep === ':' ? /^([A-Za-z_][\w.-]*)\s*:/ : /^([A-Za-z_][\w.-]*)\s*=/;
  for (let i = 0; i < lines.length && items.length < 200; i++) {
    const line = lines[i];
    if (!line || line.trim().startsWith('#')) continue;
    const m = line.match(re);
    if (m) items.push({ label: m[1], level: 0, line: i + 1 });
  }
  return items;
}
function buildOutlineDelimited(text, sep) {
  const firstLine = text.split('\n')[0] || '';
  if (!firstLine) return [];
  return firstLine.split(sep).map((c, i) => ({
    label: c.trim() || ('column ' + (i + 1)),
    level: 0,
    line: 1,
  }));
}

function buildOutline(viewType, content) {
  switch (viewType) {
    case 'markdown': return buildOutlineMarkdown();
    case 'html': return buildOutlineHtml(content);
    case 'json':
    case 'jsonl':
      return buildOutlineJson(content);
    case 'yaml': return buildOutlineYaml(content);
    case 'toml':
    case 'ini':
    case 'conf':
      return buildOutlineSectioned(content);
    case 'properties':
    case 'env':
      return buildOutlineKeyValue(content, '=');
    case 'xml': return buildOutlineXml(content);
    case 'csv': return buildOutlineDelimited(content, ',');
    case 'tsv': return buildOutlineDelimited(content, '\t');
  }
  return null;
}

// ==================== TOC ====================
const tocSourceHeader = document.getElementById('toc-source-header');
const tocSourceLabel = document.getElementById('toc-source-label');

function setTocSource(text) {
  if (!tocSourceLabel || !tocSourceHeader) return;
  if (!text) {
    tocSourceHeader.classList.add('hidden');
    tocSourceLabel.textContent = '';
  } else {
    tocSourceHeader.classList.remove('hidden');
    tocSourceLabel.textContent = text;
  }
}

function buildTOC() {
  const tab = getActiveTab();
  if (tocScrollHandler) { contentEl.removeEventListener('scroll', tocScrollHandler); tocScrollHandler = null; }
  if (!tab) {
    setTocSource('');
    tocNav.innerHTML = `<p class="toc-empty">${t('outline.noFile')}</p>`;
    return;
  }
  const viewType = tab.viewType || 'markdown';
  const fileName = tab.filePath ? tab.filePath.split(/[/\\]/).pop() : t('untitled');
  setTocSource(fileName + '  ·  ' + viewType);

  const content = editor.state.doc.toString();
  const items = buildOutline(viewType, content);

  if (items === null) {
    tocNav.innerHTML = `<p class="toc-empty">${t('outline.notSupported')}</p>`;
    return;
  }
  if (items.length === 0) {
    tocNav.innerHTML = `<p class="toc-empty">${t('noHeadings')}</p>`;
    return;
  }

  const list = document.createElement('ul');
  list.className = 'toc-list';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'toc-item toc-level-' + Math.min(Math.max(item.level + 1, 1), 6);
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = item.label;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      tocScrolling = true;
      tocNav.querySelectorAll('a').forEach(l => l.classList.remove('active'));
      a.classList.add('active');

      if (viewType === 'markdown' && item.target) {
        const h = item.target;
        a.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const paneRect = previewPaneEl.getBoundingClientRect();
        const headingRect = h.getBoundingClientRect();
        previewPaneEl.scrollTo({ top: contentEl.scrollTop + headingRect.top - paneRect.top, behavior: 'smooth' });
        if (!isNaN(item.sourceLine)) {
          setTimeout(() => {
            const line = editor.state.doc.line(Math.min(item.sourceLine + 1, editor.state.doc.lines));
            editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
            setTimeout(() => { tocScrolling = false; }, 200);
          }, 100);
        } else {
          setTimeout(() => { tocScrolling = false; }, 200);
        }
      } else if (item.line && item.line >= 1 && item.line <= editor.state.doc.lines) {
        const line = editor.state.doc.line(item.line);
        editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
        editor.focus();
        setTimeout(() => { tocScrolling = false; }, 200);
      } else {
        setTimeout(() => { tocScrolling = false; }, 200);
      }
    });
    li.appendChild(a);
    list.appendChild(li);
  });
  tocNav.innerHTML = '';
  tocNav.appendChild(list);

  // Scroll spy only for markdown (other formats have no preview-side anchor to track).
  if (viewType === 'markdown') {
    const headings = items.map(it => it.target).filter(Boolean);
    const links = Array.from(tocNav.querySelectorAll('a'));
    tocScrollHandler = () => {
      if (tocScrolling) return;
      let currentIdx = -1;
      headings.forEach((h, idx) => { if (h.getBoundingClientRect().top <= 100) currentIdx = idx; });
      links.forEach((l, idx) => l.classList.toggle('active', idx === currentIdx));
    };
    contentEl.addEventListener('scroll', tocScrollHandler);
  }
}

// ==================== Backlinks ====================
async function refreshBacklinks() {
  if (!backlinksContentEl) return;
  const tab = getActiveTab();
  if (!tab?.filePath || !workspacePath) {
    backlinksContentEl.innerHTML = '<p class="backlinks-empty">' + t('backlinks.noFile') + '</p>';
    return;
  }
  // Backlinks are wiki-link-based and only meaningful in markdown.
  if ((tab.viewType || 'markdown') !== 'markdown') {
    backlinksContentEl.innerHTML = '<p class="backlinks-empty">' + t('backlinks.markdownOnly') + '</p>';
    return;
  }
  const data = await window.formatpad.getBacklinks(workspacePath, tab.filePath);
  renderBacklinks(data);
}

function renderBacklinks(data) {
  backlinksContentEl.innerHTML = '';
  const { linked, unlinked } = data;

  if (linked.length === 0 && unlinked.length === 0) {
    backlinksContentEl.innerHTML = '<p class="backlinks-empty">' + t('backlinks.none') + '</p>';
    return;
  }

  if (linked.length > 0) {
    backlinksContentEl.appendChild(createBacklinkSection(t('backlinks.linked'), linked));
  }
  if (unlinked.length > 0) {
    backlinksContentEl.appendChild(createBacklinkSection(t('backlinks.unlinked'), unlinked));
  }
}

function createBacklinkSection(title, items) {
  const section = document.createElement('div');
  section.className = 'backlink-section';

  const header = document.createElement('div');
  header.className = 'backlink-section-header';
  header.textContent = title + ' (' + items.length + ')';
  header.addEventListener('click', () => {
    const list = section.querySelector('.backlink-list');
    if (list) list.classList.toggle('collapsed');
    header.classList.toggle('collapsed');
  });
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'backlink-list';

  for (const item of items) {
    const group = document.createElement('div');
    group.className = 'backlink-item';

    const name = document.createElement('div');
    name.className = 'backlink-file-name';
    name.textContent = item.sourceTitle;
    name.addEventListener('click', () => openFileInTab(item.sourcePath));
    group.appendChild(name);

    const ctx = document.createElement('div');
    ctx.className = 'backlink-context';
    ctx.textContent = item.context.trim().substring(0, 150);
    ctx.addEventListener('click', () => openSearchResult(item.sourcePath, item.line));
    group.appendChild(ctx);

    list.appendChild(group);
  }

  section.appendChild(list);
  return section;
}

// ==================== Sidebar ====================
function showSidebar(panel) {
  if (sidebarVisible && sidebarActivePanel === panel) {
    sidebarVisible = false;
    sidebarEl.classList.add('hidden');
    document.getElementById('btn-files').classList.remove('active');
    document.getElementById('btn-toc').classList.remove('active');
    localStorage.setItem('fp-sidebar-visible', 'false');
    return;
  }

  sidebarVisible = true;
  sidebarActivePanel = panel || sidebarActivePanel || 'files';
  sidebarEl.classList.remove('hidden');
  const savedWidth = parseInt(localStorage.getItem('fp-sidebar-width'));
  if (savedWidth > 0) { sidebarEl.style.width = savedWidth + 'px'; sidebarEl.style.minWidth = savedWidth + 'px'; }

  document.querySelectorAll('.sidebar-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === sidebarActivePanel);
  });
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('sidebar-' + sidebarActivePanel).classList.add('active');

  document.getElementById('btn-files').classList.toggle('active', sidebarVisible && sidebarActivePanel === 'files');
  document.getElementById('btn-toc').classList.toggle('active', sidebarVisible && sidebarActivePanel === 'toc');

  localStorage.setItem('fp-sidebar-visible', 'true');
  localStorage.setItem('fp-sidebar-panel', sidebarActivePanel);

  if (sidebarActivePanel === 'search') {
    setTimeout(() => searchInputEl.focus(), 100);
  }
}

document.querySelectorAll('.sidebar-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = btn.dataset.panel;
    sidebarActivePanel = panel;
    document.querySelectorAll('.sidebar-tab').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('sidebar-' + panel).classList.add('active');
    localStorage.setItem('fp-sidebar-panel', panel);
    document.getElementById('btn-toc').classList.toggle('active', panel === 'toc');
    if (panel === 'search') setTimeout(() => searchInputEl.focus(), 100);
    if (panel === 'backlinks') refreshBacklinks();
  });
});

// ==================== Sidebar Resize ====================
const sidebarResizeEl = document.getElementById('sidebar-resize');
let sidebarDragging = false;

sidebarResizeEl.addEventListener('mousedown', (e) => {
  if (!sidebarVisible) return;
  sidebarDragging = true;
  sidebarResizeEl.classList.add('dragging');
  sidebarEl.style.transition = 'none';
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!sidebarDragging) return;
  const rect = workspaceEl.getBoundingClientRect();
  const newWidth = Math.max(160, Math.min(500, e.clientX - rect.left));
  sidebarEl.style.width = newWidth + 'px';
  sidebarEl.style.minWidth = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (sidebarDragging) {
    sidebarDragging = false;
    sidebarResizeEl.classList.remove('dragging');
    sidebarEl.style.transition = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('fp-sidebar-width', sidebarEl.offsetWidth);
  }
});

sidebarResizeEl.addEventListener('dblclick', () => {
  sidebarEl.style.width = '';
  sidebarEl.style.minWidth = '';
  localStorage.removeItem('fp-sidebar-width');
});

// ==================== File Tree ====================
async function openFolder() {
  const folderPath = await window.formatpad.openFolderDialog();
  if (folderPath) {
    workspacePath = folderPath;
    expandedPaths.clear();
    localStorage.setItem('fp-workspace-path', workspacePath);
    await loadFileTree();
    window.formatpad.watchDirectory(folderPath);
    window.formatpad.buildLinkIndex(folderPath).then(() => refreshFileNameCache());
    if (!sidebarVisible) showSidebar('files');
  }
}

async function loadFileTree() {
  if (!workspacePath) {
    fileTreeEl.innerHTML = `<div class="tree-empty">${t('sidebar.openFolder')}</div>`;
    return;
  }
  const tree = await window.formatpad.readDirectory(workspacePath);
  renderFileTree(tree, 0);
}

function renderFileTree(items, depth) {
  if (depth === 0) fileTreeEl.innerHTML = '';
  const container = depth === 0 ? fileTreeEl : document.createDocumentFragment();

  if (items.length === 0 && depth === 0) {
    fileTreeEl.innerHTML = `<div class="tree-empty">${t('sidebar.openFolder')}</div>`;
    return;
  }

  for (const item of items) {
    if (item.isDirectory) {
      const wrapper = document.createElement('div');
      const itemEl = document.createElement('div');
      itemEl.className = 'tree-item';
      itemEl.style.paddingLeft = (depth * 12 + 8) + 'px';
      itemEl.innerHTML =
        '<span class="tree-item-icon"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6.427 3.573l3.396 3.396a.25.25 0 0 1 0 .354l-3.396 3.396A.25.25 0 0 1 6 7.396V3.75a.25.25 0 0 1 .427-.177z"/></svg></span>' +
        '<span class="tree-item-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg></span>' +
        `<span class="tree-item-name">${escapeHtml(item.name)}</span>`;

      const childContainer = document.createElement('div');
      const wasExpanded = expandedPaths.has(item.path);
      childContainer.className = 'tree-children' + (wasExpanded ? '' : ' collapsed');

      let expanded = wasExpanded;
      let childrenRendered = false;

      if (wasExpanded && item.children) {
        childrenRendered = true;
        const arrow = itemEl.querySelector('.tree-item-icon:first-child');
        arrow.style.transform = 'rotate(90deg)';
        const frag = document.createDocumentFragment();
        renderSubTree(item.children, depth + 1, frag);
        childContainer.appendChild(frag);
      }

      itemEl.addEventListener('click', () => {
        expanded = !expanded;
        if (expanded) expandedPaths.add(item.path); else expandedPaths.delete(item.path);
        childContainer.classList.toggle('collapsed', !expanded);
        const arrow = itemEl.querySelector('.tree-item-icon:first-child');
        arrow.style.transform = expanded ? 'rotate(90deg)' : '';
        if (expanded && !childrenRendered && item.children) {
          childrenRendered = true;
          const frag = document.createDocumentFragment();
          renderSubTree(item.children, depth + 1, frag);
          childContainer.appendChild(frag);
        }
      });

      itemEl.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, item.path, true); });

      wrapper.appendChild(itemEl);
      wrapper.appendChild(childContainer);
      container.appendChild(wrapper);
    } else {
      const itemEl = document.createElement('div');
      itemEl.className = 'tree-item';
      itemEl.style.paddingLeft = (depth * 12 + 24) + 'px';
      const isMd = /\.(md|markdown|mkd|mdx)$/i.test(item.name);
      const isSupported = isSupportedFormat(item.name);
      itemEl.innerHTML =
        '<span class="tree-item-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25V1.75C2 .784 2.784 0 3.75 0Z"/></svg></span>' +
        `<span class="tree-item-name" style="${isSupported ? '' : 'opacity:0.5'}">${escapeHtml(item.name)}</span>`;

      if (isSupported) {
        itemEl.addEventListener('click', () => openFileInTab(item.path));
      }
      if (isMd) {
        // Drag .md file to editor → insert [[link]]
        itemEl.draggable = true;
        itemEl.addEventListener('dragstart', (e) => {
          const baseName = item.name.replace(/\.(md|markdown|mkd|mdx)$/i, '');
          e.dataTransfer.setData('text/plain', '[[' + baseName + ']]');
          e.dataTransfer.setData('application/x-fp-link', baseName);
          e.dataTransfer.effectAllowed = 'copy';
        });
      }
      itemEl.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, item.path, false); });
      container.appendChild(itemEl);
    }
  }

  if (depth === 0) return;
  return container;
}

function renderSubTree(items, depth, container) {
  for (const item of items) {
    if (item.isDirectory) {
      const wrapper = document.createElement('div');
      const itemEl = document.createElement('div');
      itemEl.className = 'tree-item';
      itemEl.style.paddingLeft = (depth * 12 + 8) + 'px';
      itemEl.innerHTML =
        '<span class="tree-item-icon"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6.427 3.573l3.396 3.396a.25.25 0 0 1 0 .354l-3.396 3.396A.25.25 0 0 1 6 7.396V3.75a.25.25 0 0 1 .427-.177z"/></svg></span>' +
        '<span class="tree-item-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg></span>' +
        `<span class="tree-item-name">${escapeHtml(item.name)}</span>`;

      const childContainer = document.createElement('div');
      const wasExpanded = expandedPaths.has(item.path);
      childContainer.className = 'tree-children' + (wasExpanded ? '' : ' collapsed');
      let expanded = wasExpanded;
      let childrenRendered = false;

      if (wasExpanded && item.children) {
        childrenRendered = true;
        itemEl.querySelector('.tree-item-icon:first-child').style.transform = 'rotate(90deg)';
        const frag = document.createDocumentFragment();
        renderSubTree(item.children, depth + 1, frag);
        childContainer.appendChild(frag);
      }

      itemEl.addEventListener('click', () => {
        expanded = !expanded;
        if (expanded) expandedPaths.add(item.path); else expandedPaths.delete(item.path);
        childContainer.classList.toggle('collapsed', !expanded);
        itemEl.querySelector('.tree-item-icon:first-child').style.transform = expanded ? 'rotate(90deg)' : '';
        if (expanded && !childrenRendered && item.children) {
          childrenRendered = true;
          const frag = document.createDocumentFragment();
          renderSubTree(item.children, depth + 1, frag);
          childContainer.appendChild(frag);
        }
      });
      itemEl.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, item.path, true); });
      wrapper.appendChild(itemEl);
      wrapper.appendChild(childContainer);
      container.appendChild(wrapper);
    } else {
      const itemEl = document.createElement('div');
      itemEl.className = 'tree-item';
      itemEl.style.paddingLeft = (depth * 12 + 24) + 'px';
      const isMd = /\.(md|markdown|mkd|mdx)$/i.test(item.name);
      const isSupported = isSupportedFormat(item.name);
      itemEl.innerHTML =
        '<span class="tree-item-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25V1.75C2 .784 2.784 0 3.75 0Z"/></svg></span>' +
        `<span class="tree-item-name" style="${isSupported ? '' : 'opacity:0.5'}">${escapeHtml(item.name)}</span>`;
      if (isSupported) {
        itemEl.addEventListener('click', () => openFileInTab(item.path));
      }
      if (isMd) {
        itemEl.draggable = true;
        itemEl.addEventListener('dragstart', (e) => {
          const baseName = item.name.replace(/\.(md|markdown|mkd|mdx)$/i, '');
          e.dataTransfer.setData('text/plain', '[[' + baseName + ']]');
          e.dataTransfer.setData('application/x-fp-link', baseName);
          e.dataTransfer.effectAllowed = 'copy';
        });
      }
      itemEl.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, item.path, false); });
      container.appendChild(itemEl);
    }
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function openFileInTab(filePath) {
  const existing = findTabByPath(filePath);
  if (existing) { switchToTab(existing.id); return; }
  const result = await window.formatpad.readFile(filePath);
  if (result.error) return;
  createTab(result.filePath, result.dirPath, result.content);
}

// File tree toolbar
document.getElementById('btn-open-folder').addEventListener('click', openFolder);
document.getElementById('btn-refresh-tree').addEventListener('click', loadFileTree);

// Blank-area right-click in the file tree → context menu rooted at the workspace.
document.getElementById('file-tree').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.tree-item')) return;
  if (!workspacePath) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, workspacePath, true);
});

// File watcher
let fileTreeRefreshTimer = null;
let linkIndexRefreshTimer = null;
window.formatpad.onDirectoryChanged(() => {
  if (fileTreeRefreshTimer) clearTimeout(fileTreeRefreshTimer);
  fileTreeRefreshTimer = setTimeout(loadFileTree, 500);
  if (linkIndexRefreshTimer) clearTimeout(linkIndexRefreshTimer);
  linkIndexRefreshTimer = setTimeout(() => {
    if (workspacePath) window.formatpad.buildLinkIndex(workspacePath).then(() => refreshFileNameCache());
  }, 1000);
});

// ==================== Context Menu ====================
function showContextMenu(x, y, targetPath, isDir) {
  contextMenuTarget = targetPath;
  contextMenuIsDir = isDir;
  const menu = document.getElementById('context-menu');
  menu.classList.remove('hidden');

  const isRoot = workspacePath && targetPath === workspacePath;

  document.getElementById('ctx-new-file').style.display = isDir ? '' : 'none';
  document.getElementById('ctx-new-md').style.display = isDir ? '' : 'none';
  document.getElementById('ctx-new-folder').style.display = isDir ? '' : 'none';
  document.getElementById('ctx-sep-new').style.display = isDir ? '' : 'none';

  document.getElementById('ctx-reveal').style.display = '';

  document.getElementById('ctx-rename').style.display = isRoot ? 'none' : '';
  document.getElementById('ctx-delete').style.display = isRoot ? 'none' : '';
  document.getElementById('ctx-sep-mutate').style.display = isRoot ? 'none' : '';

  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - menuW - 4) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menuH - 4) + 'px';
}

document.addEventListener('click', () => document.getElementById('context-menu').classList.add('hidden'));

document.getElementById('ctx-new-file').addEventListener('click', async () => {
  const name = prompt(t('context.newFile') + ':', 'untitled.md');
  if (!name) return;
  const fullPath = contextMenuTarget.replace(/\\/g, '/') + '/';
  const result = await window.formatpad.createFile(fullPath);
  if (result.success) { await loadFileTree(); await openFileInTab(fullPath); }
});

document.getElementById('ctx-new-folder').addEventListener('click', async () => {
  const name = prompt(t('context.newFolder') + ':');
  if (!name) return;
  const fullPath = contextMenuTarget.replace(/\\/g, '/') + '/';
  const result = await window.formatpad.createFolder(fullPath);
  if (result.success) await loadFileTree();
});

document.getElementById('ctx-new-md').addEventListener('click', async () => {
  const name = prompt(t('context.newMdFile') + ':', 'untitled.md');
  if (!name) return;
  const finalName = /\.(md|markdown|mkd|mdx)$/i.test(name) ? name : name + '.md';
  const fullPath = contextMenuTarget.replace(/\\/g, '/') + '/' + finalName;
  const result = await window.formatpad.createFile(fullPath);
  if (result.success) { await loadFileTree(); await openFileInTab(fullPath); }
});

document.getElementById('ctx-reveal').addEventListener('click', () => {
  window.formatpad.revealInExplorer(contextMenuTarget);
});

document.getElementById('ctx-rename').addEventListener('click', async () => {
  const oldName = contextMenuTarget.split(/[/\\]/).pop();
  const newName = prompt(t('context.rename') + ':', oldName);
  if (!newName || newName === oldName) return;
  const dir = contextMenuTarget.substring(0, contextMenuTarget.length - oldName.length);
  const newPath = dir + newName;
  const result = await window.formatpad.renameFile(contextMenuTarget, newPath);
  if (result.success) {
    for (const tab of tabs) {
      if (tab.filePath && tab.filePath.replace(/\\/g, '/').toLowerCase() === contextMenuTarget.replace(/\\/g, '/').toLowerCase()) {
        tab.filePath = newPath;
        tab.dirPath = dir.replace(/[/\\]$/, '');
      }
    }
    await loadFileTree();
    renderTabBar();
    updateTitle();
  }
});

document.getElementById('ctx-delete').addEventListener('click', async () => {
  const name = contextMenuTarget.split(/[/\\]/).pop();
  if (!confirm(t('dialog.deleteConfirm').replace('{0}', name))) return;
  const result = await window.formatpad.deleteFile(contextMenuTarget);
  if (result.success) {
    const tab = findTabByPath(contextMenuTarget);
    if (tab) { tab.isModified = false; await closeTab(tab.id); }
    await loadFileTree();
  }
});

// ==================== Search ====================
document.getElementById('btn-search-regex').addEventListener('click', (e) => {
  searchRegex = !searchRegex;
  e.currentTarget.classList.toggle('active', searchRegex);
  performSearch();
});

document.getElementById('btn-search-case').addEventListener('click', (e) => {
  searchCaseSensitive = !searchCaseSensitive;
  e.currentTarget.classList.toggle('active', searchCaseSensitive);
  performSearch();
});

searchInputEl.addEventListener('input', () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(performSearch, 300);
});

searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); performSearch(); }
});

// Order roughly matches FORMAT_BAR_VIEWS — keeps the popover skim-friendly.
const SEARCH_FILTER_EXTS = [
  'md', 'markdown', 'mdx', 'mmd',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'conf', 'properties', 'env',
  'csv', 'tsv',
  'xml', 'html', 'htm',
  'log', 'txt',
];
const SEARCH_EXT_LS_KEY = 'fp-search-ext-filter';
let searchSelectedExts = null;
try {
  const raw = localStorage.getItem(SEARCH_EXT_LS_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) searchSelectedExts = parsed;
  }
} catch {}

async function performSearch() {
  const query = searchInputEl.value.trim();
  if (!query) { searchResultsEl.innerHTML = ''; searchStatusEl.textContent = ''; return; }
  if (!workspacePath) {
    searchResultsEl.innerHTML = `<div class="search-empty">${t('sidebar.openFolder')}</div>`;
    return;
  }
  const results = await window.formatpad.searchFiles(workspacePath, query, {
    regex: searchRegex,
    caseSensitive: searchCaseSensitive,
    extensions: searchSelectedExts,
  });
  renderSearchResults(results);
}

(() => {
  const btn = document.getElementById('btn-search-ext');
  const popover = document.getElementById('search-ext-popover');
  const list = document.getElementById('search-ext-list');
  const label = document.getElementById('search-ext-label');
  if (!btn || !popover || !list || !label) return;

  function updateLabel() {
    if (!searchSelectedExts || searchSelectedExts.length === 0) {
      label.textContent = t('search.extAll');
    } else if (searchSelectedExts.length === 1) {
      label.textContent = '*.' + searchSelectedExts[0];
    } else if (searchSelectedExts.length <= 3) {
      label.textContent = searchSelectedExts.map(e => '*.' + e).join(', ');
    } else {
      label.textContent = t('search.extCount').replace('{0}', String(searchSelectedExts.length));
    }
  }

  function syncCheckboxes() {
    const set = searchSelectedExts ? new Set(searchSelectedExts) : null;
    list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = set ? set.has(cb.value) : true;
    });
  }

  function persist() {
    try {
      if (searchSelectedExts === null) localStorage.removeItem(SEARCH_EXT_LS_KEY);
      else localStorage.setItem(SEARCH_EXT_LS_KEY, JSON.stringify(searchSelectedExts));
    } catch {}
  }

  function rebuildList() {
    list.innerHTML = '';
    for (const ext of SEARCH_FILTER_EXTS) {
      const row = document.createElement('label');
      row.className = 'search-ext-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = ext;
      cb.checked = !searchSelectedExts || searchSelectedExts.includes(ext);
      cb.addEventListener('change', () => {
        const checked = Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
        searchSelectedExts = (checked.length === SEARCH_FILTER_EXTS.length) ? null : checked;
        persist();
        updateLabel();
        if (searchInputEl.value.trim()) performSearch();
      });
      const name = document.createElement('span');
      name.textContent = '*.' + ext;
      row.appendChild(cb);
      row.appendChild(name);
      list.appendChild(row);
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    popover.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!popover.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      popover.classList.add('hidden');
    }
  });
  document.getElementById('btn-search-ext-all').addEventListener('click', () => {
    searchSelectedExts = null;
    syncCheckboxes();
    persist();
    updateLabel();
    if (searchInputEl.value.trim()) performSearch();
  });
  document.getElementById('btn-search-ext-none').addEventListener('click', () => {
    searchSelectedExts = [];
    syncCheckboxes();
    persist();
    updateLabel();
    if (searchInputEl.value.trim()) performSearch();
  });

  rebuildList();
  updateLabel();
})();

function renderSearchResults(results) {
  searchResultsEl.innerHTML = '';
  if (results.length === 0) {
    searchResultsEl.innerHTML = `<div class="search-empty">${t('search.noResults')}</div>`;
    searchStatusEl.textContent = '';
    return;
  }
  let totalMatches = 0;
  for (const file of results) {
    totalMatches += file.matches.length;
    const group = document.createElement('div');
    group.className = 'search-file-group';

    const fileName = document.createElement('div');
    fileName.className = 'search-file-name';
    fileName.textContent = file.relativePath;
    fileName.addEventListener('click', () => openFileInTab(file.filePath));
    group.appendChild(fileName);

    for (const match of file.matches) {
      const matchEl = document.createElement('div');
      matchEl.className = 'search-match';
      const lineNum = document.createElement('span');
      lineNum.className = 'search-match-line';
      lineNum.textContent = match.lineNumber;
      const lineText = document.createElement('span');
      lineText.textContent = match.lineText.trim().substring(0, 120);
      matchEl.appendChild(lineNum);
      matchEl.appendChild(lineText);
      matchEl.addEventListener('click', () => openSearchResult(file.filePath, match.lineNumber));
      group.appendChild(matchEl);
    }
    searchResultsEl.appendChild(group);
  }
  searchStatusEl.textContent = t('search.results').replace('{0}', totalMatches).replace('{1}', results.length);
}

async function openSearchResult(filePath, lineNumber) {
  await openFileInTab(filePath);
  requestAnimationFrame(() => {
    const lineCount = editor.state.doc.lines;
    const line = editor.state.doc.line(Math.min(lineNumber, lineCount));
    editor.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    editor.focus();
  });
}

// ==================== View Modes ====================
let viewMode = 'split';
const viewBtns = { editor: document.getElementById('btn-editor'), split: document.getElementById('btn-split'), preview: document.getElementById('btn-preview') };

function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('fp-view-mode', mode);
  document.body.classList.remove('view-editor', 'view-split', 'view-preview');
  document.body.classList.add('view-' + mode);
  Object.entries(viewBtns).forEach(([k, btn]) => btn.classList.toggle('active', k === mode));
  if (mode === 'editor') editor.focus();
}

viewBtns.editor.addEventListener('click', () => setViewMode('editor'));
viewBtns.split.addEventListener('click', () => setViewMode('split'));
viewBtns.preview.addEventListener('click', () => setViewMode('preview'));

// ==================== Divider Resize ====================
let isDragging = false;
dividerEl.addEventListener('mousedown', (e) => {
  isDragging = true;
  dividerEl.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const rect = workspaceEl.getBoundingClientRect();
  const sidebarWidth = sidebarVisible ? sidebarEl.offsetWidth : 0;
  const available = rect.width - sidebarWidth - dividerEl.offsetWidth;
  const offset = e.clientX - rect.left - sidebarWidth;
  const ratio = Math.max(0.15, Math.min(0.85, offset / available));
  editorPaneEl.style.flex = 'none';
  editorPaneEl.style.width = (ratio * available) + 'px';
  previewPaneEl.style.flex = '1';
});
document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    dividerEl.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const rect = workspaceEl.getBoundingClientRect();
    const sidebarWidth = sidebarVisible ? sidebarEl.offsetWidth : 0;
    const available = rect.width - sidebarWidth - dividerEl.offsetWidth;
    if (available > 0) {
      localStorage.setItem('fp-divider-ratio', (editorPaneEl.offsetWidth / available).toFixed(4));
    }
  }
});

dividerEl.addEventListener('dblclick', () => {
  editorPaneEl.style.flex = '1';
  editorPaneEl.style.width = '';
  previewPaneEl.style.flex = '1';
  localStorage.removeItem('fp-divider-ratio');
});

// ==================== File Operations ====================
async function saveFile() {
  const tab = getActiveTab();
  if (!tab) return;
  const content = editor.state.doc.toString();
  if (tab.filePath) {
    const ok = await window.formatpad.saveFile(tab.filePath, content);
    if (ok) {
      tab.lastSavedContent = content;
      tab.isModified = false;
      tab.lastAutoSavedContent = null;
      updateTitle();
      renderTabBar();
      showSaveFlash();
      window.formatpad.clearRecovery(getRecoveryKey(tab));
    } else {
      alert(t('failedSave'));
    }
  } else {
    await saveFileAs();
  }
}

async function saveFileAs() {
  const tab = getActiveTab();
  if (!tab) return;
  const content = editor.state.doc.toString();
  const oldKey = getRecoveryKey(tab);
  const result = await window.formatpad.saveFileAs(content);
  if (result) {
    window.formatpad.clearRecovery(oldKey);
    tab.filePath = result;
    tab.dirPath = result.substring(0, Math.max(result.lastIndexOf('/'), result.lastIndexOf('\\')));
    tab.lastSavedContent = content;
    tab.lastAutoSavedContent = null;
    tab.isModified = false;
    updateTitle();
    renderTabBar();
    showSaveFlash();
  }
}

// ==================== Unsaved Changes Protection ====================
window.formatpad.onCheckBeforeClose(async () => {
  const unsavedTabs = tabs.filter(tb => tb.isModified);
  if (unsavedTabs.length === 0) { window.formatpad.confirmClose(); return; }
  for (const tab of unsavedTabs) {
    switchToTab(tab.id);
    const result = await window.formatpad.showSaveDialog();
    if (result === 'save') {
      await saveFile();
      if (getActiveTab()?.isModified) return;
    } else if (result === 'cancel') {
      return;
    }
  }
  window.formatpad.confirmClose();
});

// ==================== Toolbar ====================
document.getElementById('btn-new').addEventListener('click', () => {
  createTab(null, null, '');
  editor.focus();
});
document.getElementById('btn-open').addEventListener('click', () => {
  window.formatpad.openFileDialog();
});
document.getElementById('btn-save').addEventListener('click', saveFile);
document.getElementById('btn-files').addEventListener('click', () => showSidebar('files'));
document.getElementById('btn-toc').addEventListener('click', () => showSidebar('toc'));
document.getElementById('btn-set-default').addEventListener('click', () => window.formatpad.openDefaultAppsSettings());

// ==================== Language Selector ====================
const langSelect = document.getElementById('lang-select');
LANGUAGES.forEach(({ code, name }) => {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = name;
  langSelect.appendChild(opt);
});
langSelect.addEventListener('change', () => {
  localStorage.setItem('fp-locale', langSelect.value);
  setLocale(langSelect.value);
  window.formatpad.setLocale(langSelect.value);
  applyLocaleToDOM();
  updateTitle();
  if (getActiveTab()) renderPreview(editor.state.doc.toString());
  renderThemePanel();
});

// ==================== Drag & Drop ====================
// Use capture phase so that dropped files never reach CodeMirror's built-in
// drop handler (which would treat the coordinates as a text insertion point
// and mark the existing document as modified).
let dragCounter = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  if (e.target && e.target.closest && e.target.closest('.diff-text')) return; // let diff textarea handle
  e.preventDefault();
  e.stopPropagation();
  dragCounter++;
  document.body.classList.add('drag-over');
}, true);
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('application/x-fp-link')) return;
  if (e.target && e.target.closest && e.target.closest('.diff-text')) return; // let diff textarea handle
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  e.preventDefault();
}, true);
document.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  if (e.target && e.target.closest && e.target.closest('.diff-text')) return;
  e.preventDefault();
  e.stopPropagation();
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; document.body.classList.remove('drag-over'); }
}, true);
document.addEventListener('drop', (e) => {
  // Internal drag (file tree → editor): let CodeMirror handle it
  if (e.dataTransfer.types.includes('application/x-fp-link')) return;
  // Diff panel: let the textarea's own drop handler load the file text
  if (e.target && e.target.closest && e.target.closest('.diff-text')) {
    dragCounter = 0;
    document.body.classList.remove('drag-over');
    return;
  }
  dragCounter = 0;
  document.body.classList.remove('drag-over');
  e.preventDefault();
  e.stopPropagation();
  const files = e.dataTransfer.files;
  for (const file of files) {
    if (isSupportedFormat(file.name)) {
      const filePath = window.formatpad.getPathForFile(file);
      if (filePath) window.formatpad.dropFile(filePath);
    }
  }
}, true);

// ==================== Status Bar ====================
function updateStatusBar() {
  const state = editor.state;
  const { main } = state.selection;
  const line = state.doc.lineAt(main.head);
  const col = main.head - line.from + 1;
  statusCursorEl.textContent = `Ln ${line.number}, Col ${col}`;
  if (main.from !== main.to) {
    const len = Math.abs(main.to - main.from);
    statusSelectionEl.textContent = `(${len} selected)`;
  } else {
    statusSelectionEl.textContent = '';
  }
  const text = state.doc.toString();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  statusWordsEl.textContent = `${words} words`;
  statusReadTimeEl.textContent = `~${Math.max(1, Math.ceil(words / 200))} min`;
}

// ==================== Format Toolbar ====================
// Prevent format bar clicks from stealing editor focus (preserves selection)
document.getElementById('format-bar').addEventListener('mousedown', (e) => { e.preventDefault(); });
function wrapSelection(before, after, placeholder) {
  const { from, to } = editor.state.selection.main;
  const selected = editor.state.sliceDoc(from, to);
  const text = selected || placeholder;
  const insert = before + text + after;
  editor.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + before.length, head: from + before.length + text.length },
  });
  editor.focus();
}

function toggleLinePrefix(prefix) {
  const { from } = editor.state.selection.main;
  const line = editor.state.doc.lineAt(from);
  const lineText = line.text;
  if (lineText.startsWith(prefix)) {
    editor.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: '' } });
  } else {
    const headingMatch = lineText.match(/^#{1,6}\s/);
    const removeLen = headingMatch ? headingMatch[0].length : 0;
    editor.dispatch({ changes: { from: line.from, to: line.from + removeLen, insert: prefix } });
  }
  editor.focus();
}

function insertBlock(text) {
  const { from, to } = editor.state.selection.main;
  const before = from > 0 && editor.state.sliceDoc(from - 1, from) !== '\n' ? '\n' : '';
  const after = to < editor.state.doc.length && editor.state.sliceDoc(to, to + 1) !== '\n' ? '\n' : '';
  editor.dispatch({ changes: { from, to, insert: before + text + after } });
  editor.focus();
}

document.getElementById('fmt-bold').addEventListener('click', () => wrapSelection('**', '**', 'bold'));
document.getElementById('fmt-italic').addEventListener('click', () => wrapSelection('*', '*', 'italic'));
document.getElementById('fmt-strike').addEventListener('click', () => wrapSelection('~~', '~~', 'strikethrough'));
document.getElementById('fmt-highlight').addEventListener('click', () => wrapSelection('==', '==', 'highlight'));
document.getElementById('fmt-code').addEventListener('click', () => wrapSelection('`', '`', 'code'));

// Heading dropdown
const headingMenu = document.getElementById('heading-menu');
document.getElementById('fmt-heading').addEventListener('click', (e) => { e.stopPropagation(); headingMenu.classList.toggle('hidden'); });
headingMenu.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => { toggleLinePrefix('#'.repeat(parseInt(btn.dataset.level)) + ' '); headingMenu.classList.add('hidden'); });
});
document.addEventListener('click', () => headingMenu.classList.add('hidden'));
document.getElementById('fmt-link').addEventListener('click', () => {
  const { from, to } = editor.state.selection.main;
  const selected = editor.state.sliceDoc(from, to);
  if (selected) {
    const insert = `[${selected}](url)`;
    editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from + selected.length + 3, head: from + selected.length + 6 } });
  } else {
    const insert = '[link text](url)';
    editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from + 1, head: from + 10 } });
  }
  editor.focus();
});
document.getElementById('fmt-image').addEventListener('click', () => {
  const { from, to } = editor.state.selection.main;
  const selected = editor.state.sliceDoc(from, to);
  const insert = selected ? `![${selected}](image-url)` : '![alt text](image-url)';
  editor.dispatch({ changes: { from, to, insert } });
  editor.focus();
});
document.getElementById('fmt-ul').addEventListener('click', () => toggleLinePrefix('- '));
document.getElementById('fmt-ol').addEventListener('click', () => toggleLinePrefix('1. '));
document.getElementById('fmt-task').addEventListener('click', () => toggleLinePrefix('- [ ] '));
document.getElementById('fmt-quote').addEventListener('click', () => toggleLinePrefix('> '));
document.getElementById('fmt-hr').addEventListener('click', () => insertBlock('\n---\n'));
document.getElementById('fmt-codeblock').addEventListener('click', () => {
  const { from, to } = editor.state.selection.main;
  const selected = editor.state.sliceDoc(from, to);
  const insert = '```\n' + (selected || 'code') + '\n```';
  editor.dispatch({ changes: { from, to, insert } });
  editor.focus();
});
document.getElementById('fmt-table').addEventListener('click', () => {
  insertBlock('| Header | Header |\n| ------ | ------ |\n| Cell   | Cell   |\n| Cell   | Cell   |');
});

// Insert dropdown
const insertMenu = document.getElementById('insert-menu');
document.getElementById('fmt-insert').addEventListener('click', (e) => { e.stopPropagation(); insertMenu.classList.toggle('hidden'); });
document.addEventListener('click', () => insertMenu.classList.add('hidden'));

document.getElementById('fmt-math-inline').addEventListener('click', () => { insertMenu.classList.add('hidden'); wrapSelection('$', '$', 'E=mc^2'); });
document.getElementById('fmt-math-block').addEventListener('click', () => { insertMenu.classList.add('hidden'); insertBlock('$$\n\\sum_{i=1}^{n} x_i\n$$'); });
document.getElementById('fmt-mermaid').addEventListener('click', () => { insertMenu.classList.add('hidden'); insertBlock('```mermaid\ngraph TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[OK]\n    B -->|No| D[End]\n```'); });
document.getElementById('fmt-sup').addEventListener('click', () => { insertMenu.classList.add('hidden'); wrapSelection('<sup>', '</sup>', 'text'); });
document.getElementById('fmt-sub').addEventListener('click', () => { insertMenu.classList.add('hidden'); wrapSelection('<sub>', '</sub>', 'text'); });
document.getElementById('fmt-footnote').addEventListener('click', () => {
  insertMenu.classList.add('hidden');
  const { from, to } = editor.state.selection.main;
  const ref = '[^1]';
  const def = '\n\n[^1]: footnote text';
  const docLen = editor.state.doc.length;
  editor.dispatch({ changes: [{ from, to, insert: ref }, { from: docLen, insert: def }] });
  editor.focus();
});
document.getElementById('fmt-comment').addEventListener('click', () => { insertMenu.classList.add('hidden'); wrapSelection('<!-- ', ' -->', 'comment'); });
document.getElementById('fmt-details').addEventListener('click', () => {
  insertMenu.classList.add('hidden');
  insertBlock('<details>\n<summary>Click to expand</summary>\n\nContent here...\n\n</details>');
});

// ==================== Per-viewType Toolbars ====================
// Handlers mutate the live viewer (currentGrid / currentJsonEditor) when possible,
// or replace editor text for operations that restructure content. Replacing text
// triggers preview re-render, which remounts the structured viewer cleanly.

function replaceEditorDoc(text) {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  editor.focus();
}

function notifyFormatError(label, err) {
  const msg = err?.message || String(err);
  console.warn('[' + label + ']', msg);
  const info = document.getElementById('file-info');
  if (!info) return;
  const prev = info.textContent;
  const prevColor = info.style.color;
  info.textContent = label + ': ' + msg;
  info.style.color = 'var(--syntax-tag, #f7768e)';
  setTimeout(() => { info.textContent = prev; info.style.color = prevColor; }, 2500);
}

// ========== CSV / TSV ==========
function csvAction(act) { if (currentGrid) currentGrid.runAction(act); }
document.getElementById('fmt-csv-row-above').addEventListener('click', () => csvAction('row-above'));
document.getElementById('fmt-csv-row-below').addEventListener('click', () => csvAction('row-below'));
document.getElementById('fmt-csv-col-left').addEventListener('click', () => csvAction('col-left'));
document.getElementById('fmt-csv-col-right').addEventListener('click', () => csvAction('col-right'));
document.getElementById('fmt-csv-del-row').addEventListener('click', () => csvAction('del-row'));
document.getElementById('fmt-csv-del-col').addEventListener('click', () => csvAction('del-col'));

document.getElementById('fmt-csv-clear-sort').addEventListener('click', () => {
  if (!currentGrid) return;
  currentGrid.sort = null;
  currentGrid.render();
});
document.getElementById('fmt-csv-clear-filters').addEventListener('click', () => {
  if (!currentGrid) return;
  currentGrid.filters = {};
  currentGrid.hideFilterPopup?.();
  currentGrid.render();
});
document.getElementById('fmt-csv-trim').addEventListener('click', () => {
  if (!currentGrid || currentGrid.readOnly) return;
  let changed = false;
  for (let c = 0; c < currentGrid.headers.length; c++) {
    const v = String(currentGrid.headers[c] ?? '');
    const t = v.trim();
    if (t !== v) { currentGrid.headers[c] = t; changed = true; }
  }
  for (let r = 0; r < currentGrid.data.length; r++) {
    for (let c = 0; c < currentGrid.data[r].length; c++) {
      const v = String(currentGrid.data[r][c] ?? '');
      const t = v.trim();
      if (t !== v) { currentGrid.data[r][c] = t; changed = true; }
    }
  }
  if (changed) { currentGrid.render(); currentGrid.notify(); }
});
document.getElementById('fmt-csv-dedupe').addEventListener('click', () => {
  if (!currentGrid || currentGrid.readOnly) return;
  const seen = new Set();
  const kept = [];
  for (const row of currentGrid.data) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  if (kept.length === currentGrid.data.length) return;
  currentGrid.data = kept;
  currentGrid.sort = null;
  currentGrid.render();
  currentGrid.notify();
});
document.getElementById('fmt-csv-copy-md').addEventListener('click', () => {
  if (!currentGrid) return;
  const hdr = currentGrid.headers;
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [];
  lines.push('| ' + hdr.map(esc).join(' | ') + ' |');
  lines.push('| ' + hdr.map(() => '---').join(' | ') + ' |');
  for (const row of currentGrid.data) {
    lines.push('| ' + hdr.map((_, i) => esc(row[i])).join(' | ') + ' |');
  }
  navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
});
document.getElementById('fmt-csv-transpose').addEventListener('click', () => {
  if (!currentGrid || currentGrid.readOnly) return;
  const matrix = [currentGrid.headers.slice(), ...currentGrid.data.map(r => r.slice())];
  if (matrix.length === 0) return;
  const nCols = Math.max(...matrix.map(r => r.length));
  const out = [];
  for (let c = 0; c < nCols; c++) {
    const newRow = [];
    for (let r = 0; r < matrix.length; r++) newRow.push(matrix[r][c] ?? '');
    out.push(newRow);
  }
  if (out.length === 0) return;
  currentGrid.headers = out[0];
  currentGrid.data = out.slice(1);
  if (currentGrid.data.length === 0) currentGrid.data = [Array(currentGrid.headers.length).fill('')];
  currentGrid.colWidths = currentGrid.headers.map(() => 120);
  currentGrid.sort = null;
  currentGrid.filters = {};
  currentGrid.setActive(0, 0);
  currentGrid.render();
  currentGrid.notify();
});

// ========== JSON ==========
function jsonBeautify(indent) {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    replaceEditorDoc(JSON.stringify(JSON.parse(text), null, indent));
  } catch (err) { notifyFormatError('JSON', err); }
}
document.getElementById('fmt-json-beautify2').addEventListener('click', () => jsonBeautify(2));
document.getElementById('fmt-json-beautify4').addEventListener('click', () => jsonBeautify(4));
document.getElementById('fmt-json-minify').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    replaceEditorDoc(JSON.stringify(JSON.parse(text)));
  } catch (err) { notifyFormatError('JSON', err); }
});
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}
document.getElementById('fmt-json-sort-keys').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    replaceEditorDoc(JSON.stringify(sortKeysDeep(JSON.parse(text)), null, 2));
  } catch (err) { notifyFormatError('JSON', err); }
});
document.getElementById('fmt-json-to-yaml').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const out = yamljs.dump(JSON.parse(text), { indent: 2, lineWidth: -1 });
    navigator.clipboard.writeText(out).catch(() => {});
  } catch (err) { notifyFormatError('JSON→YAML', err); }
});
function walkExpandable(data, visit) {
  const seen = new WeakSet();
  const inner = (v) => {
    if (v === null || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    visit(v);
    if (Array.isArray(v)) for (const c of v) inner(c);
    else for (const k of Object.keys(v)) inner(v[k]);
  };
  inner(data);
}
function setAllJsonExpanded(flag) {
  if (!currentJsonEditor || !currentJsonEditor.data) return;
  walkExpandable(currentJsonEditor.data, (v) => {
    try {
      if (Object.prototype.hasOwnProperty.call(v, 'jeditExpanded')) v.jeditExpanded = flag;
      else Object.defineProperty(v, 'jeditExpanded', { value: flag, writable: true, enumerable: false, configurable: true });
    } catch {}
  });
  currentJsonEditor.render();
}
document.getElementById('fmt-json-expand-all').addEventListener('click', () => setAllJsonExpanded(true));
document.getElementById('fmt-json-collapse-all').addEventListener('click', () => setAllJsonExpanded(false));
document.getElementById('fmt-json-escape').addEventListener('click', () => {
  const { from, to } = editor.state.selection.main;
  if (from === to) { notifyFormatError('Escape', new Error('Select text first')); return; }
  const text = editor.state.sliceDoc(from, to);
  editor.dispatch({ changes: { from, to, insert: JSON.stringify(text) } });
  editor.focus();
});
document.getElementById('fmt-json-unescape').addEventListener('click', () => {
  const { from, to } = editor.state.selection.main;
  if (from === to) { notifyFormatError('Unescape', new Error('Select a JSON string first')); return; }
  const text = editor.state.sliceDoc(from, to);
  try {
    const decoded = JSON.parse(text);
    if (typeof decoded !== 'string') throw new Error('Selection is not a JSON string literal');
    editor.dispatch({ changes: { from, to, insert: decoded } });
    editor.focus();
  } catch (err) { notifyFormatError('Unescape', err); }
});

// ========== YAML ==========
document.getElementById('fmt-yaml-beautify').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    replaceEditorDoc(yamljs.dump(yamljs.load(text), { indent: 2, lineWidth: -1 }));
  } catch (err) { notifyFormatError('YAML', err); }
});
document.getElementById('fmt-yaml-to-json').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const obj = yamljs.load(text);
    navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).catch(() => {});
  } catch (err) { notifyFormatError('YAML→JSON', err); }
});
document.getElementById('fmt-yaml-expand-all').addEventListener('click', () => setAllJsonExpanded(true));
document.getElementById('fmt-yaml-collapse-all').addEventListener('click', () => setAllJsonExpanded(false));

// ========== TOML / INI ==========
document.getElementById('fmt-kv-expand-all').addEventListener('click', () => setAllJsonExpanded(true));
document.getElementById('fmt-kv-collapse-all').addEventListener('click', () => setAllJsonExpanded(false));

// ========== Mermaid ==========
const MERMAID_TEMPLATES = {
  flowchart: 'flowchart TD\n    A[Start] --> B{Condition}\n    B -->|Yes| C[Action]\n    B -->|No| D[End]',
  sequence:  'sequenceDiagram\n    participant A as Alice\n    participant B as Bob\n    A->>B: Hello\n    B-->>A: Hi!',
  class:     'classDiagram\n    class Animal {\n      +name: String\n      +eat() void\n    }\n    class Dog {\n      +bark() void\n    }\n    Animal <|-- Dog',
  state:     'stateDiagram-v2\n    [*] --> Idle\n    Idle --> Active: start\n    Active --> Idle: stop\n    Active --> [*]',
  er:        'erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    ORDER ||--|{ ITEM : contains\n    CUSTOMER {\n      string name\n      string email\n    }',
  gantt:     'gantt\n    title Project Timeline\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Task 1 :a1, 2026-01-01, 7d\n    Task 2 :after a1, 5d',
  pie:       'pie title Distribution\n    "Red"   : 45\n    "Blue"  : 30\n    "Green" : 25',
  mindmap:   'mindmap\n  root((Topic))\n    Branch 1\n      Leaf A\n      Leaf B\n    Branch 2',
  timeline:  'timeline\n    title Project Timeline\n    2025 : Kickoff\n    2026 : Launch\n    2027 : Expansion',
  journey:   'journey\n    title User Journey\n    section Onboarding\n      Sign up: 5: User\n      Verify email: 3: User\n    section Use\n      Explore features: 4: User',
};
const mmdMenu = document.getElementById('mmd-insert-menu');
document.getElementById('fmt-mmd-insert').addEventListener('click', (e) => { e.stopPropagation(); mmdMenu.classList.toggle('hidden'); });
document.addEventListener('click', () => mmdMenu.classList.add('hidden'));
mmdMenu.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    mmdMenu.classList.add('hidden');
    const tpl = MERMAID_TEMPLATES[btn.dataset.mmd];
    if (!tpl) return;
    // Mermaid files hold one diagram each — inserting into non-empty content
    // produces invalid multi-diagram text. Replace entire doc; Ctrl+Z restores prior.
    replaceEditorDoc(tpl + '\n');
  });
});
document.getElementById('fmt-mmd-arrow').addEventListener('click', () => wrapSelection(' --> ', '', 'Target'));
document.getElementById('fmt-mmd-node-decision').addEventListener('click', () => wrapSelection('{', '}', 'Decision?'));
document.getElementById('fmt-mmd-subgraph').addEventListener('click', () => insertBlock('subgraph Group\n    A --> B\nend'));

// ========== HTML / XML ==========
const VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

function serializeMarkupNode(node, depth, isXml) {
  const pad = '  '.repeat(depth);
  if (node.nodeType === 3) {
    const txt = node.nodeValue;
    if (!txt || !txt.trim()) return '';
    return pad + txt.trim() + '\n';
  }
  if (node.nodeType === 8) return pad + '<!--' + node.nodeValue + '-->\n';
  if (node.nodeType !== 1) return '';
  const tag = isXml ? node.tagName : node.tagName.toLowerCase();
  const attrs = Array.from(node.attributes || [])
    .map(a => ` ${a.name}="${String(a.value).replace(/"/g, '&quot;')}"`).join('');
  if (!isXml && VOID_TAGS.has(tag)) return `${pad}<${tag}${attrs}>\n`;
  const children = Array.from(node.childNodes);
  if (children.length === 0) return `${pad}<${tag}${attrs}></${tag}>\n`;
  if (children.length === 1 && children[0].nodeType === 3) {
    const txt = (children[0].nodeValue || '').trim();
    if (txt && !txt.includes('\n')) return `${pad}<${tag}${attrs}>${txt}</${tag}>\n`;
  }
  let out = `${pad}<${tag}${attrs}>\n`;
  for (const c of children) out += serializeMarkupNode(c, depth + 1, isXml);
  out += `${pad}</${tag}>\n`;
  return out;
}

function beautifyMarkup(text, isXml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, isXml ? 'application/xml' : 'text/html');
  const perr = doc.querySelector('parsererror');
  if (perr) throw new Error(perr.textContent?.split('\n')[0] || 'Parse error');
  if (isXml) {
    const decl = text.match(/^\s*(<\?xml[^?]*\?>)/i);
    const body = serializeMarkupNode(doc.documentElement, 0, true).trimEnd();
    return decl ? decl[1] + '\n' + body : body;
  }
  const hasFullDoc = /^\s*(<!doctype|<html\b)/i.test(text);
  if (hasFullDoc) {
    return ('<!DOCTYPE html>\n' + serializeMarkupNode(doc.documentElement, 0, false)).trimEnd();
  }
  const body = doc.body;
  if (!body) throw new Error('Empty document');
  let out = '';
  for (const c of body.childNodes) out += serializeMarkupNode(c, 0, false);
  return out.trimEnd();
}

function minifyMarkup(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripMarkupTags(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/html');
  if (doc.body) doc.body.querySelectorAll('script, style, noscript').forEach(el => el.remove());
  const out = (doc.body ? doc.body.textContent : text) || '';
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

document.getElementById('fmt-markup-beautify').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  const isXml = getActiveTab()?.viewType === 'xml';
  try { replaceEditorDoc(beautifyMarkup(text, isXml)); }
  catch (err) { notifyFormatError(isXml ? 'XML' : 'HTML', err); }
});
document.getElementById('fmt-markup-minify').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  replaceEditorDoc(minifyMarkup(text));
});
document.getElementById('fmt-markup-strip').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  replaceEditorDoc(stripMarkupTags(text));
});

// ==================== Format Modal (shared for XPath/JSONPath/Schema/Diff) ====================
const fmtModalEl = document.getElementById('fmt-modal');
const fmtModalTitleEl = document.getElementById('fmt-modal-title');
const fmtModalBodyEl = document.getElementById('fmt-modal-body');
const fmtModalFooterEl = document.getElementById('fmt-modal-footer');

function openFmtModal({ title, body, footer }) {
  fmtModalTitleEl.textContent = title;
  fmtModalBodyEl.innerHTML = '';
  if (typeof body === 'string') fmtModalBodyEl.innerHTML = body;
  else if (body instanceof Node) fmtModalBodyEl.appendChild(body);
  fmtModalFooterEl.innerHTML = '';
  for (const btn of (footer || [])) {
    const b = document.createElement('button');
    b.textContent = btn.label;
    if (btn.primary) b.classList.add('primary');
    b.addEventListener('click', btn.onClick);
    fmtModalFooterEl.appendChild(b);
  }
  fmtModalEl.classList.remove('hidden');
}
function closeFmtModal() {
  if (fmtModalEl.classList.contains('locked')) return;
  fmtModalEl.classList.add('hidden');
}
document.getElementById('fmt-modal-close').addEventListener('click', closeFmtModal);
document.getElementById('fmt-modal-backdrop').addEventListener('click', closeFmtModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !fmtModalEl.classList.contains('hidden')) {
    if (fmtModalEl.classList.contains('locked')) return;
    e.preventDefault();
    closeFmtModal();
  }
});

// ==================== Auto-update Modal ====================
function showUpdateModal({ currentVersion, latestVersion, releaseBody, hasInstaller }) {
  const body = document.createElement('div');
  body.className = 'update-modal';
  const notesBlock = releaseBody
    ? `<div class="update-modal-notes-header">${escapeHtml(t('update.releaseNotes'))}</div>
       <div class="update-modal-notes">${escapeHtml(releaseBody)}</div>`
    : '';
  body.innerHTML = `
    <div class="update-modal-hero">
      <img src="formatpad-mark.png" class="update-modal-icon" alt="">
      <div class="update-modal-hero-text">
        <div class="update-modal-headline">${escapeHtml(t('update.message').replace('{0}', latestVersion))}</div>
        <div class="update-modal-versions">
          <div class="update-modal-version">
            <span class="update-modal-version-label">${escapeHtml(t('update.current'))}</span>
            <span class="update-modal-version-value">v${escapeHtml(currentVersion)}</span>
          </div>
          <span class="update-modal-version-arrow">→</span>
          <div class="update-modal-version">
            <span class="update-modal-version-label">${escapeHtml(t('update.latest'))}</span>
            <span class="update-modal-version-value update-modal-version-new">v${escapeHtml(latestVersion)}</span>
          </div>
        </div>
      </div>
    </div>
    ${notesBlock}
  `;

  const act = (action) => { closeFmtModal(); window.formatpad.updateAction(action); };
  const footer = [
    { label: t('update.remindLater'), onClick: () => act('later') },
    { label: t('update.skipVersion'), onClick: () => act('skip') },
    { label: t('update.viewRelease'), onClick: () => act('view-release') },
  ];
  if (hasInstaller) {
    footer.push({ label: t('update.downloadInstall'), primary: true, onClick: () => showUpdateConfirmModal() });
  }
  openFmtModal({ title: t('update.title'), body, footer });
}

function showUpdateConfirmModal() {
  const body = document.createElement('div');
  body.className = 'update-confirm';
  const isMac = window.formatpad?.platform === 'darwin';
  const msgKey = isMac ? 'update.confirmMessage.mac' : 'update.confirmMessage';
  body.innerHTML = `
    <div class="update-confirm-icon">⚠</div>
    <div class="update-confirm-text">${escapeHtml(t(msgKey))}</div>
  `;
  openFmtModal({
    title: t('update.confirmTitle'),
    body,
    footer: [
      { label: t('update.confirmCancel'), onClick: () => closeFmtModal() },
      { label: t('update.confirmContinue'), primary: true, onClick: () => {
        showUpdateProgressModal();
        window.formatpad.updateAction('download-install');
      }},
    ],
  });
}

function showUpdateProgressModal() {
  const body = document.createElement('div');
  body.className = 'update-progress';
  body.innerHTML = `
    <div class="update-progress-label">${escapeHtml(t('update.downloading'))}</div>
    <div class="update-progress-bar"><div class="update-progress-fill" id="update-progress-fill"></div></div>
    <div class="update-progress-pct" id="update-progress-pct">0%</div>
  `;
  openFmtModal({ title: t('update.title'), body, footer: [] });
  fmtModalEl.classList.add('locked');
}

if (window.formatpad?.onShowUpdateDialog) {
  window.formatpad.onShowUpdateDialog((data) => showUpdateModal(data));
}
if (window.formatpad?.onUpdateProgress) {
  window.formatpad.onUpdateProgress((progress) => {
    const fill = document.getElementById('update-progress-fill');
    const pct = document.getElementById('update-progress-pct');
    const v = Math.max(0, Math.min(1, progress));
    if (fill) fill.style.width = (v * 100).toFixed(1) + '%';
    if (pct) pct.textContent = Math.floor(v * 100) + '%';
  });
}
if (window.formatpad?.onUpdateError) {
  window.formatpad.onUpdateError(() => {
    fmtModalEl.classList.remove('locked');
    closeFmtModal();
  });
}

// ==================== Extended: Markdown ====================
// Align table columns: detect | ... | blocks, pad each cell to column max width
function alignMarkdownTables(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Look for pipe-based table: row, separator (---), more rows
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:-]+\|\s*$/.test(lines[i + 1])) {
      const block = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { block.push(lines[i]); i++; }
      out.push(...formatPipeTable(block));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}
function formatPipeTable(block) {
  const parseRow = (row) => {
    const trimmed = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
    return trimmed.split('|').map(c => c.trim());
  };
  const rows = block.map(parseRow);
  const nCols = Math.max(...rows.map(r => r.length));
  for (const row of rows) while (row.length < nCols) row.push('');
  // Determine alignment from separator row (index 1)
  const alignRow = rows[1] || [];
  const aligns = Array.from({ length: nCols }, (_, i) => {
    const cell = (alignRow[i] || '').trim();
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  const widths = Array(nCols).fill(0);
  for (let r = 0; r < rows.length; r++) {
    if (r === 1) continue;
    for (let c = 0; c < nCols; c++) widths[c] = Math.max(widths[c], displayWidth(rows[r][c]));
  }
  const pad = (s, w, align) => {
    const dw = displayWidth(s);
    const need = Math.max(0, w - dw);
    if (align === 'right') return ' '.repeat(need) + s;
    if (align === 'center') {
      const l = Math.floor(need / 2), r = need - l;
      return ' '.repeat(l) + s + ' '.repeat(r);
    }
    return s + ' '.repeat(need);
  };
  const lines = [];
  for (let r = 0; r < rows.length; r++) {
    if (r === 1) {
      const sepCells = aligns.map((a, c) => {
        const w = Math.max(3, widths[c]);
        if (a === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
        if (a === 'right')  return '-'.repeat(Math.max(2, w - 1)) + ':';
        return '-'.repeat(Math.max(3, w));
      });
      lines.push('| ' + sepCells.join(' | ') + ' |');
    } else {
      const cells = rows[r].map((s, c) => pad(s, widths[c], aligns[c]));
      lines.push('| ' + cells.join(' | ') + ' |');
    }
  }
  return lines;
}
function displayWidth(s) {
  // Rough CJK-aware width; counts CJK chars as 2
  let w = 0;
  for (const ch of String(s || '')) w += /[ᄀ-ᅟ⺀-〾぀-꓏가-힣豈-﫿︰-﹏＀-｠]/.test(ch) ? 2 : 1;
  return w;
}
document.getElementById('fmt-md-table-align').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text) return;
  replaceEditorDoc(alignMarkdownTables(text));
});
// Renumber ordered lists: rewrite `N. ` on consecutive lines at same indent to 1,2,3,...
function renumberMarkdownOLs(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (!m) { out.push(lines[i]); i++; continue; }
    const indent = m[1];
    let n = 1;
    while (i < lines.length) {
      const m2 = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
      if (!m2 || m2[1] !== indent) break;
      out.push(`${indent}${n}. ${m2[3]}`);
      n++;
      i++;
    }
  }
  return out.join('\n');
}
document.getElementById('fmt-md-ol-renum').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text) return;
  replaceEditorDoc(renumberMarkdownOLs(text));
});

// ==================== Extended: CSV / TSV ====================
document.getElementById('fmt-csv-fill-down').addEventListener('click', () => {
  if (!currentGrid || currentGrid.readOnly) return;
  let changed = false;
  for (let c = 0; c < currentGrid.headers.length; c++) {
    for (let r = 1; r < currentGrid.data.length; r++) {
      const cur = String(currentGrid.data[r][c] ?? '');
      if (cur === '') {
        const above = String(currentGrid.data[r - 1][c] ?? '');
        if (above !== '') { currentGrid.data[r][c] = above; changed = true; }
      }
    }
  }
  if (changed) { currentGrid.render(); currentGrid.notify(); }
});
document.getElementById('fmt-csv-split-col').addEventListener('click', () => {
  if (!currentGrid || currentGrid.readOnly) return;
  const delim = prompt('Split by delimiter:', ',');
  if (delim === null || delim === '') return;
  const col = currentGrid.active.col;
  let maxParts = 1;
  for (const row of currentGrid.data) {
    const val = String(row[col] ?? '');
    if (val === '') continue;
    const n = val.split(delim).length;
    if (n > maxParts) maxParts = n;
  }
  if (maxParts === 1) { notifyFormatError('Split', new Error('No delimiter found in column')); return; }
  const baseHeader = currentGrid.headers[col] || 'col';
  const newHeaders = Array.from({ length: maxParts }, (_, i) => `${baseHeader}_${i + 1}`);
  currentGrid.headers.splice(col, 1, ...newHeaders);
  currentGrid.colWidths.splice(col, 1, ...newHeaders.map(() => 120));
  for (const row of currentGrid.data) {
    const val = String(row[col] ?? '');
    const parts = val.split(delim);
    while (parts.length < maxParts) parts.push('');
    row.splice(col, 1, ...parts);
  }
  currentGrid.sort = null;
  currentGrid.filters = {};
  currentGrid.render();
  currentGrid.notify();
});
function csvRowsAsObjects() {
  if (!currentGrid) return null;
  const hdr = currentGrid.headers;
  return currentGrid.data.map(row => {
    const obj = {};
    hdr.forEach((h, i) => { obj[h] = row[i] ?? ''; });
    return obj;
  });
}
document.getElementById('fmt-csv-to-json').addEventListener('click', () => {
  const rows = csvRowsAsObjects();
  if (!rows) return;
  navigator.clipboard.writeText(JSON.stringify(rows, null, 2)).catch(() => {});
});
document.getElementById('fmt-csv-to-yaml').addEventListener('click', () => {
  const rows = csvRowsAsObjects();
  if (!rows) return;
  navigator.clipboard.writeText(yamljs.dump(rows, { indent: 2, lineWidth: -1 })).catch(() => {});
});

// ==================== Extended: JSON ====================
document.getElementById('fmt-json-repair').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const fixed = jsonrepair(text);
    const pretty = JSON.stringify(JSON.parse(fixed), null, 2);
    replaceEditorDoc(pretty);
  } catch (err) { notifyFormatError('Repair', err); }
});
document.getElementById('fmt-json-path').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('modal.jsonpath.placeholder');
  const result = document.createElement('div');
  result.className = 'fmt-modal-result';
  result.textContent = '(enter path and Run)';
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '10px';
  const label = document.createElement('label');
  label.textContent = 'Path';
  container.append(label, input, result);
  const run = () => {
    try {
      const data = JSON.parse(editor.state.doc.toString());
      const matches = JSONPath({ path: input.value, json: data });
      result.classList.remove('error');
      result.textContent = Array.isArray(matches) && matches.length
        ? JSON.stringify(matches, null, 2)
        : '(no matches)';
    } catch (err) {
      result.classList.add('error');
      result.textContent = err.message || String(err);
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  openFmtModal({
    title: t('modal.jsonpath.title'),
    body: container,
    footer: [
      { label: t('modal.run'), primary: true, onClick: run },
      { label: t('modal.copyResult'), onClick: () => navigator.clipboard.writeText(result.textContent).catch(() => {}) },
      { label: t('modal.close'), onClick: closeFmtModal },
    ],
  });
  setTimeout(() => input.focus(), 30);
});
document.getElementById('fmt-json-schema').addEventListener('click', () => {
  const schemaTa = document.createElement('textarea');
  schemaTa.placeholder = t('modal.schema.placeholder');
  const saved = localStorage.getItem('fp-last-schema');
  if (saved) schemaTa.value = saved;
  const result = document.createElement('div');
  result.className = 'fmt-modal-result';
  result.textContent = '(paste schema and Validate)';
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '10px';
  const label = document.createElement('label');
  label.textContent = 'Schema';
  container.append(label, schemaTa, result);
  const run = () => {
    try {
      const schema = JSON.parse(schemaTa.value);
      const data = JSON.parse(editor.state.doc.toString());
      localStorage.setItem('fp-last-schema', schemaTa.value);
      const ajv = new Ajv({ allErrors: true, strict: false });
      const validate = ajv.compile(schema);
      if (validate(data)) {
        result.classList.remove('error');
        result.classList.add('ok');
        result.textContent = '✓ Valid';
      } else {
        result.classList.remove('ok');
        result.classList.add('error');
        result.textContent = validate.errors.map(e => `${e.instancePath || '(root)'} ${e.message}`).join('\n');
      }
    } catch (err) {
      result.classList.remove('ok');
      result.classList.add('error');
      result.textContent = err.message || String(err);
    }
  };
  openFmtModal({
    title: t('modal.schema.title'),
    body: container,
    footer: [
      { label: t('modal.validate'), primary: true, onClick: run },
      { label: t('modal.close'), onClick: closeFmtModal },
    ],
  });
  setTimeout(() => schemaTa.focus(), 30);
});
function applyDiffWorkspaceMode() {
  const on = jsonViewMode === 'diff' && getActiveTab()?.viewType === 'json';
  document.body.classList.toggle('json-diff-mode', on);
}
function setJsonViewMode(mode) {
  if (jsonViewMode === mode) return;
  jsonViewMode = mode;
  const diffBtn = document.getElementById('fmt-json-diff');
  if (diffBtn) diffBtn.classList.toggle('fmt-active', mode === 'diff');
  applyDiffWorkspaceMode();
  invalidateRenderCache(); // mode change forces re-render even with same content
  if (getActiveTab()?.viewType === 'json') renderPreview(editor.state.doc.toString());
}
document.getElementById('fmt-json-diff').addEventListener('click', () => {
  setJsonViewMode(jsonViewMode === 'diff' ? 'tree' : 'diff');
});

// ==================== Extended: JSONL ====================
document.getElementById('fmt-jsonl-minify-each').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const out = text.split(/\r?\n/).map(l => {
      if (!l.trim()) return l;
      return JSON.stringify(JSON.parse(l));
    }).join('\n');
    replaceEditorDoc(out);
  } catch (err) { notifyFormatError('JSONL', err); }
});
document.getElementById('fmt-jsonl-to-array').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const arr = text.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    replaceEditorDoc(JSON.stringify(arr, null, 2));
  } catch (err) { notifyFormatError('JSONL→Array', err); }
});
document.getElementById('fmt-jsonl-from-array').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('Not a JSON array');
    replaceEditorDoc(arr.map(x => JSON.stringify(x)).join('\n'));
  } catch (err) { notifyFormatError('Array→JSONL', err); }
});
document.getElementById('fmt-jsonl-to-csv').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const { objs } = parseJsonlLines(text);
    if (objs.length === 0) { notifyFormatError('JSONL→CSV', new Error('No valid lines')); return; }
    if (!objs.every(x => x && typeof x === 'object' && !Array.isArray(x))) throw new Error('JSONL contains non-object values');
    const keys = [...new Set(objs.flatMap(o => Object.keys(o)))];
    const fmtCell = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    };
    const rows = [keys, ...objs.map(o => keys.map(k => fmtCell(o[k])))];
    navigator.clipboard.writeText(Papa.unparse(rows)).catch(() => {});
  } catch (err) { notifyFormatError('JSONL→CSV', err); }
});
document.getElementById('fmt-jsonl-stats').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  const { objs } = parseJsonlLines(text);
  const totalLines = text.split(/\r?\n/).filter(l => l.trim()).length;
  const validLines = objs.length;
  const invalidLines = totalLines - validLines;
  const keyCount = new Map();
  for (const o of objs) {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const k of Object.keys(o)) keyCount.set(k, (keyCount.get(k) || 0) + 1);
    }
  }
  const keyStats = [...keyCount.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  ${k}: ${n}/${validLines} (${Math.round(n / validLines * 100)}%)`).join('\n');
  const result = document.createElement('div');
  result.className = 'fmt-modal-result';
  result.textContent = [
    `Total lines: ${totalLines}`,
    `Valid JSON:  ${validLines}`,
    invalidLines > 0 ? `Invalid:     ${invalidLines}` : null,
    '',
    'Key frequency:',
    keyStats || '  (no keys)',
  ].filter(Boolean).join('\n');
  openFmtModal({
    title: 'JSONL Statistics',
    body: result,
    footer: [{ label: t('modal.close'), onClick: closeFmtModal }],
  });
});

// ==================== Extended: YAML ====================
document.getElementById('fmt-yaml-sort-keys').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const sorted = sortKeysDeep(yamljs.load(text));
    replaceEditorDoc(yamljs.dump(sorted, { indent: 2, lineWidth: -1 }));
  } catch (err) { notifyFormatError('YAML', err); }
});

// ==================== Extended: HTML ====================
function encodeHtmlEntities(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function decodeHtmlEntities(s) {
  const d = document.createElement('div');
  d.innerHTML = String(s);
  return d.textContent || '';
}
function transformHtmlSelection(fn) {
  const { from, to } = editor.state.selection.main;
  if (from === to) {
    const text = editor.state.doc.toString();
    if (!text) return;
    replaceEditorDoc(fn(text));
  } else {
    editor.dispatch({ changes: { from, to, insert: fn(editor.state.sliceDoc(from, to)) } });
    editor.focus();
  }
}
document.getElementById('fmt-html-ent-enc').addEventListener('click', () => transformHtmlSelection(encodeHtmlEntities));
document.getElementById('fmt-html-ent-dec').addEventListener('click', () => transformHtmlSelection(decodeHtmlEntities));
document.getElementById('fmt-html-to-md').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    const md = td.turndown(text);
    navigator.clipboard.writeText(md).catch(() => {});
  } catch (err) { notifyFormatError('HTML→MD', err); }
});

// ==================== Extended: XML ====================
document.getElementById('fmt-xml-xpath').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('modal.xpath.placeholder');
  const result = document.createElement('div');
  result.className = 'fmt-modal-result';
  result.textContent = '(enter XPath and Run)';
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '10px';
  const label = document.createElement('label');
  label.textContent = 'XPath';
  container.append(label, input, result);
  const run = () => {
    try {
      const xmlText = editor.state.doc.toString();
      const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
      const perr = doc.querySelector('parsererror');
      if (perr) throw new Error('Invalid XML');
      const xres = doc.evaluate(input.value, doc, null, XPathResult.ANY_TYPE, null);
      const out = [];
      const type = xres.resultType;
      if (type === XPathResult.NUMBER_TYPE) out.push(String(xres.numberValue));
      else if (type === XPathResult.STRING_TYPE) out.push(xres.stringValue);
      else if (type === XPathResult.BOOLEAN_TYPE) out.push(String(xres.booleanValue));
      else {
        let node;
        const serializer = new XMLSerializer();
        while ((node = xres.iterateNext()) !== null) {
          out.push(node.nodeType === 1 ? serializer.serializeToString(node) : String(node.nodeValue));
        }
      }
      result.classList.remove('error');
      result.textContent = out.length ? out.join('\n\n') : '(no matches)';
    } catch (err) {
      result.classList.add('error');
      result.textContent = err.message || String(err);
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  openFmtModal({
    title: t('modal.xpath.title'),
    body: container,
    footer: [
      { label: t('modal.run'), primary: true, onClick: run },
      { label: t('modal.copyResult'), onClick: () => navigator.clipboard.writeText(result.textContent).catch(() => {}) },
      { label: t('modal.close'), onClick: closeFmtModal },
    ],
  });
  setTimeout(() => input.focus(), 30);
});

// ==================== Extended: .env ====================
document.getElementById('fmt-env-validate').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  const result = document.createElement('div');
  result.className = 'fmt-modal-result';
  const seen = new Map();
  const issues = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) { issues.push({ line: i + 1, kind: 'syntax', msg: 'Invalid format (expected KEY=VALUE)' }); continue; }
    const key = m[1];
    let value = m[2];
    const first = value[0];
    if (first === '"' || first === "'") {
      const last = value[value.length - 1];
      if (value.length < 2 || last !== first) issues.push({ line: i + 1, kind: 'quote', msg: `Unterminated ${first === '"' ? 'double' : 'single'} quote` });
    }
    if (seen.has(key)) issues.push({ line: i + 1, kind: 'duplicate', msg: `Duplicate key "${key}" (first at line ${seen.get(key)})` });
    else seen.set(key, i + 1);
  }
  if (issues.length === 0) {
    result.classList.add('ok');
    result.textContent = `✓ ${seen.size} keys, no issues`;
  } else {
    result.classList.add('error');
    result.textContent = issues.map(x => `L${x.line} [${x.kind}] ${x.msg}`).join('\n');
  }
  openFmtModal({
    title: 'Validate .env',
    body: result,
    footer: [{ label: t('modal.close'), onClick: closeFmtModal }],
  });
});

// ==================== Extended: Mermaid theme ====================
const mmdThemeMenu = document.getElementById('mmd-theme-menu');
document.getElementById('fmt-mmd-theme').addEventListener('click', (e) => { e.stopPropagation(); mmdThemeMenu.classList.toggle('hidden'); });
document.addEventListener('click', () => mmdThemeMenu.classList.add('hidden'));
mmdThemeMenu.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    mmdThemeMenu.classList.add('hidden');
    mmdTheme = btn.dataset.theme;
    localStorage.setItem('fp-mmd-theme', mmdTheme);
    invalidateRenderCache();
    if (getActiveTab()?.viewType === 'mermaid') renderPreview(editor.state.doc.toString());
  });
});

// ==================== Clipboard Image Paste ====================
document.getElementById('editor').addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) return;
      const buffer = await blob.arrayBuffer();
      const ext = item.type.split('/')[1] === 'png' ? 'png' : 'jpg';
      const tab = getActiveTab();
      const result = await window.formatpad.saveImage(tab?.filePath, new Uint8Array(buffer), ext);
      if (result) {
        const { from, to } = editor.state.selection.main;
        const insert = `![image](${result})`;
        editor.dispatch({ changes: { from, to, insert } });
      }
      return;
    }
  }
});

// ==================== Mermaid Rendering ====================
let mmdLastAppliedTheme = null;
async function renderMermaidBlocks() {
  const blocks = contentEl.querySelectorAll('.mermaid-block');
  if (blocks.length === 0) return;
  if (!mermaidModule) {
    try {
      mermaidModule = (await import('mermaid')).default;
      mermaidModule.initialize({ startOnLoad: false, theme: mmdTheme, securityLevel: 'strict', logLevel: 'fatal' });
      mmdLastAppliedTheme = mmdTheme;
      mermaidReady = true;
    } catch { return; }
  } else if (mmdLastAppliedTheme !== mmdTheme) {
    try { mermaidModule.initialize({ startOnLoad: false, theme: mmdTheme, securityLevel: 'strict', logLevel: 'fatal' }); }
    catch {}
    mmdLastAppliedTheme = mmdTheme;
  }
  for (const block of blocks) {
    const code = block.getAttribute('data-mermaid');
    if (!code) continue;
    let valid = true;
    try { valid = await mermaidModule.parse(code, { suppressErrors: true }); }
    catch { valid = false; }
    if (!valid) {
      block.innerHTML = '<div class="preview-error">Invalid Mermaid diagram.</div>';
      continue;
    }
    try {
      const id = 'mermaid-' + Math.random().toString(36).substring(2, 9);
      const { svg } = await mermaidModule.render(id, code);
      block.innerHTML = svg;
      block.classList.add('mermaid-rendered');
    } catch { block.innerHTML = '<div class="preview-error">Mermaid render failed.</div>'; }
    // Purge any stray error element Mermaid may have appended to <body>.
    document.querySelectorAll('body > [id^="dmermaid"], body > svg[id^="mermaid"]').forEach((el) => el.remove());
  }
}

// ==================== Keyboard Shortcuts ====================
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (e.ctrlKey && key === 'b' && !e.shiftKey) { e.preventDefault(); wrapSelection('**', '**', 'bold'); }
  if (e.ctrlKey && key === 'i' && !e.shiftKey) { e.preventDefault(); wrapSelection('*', '*', 'italic'); }
  if (e.ctrlKey && key === 'k') { e.preventDefault(); document.getElementById('fmt-link').click(); }
  if (e.ctrlKey && key === 'n') { e.preventDefault(); createTab(null, null, ''); editor.focus(); }
  if (e.ctrlKey && key === 'o' && !e.shiftKey) { e.preventDefault(); window.formatpad.openFileDialog(); }
  if (e.ctrlKey && key === 't' && !e.shiftKey) { e.preventDefault(); showSidebar('toc'); }
  if (e.ctrlKey && key === 's' && !e.defaultPrevented) { e.preventDefault(); if (e.shiftKey) saveFileAs(); else saveFile(); }
  if (e.ctrlKey && key === 'w') { e.preventDefault(); if (activeTabId) closeTab(activeTabId); }
  // Ctrl+Tab / Ctrl+Shift+Tab to cycle tabs
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    if (tabs.length > 1) {
      const currentIdx = tabs.findIndex(tb => tb.id === activeTabId);
      const nextIdx = e.shiftKey
        ? (currentIdx - 1 + tabs.length) % tabs.length
        : (currentIdx + 1) % tabs.length;
      switchToTab(tabs[nextIdx].id);
    }
  }
  // Ctrl+Shift+E — file explorer
  if (e.ctrlKey && e.shiftKey && key === 'e') { e.preventDefault(); showSidebar('files'); }
  // Ctrl+Shift+F — search in files
  if (e.ctrlKey && e.shiftKey && key === 'f') { e.preventDefault(); showSidebar('search'); }
  // Ctrl+Shift+B — backlinks
  if (e.ctrlKey && e.shiftKey && key === 'b') { e.preventDefault(); showSidebar('backlinks'); }
  if (key === 'escape') {
    if (!themePanel.classList.contains('hidden')) themePanel.classList.add('hidden');
    if (!exportMenu.classList.contains('hidden')) exportMenu.classList.add('hidden');
    document.getElementById('context-menu').classList.add('hidden');
  }
});

// ==================== IPC ====================
window.formatpad.onLoadMarkdown((data) => {
  const tab = createTab(data.filePath, data.dirPath, data.content);
  if ('savedContent' in data) {
    tab.lastSavedContent = normalizeLineEndings(data.savedContent);
    tab.isModified = editor.state.doc.toString() !== tab.lastSavedContent;
    updateTitle();
    renderTabBar();
  }
});

// ==================== Init ====================
function applyLocaleToDOM() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.body.dataset.dropText = t('dropHere');
}

function applyDividerRatio(ratio) {
  const rect = workspaceEl.getBoundingClientRect();
  const sidebarWidth = sidebarVisible ? sidebarEl.offsetWidth : 0;
  const available = rect.width - sidebarWidth - dividerEl.offsetWidth;
  if (available > 0) {
    editorPaneEl.style.flex = 'none';
    editorPaneEl.style.width = (ratio * available) + 'px';
    previewPaneEl.style.flex = '1';
  }
}

// Editor pane width is stored as a pixel value once the user drags the divider,
// so window resizes would otherwise leave it stuck at an absolute width while
// preview absorbs/loses all the delta. Re-apply the saved ratio on resize so
// both panes scale proportionally. Debounce mildly to avoid thrashing.
let resizeRaf = 0;
window.addEventListener('resize', () => {
  if (isDragging) return;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    const savedRatio = parseFloat(localStorage.getItem('fp-divider-ratio'));
    if (savedRatio > 0 && savedRatio < 1) {
      applyDividerRatio(savedRatio);
    } else {
      // No saved ratio — make sure the editor pane is back to flex:1 so the
      // two panes share the width equally on any window size.
      editorPaneEl.style.flex = '1';
      editorPaneEl.style.width = '';
      previewPaneEl.style.flex = '1';
    }
  });
});

(async () => {
  // Load locale
  const { code: installerLocale, mtime } = await window.formatpad.getLocale();
  const prevMtime = localStorage.getItem('fp-locale-mtime');
  if (String(mtime) !== prevMtime) {
    localStorage.removeItem('fp-locale');
    localStorage.setItem('fp-locale-mtime', String(mtime));
  }
  const userLocale = localStorage.getItem('fp-locale');
  setLocale(userLocale || installerLocale);
  applyLocaleToDOM();
  langSelect.value = getLocaleCode();

  await initTheme();

  // Restore sidebar state (migrate from legacy TOC)
  const legacyTocVisible = localStorage.getItem('fp-toc-visible');
  const savedSidebarVisible = localStorage.getItem('fp-sidebar-visible');
  const savedSidebarPanel = localStorage.getItem('fp-sidebar-panel') || 'files';

  if (savedSidebarVisible === 'true' || (savedSidebarVisible === null && legacyTocVisible === 'true')) {
    sidebarActivePanel = legacyTocVisible === 'true' && savedSidebarVisible === null ? 'toc' : savedSidebarPanel;
    sidebarEl.style.transition = 'none';
    showSidebar(sidebarActivePanel);
    sidebarEl.offsetHeight;
    sidebarEl.style.transition = '';
  }
  if (legacyTocVisible !== null) localStorage.removeItem('fp-toc-visible');

  // Restore zoom level
  applyZoom(zoomLevel);

  // Restore view mode
  setViewMode(localStorage.getItem('fp-view-mode') || 'split');

  // Hide format-bar until a tab is active
  updateFormatBar(getActiveTab()?.viewType || null);

  // Restore divider ratio
  const savedRatio = parseFloat(localStorage.getItem('fp-divider-ratio'));
  if (savedRatio > 0 && savedRatio < 1) applyDividerRatio(savedRatio);

  // Restore workspace & file tree
  if (workspacePath) {
    loadFileTree();
    window.formatpad.watchDirectory(workspacePath);
    window.formatpad.buildLinkIndex(workspacePath).then(() => refreshFileNameCache());
  }

  // Auto-save recovery (every 30 seconds)
  autoSaveTimer = setInterval(() => {
    for (const tab of tabs) {
      if (!tab.isModified) continue;
      const content = tab.id === activeTabId
        ? editor.state.doc.toString()
        : tab.editorState.doc.toString();
      if (content === tab.lastAutoSavedContent) continue;
      tab.lastAutoSavedContent = content;
      window.formatpad.autoSaveRecovery(getRecoveryKey(tab), content);
    }
  }, 30000);
})();

// (v2 had a `onSetWorkspaceDir` listener for when the tree editor launched the MD editor as
// a sub-window. In v3 FormatPad is a standalone process, so this hook is no longer needed.)
