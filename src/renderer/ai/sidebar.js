import { buildContextBundle, buildMessages, estimateTokens } from './context.js';
import { extractApplicableCodeBlocks, openApplyDiff } from './apply-diff.js';
import { estimateCostUsd, getProvider, providers } from './providers/index.js';
import { getAction, getActionsFor } from './actions/index.js';
import { createMcpController } from './mcp-ui/index.js';

const LS = {
  visible: 'fp-ai-sidebar-visible',
  width: 'fp-ai-sidebar-width',
  provider: 'fp-ai-provider',
  includeTabs: 'fp-ai-include-tabs',
  includeTree: 'fp-ai-include-tree',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function nowIso() {
  return new Date().toISOString();
}

function makeAbortError(message = 'AI request canceled.', name = 'AbortError') {
  try {
    return new DOMException(message, name);
  } catch {
    const err = new Error(message);
    err.name = name;
    return err;
  }
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

function isCancelError(err) {
  return err?.name === 'AbortError';
}

function throwIfSignalAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || makeAbortError();
}

function abortController(controller, reason) {
  try {
    controller.abort(reason);
  } catch {
    controller.abort();
  }
}

function linkAbortSignals(signals) {
  const controller = new AbortController();
  const cleanups = [];
  const abortFrom = (signal) => {
    if (controller.signal.aborted) return;
    abortController(controller, signal?.reason || makeAbortError());
  };

  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener('abort', listener, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', listener));
  }

  return {
    signal: controller.signal,
    cleanup() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

function fileName(path) {
  return String(path || 'Untitled').split(/[\\/]/).pop() || 'Untitled';
}

function modelKey(providerId) {
  return `fp-ai-model-${providerId}`;
}

function endpointKey(providerId) {
  return `fp-ai-endpoint-${providerId}`;
}

function getSavedModel(provider) {
  return localStorage.getItem(modelKey(provider.id)) || provider.defaultModel || provider.models?.[0] || '';
}

function getSavedEndpoint(provider) {
  return localStorage.getItem(endpointKey(provider.id)) || provider.defaultEndpoint || '';
}

function setSidebarVisible(root, handle, visible) {
  root.classList.toggle('hidden', !visible);
  handle.classList.toggle('hidden', !visible);
  localStorage.setItem(LS.visible, String(visible));
}

function makeMessage(role, content) {
  return { role, content, createdAt: nowIso() };
}

export function createAISidebar({ workspaceEl, hooks, keyStore, conversationStore, track }) {
  const resize = el('div', 'ai-sidebar-resize hidden');
  const root = el('aside', 'ai-sidebar hidden');
  root.style.width = `${parseInt(localStorage.getItem(LS.width), 10) || 380}px`;
  workspaceEl.append(resize, root);

  let provider = getProvider(localStorage.getItem(LS.provider) || 'openai');
  let model = getSavedModel(provider);
  let endpoint = getSavedEndpoint(provider);
  let includeTabs = localStorage.getItem(LS.includeTabs) === 'true';
  let includeTree = localStorage.getItem(LS.includeTree) === 'true';
  let messages = [];
  let currentConversation = conversationStore.create();
  let keyStatus = { providers: {} };
  let activeMode = 'chat';
  let sending = false;
  let historyQuery = '';
  let chatAbortController = null;
  let actionRunning = null;
  let actionRunSeq = 0;
  let actionStatus = '';
  let runnerAttachment = null;
  let includeRunnerOutput = false;
  let runnerAttachmentUntil = 0;
  let runnerAttachmentTimer = null;

  root.innerHTML = `
    <div class="ai-header">
      <button type="button" class="ai-provider-button"></button>
    </div>
    <div class="ai-mode-tabs">
      <button type="button" data-mode="chat" class="active">Chat</button>
      <button type="button" data-mode="actions">Assist</button>
      <button type="button" data-mode="mcp">MCP</button>
    </div>
    <div class="ai-main">
      <section class="ai-history">
        <div class="ai-history-head">
          <button type="button" class="ai-new-chat">New</button>
          <button type="button" class="ai-rename-chat">Rename</button>
          <input type="search" placeholder="Search">
        </div>
        <div class="ai-history-list"></div>
      </section>
      <section class="ai-chat-panel"></section>
      <section class="ai-actions-panel hidden"></section>
      <section class="ai-mcp-panel hidden"></section>
    </div>
  `;

  const providerBtn = root.querySelector('.ai-provider-button');
  const chatPanel = root.querySelector('.ai-chat-panel');
  const actionsPanel = root.querySelector('.ai-actions-panel');
  const mcpPanel = root.querySelector('.ai-mcp-panel');
  const historyList = root.querySelector('.ai-history-list');
  const historySearch = root.querySelector('.ai-history input');
  const newChatBtn = root.querySelector('.ai-new-chat');
  const renameChatBtn = root.querySelector('.ai-rename-chat');

  const logEl = el('div', 'ai-log');
  const activeContextEl = el('div', 'ai-context-chip');
  const optionsEl = el('div', 'ai-context-options');
  const composerWrap = el('div', 'ai-composer-wrap');
  const composer = document.createElement('textarea');
  composer.className = 'ai-composer';
  composer.rows = 4;
  composer.placeholder = 'Ask about this tab, or use /model, /clear, /copy, /file <path>';
  const footer = el('div', 'ai-footer');
  const sendBtn = el('button', 'ai-send', 'Send');
  sendBtn.type = 'button';
  composerWrap.append(composer, footer, sendBtn);
  chatPanel.append(activeContextEl, optionsEl, logEl, composerWrap);

  const includeTabsLabel = document.createElement('label');
  includeTabsLabel.innerHTML = '<input type="checkbox"> Include open tab list';
  includeTabsLabel.querySelector('input').checked = includeTabs;
  includeTabsLabel.querySelector('input').addEventListener('change', (event) => {
    includeTabs = event.target.checked;
    localStorage.setItem(LS.includeTabs, String(includeTabs));
    updateFooter();
  });

  const includeTreeLabel = document.createElement('label');
  includeTreeLabel.innerHTML = '<input type="checkbox"> Include workspace files';
  includeTreeLabel.querySelector('input').checked = includeTree;
  includeTreeLabel.querySelector('input').addEventListener('change', (event) => {
    includeTree = event.target.checked;
    localStorage.setItem(LS.includeTree, String(includeTree));
    updateFooter();
  });
  optionsEl.append(includeTabsLabel, includeTreeLabel);
  const runnerChip = el('button', 'ai-runner-chip hidden');
  runnerChip.type = 'button';
  runnerChip.addEventListener('click', () => {
    if (!runnerAttachment) return;
    const body = el('div', 'ai-settings ai-runner-attachment');
    body.appendChild(el('p', '', `${runnerAttachment.commandLine || 'Command'} / exit ${runnerAttachment.exitCode ?? ''}`));
    const pre = document.createElement('pre');
    pre.textContent = runnerAttachment.output || '';
    body.appendChild(pre);
    hooks.openModal?.({
      title: 'Runner output attachment',
      body,
      footer: [
        { label: includeRunnerOutput ? 'Exclude from next chat' : 'Include in next chat', onClick: () => {
          includeRunnerOutput = !includeRunnerOutput;
          renderRunnerChip();
          updateFooter();
          hooks.closeModal?.();
        } },
        { label: 'Close', primary: true, onClick: () => hooks.closeModal?.() },
      ],
    });
  });
  optionsEl.appendChild(runnerChip);

  const mcpController = createMcpController({
    panel: mcpPanel,
    hooks,
    track,
  });

  function renderHeader() {
    providerBtn.textContent = `${provider.displayName} / ${model || 'model'}`;
    providerBtn.title = 'AI provider settings';
  }

  function renderMode() {
    root.querySelectorAll('.ai-mode-tabs button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === activeMode);
    });
    chatPanel.classList.toggle('hidden', activeMode !== 'chat');
    actionsPanel.classList.toggle('hidden', activeMode !== 'actions');
    mcpPanel.classList.toggle('hidden', activeMode !== 'mcp');
    if (activeMode === 'actions') renderActions();
    if (activeMode === 'mcp') mcpController.render();
  }

  function renderRunnerChip() {
    const active = !!runnerAttachment && includeRunnerOutput && Date.now() < runnerAttachmentUntil;
    runnerChip.classList.toggle('hidden', !runnerAttachment);
    runnerChip.classList.toggle('active', active);
    if (!runnerAttachment) {
      runnerChip.textContent = '';
      return;
    }
    const suffix = active ? 'included' : 'click to include';
    runnerChip.textContent = `Runner: ${fileName(runnerAttachment.commandLine || 'output')} (${suffix})`;
  }

  function actionScopes(active) {
    const scopes = ['document'];
    if (active?.selection) scopes.push('selection');
    if (active?.viewType === 'csv' || active?.viewType === 'tsv') scopes.push('column');
    if (active?.viewType === 'json' || active?.viewType === 'mermaid') scopes.push('node');
    return scopes;
  }

  function renderActions() {
    const active = hooks.getActiveTab?.();
    actionsPanel.innerHTML = '';
    const head = el('div', 'ai-actions-head');
    head.appendChild(el('strong', '', active ? `Assist tools for ${fileName(active.filePath || active.name)}` : 'Assist tools'));
    head.appendChild(el('span', '', active
      ? `${active.viewType || 'plain'} / ${actionScopes(active).join(', ')}. Local tools stay on-device; AI-powered tools use ${providerStatusText()}.`
      : 'Open a document to enable format-aware local and AI-powered tools.'));
    actionsPanel.appendChild(head);

    if (actionRunning) {
      const run = el('div', 'ai-action-running');
      run.innerHTML = `<span class="ai-spinner"></span><span>${actionRunning.label}</span>`;
      const cancel = el('button', '', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', cancelRunningAction);
      run.appendChild(cancel);
      actionsPanel.appendChild(run);
    } else if (actionStatus) {
      actionsPanel.appendChild(el('div', 'ai-action-status', actionStatus));
    }

    if (!active) {
      const empty = el('div', 'ai-empty');
      empty.innerHTML = '<strong>No active document.</strong><span>Open a CSV, JSON, Markdown, or Mermaid tab to see local and AI-powered assist tools.</span>';
      actionsPanel.appendChild(empty);
      return;
    }

    const actions = getActionsFor(active.viewType, actionScopes(active));
    if (actions.length === 0) {
      const empty = el('div', 'ai-empty');
      empty.innerHTML = `<strong>No assist tools for ${active.viewType || 'plain'} yet.</strong><span>Current tools target CSV/TSV, JSON, Markdown, and Mermaid.</span>`;
      actionsPanel.appendChild(empty);
      return;
    }

    const localActions = actions.filter(action => !actionUsesAI(action));
    const aiActions = actions.filter(actionUsesAI);
    const aiBlocked = !providerKeyConfigured();

    function renderActionButton(action, { aiPowered }) {
      const btn = el('button', 'ai-action-card');
      btn.type = 'button';
      btn.classList.toggle('ai-powered', aiPowered);
      btn.classList.toggle('local-tool', !aiPowered);
      btn.disabled = !!actionRunning || (aiPowered && aiBlocked);
      btn.title = aiPowered && aiBlocked ? `${provider.displayName} API key is not configured.` : '';
      const icon = el('span', 'ai-action-icon');
      icon.innerHTML = action.icon || '';
      const text = el('span', 'ai-action-copy');
      text.appendChild(el('strong', '', action.label));
      text.appendChild(el('small', '', action.description || [].concat(action.scope).join(' / ')));
      const meta = el('span', 'ai-action-meta');
      meta.appendChild(el('span', aiPowered ? 'ai-action-badge ai' : 'ai-action-badge local', aiPowered ? 'Uses AI provider' : 'Runs locally'));
      meta.appendChild(el('span', 'ai-action-scope', [].concat(action.scope).join(' / ')));
      if (aiPowered && aiBlocked) meta.appendChild(el('span', 'ai-action-warning', 'Requires provider key'));
      text.appendChild(meta);
      btn.append(icon, text);
      btn.addEventListener('click', () => runAIAction(action));
      return btn;
    }

    function renderActionSection(title, subtitle, items, options = {}) {
      if (!items.length) return;
      const section = el('section', 'ai-action-section');
      const sectionHead = el('div', 'ai-action-section-head');
      sectionHead.appendChild(el('strong', '', title));
      sectionHead.appendChild(el('span', '', subtitle));
      if (options.setupProvider) {
        const setup = el('button', '', 'Set up provider');
        setup.type = 'button';
        setup.addEventListener('click', openProviderSettings);
        sectionHead.appendChild(setup);
      }
      section.appendChild(sectionHead);
      const list = el('div', 'ai-action-list');
      for (const action of items) list.appendChild(renderActionButton(action, { aiPowered: options.aiPowered === true }));
      section.appendChild(list);
      actionsPanel.appendChild(section);
    }

    renderActionSection(
      'AI-powered edits',
      aiBlocked
        ? `${provider.displayName} needs an API key before these can run. Local tools below still work.`
        : `Uses ${providerStatusText()} and may send document context to the configured provider.`,
      aiActions,
      { aiPowered: true, setupProvider: aiBlocked },
    );
    renderActionSection(
      'Local format tools',
      'No AI provider or API key. Runs locally in FormatPad.',
      localActions,
      { aiPowered: false },
    );
  }

  function renderMessageContent(container, msg) {
    container.innerHTML = '';
    const text = String(msg.content || '');
    const codeRe = /```([a-z0-9_-]+)?\s*\n([\s\S]*?)```/gi;
    let last = 0;
    let match;
    while ((match = codeRe.exec(text))) {
      if (match.index > last) container.appendChild(el('div', 'ai-message-text', text.slice(last, match.index)));
      const lang = (match[1] || '').toLowerCase();
      const code = match[2].replace(/\n$/, '');
      const block = el('div', 'ai-code-block');
      const head = el('div', 'ai-code-head');
      head.appendChild(el('span', '', lang || 'code'));
      const active = hooks.getActiveTab?.();
      const applicable = extractApplicableCodeBlocks(match[0], active?.viewType).length > 0;
      if (msg.role === 'assistant' && applicable) {
        const applyBtn = el('button', '', 'Apply');
        applyBtn.type = 'button';
        applyBtn.addEventListener('click', () => {
          const latest = hooks.getActiveTab?.();
          openApplyDiff({
            currentText: latest?.selection || latest?.content || '',
            newText: code,
            title: `Apply ${lang || latest?.viewType || 'text'} block`,
            openModal: hooks.openModal,
            closeModal: hooks.closeModal,
            apply: hooks.replaceSelectionOrDocument,
          });
        });
        head.appendChild(applyBtn);
      }
      if (msg.role === 'assistant' && ['bash', 'sh', 'shell', 'powershell', 'ps1'].includes(lang)) {
        const runWrap = el('span', 'ai-run-shell');
        const target = document.createElement('select');
        for (const [value, label] of [
          ['runner', 'Command Runner'],
          ['terminal', 'Terminal draft'],
          ['copy', 'Copy'],
        ]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          target.appendChild(option);
        }
        const runBtn = el('button', '', 'Run');
        runBtn.type = 'button';
        runBtn.title = 'Prefills only. Commands are never auto-executed from AI responses.';
        runBtn.addEventListener('click', async () => {
          if (target.value === 'copy') {
            await navigator.clipboard.writeText(code);
            return;
          }
          window.dispatchEvent(new CustomEvent('formatpad-terminal-prefill', {
            detail: { command: code, mode: target.value },
          }));
        });
        runWrap.append(target, runBtn);
        head.appendChild(runWrap);
      }
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code;
      pre.appendChild(codeEl);
      block.append(head, pre);
      container.appendChild(block);
      last = codeRe.lastIndex;
    }
    if (last < text.length || !text) container.appendChild(el('div', 'ai-message-text', text.slice(last)));
  }

  function renderMessages() {
    logEl.innerHTML = '';
    if (messages.length === 0) {
      const empty = el('div', 'ai-empty');
      const active = hooks.getActiveTab?.();
      empty.appendChild(el('strong', '', active ? `AI is ready for ${fileName(active.filePath || active.name)}` : 'AI sidebar is ready.'));
      empty.appendChild(el('span', '', active
        ? 'Ask for a rewrite, explanation, or format transform using the current document as context.'
        : 'Ask a general question, or open a document to attach file context.'));
      logEl.appendChild(empty);
      return;
    }
    for (const msg of messages) {
      const item = el('article', `ai-message ${msg.role}`);
      const bubble = el('div', 'ai-message-bubble');
      bubble.appendChild(el('div', 'ai-message-role', msg.role === 'assistant' ? 'FormatPad AI' : 'You'));
      const content = el('div', 'ai-message-body');
      renderMessageContent(content, msg);
      bubble.appendChild(content);
      item.appendChild(bubble);
      logEl.appendChild(item);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function updateFooter() {
    const active = hooks.getActiveTab?.();
    const promptTokens = estimateTokens(composer.value);
    const runnerEstimate = runnerAttachment && includeRunnerOutput && Date.now() < runnerAttachmentUntil
      ? Math.min(8000, estimateTokens(runnerAttachment.output || ''))
      : 0;
    const contextEstimate = estimateTokens(active?.content || '') + (includeTabs ? 150 : 0) + (includeTree ? 350 : 0) + runnerEstimate;
    const total = promptTokens + contextEstimate;
    const cost = estimateCostUsd(provider, total);
    footer.textContent = `${promptTokens} prompt tokens / about ${total} with context / $${cost.toFixed(4)} est.${runnerEstimate ? ' runner attached' : ''}`;
    renderRunnerChip();
  }

  function getActiveContextSummary() {
    const active = hooks.getActiveTab?.();
    if (!active) {
      return {
        key: 'none',
        label: 'No active document. Chat still works; open a file to attach document context.',
      };
    }
    const contentLength = String(active.content || '').length;
    const selectionLength = String(active.selection || '').length;
    const name = fileName(active.filePath || active.name);
    const bits = [active.viewType || 'plain', `${contentLength.toLocaleString()} chars`];
    if (selectionLength) bits.push(`${selectionLength.toLocaleString()} selected`);
    if (active.isModified) bits.push('unsaved');
    return {
      key: [active.id, active.filePath || active.name || '', active.viewType || '', contentLength, selectionLength, active.isModified ? 'dirty' : 'clean'].join('|'),
      label: `Context: ${name} (${bits.join(', ')})`,
    };
  }

  let lastActiveContextKey = '';
  function refreshActiveContext({ force = false } = {}) {
    const summary = getActiveContextSummary();
    const changed = force || summary.key !== lastActiveContextKey;
    if (changed) {
      lastActiveContextKey = summary.key;
      activeContextEl.textContent = summary.label;
      if (messages.length === 0) renderMessages();
      if (activeMode === 'actions') renderActions();
    }
    updateFooter();
  }

  async function loadHistory() {
    try {
      const items = historyQuery
        ? await conversationStore.search(historyQuery)
        : await conversationStore.list();
      historyList.innerHTML = '';
      for (const item of items) {
        const btn = el('button', 'ai-history-item');
        btn.type = 'button';
        btn.classList.toggle('active', item.id === currentConversation?.id);
        const title = el('span', 'ai-history-title', item.title || 'New chat');
        const meta = el('span', 'ai-history-meta', `${item.messageCount || 0} messages`);
        btn.append(title, meta);
        btn.addEventListener('click', async () => {
          const loaded = await conversationStore.load(item.id);
          if (!loaded) return;
          currentConversation = loaded;
          messages = loaded.messages || [];
          provider = getProvider(loaded.provider || provider.id);
          model = loaded.model || getSavedModel(provider);
          endpoint = getSavedEndpoint(provider);
          renderHeader();
          renderMessages();
          loadHistory();
        });
        historyList.appendChild(btn);
      }
    } catch {
      historyList.innerHTML = '<div class="ai-history-empty">History unavailable</div>';
    }
  }

  async function saveConversation() {
    if (!currentConversation) currentConversation = conversationStore.create();
    const firstUser = messages.find(msg => msg.role === 'user')?.content || 'New chat';
    currentConversation.title = currentConversation.title === 'New chat'
      ? firstUser.slice(0, 70).replace(/\s+/g, ' ')
      : currentConversation.title;
    currentConversation.messages = messages;
    currentConversation.provider = provider.id;
    currentConversation.model = model;
    currentConversation.updatedAt = nowIso();
    await conversationStore.save(currentConversation);
    loadHistory();
  }

  function renameCurrentConversation() {
    const body = el('div', 'ai-settings');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentConversation?.title || 'New chat';
    input.maxLength = 120;
    const row = el('label', 'ai-settings-row');
    row.append(el('span', '', 'Name'), input);
    body.appendChild(row);
    hooks.openModal?.({
      title: 'Rename conversation',
      body,
      footer: [
        { label: 'Cancel', onClick: () => hooks.closeModal?.() },
        {
          label: 'Save',
          primary: true,
          onClick: async () => {
            currentConversation.title = input.value.trim() || 'New chat';
            await saveConversation();
            hooks.closeModal?.();
          },
        },
      ],
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  function appendAssistantNote(text) {
    messages.push(makeMessage('assistant', text));
    renderMessages();
    saveConversation();
  }

  function providerUsesStoredKey() {
    return provider.needsKey || keyStatus.providers?.[provider.id]?.hasKey === true;
  }

  function actionUsesAI(action) {
    return action.requiresAI !== false;
  }

  function providerKeyConfigured() {
    return !provider.needsKey || keyStatus.providers?.[provider.id]?.hasKey === true;
  }

  function providerStatusText() {
    return `${provider.displayName}${model ? ` / ${model}` : ''}`;
  }

  function ensureTabActive(tabId, message = 'Original document was closed before applying the AI result.') {
    if (!tabId) return hooks.getActiveTab?.();
    let active = hooks.getActiveTab?.();
    if (active?.id === tabId) return active;
    const restored = hooks.activateTab?.(tabId);
    active = hooks.getActiveTab?.();
    if (restored === false || active?.id !== tabId) {
      throw makeAbortError(message);
    }
    return active;
  }

  async function* chatWithCurrentProvider({ requestMessages, tools = [], abortSignal }) {
    try {
      keyStatus = await keyStore.status();
    } catch {}
    if (keyStore.desktopProxy && providerUsesStoredKey()) {
      yield* keyStore.chat({
        provider: provider.id,
        messages: requestMessages,
        model,
        endpoint,
        tools,
        abortSignal,
      });
      return;
    }

    const needsKey = providerUsesStoredKey();
    if (needsKey && typeof keyStore.getDecrypted !== 'function') {
      throw new Error('Saved desktop AI keys are available only through the main-process proxy.');
    }
    const keyRes = needsKey ? await keyStore.getDecrypted(provider.id) : { key: '' };
    if (keyRes?.error) throw new Error(keyRes.error);
    if (provider.needsKey && !keyRes?.key) throw new Error(`${provider.displayName} API key is not set.`);

    yield* provider.chat({
      messages: requestMessages,
      model,
      endpoint,
      apiKey: keyRes.key,
      tools,
      abortSignal,
    });
  }

  async function streamAssistantResponse({ requestMessages, assistantMsg, tools = [], abortSignal, timeoutMs = 120000 }) {
    const toolCalls = [];
    const timeoutController = new AbortController();
    const timeoutId = timeoutMs > 0
      ? setTimeout(() => abortController(
        timeoutController,
        makeAbortError('AI request timed out. Try a smaller document or cancel and retry.', 'TimeoutError'),
      ), timeoutMs)
      : null;
    const linked = linkAbortSignals([abortSignal, timeoutController.signal]);
    try {
      throwIfSignalAborted(linked.signal);
      for await (const chunk of chatWithCurrentProvider({ requestMessages, tools, abortSignal: linked.signal })) {
        throwIfSignalAborted(linked.signal);
        if (chunk.type === 'text') {
          assistantMsg.content += chunk.delta;
          renderMessages();
        } else if (chunk.type === 'tool_call') {
          toolCalls.push(chunk);
        }
      }
      throwIfSignalAborted(linked.signal);
      return toolCalls;
    } catch (err) {
      if (linked.signal.aborted) throw linked.signal.reason || err || makeAbortError();
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      linked.cleanup();
    }
  }

  function formatToolResultsForModel(results) {
    return (results || []).map((item, index) => {
      const title = `${index + 1}. ${item.server || 'MCP'} / ${item.tool || item.name}`;
      if (item.error) return `${title}\nERROR: ${item.error}`;
      return `${title}\n${item.resultText || ''}`;
    }).join('\n\n---\n\n');
  }

  async function handleSlash(raw) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/')) return false;
    const [cmd, ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(' ').trim();

    if (cmd === '/model') {
      if (!arg) {
        appendAssistantNote(`Current model: ${model}`);
      } else {
        model = arg;
        localStorage.setItem(modelKey(provider.id), model);
        renderHeader();
        appendAssistantNote(`Model switched to ${model} for this conversation.`);
      }
      return true;
    }

    if (cmd === '/clear') {
      messages = [];
      currentConversation = conversationStore.create();
      renderMessages();
      loadHistory();
      return true;
    }

    if (cmd === '/copy') {
      const last = [...messages].reverse().find(msg => msg.role === 'assistant');
      if (last?.content) await navigator.clipboard.writeText(last.content);
      appendAssistantNote(last?.content ? 'Last assistant response copied.' : 'No assistant response to copy yet.');
      return true;
    }

    if (cmd === '/file') {
      const workspacePath = hooks.getWorkspacePath?.();
      if (!workspacePath || !arg || arg.includes('..') || /^[a-z]+:|^[\\/]/i.test(arg)) {
        appendAssistantNote('Usage: /file relative/path.ext from the current workspace.');
        return true;
      }
      const sep = workspacePath.includes('\\') ? '\\' : '/';
      const target = `${workspacePath.replace(/[\\/]+$/, '')}${sep}${arg.replace(/[\\/]+/g, sep)}`;
      const content = await window.formatpad.readFile(target);
      composer.value = `<file path="${arg}">\n${content}\n</file>\n\n${composer.value}`;
      updateFooter();
      return true;
    }

    return false;
  }

  function setChatSending(next, controller = null) {
    sending = next;
    chatAbortController = next ? controller : null;
    sendBtn.disabled = false;
    sendBtn.textContent = next ? 'Stop' : 'Send';
  }

  function cancelChatResponse() {
    if (!chatAbortController) return;
    abortController(chatAbortController, makeAbortError('AI chat canceled.'));
  }

  async function sendMessage() {
    if (sending) {
      cancelChatResponse();
      return;
    }
    const raw = composer.value.trim();
    if (!raw) return;
    if (await handleSlash(raw)) {
      composer.value = '';
      updateFooter();
      return;
    }

    const active = hooks.getActiveTab?.();

    const priorHistory = [...messages];
    const userMsg = makeMessage('user', raw);
    messages.push(userMsg);
    composer.value = '';
    updateFooter();
    renderMessages();

    const assistantMsg = makeMessage('assistant', '');
    messages.push(assistantMsg);
    renderMessages();
    const controller = new AbortController();
    setChatSending(true, controller);

    try {
      const workspaceFiles = includeTree ? await hooks.getWorkspaceFiles?.() : [];
      const contextBundle = buildContextBundle({
        activeTab: active,
        openTabs: hooks.getOpenTabs?.() || [],
        workspaceFiles,
        includeOtherTabs: includeTabs,
        includeFileTree: includeTree,
        runnerOutput: runnerAttachment,
        includeRunnerOutput: !!(runnerAttachment && includeRunnerOutput && Date.now() < runnerAttachmentUntil),
      });
      const requestMessages = buildMessages({ contextBundle, history: priorHistory, userText: raw });
      const mcpTools = await mcpController.getToolSpecs();
      const toolCalls = await streamAssistantResponse({
        requestMessages,
        assistantMsg,
        tools: mcpTools,
        abortSignal: controller.signal,
      });
      throwIfSignalAborted(controller.signal);
      if (toolCalls.length) {
        const toolResults = await mcpController.resolveToolCalls(toolCalls);
        throwIfSignalAborted(controller.signal);
        const toolText = formatToolResultsForModel(toolResults);
        assistantMsg.content += `${assistantMsg.content ? '\n\n' : ''}MCP tool results received. Preparing final answer...\n`;
        renderMessages();
        await streamAssistantResponse({
          requestMessages: [
            ...requestMessages,
            { role: 'assistant', content: assistantMsg.content || 'I requested MCP tool results.' },
            { role: 'user', content: `Use these MCP tool results to answer the original request. Do not request more tools.\n\n${toolText}` },
          ],
          assistantMsg,
          tools: [],
          abortSignal: controller.signal,
        });
      }
      track?.('ai_action', {
        format: active?.viewType || 'unknown',
        action_name: 'chat',
        provider: provider.id,
        success: 'true',
      });
    } catch (err) {
      assistantMsg.content += `${assistantMsg.content ? '\n\n' : ''}${isCancelError(err) ? 'Canceled.' : `Error: ${err.message || String(err)}`}`;
      if (!isAbortError(err)) hooks.notify?.('AI', err);
      track?.('ai_action', {
        format: active?.viewType || 'unknown',
        action_name: 'chat',
        provider: provider.id,
        success: 'false',
      });
      track?.('error', { type: err.name || 'AIError', format: active?.viewType || 'unknown' });
    } finally {
      setChatSending(false);
      renderMessages();
      saveConversation();
    }
  }

  async function completeWithProvider({ prompt, messages: requestMessages, system, abortSignal, timeoutMs = 120000 }) {
    throwIfSignalAborted(abortSignal);
    const messagesForProvider = requestMessages || [
      { role: 'system', content: system || 'You are FormatPad AI. Return concise, directly usable output.' },
      { role: 'user', content: prompt },
    ];
    const timeoutController = new AbortController();
    const timeoutId = timeoutMs > 0
      ? setTimeout(() => abortController(
        timeoutController,
        makeAbortError('AI request timed out. Try a smaller document or cancel and retry.', 'TimeoutError'),
      ), timeoutMs)
      : null;
    const linked = linkAbortSignals([abortSignal, timeoutController.signal]);
    let text = '';
    try {
      for await (const chunk of chatWithCurrentProvider({
        requestMessages: messagesForProvider,
        abortSignal: linked.signal,
      })) {
        throwIfSignalAborted(linked.signal);
        if (chunk.type === 'text') text += chunk.delta;
      }
      throwIfSignalAborted(linked.signal);
      return text;
    } catch (err) {
      if (linked.signal.aborted) throw linked.signal.reason || err || makeAbortError();
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      linked.cleanup();
    }
  }

  function templateSectionPrompt({ active, section, sectionText }) {
    return [
      `Fill the "${section}" section of this Markdown dev artifact.`,
      'Return only the replacement Markdown for this section body. Do not include the section heading.',
      'Keep it concise, concrete, and directly usable. Preserve checkboxes where useful.',
      '',
      `<section-current name="${section}">`,
      sectionText || '',
      '</section-current>',
      '',
      '<document>',
      active?.content || '',
      '</document>',
    ].join('\n');
  }

  async function fillTemplateSection(section, { abortSignal } = {}) {
    const active = hooks.getActiveTab?.();
    if (!active) throw new Error('Open a template document first.');
    const current = hooks.getTemplateSection?.(section);
    if (!current) throw new Error(`Section not found: ${section}`);
    const response = await completeWithProvider({
      abortSignal,
      prompt: templateSectionPrompt({ active, section, sectionText: current.text }),
      system: 'You are FormatPad AI. Fill one Markdown template section at a time. Return only Markdown for the requested section body.',
    });
    const replacement = (extractCode(response, 'markdown') || response).trim();
    if (!replacement) throw new Error(`AI returned no content for ${section}.`);
    ensureTabActive(active.id, 'Template document was closed before applying the AI result.');
    const latest = hooks.getTemplateSection?.(section);
    if (!latest) throw new Error(`Section not found: ${section}`);
    const accepted = await openApplyDiff({
      currentText: latest.text || '',
      newText: replacement,
      title: `Fill template section: ${section}`,
      openModal: hooks.openModal,
      closeModal: hooks.closeModal,
      apply: (text) => {
        ensureTabActive(active.id, 'Template document was closed before applying the AI result.');
        hooks.replaceTemplateSection?.(section, text);
      },
    });
    if (!accepted) throw makeAbortError(`Fill template section: ${section} canceled.`);
    return accepted;
  }

  async function completeTemplateSections(sections) {
    const pending = (sections || []).filter(Boolean);
    if (!pending.length || actionRunning) return;
    const controller = new AbortController();
    actionRunning = { id: 'template.complete', label: 'Complete remaining template sections', controller };
    actionStatus = '';
    activeMode = 'actions';
    toggle(true);
    renderMode();
    try {
      for (const section of pending) {
        if (controller.signal.aborted) throw new DOMException('Canceled', 'AbortError');
        actionStatus = `Filling ${section}...`;
        renderActions();
        await fillTemplateSection(section, { abortSignal: controller.signal });
      }
      actionStatus = 'Template sections completed.';
    } catch (err) {
      actionStatus = err?.name === 'AbortError'
        ? 'Template completion canceled.'
        : `Template completion failed: ${err.message || String(err)}`;
      hooks.notify?.('Templates', err);
    } finally {
      actionRunning = null;
      renderActions();
    }
  }

  function extractCode(text, lang) {
    const wanted = String(lang || '').toLowerCase();
    const re = /```([a-z0-9_-]+)?\s*\n([\s\S]*?)```/gi;
    let fallback = '';
    let match;
    while ((match = re.exec(String(text || '')))) {
      const found = String(match[1] || '').toLowerCase();
      if (!fallback) fallback = match[2].replace(/\n$/, '');
      if (!wanted || found === wanted || (wanted === 'markdown' && found === 'md')) {
        return match[2].replace(/\n$/, '');
      }
    }
    return fallback;
  }

  function extractJson(text) {
    const fenced = extractCode(text, 'json');
    if (fenced) return fenced;
    const raw = String(text || '');
    const start = raw.indexOf('[') >= 0 ? raw.indexOf('[') : raw.indexOf('{');
    const end = raw.lastIndexOf(']') >= 0 ? raw.lastIndexOf(']') : raw.lastIndexOf('}');
    return start >= 0 && end > start ? raw.slice(start, end + 1) : '';
  }

  function promptText(title, label, defaultValue = '', options = {}) {
    return new Promise(resolve => {
      const signal = options.abortSignal;
      if (signal?.aborted) {
        resolve('');
        return;
      }
      let settled = false;
      const body = el('div', 'ai-settings');
      const input = options.multiline ? document.createElement('textarea') : document.createElement('input');
      if (!options.multiline) input.type = 'text';
      input.value = defaultValue || '';
      input.placeholder = options.placeholder || '';
      if (options.multiline) input.rows = 8;
      if (options.description) {
        const description = el('p', 'ai-prompt-description', String(options.description));
        body.appendChild(description);
      }
      const row = el('label', 'ai-settings-row');
      row.append(el('span', '', label), input);
      body.appendChild(row);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        hooks.closeModal?.();
        resolve(value);
      };
      const onAbort = () => finish('');
      signal?.addEventListener('abort', onAbort, { once: true });
      hooks.openModal?.({
        title,
        body,
        onClose: () => finish(''),
        footer: [
          { label: 'Cancel', onClick: () => finish('') },
          { label: 'OK', primary: true, onClick: () => finish(input.value) },
        ],
      });
      setTimeout(() => { input.focus(); input.select?.(); }, 0);
    });
  }

  function promptChoice(title, label, options, defaultValue, promptOptions = {}) {
    return new Promise(resolve => {
      const signal = promptOptions.abortSignal;
      if (signal?.aborted) {
        resolve('');
        return;
      }
      let settled = false;
      const body = el('div', 'ai-settings');
      const select = document.createElement('select');
      for (const option of options) {
        const opt = document.createElement('option');
        opt.value = option;
        opt.textContent = option;
        select.appendChild(opt);
      }
      select.value = defaultValue || options[0] || '';
      const row = el('label', 'ai-settings-row');
      row.append(el('span', '', label), select);
      body.appendChild(row);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        hooks.closeModal?.();
        resolve(value);
      };
      const onAbort = () => finish('');
      signal?.addEventListener('abort', onAbort, { once: true });
      hooks.openModal?.({
        title,
        body,
        onClose: () => finish(''),
        footer: [
          { label: 'Cancel', onClick: () => finish('') },
          { label: 'OK', primary: true, onClick: () => finish(select.value) },
        ],
      });
      setTimeout(() => select.focus(), 0);
    });
  }

  function cancelRunningAction() {
    if (!actionRunning) return;
    const running = actionRunning;
    running.canceled = true;
    abortController(running.controller, makeAbortError(`${running.label} canceled.`));
    actionStatus = `${running.label} canceled.`;
    actionRunning = null;
    renderActions();
  }

  async function runAIAction(action, detail = {}) {
    const active = hooks.getActiveTab?.();
    if (!active || actionRunning) return;
    const controller = new AbortController();
    const runId = ++actionRunSeq;
    actionRunning = { id: action.id, label: action.label, controller, runId, canceled: false };
    actionStatus = '';
    renderActions();
    const isCurrentRun = () => actionRunning?.runId === runId;
    const ensureActionActive = () => {
      if (!isCurrentRun() || controller.signal.aborted) {
        throw controller.signal.reason || makeAbortError(`${action.label} canceled.`);
      }
    };
    const context = {
      activeTab: active,
      openTabs: hooks.getOpenTabs?.() || [],
      workspacePath: hooks.getWorkspacePath?.(),
      detail,
    };
    const ui = {
      promptText: (title, label, defaultValue = '', options = {}) => {
        ensureActionActive();
        return promptText(title, label, defaultValue, { ...options, abortSignal: controller.signal });
      },
      promptChoice: (title, label, options, defaultValue) => {
        ensureActionActive();
        return promptChoice(title, label, options, defaultValue, { abortSignal: controller.signal });
      },
      extractCode,
      extractJson,
      openTab: ({ name, content, viewType }) => {
        ensureActionActive();
        return hooks.createTextTab?.(name, content, viewType);
      },
      applyDocument: ({ title, newText }) => {
        ensureActionActive();
        const target = ensureTabActive(active.id);
        return openApplyDiff({
          currentText: target?.content || '',
          newText,
          title,
          openModal: hooks.openModal,
          closeModal: hooks.closeModal,
          apply: (text) => {
            ensureActionActive();
            ensureTabActive(active.id);
            (hooks.replaceDocument || hooks.replaceSelectionOrDocument)?.(text);
          },
        }).then((accepted) => {
          if (!accepted) throw makeAbortError(`${title} canceled.`);
          return accepted;
        });
      },
      applySelectionOrDocument: ({ title, newText }) => {
        ensureActionActive();
        const latest = ensureTabActive(active.id);
        return openApplyDiff({
          currentText: latest?.selection || latest?.content || '',
          newText,
          title,
          openModal: hooks.openModal,
          closeModal: hooks.closeModal,
          apply: (text) => {
            ensureActionActive();
            ensureTabActive(active.id);
            hooks.replaceSelectionOrDocument?.(text);
          },
        }).then((accepted) => {
          if (!accepted) throw makeAbortError(`${title} canceled.`);
          return accepted;
        });
      },
      notify: hooks.notify,
      showFilterChip: hooks.showCsvFilterChip,
    };
    try {
      const result = await action.run({
        context,
        ui,
        llm: {
          complete: async (args) => {
            ensureActionActive();
            const text = await completeWithProvider({ ...args, abortSignal: controller.signal });
            ensureActionActive();
            return text;
          },
        },
      });
      ensureActionActive();
      actionStatus = result?.message || `${action.label} finished.`;
      track?.('ai_action', { format: active.viewType || 'unknown', action_name: action.id, provider: provider.id, success: 'true' });
    } catch (err) {
      if (isCurrentRun()) {
        actionStatus = isCancelError(err)
          ? `${action.label} canceled.`
          : `${action.label}: ${err.message || String(err)}`;
        if (!isAbortError(err)) hooks.notify?.('AI action', err);
        track?.('ai_action', { format: active.viewType || 'unknown', action_name: action.id, provider: provider.id, success: 'false' });
        track?.('error', { type: err.name || 'AIActionError', format: active.viewType || 'unknown' });
      }
    } finally {
      if (isCurrentRun()) {
        actionRunning = null;
        renderActions();
      }
    }
  }

  async function openProviderSettings() {
    keyStatus = await keyStore.status();
    const body = el('div', 'ai-settings');
    const providerSelect = document.createElement('select');
    for (const item of providers) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.displayName;
      providerSelect.appendChild(option);
    }
    providerSelect.value = provider.id;

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.value = model;
    modelInput.placeholder = 'model id';

    const endpointInput = document.createElement('input');
    endpointInput.type = 'text';
    endpointInput.value = endpoint;
    endpointInput.placeholder = 'endpoint base URL';

    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = 'Paste API key to save or replace';

    const status = el('div', 'ai-key-status');

    function refreshFields() {
      const selected = getProvider(providerSelect.value);
      modelInput.value = localStorage.getItem(modelKey(selected.id)) || selected.defaultModel || '';
      endpointInput.value = localStorage.getItem(endpointKey(selected.id)) || selected.defaultEndpoint || '';
      endpointInput.disabled = !selected.configurableEndpoint && selected.id !== 'ollama';
      keyInput.disabled = !selected.needsKey && selected.id !== 'openai-compatible';
      const entry = keyStatus.providers?.[selected.id];
      status.textContent = selected.needsKey || selected.id === 'openai-compatible'
        ? (entry?.hasKey ? `Saved key: ${entry.mask}` : 'No key saved.')
        : 'No API key required.';
    }

    providerSelect.addEventListener('change', refreshFields);
    for (const [label, control] of [
      ['Provider', providerSelect],
      ['Model', modelInput],
      ['Endpoint', endpointInput],
      ['API key', keyInput],
    ]) {
      const row = el('label', 'ai-settings-row');
      row.append(el('span', '', label), control);
      body.appendChild(row);
    }
    body.appendChild(status);
    refreshFields();

    hooks.openModal?.({
      title: 'AI provider settings',
      body,
      footer: [
        { label: 'Cancel', onClick: () => hooks.closeModal?.() },
        {
          label: 'Remove key',
          onClick: async () => {
            const selected = providerSelect.value;
            await keyStore.remove(selected);
            keyStatus = await keyStore.status();
            refreshFields();
            renderActions();
          },
        },
        {
          label: 'Save',
          primary: true,
          onClick: async () => {
            provider = getProvider(providerSelect.value);
            model = modelInput.value.trim() || provider.defaultModel || '';
            endpoint = endpointInput.value.trim() || provider.defaultEndpoint || '';
            localStorage.setItem(LS.provider, provider.id);
            localStorage.setItem(modelKey(provider.id), model);
            localStorage.setItem(endpointKey(provider.id), endpoint);
            if (keyInput.value.trim()) {
              const res = await keyStore.set(provider.id, keyInput.value.trim(), { endpoint });
              if (res?.error) {
                hooks.notify?.('AI', new Error(res.error));
                return;
              }
            }
            keyStatus = await keyStore.status();
            renderHeader();
            renderActions();
            updateFooter();
            hooks.closeModal?.();
          },
        },
      ],
    });
  }

  function toggle(force) {
    const visible = force === undefined ? root.classList.contains('hidden') : force;
    setSidebarVisible(root, resize, visible);
    hooks.onVisibilityChange?.(visible);
    if (visible) {
      refreshActiveContext({ force: true });
      composer.focus();
      updateFooter();
    }
  }

  function openMode(mode) {
    activeMode = mode;
    toggle(true);
    renderMode();
    refreshActiveContext({ force: true });
    if (mode === 'chat') composer.focus();
  }

  function startNewChat() {
    messages = [];
    currentConversation = conversationStore.create();
    openMode('chat');
    renderMessages();
    loadHistory();
  }

  function openActionsMode() {
    openMode('actions');
  }

  function openMcpMode() {
    openMode('mcp');
  }

  function runLastActionCommand() {
    const active = hooks.getActiveTab?.();
    if (!active) {
      hooks.notify?.('AI', new Error('Open a document before running an AI action.'));
      return;
    }
    const action = getActionsFor(active.viewType, actionScopes(active))[0];
    if (!action) {
      hooks.notify?.('AI', new Error(`No AI actions are available for ${active.viewType || 'this document'}.`));
      return;
    }
    openActionsMode();
    runAIAction(action);
  }

  providerBtn.addEventListener('click', openProviderSettings);
  sendBtn.addEventListener('click', sendMessage);
  composer.addEventListener('input', () => {
    clearTimeout(composer._aiTimer);
    composer._aiTimer = setTimeout(updateFooter, 200);
  });
  composer.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      sendMessage();
    }
  });

  root.querySelectorAll('.ai-mode-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      activeMode = btn.dataset.mode;
      renderMode();
    });
  });

  window.addEventListener('formatpad-ai-run-action', (event) => {
    const action = getAction(event.detail?.id);
    if (!action) return;
    activeMode = 'actions';
    toggle(true);
    renderMode();
    runAIAction(action, event.detail || {});
  });
  window.addEventListener('formatpad-ai-open-actions', () => {
    activeMode = 'actions';
    toggle(true);
    renderMode();
  });
  window.addEventListener('formatpad-ai-prefill', (event) => {
    const text = String(event.detail?.text || '');
    if (!text) return;
    activeMode = 'chat';
    toggle(true);
    renderMode();
    composer.value = text;
    updateFooter();
    composer.focus();
  });
  window.addEventListener('formatpad-runner-output', (event) => {
    runnerAttachment = event.detail || hooks.getRunnerAttachment?.() || null;
    includeRunnerOutput = !!runnerAttachment;
    runnerAttachmentUntil = Date.now() + 60_000;
    if (runnerAttachmentTimer) clearTimeout(runnerAttachmentTimer);
    runnerAttachmentTimer = setTimeout(() => {
      renderRunnerChip();
      updateFooter();
    }, 60_100);
    renderRunnerChip();
    updateFooter();
  });
  window.addEventListener('formatpad-ai-fill-template-section', (event) => {
    const section = String(event.detail?.section || '').trim();
    if (!section) return;
    activeMode = 'chat';
    toggle(true);
    renderMode();
    fillTemplateSection(section).catch(err => hooks.notify?.('Templates', err));
  });
  window.addEventListener('formatpad-ai-complete-template', (event) => {
    completeTemplateSections(event.detail?.sections || []);
  });
  window.addEventListener('formatpad-ai-load-handover', (event) => {
    const text = String(event.detail?.content || '').trim();
    if (!text) return;
    messages = [];
    currentConversation = conversationStore.create();
    activeMode = 'chat';
    toggle(true);
    renderMode();
    composer.value = `<handover>\n${text}\n</handover>\n\nUse this handover as context for the next steps.`;
    updateFooter();
    renderMessages();
    loadHistory();
    composer.focus();
  });

  historySearch.addEventListener('input', () => {
    historyQuery = historySearch.value.trim();
    loadHistory();
  });
  newChatBtn.addEventListener('click', startNewChat);
  renameChatBtn.addEventListener('click', renameCurrentConversation);

  let dragging = false;
  resize.addEventListener('mousedown', () => {
    dragging = true;
    resize.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const rect = workspaceEl.getBoundingClientRect();
    const width = Math.min(720, Math.max(280, rect.right - event.clientX));
    root.style.width = `${width}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resize.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(LS.width, root.offsetWidth);
  });

  renderHeader();
  renderMode();
  renderMessages();
  refreshActiveContext({ force: true });
  keyStore.status().then(status => {
    keyStatus = status || keyStatus;
    renderHeader();
    renderActions();
  }).catch(() => {});
  loadHistory();
  const initialVisible = localStorage.getItem(LS.visible) === 'true';
  setSidebarVisible(root, resize, initialVisible);
  hooks.onVisibilityChange?.(initialVisible);
  if (initialVisible) refreshActiveContext({ force: true });

  return {
    toggle,
    isVisible() {
      return !root.classList.contains('hidden');
    },
    refreshActiveContext,
    openChat() {
      openMode('chat');
    },
    newChat: startNewChat,
    openActions: openActionsMode,
    openMcp: openMcpMode,
    openSettings() {
      toggle(true);
      openProviderSettings();
    },
    runLastAction: runLastActionCommand,
  };
}
