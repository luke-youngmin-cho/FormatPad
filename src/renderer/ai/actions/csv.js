import Papa from 'papaparse';
import { registerAction } from './registry.js';

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 2h12v12H2V2zm1 3h10V3H3v2zm0 1v3h4V6H3zm5 0v3h5V6H8zm-5 4v3h4v-3H3zm5 0v3h5v-3H8z"/></svg>';

function delimiter(format) { return format === 'tsv' ? '\t' : ','; }
function parseTable(context) {
  const delim = delimiter(context.activeTab?.viewType);
  const parsed = Papa.parse(context.activeTab?.content || '', { delimiter: delim, skipEmptyLines: false });
  const rows = parsed.data.filter(row => !(row.length === 1 && row[0] === ''));
  return { headers: rows[0] || [], data: rows.slice(1), delim };
}
function unparse(headers, data, delim) { return Papa.unparse([headers, ...data], { delimiter: delim }); }
function colIndex(headers, answer) {
  const raw = String(answer || '').trim();
  const byName = headers.findIndex(h => h.toLowerCase() === raw.toLowerCase());
  if (byName >= 0) return byName;
  const n = Number(raw) - 1;
  return Number.isInteger(n) && n >= 0 && n < headers.length ? n : -1;
}
function infer(values) {
  const tests = {
    integer: v => /^-?\d+$/.test(v),
    float: v => /^-?\d+(\.\d+)?$/.test(v),
    boolean: v => /^(true|false|yes|no|0|1)$/i.test(v),
    date: v => !Number.isNaN(Date.parse(v)) && /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v),
  };
  const scored = Object.entries(tests).map(([type, fn]) => [type, values.filter(v => v !== '' && fn(String(v).trim())).length]);
  scored.sort((a, b) => b[1] - a[1]);
  return scored[0]?.[1] ? scored[0][0] : 'string';
}
function compatible(type, value) {
  const v = String(value ?? '').trim();
  if (!v) return true;
  if (type === 'integer') return /^-?\d+$/.test(v);
  if (type === 'float') return /^-?\d+(\.\d+)?$/.test(v);
  if (type === 'boolean') return /^(true|false|yes|no|0|1)$/i.test(v);
  if (type === 'date') return !Number.isNaN(Date.parse(v));
  return true;
}
function stats(headers, data) {
  return headers.map((h, c) => {
    const vals = data.map(r => r[c]).filter(v => v !== '');
    const nums = vals.map(Number).filter(Number.isFinite);
    if (nums.length >= Math.max(2, vals.length * 0.6)) {
      const sum = nums.reduce((a, b) => a + b, 0);
      return `- **${h}**: numeric, count ${nums.length}, min ${Math.min(...nums)}, max ${Math.max(...nums)}, mean ${(sum / nums.length).toFixed(2)}`;
    }
    const counts = new Map();
    for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `${v} (${n})`).join(', ');
    return `- **${h}**: text-ish, count ${vals.length}, top ${top || 'n/a'}`;
  }).join('\n');
}

registerAction({
  id: 'csv.type-outliers',
  format: ['csv', 'tsv'],
  scope: 'column',
  label: 'Detect type + outliers',
  icon: ICON,
  requiresAI: false,
  description: 'Infer one column locally and propose clearing inconsistent values.',
  async run({ context, ui }) {
    const table = parseTable(context);
    const defaultColumn = Number.isInteger(context.detail?.column)
      ? String(context.detail.column + 1)
      : (table.headers[0] || '1');
    const c = colIndex(table.headers, await ui.promptText('Type + outliers', 'Column name or 1-based index', defaultColumn));
    if (c < 0) throw new Error('Column not found.');
    const type = infer(table.data.map(r => r[c]));
    const next = table.data.map(row => row.slice());
    let changed = 0;
    for (const row of next) if (!compatible(type, row[c])) { row[c] = ''; changed++; }
    await ui.applyDocument({ title: `Clear ${changed} ${type} outliers in ${table.headers[c]}`, newText: unparse(table.headers, next, table.delim) });
    return { message: `${type} detected; ${changed} outliers proposed for clearing.` };
  },
});

