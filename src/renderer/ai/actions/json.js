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

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function schemaTypes(schema) {
  const type = schema?.type;
  if (Array.isArray(type)) return type;
  if (type) return [type];
  if (schema?.properties || schema?.required) return ['object'];
  if (schema?.items) return ['array'];
  return [];
}

function pathJoin(path, key) {
  const escaped = String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${path || ''}/${escaped}`;
}

function validateSchema(value, schema, path = '') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];
  const add = (message, at = path) => errors.push({ path: at || '/', message });

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    add(`must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
    add(`must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`);
  }

  const types = schemaTypes(schema);
  if (types.length && !types.some(type => typeMatches(value, type))) {
    add(`must be ${types.join(' or ')}; got ${jsonType(value)}`);
    return errors;
  }

  if (typeMatches(value, 'object')) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) add(`missing required property "${key}"`, pathJoin(path, key));
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateSchema(value[key], childSchema, pathJoin(path, key)));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) add(`additional property "${key}" is not allowed`, pathJoin(path, key));
      }
    }
  }

  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) add(`must contain at least ${schema.minItems} items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) add(`must contain at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, pathJoin(path, index))));
    }
  }

  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) add(`must be at least ${schema.minLength} characters`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) add(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) add(`must match pattern ${schema.pattern}`);
      } catch {
        add(`schema pattern is invalid: ${schema.pattern}`);
      }
    }
  }

  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) add(`must be >= ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) add(`must be <= ${schema.maximum}`);
    if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) add(`must be > ${schema.exclusiveMinimum}`);
    if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) add(`must be < ${schema.exclusiveMaximum}`);
  }

  return errors;
}

function validationReport(errors) {
  if (!errors.length) return 'JSON is valid against the schema.';
  return errors.map((err, index) => `${index + 1}. ${err.path}: ${err.message}`).join('\n');
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
    const data = parseJson(context);
    const inferred = { $schema: 'http://json-schema.org/draft-07/schema#', ...schemaFor(data) };
    const schemaText = await ui.promptText(
      'Validate current JSON',
      `Schema for current file: ${context.activeTab?.name || 'current JSON'}`,
      JSON.stringify(inferred, null, 2),
      {
        multiline: true,
        description: 'FormatPad validates the currently open JSON document against this schema. Edit the schema if you want stricter rules, then press OK.',
      },
    );
    if (!schemaText) return { message: 'Canceled' };
    const schema = JSON.parse(schemaText);
    const report = validationReport(validateSchema(data, schema));
    const explanation = await llm.complete({
      prompt: [
        `Explain these JSON Schema validation results for the currently open file (${context.activeTab?.name || 'current JSON'}) in plain English:`,
        '',
        report,
      ].join('\n'),
    });
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
