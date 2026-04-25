import { snippet, snippetCompletion } from '@codemirror/autocomplete';
import { builtinSnippets } from './builtins/index.js';

export const DEFAULT_USER_SNIPPETS = '{\n  "markdown": [\n    { "name": "note", "description": "Callout note", "body": "> **Note** ${0}" }\n  ]\n}\n';

const FORMAT_ALIASES = {
  md: 'markdown',
  markdown: 'markdown',
  mermaid: 'mermaid',
  mmd: 'mermaid',
  json: 'json',
  jsonl: 'json',
  ndjson: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  csv: 'csv',
  tsv: 'csv',
  env: 'env',
  properties: 'env',
};

let userSnippets = {};
const listeners = new Set();

function normalizeSnippet(raw, format, source) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const body = String(raw.body || '');
  if (!name || !body) return null;
  return {
    name,
    body,
    format,
    source,
    description: String(raw.description || raw.detail || ''),
  };
}

export function normalizeSnippetFormat(format) {
  return FORMAT_ALIASES[String(format || '').toLowerCase()] || String(format || '').toLowerCase();
}

export function setUserSnippets(raw) {
  const next = {};
  if (raw && typeof raw === 'object') {
    for (const [format, list] of Object.entries(raw)) {
      const key = normalizeSnippetFormat(format);
      if (!Array.isArray(list)) continue;
      next[key] = list
        .map(item => normalizeSnippet(item, key, 'user'))
        .filter(Boolean);
    }
  }
  userSnippets = next;
  for (const listener of listeners) listener();
}

export function onSnippetsChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnippetsForFormat(format) {
  const key = normalizeSnippetFormat(format);
  const builtins = (builtinSnippets[key] || [])
    .map(item => normalizeSnippet(item, key, 'built-in'))
    .filter(Boolean);
  return [...builtins, ...(userSnippets[key] || [])];
}

export function getAllSnippetFormats() {
  return Array.from(new Set([...Object.keys(builtinSnippets), ...Object.keys(userSnippets)])).sort();
}

export function parseUserSnippets(text) {
  if (!String(text || '').trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('snippets.json must be an object keyed by format.');
  }
  return parsed;
}

function optionForSnippet(item) {
  return snippetCompletion(item.body, {
    label: item.name,
    displayLabel: item.name,
    detail: 'snippet',
    type: 'snippet',
    boost: item.source === 'user' ? 12 : 4,
    section: 'Snippets',
    info: item.description || `${item.format} snippet`,
  });
}

export function createSnippetCompletionSource(getFormat) {
  return (context) => {
    const format = normalizeSnippetFormat(getFormat?.() || 'markdown');
    const snippets = getSnippetsForFormat(format);
    if (!snippets.length) return null;

    const line = context.state.doc.lineAt(context.pos);
    const beforeLine = context.state.sliceDoc(line.from, context.pos);
    const shortcut = beforeLine.match(/(^|\s)([A-Za-z0-9_-]+):\s*$/);
    if (shortcut) {
      const from = line.from + shortcut.index + shortcut[1].length;
      return {
        from,
        to: context.pos,
        options: snippets
          .filter(item => item.name.toLowerCase().startsWith(shortcut[2].toLowerCase()))
          .map(optionForSnippet),
        validFor: /^[A-Za-z0-9_-]*:?\s*$/,
      };
    }

    const token = context.matchBefore(/[A-Za-z0-9_-]*$/);
    if (!token || (!context.explicit && token.from === token.to)) return null;
    return {
      from: token.from,
      options: snippets.map(optionForSnippet),
      validFor: /^[A-Za-z0-9_-]*$/,
    };
  };
}

export function expandSnippetShortcut(view, format) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const beforeLine = view.state.sliceDoc(line.from, pos);
  const match = beforeLine.match(/(^|\s)([A-Za-z0-9_-]+):\s*$/);
  if (!match) return false;
  const item = getSnippetsForFormat(format).find(sn => sn.name === match[2]);
  if (!item) return false;
  const from = line.from + match.index + match[1].length;
  snippet(item.body)(view, null, from, pos);
  return true;
}

export function insertSnippet(view, item) {
  const range = view.state.selection.main;
  snippet(item.body)(view, null, range.from, range.to);
  view.focus();
}
