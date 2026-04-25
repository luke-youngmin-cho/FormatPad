import Ajv from 'ajv';
import { jsonrepair } from 'jsonrepair';
import { registerAction } from './registry.js';

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M5 3 2 8l3 5 1.2-.7L3.6 8l2.6-4.3L5 3zm6 0-1.2.7L12.4 8l-2.6 4.3L11 13l3-5-3-5z"/></svg>';

function parseJson(context) {
  return JSON.parse(context.activeTab?.content || 'null');
}

function schemaFor(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? schemaFor(value[0]) : {} };
  if (typeof value === 'object') {
    const properties = {};
    const required = [];
    for (const [key, val] of Object.entries(value)) {
      properties[key] = schemaFor(val);
      required.push(key);
    }
    return { type: 'object', properties, required, additionalProperties: true };
  }
  if (Number.isInteger(value)) return { type: 'integer' };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

function sampleFor(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object') {
    const out = {};
    for (const [key, sub] of Object.entries(schema.properties || {})) out[key] = sampleFor(sub);
    return out;
  }
  if (type === 'array') return [sampleFor(schema.items || {})];
  if (type === 'integer') return 1;
  if (type === 'number') return 1.5;
  if (type === 'boolean') return true;
  if (type === 'null') return null;
  return 'string';
}

function flattenRows(value, prefix = '', out = {}) {
  if (Array.isArray(value)) return value.flatMap(item => flattenRows(item, prefix, {}));
  if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const nested = flattenRows(val, path, out);
      if (Array.isArray(nested) && nested.length > 1) return nested;
    }
    return [out];
  }
  out[prefix || 'value'] = value;
  return [out];
}

function toCsv(rows) {
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const esc = val => {
    const s = val == null ? '' : String(val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(row => headers.map(h => esc(row[h])).join(','))].join('\n');
}

registerAction({
  id: 'json.generate-schema',
  format: 'json',
  scope: 'document',
  label: 'Generate JSON Schema',
  icon: ICON,
  async run({ context, ui }) {
    const schema = { $schema: 'http://json-schema.org/draft-07/schema#', ...schemaFor(parseJson(context)) };
    ui.openTab({ name: 'schema.json', content: JSON.stringify(schema, null, 2), viewType: 'json' });
    return { message: 'Schema opened' };
  },
});

registerAction({
  id: 'json.generate-samples',
  format: 'json',
  scope: 'document',
  label: 'Generate sample data',
  icon: ICON,
  async run({ context, ui }) {
    const count = Math.max(1, Math.min(20, Number(await ui.promptText('Generate samples', 'Number of samples', '3')) || 3));
    const schema = parseJson(context);
    const samples = Array.from({ length: count }, () => sampleFor(schema));
    ui.openTab({ name: 'sample-data.json', content: JSON.stringify(samples, null, 2), viewType: 'json' });
    return { message: 'Sample data opened' };
  },
});

registerAction({
  id: 'json.flatten-csv',
  format: 'json',
  scope: ['document', 'node'],
  label: 'Flatten to CSV',
  icon: ICON,
  async run({ context, ui }) {
    const rows = flattenRows(parseJson(context)).filter(Boolean);
    ui.openTab({ name: 'flattened.csv', content: toCsv(rows) + '\n', viewType: 'csv' });
    return { message: 'Flattened CSV opened' };
  },
});

registerAction({
  id: 'json.validate-explain',
  format: 'json',
  scope: 'document',
  label: 'Validate + explain',
  icon: ICON,
  async run({ context, llm, ui }) {
    const schemaText = await ui.promptText('Validate JSON', 'Paste draft-07 schema JSON', '{\n  "type": "object"\n}', { multiline: true });
    if (!schemaText) return { message: 'Canceled' };
    const data = parseJson(context);
    const schema = JSON.parse(schemaText);
    const ajv = new Ajv({ allErrors: true, strict: false });
    const valid = ajv.validate(schema, data);
    const report = valid ? 'JSON is valid against the schema.' : JSON.stringify(ajv.errors || [], null, 2);
    const explanation = await llm.complete({ prompt: `Explain these JSON Schema validation results in plain English:\n\n${report}` });
    ui.openTab({ name: 'JSON Validation Report.md', content: explanation.trim() + '\n', viewType: 'markdown' });
    return { message: 'Validation report opened' };
  },
});

registerAction({
  id: 'json.repair-explain',
  format: 'json',
  scope: 'document',
  label: 'Repair + explain',
  icon: ICON,
  async run({ context, llm, ui }) {
    const source = context.activeTab?.content || '';
    const repaired = jsonrepair(source);
    const explanation = await llm.complete({ prompt: `Explain the likely fixes made by jsonrepair. Original:\n${source}\n\nRepaired:\n${repaired}` });
    await ui.applyDocument({ title: 'Repair JSON', newText: repaired });
    ui.openTab({ name: 'JSON Repair Explanation.md', content: explanation.trim() + '\n', viewType: 'markdown' });
    return { message: 'Repair proposed' };
  },
});
