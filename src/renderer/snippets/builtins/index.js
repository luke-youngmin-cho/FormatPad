import { markdownSnippets } from './markdown.js';
import { jsonSnippets } from './json.js';
import { yamlSnippets } from './yaml.js';
import { csvSnippets } from './csv.js';
import { mermaidSnippets } from './mermaid.js';
import { envSnippets } from './env.js';

export const builtinSnippets = {
  markdown: markdownSnippets,
  json: jsonSnippets,
  yaml: yamlSnippets,
  csv: csvSnippets,
  mermaid: mermaidSnippets,
  env: envSnippets,
};
