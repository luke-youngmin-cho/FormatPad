function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function toolAlias(serverId, toolName) {
  const safe = `mcp_${serverId}_${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  const suffix = hashString(`${serverId}:${toolName}`);
  return `${safe.slice(0, Math.max(8, 63 - suffix.length))}_${suffix}`.slice(0, 64);
}

function parseArgs(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function textFromToolResult(result) {
  const parts = [];
  for (const item of result?.content || []) {
    if (item.type === 'text') parts.push(item.text || '');
    else if (item.type === 'resource') parts.push(`[resource] ${item.resource?.uri || ''}`);
    else parts.push(`[${item.type || 'content'}]`);
  }
  if (result?.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.filter(Boolean).join('\n\n').slice(0, 12000) || JSON.stringify(result || {}, null, 2).slice(0, 12000);
}

function resourceText(result) {
  const parts = [];
  for (const item of result?.contents || []) {
    if (item.text) parts.push(item.text);
    else if (item.blob) parts.push(`[binary resource: ${item.mimeType || 'application/octet-stream'}]`);
  }
  return parts.join('\n\n');
}

function guessViewType(name, mimeType) {
  const lower = String(name || '').toLowerCase();
  if (mimeType === 'application/json' || lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.tsv')) return 'tsv';
  if (lower.endsWith('.mmd')) return 'mermaid';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  return 'text';
}

function shortJson(value, max = 5000) {
  const text = JSON.stringify(value || {}, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

export function createMcpController({ panel, hooks, track }) {
  const available = typeof window !== 'undefined' && !!window.mcp;
  let servers = [];
  let statuses = {};
  let statusMessage = '';
  let toolCache = new Map();
  let aliasMap = new Map();
  let selectedServerId = '';
  let busy = false;
  const callLog = [];

  async function refresh() {
    if (!available) return;
    const data = await window.mcp.listServers();
    servers = data.servers || [];
    statuses = data.statuses || {};
    if (!selectedServerId && servers.length) selectedServerId = servers[0].id;
  }

  async function ensureTools(serverId) {
    const status = statuses[serverId];
    if (status?.state !== 'running') return [];
    const tools = await window.mcp.listTools(serverId);
    toolCache.set(serverId, tools || []);
    return tools || [];
  }

  async function getToolSpecs() {
    if (!available) return [];
    try {
      await refresh();
      aliasMap = new Map();
      const specs = [];
      for (const server of servers) {
        if (statuses[server.id]?.state !== 'running') continue;
        const tools = await ensureTools(server.id);
        for (const tool of tools) {
          const alias = toolAlias(server.id, tool.name);
          aliasMap.set(alias, { server, tool });
          specs.push({
            type: 'function',
            function: {
              name: alias,
              description: `[${server.label}] ${tool.description || tool.name}`,
              parameters: tool.inputSchema || { type: 'object', properties: {} },
            },
          });
        }
      }
      return specs;
    } catch {
      return [];
    }
  }

  function askPermission({ server, tool, args, permission }) {
    return new Promise((resolve, reject) => {
      const body = el('div', 'ai-settings ai-mcp-permission');
      body.appendChild(el('p', '', `Allow MCP tool call: ${server.label} / ${tool.name}`));
      body.appendChild(el('p', '', permission.readOnly
        ? 'This tool name looks read-only. You can allow once, for this session, or save a global allow.'
        : 'This tool name may mutate data. FormatPad will ask every time and will not persist this permission.'));
      const pre = document.createElement('pre');
      pre.textContent = shortJson(args);
      body.appendChild(pre);
      const cancel = () => {
        hooks.closeModal?.();
        reject(new Error('MCP tool call canceled.'));
      };
      const allow = (scope) => {
        hooks.closeModal?.();
        resolve({ scope, token: permission.token });
      };
      const footer = [
        { label: 'Cancel', onClick: cancel },
        { label: 'Allow once', primary: true, onClick: () => allow('once') },
      ];
      if (permission.canPersistGlobal) {
        footer.push({ label: 'Allow session', onClick: () => allow('session') });
        footer.push({ label: 'Always allow read-only', onClick: () => allow('global') });
      }
      hooks.openModal?.({ title: 'MCP permission required', body, footer });
    });
  }

  async function callToolWithPermission(server, tool, args) {
    const permission = await window.mcp.prepareToolCall(server.id, tool.name);
    const result = await window.mcp.callTool(server.id, tool.name, args);
    callLog.unshift({
      server: server.label,
      tool: tool.name,
      at: new Date().toLocaleTimeString(),
      text: textFromToolResult(result),
    });
    callLog.splice(12);
    track?.('mcp_tool_call', { server: server.id, tool: tool.name, read_only: String(permission.readOnly) });
    return result;
  }

  async function resolveToolCalls(toolCalls) {
    const results = [];
    for (const call of toolCalls || []) {
      let mapping = aliasMap.get(call.name);
      if (!mapping) {
        await getToolSpecs();
        mapping = aliasMap.get(call.name);
      }
      if (!mapping) {
        results.push({ name: call.name, error: 'Unknown MCP tool alias.' });
        continue;
      }
      const args = parseArgs(call.arguments || call.args);
      try {
        const result = await callToolWithPermission(mapping.server, mapping.tool, args);
        results.push({
          name: call.name,
          server: mapping.server.label,
          tool: mapping.tool.name,
          resultText: textFromToolResult(result),
        });
      } catch (err) {
        results.push({
          name: call.name,
          server: mapping.server.label,
          tool: mapping.tool.name,
          error: err.message || String(err),
        });
      }
    }
    render();
    return results;
  }

  async function toggleServer(server, enabled) {
    busy = true;
    statusMessage = enabled ? `Starting ${server.label}...` : `Stopping ${server.label}...`;
    render();
    try {
      const data = await window.mcp.setEnabled(server.id, enabled, hooks.getWorkspacePath?.() || '');
      statuses = data.statuses || {};
      statusMessage = enabled ? `${server.label} started.` : `${server.label} stopped.`;
      await refresh();
    } catch (err) {
      statusMessage = `${server.label}: ${err.message || String(err)}`;
      hooks.notify?.('MCP', err);
      await refresh().catch(() => {});
    } finally {
      busy = false;
      render();
    }
  }

  async function openResource(server, resource) {
    try {
      const result = await window.mcp.readResource(server.id, resource.uri);
      const content = resourceText(result) || JSON.stringify(result, null, 2);
      hooks.createTextTab?.(resource.name || resource.uri, content, guessViewType(resource.uri, resource.mimeType));
    } catch (err) {
      hooks.notify?.('MCP resource', err);
    }
  }

  async function openResourcePrompt(server) {
    const uri = await promptText('Open MCP resource', 'Resource URI', '');
    if (!uri) return;
    await openResource(server, { uri, name: uri });
  }

  function promptText(title, label, value) {
    return new Promise(resolve => {
      const body = el('div', 'ai-settings');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value || '';
      const row = el('label', 'ai-settings-row');
      row.append(el('span', '', label), input);
      body.appendChild(row);
      hooks.openModal?.({
        title,
        body,
        footer: [
          { label: 'Cancel', onClick: () => { hooks.closeModal?.(); resolve(''); } },
          { label: 'Open', primary: true, onClick: () => { hooks.closeModal?.(); resolve(input.value.trim()); } },
        ],
      });
      setTimeout(() => input.focus(), 0);
    });
  }

  async function editServer(server = {}) {
    const body = el('div', 'ai-settings ai-mcp-edit');
    const fields = {};
    for (const [name, label, value, multiline] of [
      ['id', 'ID', server.id || '', false],
      ['label', 'Label', server.label || '', false],
      ['command', 'Command', server.command || 'npx', false],
      ['args', 'Args JSON', JSON.stringify(server.args || [], null, 2), true],
      ['env', 'Env JSON', JSON.stringify(server.env || {}, null, 2), true],
      ['cwd', 'Working dir', server.cwd || '', false],
    ]) {
      const input = multiline ? document.createElement('textarea') : document.createElement('input');
      if (!multiline) input.type = 'text';
      input.value = value;
      if (multiline) input.rows = 5;
      fields[name] = input;
      const row = el('label', 'ai-settings-row');
      row.append(el('span', '', label), input);
      body.appendChild(row);
    }
    hooks.openModal?.({
      title: server.id ? 'Edit MCP server' : 'Add MCP server',
      body,
      footer: [
        { label: 'Cancel', onClick: () => hooks.closeModal?.() },
        {
          label: 'Save',
          primary: true,
          onClick: async () => {
            try {
              await window.mcp.upsertServer({
                id: fields.id.value.trim(),
                label: fields.label.value.trim(),
                command: fields.command.value.trim(),
                args: JSON.parse(fields.args.value || '[]'),
                env: JSON.parse(fields.env.value || '{}'),
                cwd: fields.cwd.value.trim(),
                enabled: server.enabled === true,
              });
              hooks.closeModal?.();
              await refresh();
              render();
            } catch (err) {
              hooks.notify?.('MCP server', err);
            }
          },
        },
      ],
    });
  }

  async function exportConfig() {
    const config = await window.mcp.exportConfig();
    hooks.createTextTab?.('mcp-servers.json', JSON.stringify(config, null, 2), 'json');
  }

  async function importConfig() {
    const body = el('div', 'ai-settings');
    const input = document.createElement('textarea');
    input.rows = 12;
    input.placeholder = '{ "servers": [] }';
    body.appendChild(input);
    hooks.openModal?.({
      title: 'Import MCP config',
      body,
      footer: [
        { label: 'Cancel', onClick: () => hooks.closeModal?.() },
        {
          label: 'Import',
          primary: true,
          onClick: async () => {
            try {
              await window.mcp.importConfig(input.value);
              hooks.closeModal?.();
              await refresh();
              render();
            } catch (err) {
              hooks.notify?.('MCP import', err);
            }
          },
        },
      ],
    });
  }

  async function runToolPrompt(server, tool) {
    const body = el('div', 'ai-settings');
    const input = document.createElement('textarea');
    input.rows = 8;
    input.value = JSON.stringify({}, null, 2);
    const row = el('label', 'ai-settings-row');
    row.append(el('span', '', 'Arguments JSON'), input);
    body.appendChild(row);
    hooks.openModal?.({
      title: `Run ${tool.name}`,
      body,
      footer: [
        { label: 'Cancel', onClick: () => hooks.closeModal?.() },
        {
          label: 'Run',
          primary: true,
          onClick: async () => {
            try {
              const args = JSON.parse(input.value || '{}');
              hooks.closeModal?.();
              const result = await callToolWithPermission(server, tool, args);
              hooks.createTextTab?.(`${tool.name} result.md`, textFromToolResult(result), 'markdown');
              render();
            } catch (err) {
              hooks.notify?.('MCP tool', err);
            }
          },
        },
      ],
    });
  }

  function renderServer(server) {
    const status = statuses[server.id] || { state: 'stopped' };
    const card = el('article', 'ai-mcp-card');
    const head = el('div', 'ai-mcp-card-head');
    const title = el('div', '');
    title.appendChild(el('strong', '', server.label));
    title.appendChild(el('span', '', `${status.state}${status.toolCount ? ` / ${status.toolCount} tools` : ''}`));
    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.checked = server.enabled && status.state === 'running';
    enable.disabled = busy;
    enable.addEventListener('change', () => toggleServer(server, enable.checked));
    head.append(title, enable);
    card.appendChild(head);
    card.appendChild(el('p', 'ai-mcp-desc', server.description || `${server.command} ${(server.args || []).join(' ')}`));
    if (status.lastError) card.appendChild(el('pre', 'ai-mcp-error', status.lastError));
    if (status.stderr) card.appendChild(el('pre', 'ai-mcp-stderr', status.stderr));

    const actions = el('div', 'ai-mcp-actions');
    const edit = el('button', '', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => editServer(server));
    const tools = el('button', '', 'Tools');
    tools.type = 'button';
    tools.disabled = status.state !== 'running';
    tools.addEventListener('click', async () => {
      selectedServerId = server.id;
      await ensureTools(server.id);
      render();
    });
    const resources = el('button', '', 'Open resource');
    resources.type = 'button';
    resources.disabled = status.state !== 'running';
    resources.addEventListener('click', () => openResourcePrompt(server));
    actions.append(edit, tools, resources);
    card.appendChild(actions);

    if (selectedServerId === server.id && toolCache.has(server.id)) {
      const list = el('div', 'ai-mcp-tool-list');
      for (const tool of toolCache.get(server.id)) {
        const row = el('button', 'ai-mcp-tool');
        row.type = 'button';
        row.innerHTML = `<strong>${tool.name}</strong><span>${tool.description || 'No description'}</span>`;
        row.addEventListener('click', () => runToolPrompt(server, tool));
        list.appendChild(row);
      }
      if (!list.childElementCount) list.appendChild(el('div', 'ai-history-empty', 'No tools reported.'));
      card.appendChild(list);
    }
    return card;
  }

  function renderLog() {
    const wrap = el('div', 'ai-mcp-log');
    wrap.appendChild(el('strong', '', 'Recent tool calls'));
    if (!callLog.length) {
      wrap.appendChild(el('span', '', 'No MCP calls yet.'));
      return wrap;
    }
    for (const item of callLog) {
      const row = el('details', '');
      const summary = document.createElement('summary');
      summary.textContent = `${item.at} / ${item.server} / ${item.tool}`;
      const pre = document.createElement('pre');
      pre.textContent = item.text;
      row.append(summary, pre);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function render() {
    if (!panel) return;
    panel.innerHTML = '';
    if (!available) {
      const empty = el('div', 'ai-empty');
      empty.innerHTML = '<strong>MCP is desktop-only.</strong><span>Open the Electron app to connect local MCP servers.</span>';
      panel.appendChild(empty);
      return;
    }
    const head = el('div', 'ai-actions-head');
    const title = el('div', '');
    title.appendChild(el('strong', '', 'MCP servers'));
    title.appendChild(el('span', '', 'Disabled by default. Tool calls always require permission.'));
    const buttons = el('div', 'ai-mcp-actions');
    for (const [label, fn] of [
      ['Refresh', async () => { await refresh(); render(); }],
      ['Add', () => editServer()],
      ['Export', exportConfig],
      ['Import', importConfig],
    ]) {
      const btn = el('button', '', label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        const result = fn();
        if (result?.catch) result.catch(err => hooks.notify?.('MCP', err));
      });
      buttons.appendChild(btn);
    }
    head.append(title, buttons);
    panel.appendChild(head);
    if (statusMessage) panel.appendChild(el('div', 'ai-action-status', statusMessage));
    for (const server of servers) panel.appendChild(renderServer(server));
    panel.appendChild(renderLog());
  }

  refresh().then(render).catch(() => render());

  return {
    render,
    refresh,
    getToolSpecs,
    resolveToolCalls,
  };
}
