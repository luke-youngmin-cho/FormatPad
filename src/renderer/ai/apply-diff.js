const LANG_ALIASES = {
  markdown: ['markdown', 'md', 'mdx'],
  mermaid: ['mermaid', 'mmd'],
  yaml: ['yaml', 'yml'],
  json: ['json'],
  jsonl: ['jsonl', 'ndjson'],
  html: ['html', 'htm'],
  xml: ['xml'],
  csv: ['csv'],
  tsv: ['tsv'],
  toml: ['toml'],
  ini: ['ini'],
  env: ['env', 'dotenv'],
  log: ['log', 'text', 'txt'],
  text: ['text', 'txt'],
};

export function languageMatches(lang, viewType) {
  const normalizedLang = String(lang || '').toLowerCase();
  const normalizedView = String(viewType || 'text').toLowerCase();
  if (!normalizedLang) return false;
  if (normalizedLang === normalizedView) return true;
  return (LANG_ALIASES[normalizedView] || []).includes(normalizedLang);
}

export function extractApplicableCodeBlocks(text, viewType) {
  const blocks = [];
  const re = /```([a-z0-9_-]+)?\s*\n([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const lang = (match[1] || '').toLowerCase();
    if (languageMatches(lang, viewType)) {
      blocks.push({ lang, code: match[2].replace(/\n$/, '') });
    }
  }
  return blocks;
}

function diffLines(oldText, newText) {
  const oldLines = String(oldText || '').split(/\r?\n/);
  const newLines = String(newText || '').split(/\r?\n/);
  const rows = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const left = oldLines[i] ?? '';
    const right = newLines[i] ?? '';
    rows.push({
      type: left === right ? 'same' : 'changed',
      left,
      right,
      line: i + 1,
    });
  }
  return rows;
}

function lineEl(row, side) {
  const div = document.createElement('div');
  div.className = `ai-diff-line ${row.type}`;
  const num = document.createElement('span');
  num.className = 'ai-diff-num';
  num.textContent = String(row.line);
  const code = document.createElement('span');
  code.className = 'ai-diff-code';
  code.textContent = side === 'left' ? row.left : row.right;
  div.append(num, code);
  return div;
}

export function openApplyDiff({ currentText, newText, title = 'Apply AI result', openModal, closeModal, apply }) {
  if (!openModal) {
    if (window.confirm('Replace the current selection or document with the AI result?')) {
      apply(newText);
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      if (accepted) apply(newText);
      closeModal?.();
      resolve(accepted);
    };
    const body = document.createElement('div');
    body.className = 'ai-diff-modal';
    const intro = document.createElement('p');
    intro.textContent = 'Review the proposed replacement. Accepting creates a normal undoable editor change.';
    const grid = document.createElement('div');
    grid.className = 'ai-diff-grid';
    const left = document.createElement('div');
    left.className = 'ai-diff-pane';
    const right = document.createElement('div');
    right.className = 'ai-diff-pane';
    left.innerHTML = '<div class="ai-diff-title">Current</div>';
    right.innerHTML = '<div class="ai-diff-title">AI result</div>';
    for (const row of diffLines(currentText, newText)) {
      left.appendChild(lineEl(row, 'left'));
      right.appendChild(lineEl(row, 'right'));
    }
    grid.append(left, right);
    body.append(intro, grid);

    openModal({
      title,
      body,
      onClose: () => finish(false),
      footer: [
        { label: 'Cancel', onClick: () => finish(false) },
        {
          label: 'Accept',
          primary: true,
          onClick: () => finish(true),
        },
      ],
    });
  });
}
