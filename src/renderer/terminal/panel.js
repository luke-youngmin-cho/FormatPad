import { createPtyTerminalGroup } from './pty-view.js';

const SHELL_OPERATORS = new Set(['&&', '||', ';', '|', '>', '>>', '<', '&']);
const MAX_RENDERED_CHARS = 240_000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function quoteCommand(tokens) {
  return tokens.map(token => /\s/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token).join(' ');
}

function tokenizeCommandLine(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Type a command first.');
  const tokens = [];
  let current = '';
  let quote = '';
  let escaping = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (quote) throw new Error('Unclosed quote in command.');
  if (current) tokens.push(current);
  if (!tokens.length) throw new Error('Type a command first.');
  const op = tokens.find(token => SHELL_OPERATORS.has(token));
  if (op) {
    throw new Error(`Shell operator "${op}" is not supported. Command Runner runs one explicit command with shell:false.`);
  }
  return { command: tokens[0], args: tokens.slice(1), commandLine: raw };
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isInsidePath(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

function truncateForUi(text) {
  const raw = stripAnsi(text);
  if (raw.length <= MAX_RENDERED_CHARS) return raw;
  return `${raw.slice(0, MAX_RENDERED_CHARS)}\n\n[output truncated in UI after ${MAX_RENDERED_CHARS} chars; full in-memory block is retained for AI/copy]`;
}

function nowId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createTerminalPanel({ hooks, track }) {
  const available = typeof window !== 'undefined' && !!window.terminal;
  const statusbar = document.getElementById('statusbar');
  const root = el('section', 'terminal-panel hidden');
  root.innerHTML = `
    <div class="terminal-head">
      <div>
        <strong>Terminal</strong>
        <span>Integrated shell with command runner and AI helpers</span>
      </div>
      <div class="terminal-head-actions">
        <div class="terminal-mode-tabs">
          <button type="button" data-terminal-mode="terminal" class="active">Terminal</button>
          <button type="button" data-terminal-mode="runner">Runner</button>
        </div>
        <span class="terminal-env"></span>
        <button type="button" class="terminal-cancel" disabled>Cancel</button>
        <button type="button" class="terminal-close">x</button>
      </div>
    </div>
    <div class="terminal-runner-view hidden">
      <div class="terminal-banner">Command Runner supports one command at a time with shell:false. Use Terminal mode for TUI apps and interactive shells.</div>
      <div class="terminal-cwd-row">
        <label>CWD <input type="text" class="terminal-cwd"></label>
      </div>
      <div class="terminal-output"></div>
      <form class="terminal-form">
        <span>&gt;</span>
        <input type="text" class="terminal-input" autocomplete="off" spellcheck="false" list="terminal-history-list" placeholder="node -v">
        <datalist id="terminal-history-list"></datalist>
        <button type="submit">Run</button>
      </form>
    </div>
    <div class="terminal-pty-view"></div>
  `;
  document.body.insertBefore(root, statusbar || null);

  const envEl = root.querySelector('.terminal-env');
  const cwdInput = root.querySelector('.terminal-cwd');
  const outputEl = root.querySelector('.terminal-output');
  const form = root.querySelector('.terminal-form');
  const input = root.querySelector('.terminal-input');
  const runBtn = root.querySelector('.terminal-form button');
  const cancelBtn = root.querySelector('.terminal-cancel');
  const closeBtn = root.querySelector('.terminal-close');
  const historyList = root.querySelector('#terminal-history-list');
  const runnerView = root.querySelector('.terminal-runner-view');
  const ptyView = root.querySelector('.terminal-pty-view');
  const modeBtns = Array.from(root.querySelectorAll('.terminal-mode-tabs button'));

  const blocks = [];
  let activeRunId = '';
  let activeBlock = null;
  let removeTerminalListener = null;
  let activeMode = 'terminal';
  let ptyGroup = null;

  function ensurePtyGroup() {
    if (!ptyGroup) {
      ptyGroup = createPtyTerminalGroup({
        mount: ptyView,
        hooks,
        track,
      });
    }
    return ptyGroup;
  }

  function setMode(mode) {
    activeMode = mode === 'terminal' ? 'terminal' : 'runner';
    modeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.terminalMode === activeMode));
    runnerView.classList.toggle('hidden', activeMode !== 'runner');
    ptyView.classList.toggle('hidden', activeMode !== 'terminal');
    cancelBtn.classList.toggle('hidden', activeMode !== 'runner');
    envEl.classList.toggle('hidden', activeMode !== 'runner');
    if (activeMode === 'terminal') {
      ensurePtyGroup().activate();
    }
  }

  function defaultCwd() {
    return hooks.getWorkspacePath?.() || hooks.getActiveTab?.()?.dirPath || '';
  }

  function refreshCwdIfEmpty() {
    if (!cwdInput.value.trim()) cwdInput.value = defaultCwd();
  }

  function setVisible(visible) {
    root.classList.toggle('hidden', !visible);
    if (visible) {
      refreshCwdIfEmpty();
      if (activeMode === 'terminal') ensurePtyGroup().activate();
      else input.focus();
    }
  }

  function toggle(force) {
    setVisible(force === undefined ? root.classList.contains('hidden') : force);
  }

  function setRunning(running) {
    input.disabled = running || !available;
    runBtn.disabled = running || !available;
    cancelBtn.disabled = !running;
  }

  function loadHistory() {
    if (!available) return;
    window.terminal.history().then(items => {
      historyList.innerHTML = '';
      for (const command of items || []) {
        const option = document.createElement('option');
        option.value = command;
        historyList.appendChild(option);
      }
    }).catch(() => {});
  }

  function blockMarkdown(block) {
    const command = block.commandLine || quoteCommand([block.command, ...(block.args || [])]);
    return [
      `### Command: \`${command.replace(/`/g, '\\`')}\``,
      '',
      `- CWD: \`${block.cwd || ''}\``,
      `- Exit: ${block.exitCode === null || block.exitCode === undefined ? 'running' : block.exitCode}`,
      '',
      '```text',
      stripAnsi(block.output || ''),
      '```',
      '',
    ].join('\n');
  }

  function dispatchRunnerOutput(block) {
    window.dispatchEvent(new CustomEvent('formatpad-runner-output', {
      detail: {
        runId: block.id,
        commandLine: block.commandLine,
        cwd: block.cwd,
        exitCode: block.exitCode,
        output: stripAnsi(block.output || ''),
        finishedAt: block.finishedAt,
      },
    }));
  }

  function createBlock({ id, commandLine, command, args, cwd }) {
    const block = {
      id,
      commandLine,
      command,
      args,
      cwd,
      output: '',
      exitCode: null,
      startedAt: new Date().toISOString(),
    };
    const details = el('details', 'terminal-block');
    details.open = true;
    const summary = document.createElement('summary');
    const title = el('span', 'terminal-command', `> ${commandLine}`);
    const badge = el('span', 'terminal-badge running', 'running');
    summary.append(title, badge);
    const toolbar = el('div', 'terminal-block-toolbar');
    for (const [label, handler] of [
      ['Copy', async () => navigator.clipboard.writeText(stripAnsi(block.output || ''))],
      ['Ask AI', () => {
        window.dispatchEvent(new CustomEvent('formatpad-ai-prefill', {
          detail: { text: `<runner_output>\n${stripAnsi(block.output || '')}\n</runner_output>\n\nExplain this output:` },
        }));
      }],
      ['Insert into editor tab', () => hooks.insertRunnerBlock?.(blockMarkdown(block))],
    ]) {
      const btn = el('button', '', label);
      btn.type = 'button';
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const result = handler();
        if (result?.catch) result.catch(err => hooks.notify?.('Command Runner', err));
      });
      toolbar.appendChild(btn);
    }
    const pre = document.createElement('pre');
    details.append(summary, toolbar, pre);
    outputEl.prepend(details);
    block.details = details;
    block.pre = pre;
    block.badge = badge;
    blocks.unshift(block);
    return block;
  }

  function appendToBlock(block, stream, chunk) {
    if (!block) return;
    block.output += chunk;
    block.pre.textContent = truncateForUi(block.output);
    block.pre.dataset.stream = stream;
  }

  function finishBlock(block, payload) {
    if (!block) return;
    block.exitCode = payload.code;
    block.signal = payload.signal;
    block.cancelled = payload.cancelled === true;
    block.finishedAt = new Date().toISOString();
    block.badge.classList.remove('running');
    block.badge.classList.toggle('ok', payload.code === 0);
    block.badge.classList.toggle('fail', payload.code !== 0);
    block.badge.textContent = block.cancelled
      ? 'cancelled'
      : (payload.code === 0 ? 'exit 0' : `exit ${payload.code ?? payload.signal ?? 'error'}`);
    block.details.classList.toggle('terminal-failed', payload.code !== 0);
    activeRunId = '';
    activeBlock = null;
    setRunning(false);
    loadHistory();
    dispatchRunnerOutput(block);
    track?.('terminal_run', {
      command: block.command,
      exit_code: String(payload.code ?? ''),
      success: String(payload.code === 0),
    });
  }

  function showSyntheticError(commandLine, message) {
    const block = createBlock({
      id: nowId(),
      commandLine,
      command: '',
      args: [],
      cwd: cwdInput.value.trim(),
    });
    appendToBlock(block, 'err', `${message}\n`);
    finishBlock(block, { code: 1, signal: null, cancelled: false });
  }

  function handleTerminalEvent(payload) {
    if (!payload || payload.runId !== activeRunId) return;
    if (payload.type === 'start') {
      envEl.textContent = `${payload.maskedEnvCount || 0} env vars masked`;
      return;
    }
    if (payload.type === 'chunk') {
      appendToBlock(activeBlock, payload.stream, payload.chunk || '');
      return;
    }
    if (payload.type === 'error') {
      appendToBlock(activeBlock, 'err', `\n${payload.message || 'Command failed to start.'}\n`);
      return;
    }
    if (payload.type === 'timeout') {
      appendToBlock(activeBlock, 'err', `\nTimed out after ${payload.timeoutMs} ms. Cancelling...\n`);
      return;
    }
    if (payload.type === 'exit') finishBlock(activeBlock, payload);
  }

  function askOutsideWorkspace(cwd, workspaceRoot) {
    return new Promise(resolve => {
      let settled = false;
      const finish = (allowed) => {
        if (settled) return;
        settled = true;
        hooks.closeModal?.();
        resolve(allowed);
      };
      const body = el('div', 'terminal-confirm');
      body.innerHTML = `
        <p>The working directory is outside the current workspace.</p>
        <pre></pre>
        <p>This approval applies to this command run only.</p>
      `;
      body.querySelector('pre').textContent = `workspace: ${workspaceRoot || '(none)'}\ncwd: ${cwd}`;
      hooks.openModal?.({
        title: 'Run outside workspace?',
        body,
        onClose: () => finish(false),
        footer: [
          { label: 'Cancel', onClick: () => finish(false) },
          { label: 'Allow once', primary: true, onClick: () => finish(true) },
        ],
      });
    });
  }

  async function runFromInput() {
    if (!available) {
      showSyntheticError(input.value, 'Command Runner is available only in the Electron desktop app.');
      return;
    }
    if (activeRunId) return;
    let parsed;
    try {
      parsed = tokenizeCommandLine(input.value);
    } catch (err) {
      showSyntheticError(input.value, err.message || String(err));
      return;
    }
    const cwd = cwdInput.value.trim() || defaultCwd();
    const workspaceRoot = hooks.getWorkspacePath?.() || '';
    let allowOutsideWorkspace = false;
    if (!workspaceRoot || !isInsidePath(cwd, workspaceRoot)) {
      allowOutsideWorkspace = await askOutsideWorkspace(cwd, workspaceRoot);
      if (!allowOutsideWorkspace) return;
    }
    const runId = nowId();
    activeRunId = runId;
    activeBlock = createBlock({ id: runId, ...parsed, cwd });
    setRunning(true);
    input.value = '';
    try {
      const result = await window.terminal.run({
        runId,
        commandLine: parsed.commandLine,
        command: parsed.command,
        args: parsed.args,
        cwd,
        workspaceRoot,
        allowOutsideWorkspace,
        timeoutMs: 300_000,
      });
      envEl.textContent = `${result.maskedEnvCount || 0} env vars masked`;
    } catch (err) {
      appendToBlock(activeBlock, 'err', `${err.message || String(err)}\n`);
      finishBlock(activeBlock, { code: 1, signal: null, cancelled: false });
      hooks.notify?.('Command Runner', err);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runFromInput();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeRunId) {
      event.preventDefault();
      window.terminal?.cancel(activeRunId);
    }
  });
  cancelBtn.addEventListener('click', () => {
    if (activeRunId) window.terminal?.cancel(activeRunId);
  });
  closeBtn.addEventListener('click', () => toggle(false));
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.terminalMode);
      setVisible(true);
    });
  });

  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const isBackquote = event.code === 'Backquote' || key === '`';
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && isBackquote) {
      event.preventDefault();
      toggle(true);
      setMode('terminal');
      ensurePtyGroup().newTerminal();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && isBackquote) {
      event.preventDefault();
      toggle();
    }
  });

  window.addEventListener('formatpad-terminal-prefill', (event) => {
    const command = String(event.detail?.command || event.detail?.text || '').trim();
    if (!command) return;
    toggle(true);
    if (event.detail?.mode === 'terminal' || event.detail?.target === 'terminal') {
      setMode('terminal');
      ensurePtyGroup().prefill(command);
      return;
    }
    setMode('runner');
    input.value = command;
    input.focus();
    input.select();
  });

  if (available) {
    removeTerminalListener = window.terminal.onEvent(handleTerminalEvent);
    loadHistory();
  } else {
    envEl.textContent = 'desktop only';
    setRunning(false);
    input.disabled = true;
    runBtn.disabled = true;
  }

  refreshCwdIfEmpty();

  return {
    toggle,
    openRunner() {
      toggle(true);
      setMode('runner');
      input.focus();
      input.select();
    },
    newTerminal() {
      toggle(true);
      setMode('terminal');
      ensurePtyGroup().openNewTerminalPanel?.();
    },
    prefill(command) {
      window.dispatchEvent(new CustomEvent('formatpad-terminal-prefill', { detail: { command } }));
    },
    getLastOutput() {
      const block = blocks.find(item => item.finishedAt);
      const runner = block ? {
        runId: block.id,
        source: 'runner',
        commandLine: block.commandLine,
        cwd: block.cwd,
        exitCode: block.exitCode,
        output: stripAnsi(block.output || ''),
        finishedAt: block.finishedAt,
      } : null;
      const terminal = ptyGroup?.getLastOutput?.() || null;
      if (!runner) return terminal;
      if (!terminal) return runner;
      return String(terminal.finishedAt || '') > String(runner.finishedAt || '') ? terminal : runner;
    },
    destroy() {
      if (removeTerminalListener) removeTerminalListener();
      ptyGroup?.destroy?.();
    },
  };
}