registerAction({
  id: 'csv.nl-filter',
  format: ['csv', 'tsv'],
  scope: 'document',
  label: 'Natural-language filter',
  icon: ICON,
  requiresAI: true,
  description: 'Uses the AI provider to convert a plain-language request into filter rules.',
  async run({ context, llm, ui }) {
    const table = parseTable(context);
    const request = await ui.promptText('Natural-language filter', 'Filter request', "age > 30 and city == 'Seoul'");
    if (!request) return { message: 'Canceled' };
    const raw = await llm.complete({ prompt: `Convert this table filter request to JSON rules. Headers: ${table.headers.join(', ')}. Request: ${request}. Return only JSON array like [{"column":"age","op":">","value":"30"}].` });
    const rules = JSON.parse(ui.extractJson(raw) || raw);
    const kept = table.data.filter(row => rules.every(rule => {
      const c = table.headers.findIndex(h => h.toLowerCase() === String(rule.column).toLowerCase());
      const left = row[c], right = rule.value, nL = Number(left), nR = Number(right);
      if (rule.op === '==') return String(left) === String(right);
      if (rule.op === '!=') return String(left) !== String(right);
      if (rule.op === '>') return Number.isFinite(nL) && Number.isFinite(nR) && nL > nR;
      if (rule.op === '>=') return Number.isFinite(nL) && Number.isFinite(nR) && nL >= nR;
      if (rule.op === '<') return Number.isFinite(nL) && Number.isFinite(nR) && nL < nR;
      if (rule.op === '<=') return Number.isFinite(nL) && Number.isFinite(nR) && nL <= nR;
      return true;
    }));
    ui.showFilterChip?.(request);
    ui.openTab({ name: 'filtered.csv', content: unparse(table.headers, kept, table.delim), viewType: context.activeTab?.viewType || 'csv' });
    return { message: `Filter chip: ${request}` };
  },
});

registerAction({
  id: 'csv.sql-generate',
  format: ['csv', 'tsv'],
  scope: ['selection', 'document'],
  label: 'Generate SQL SELECT',
  icon: ICON,
  requiresAI: true,
  description: 'Uses the AI provider to draft a SQL query from the table headers and sample rows.',
  async run({ context, llm, ui }) {
    const table = parseTable(context);
    const text = await llm.complete({ prompt: `Generate a useful SQL SELECT query for a table named data with columns: ${table.headers.join(', ')}. Consider this sample:\n${unparse(table.headers, table.data.slice(0, 12), table.delim)}` });
    ui.openTab({ name: 'query.sql', content: (ui.extractCode(text, 'sql') || text).trim() + '\n', viewType: 'plain' });
    return { message: 'SQL opened' };
  },
});

registerAction({
  id: 'csv.summary-stats',
  format: ['csv', 'tsv'],
  scope: 'document',
  label: 'Summary stats report',
  icon: ICON,
  requiresAI: false,
  description: 'Compute a local summary report from the current CSV/TSV data.',
  async run({ context, ui }) {
    const table = parseTable(context);
    ui.openTab({ name: 'CSV Summary.md', content: `# CSV Summary\n\nRows: ${table.data.length}\nColumns: ${table.headers.length}\n\n${stats(table.headers, table.data)}\n`, viewType: 'markdown' });
    return { message: 'Summary opened' };
  },
});

registerAction({
  id: 'csv.type-consistency',
  format: ['csv', 'tsv'],
  scope: 'column',
  label: 'Type consistency check',
  icon: ICON,
  requiresAI: false,
  description: 'Check inferred column types locally without sending data to an AI provider.',
  async run({ context, ui }) {
    const table = parseTable(context);
    const lines = table.headers.map((h, c) => {
      const type = infer(table.data.map(r => r[c]));
      const bad = table.data.filter(r => !compatible(type, r[c])).length;
      return `- **${h}**: inferred ${type}, ${bad} inconsistent value(s)`;
    });
    ui.openTab({ name: 'Type Consistency.md', content: `# Type Consistency Check\n\n${lines.join('\n')}\n`, viewType: 'markdown' });
    return { message: 'Type consistency report opened' };
  },
});
