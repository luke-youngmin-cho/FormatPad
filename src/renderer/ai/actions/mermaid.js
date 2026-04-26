import { registerAction } from './registry.js';

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 2h8v3H9v2h4v3h-3v2H6v-2H3V7h4V5H4V2z"/></svg>';

async function rewriteDiagram({ context, llm, ui, title, instruction }) {
  const source = context.activeTab?.content || '';
  if (!source.trim()) throw new Error('No Mermaid source available.');
  const text = await llm.complete({
    prompt: `${instruction}\n\nReturn only a fenced mermaid code block.\n\nMermaid source:\n${source}`,
  });
  const code = ui.extractCode(text, 'mermaid') || text;
  await ui.applyDocument({ title, newText: code });
  return { message: title };
}

registerAction({
  id: 'mermaid.decompose-node',
  format: 'mermaid',
  scope: ['document', 'node'],
  label: 'Decompose node into 3 substeps',
  icon: ICON,
  requiresAI: true,
  description: 'Uses the AI provider to rewrite a selected Mermaid node into substeps.',
  async run({ context, llm, ui }) {
    const node = await ui.promptText('Decompose node', 'Node id or label to expand', '');
    if (!node) return { message: 'Canceled' };
    return rewriteDiagram({
      context, llm, ui, title: `Decompose ${node}`,
      instruction: `Find the node "${node}" and rewrite the flow so it becomes three clear substeps while preserving existing incoming and outgoing meaning.`,
    });
  },
});

registerAction({
  id: 'mermaid.error-paths',
  format: 'mermaid',
  scope: 'document',
  label: 'Add error-path edges',
  icon: ICON,
  requiresAI: true,
  description: 'Uses the AI provider to add plausible error, timeout, or retry paths.',
  async run({ context, llm, ui }) {
    return rewriteDiagram({
      context, llm, ui, title: 'Add Mermaid error paths',
      instruction: 'If this is a flowchart, add standard error/timeout/retry branches where appropriate. Preserve syntax validity.',
    });
  },
});

registerAction({
  id: 'mermaid.describe',
  format: 'mermaid',
  scope: 'document',
  label: 'Describe diagram in prose',
  icon: ICON,
  requiresAI: true,
  description: 'Uses the AI provider to summarize the diagram in prose.',
  async run({ context, llm, ui }) {
    const text = await llm.complete({
      prompt: `Describe this Mermaid diagram in concise prose with sections for purpose, main flow, edge cases, and assumptions.\n\n${context.activeTab?.content || ''}`,
    });
    ui.openTab({ name: 'Diagram Description.md', content: text.trim() + '\n', viewType: 'markdown' });
    return { message: 'Description opened' };
  },
});

registerAction({
  id: 'mermaid.flow-to-sequence',
  format: 'mermaid',
  scope: 'document',
  label: 'Convert flowchart to sequence',
  icon: ICON,
  requiresAI: true,
  description: 'Uses the AI provider to convert a Mermaid flowchart into a sequence diagram.',
  async run({ context, llm, ui }) {
    return rewriteDiagram({
      context, llm, ui, title: 'Convert flowchart to sequence diagram',
      instruction: 'Convert the flowchart to a Mermaid sequenceDiagram. If participants are ambiguous, make conservative participant names and include a short comment in the diagram.',
    });
  },
});
