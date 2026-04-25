const TOKEN_CHAR_RATIO = 4;

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / TOKEN_CHAR_RATIO);
}

function truncateToTokens(text, maxTokens) {
  const raw = String(text || '');
  const tokens = estimateTokens(raw);
  if (tokens <= maxTokens) return { text: raw, truncated: false, tokens };
  const maxChars = Math.max(0, maxTokens * TOKEN_CHAR_RATIO);
  return {
    text: raw.slice(0, maxChars),
    truncated: true,
    tokens: maxTokens,
    originalTokens: tokens,
  };
}

function fileName(path) {
  return String(path || 'Untitled').split(/[\\/]/).pop() || 'Untitled';
}

function normalizeFileTree(files) {
  return (files || [])
    .map(item => typeof item === 'string' ? item : (item?.path || item?.name || item?.baseName || ''))
    .filter(Boolean)
    .slice(0, 100)
    .map(item => item.split(/[\\/]/).pop())
    .filter(Boolean);
}

export function buildContextBundle({
  activeTab,
  openTabs = [],
  workspaceFiles = [],
  includeOtherTabs = false,
  includeFileTree = false,
  runnerOutput = null,
  includeRunnerOutput = false,
  maxTokens = 40000,
} = {}) {
  const active = activeTab || {};
  const truncated = truncateToTokens(active.content || '', maxTokens);
  const selection = String(active.selection || '');
  const parts = [];

  parts.push(`Active tab: ${fileName(active.filePath || active.name)} (${active.viewType || active.format || 'text'})`);
  if (truncated.truncated) {
    parts.push(`Note: active tab was truncated from about ${truncated.originalTokens} tokens to ${maxTokens} tokens.`);
  }
  parts.push(`<active-tab path="${active.filePath || ''}" format="${active.viewType || active.format || 'text'}">`);
  parts.push(truncated.text);
  parts.push('</active-tab>');

  if (selection) {
    parts.push('<selection>');
    parts.push(selection);
    parts.push('</selection>');
  }

  if (includeOtherTabs) {
    parts.push('<open-tabs>');
    for (const tab of openTabs) {
      parts.push(`- ${fileName(tab.filePath || tab.name)} (${tab.viewType || tab.format || 'text'})`);
    }
    parts.push('</open-tabs>');
  }

  if (includeFileTree) {
    const files = normalizeFileTree(workspaceFiles);
    parts.push('<workspace-files>');
    for (const name of files) parts.push(`- ${name}`);
    parts.push('</workspace-files>');
  }

  if (includeRunnerOutput && runnerOutput?.output) {
    const truncatedRunner = truncateToTokens(runnerOutput.output, 8000);
    parts.push(`<runner-output command="${String(runnerOutput.commandLine || '').replace(/"/g, '&quot;')}" cwd="${String(runnerOutput.cwd || '').replace(/"/g, '&quot;')}" exit="${runnerOutput.exitCode ?? ''}">`);
    if (truncatedRunner.truncated) {
      parts.push(`Note: runner output was truncated from about ${truncatedRunner.originalTokens} tokens to 8000 tokens.`);
    }
    parts.push(truncatedRunner.text);
    parts.push('</runner-output>');
  }

  const text = parts.join('\n');
  return {
    text,
    tokenCount: estimateTokens(text),
    activeTokenCount: truncated.tokens,
    selectionTokenCount: estimateTokens(selection),
  };
}

export function buildMessages({ contextBundle, history = [], userText }) {
  const system = [
    'You are FormatPad AI, a careful document and data editing assistant.',
    'Use the provided active-tab context. Do not claim to inspect files that were not included.',
    'When returning replacement content, put it in a fenced code block with the active format language tag.',
  ].join(' ');

  const prior = history
    .filter(msg => msg.role === 'user' || msg.role === 'assistant')
    .slice(-8)
    .map(msg => ({ role: msg.role, content: msg.content }));

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Context bundle:\n${contextBundle?.text || ''}` },
    ...prior,
    { role: 'user', content: userText },
  ];
}
