import { registerAction } from './registry.js';

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 3h12v10H2V3zm2 2v6h1.5V7.7L7 10h.1l1.5-2.3V11H10V5H8.5L7.05 7.4 5.5 5H4z"/></svg>';

function selectionOrDoc(context) {
  const active = context.activeTab || {};
  return active.selection || active.content || '';
}

async function llmRewrite({ context, llm, ui, title, instruction, language = 'markdown' }) {
  const source = selectionOrDoc(context);
  if (!source.trim()) throw new Error('No Markdown content available.');
  const text = await llm.complete({
    prompt: `${instruction}\n\nReturn only a fenced ${language} code block.\n\nSource:\n${source}`,
  });
  const code = ui.extractCode(text, language) || text;
  await ui.applySelectionOrDocument({ title, newText: code });
  return { message: title };
}

function buildToc(markdown) {
  const headings = String(markdown || '').split(/\r?\n/)
    .map(line => line.match(/^(#{2,4})\s+(.+?)\s*#*\s*$/))
    .filter(Boolean)
    .map(match => {
      const level = match[1].length;
      const text = match[2].replace(/\[[^\]]+\]\([^)]+\)/g, '').replace(/[`*_~]/g, '').trim();
      const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
      return `${'  '.repeat(level - 2)}- [${text}](#${slug})`;
    });
  return ['<!-- orpad:toc:start -->', '## Table of Contents', '', ...headings, '<!-- orpad:toc:end -->', ''].join('\n');
}

registerAction({
  id: 'markdown.expand-prd',
  format: 'markdown',
  scope: 'selection',
  label: 'Expand as PRD section',
  icon: ICON,
  requiresAI: true,
  description: 'Uses the AI provider to expand selected notes into a PRD-style section.',
  async run({ context, llm, ui }) {
    return llmRewrite({
      context, llm, ui, title: 'Expand PRD section',
      instruction: 'Expand the selected notes into a practical PRD section with goal, user problem, requirements, non-goals, risks, and acceptance criteria.',
    });
  },
});

registerAction({
  id: 'markdown.translate',
  format: 'markdown',
  scope: 'selection',
  label: 'Translate selection',
  icon: ICON,
  requiresAI: true,
  description: 'Uses the AI provider to translate the selected Markdown.',
  async run({ context, llm, ui }) {
    const target = await ui.promptChoice('Translate', 'Target language', ['Korean', 'English', 'Japanese', 'Spanish', 'French'], 'Korean');
    if (!target) return { message: 'Canceled' };
    return llmRewrite({
      context, llm, ui, title: `Translate to ${target}`,
      instruction: `Translate the source Markdown to ${target}. Preserve Markdown structure and code fences.`,
    });
  },
});

registerAction({
  id: 'markdown.auto-toc',
  format: 'markdown',
  scope: 'document',
  label: 'Generate / refresh TOC',
  icon: ICON,
  requiresAI: false,
  description: 'Generate a Markdown table of contents locally from headings.',
  async run({ context, ui }) {
    const doc = context.activeTab?.content || '';
    const toc = buildToc(doc);
    const re = /<!-- orpad:toc:start -->[\s\S]*?<!-- orpad:toc:end -->\n?/;
    const next = re.test(doc) ? doc.replace(re, toc) : `${toc}\n${doc}`;
    await ui.applyDocument({ title: 'Generate / refresh Markdown TOC', newText: next });
    return { message: 'TOC generated' };
  },
});

registerAction({
  id: 'markdown.tone-shift',
  format: 'markdown',
  scope: 'selection',
  label: 'Tone shift',
  icon: ICON,
  requiresAI: true,
  description: 'Uses the AI provider to rewrite the selected Markdown tone.',
  async run({ context, llm, ui }) {
    const tone = await ui.promptChoice('Tone shift', 'Tone', ['formal', 'friendly', 'technical'], 'friendly');
    if (!tone) return { message: 'Canceled' };
    return llmRewrite({
      context, llm, ui, title: `Shift tone to ${tone}`,
      instruction: `Rewrite the selected Markdown in a ${tone} tone. Preserve factual meaning and Markdown formatting.`,
    });
  },
});

registerAction({
  id: 'markdown.extract-checklist',
  format: 'markdown',
  scope: 'document',
  label: 'Extract checklist tab',
  icon: ICON,
  requiresAI: true,
  description: 'Uses the AI provider to turn the document into a concise task checklist.',
  async run({ context, llm, ui }) {
    const text = await llm.complete({
      prompt: `Extract a concise task checklist from this Markdown. Return only Markdown task items.\n\n${context.activeTab?.content || ''}`,
    });
    const code = ui.extractCode(text, 'markdown') || text;
    ui.openTab({ name: 'AI Checklist.md', content: code.trim() + '\n', viewType: 'markdown' });
    return { message: 'Checklist opened' };
  },
});
