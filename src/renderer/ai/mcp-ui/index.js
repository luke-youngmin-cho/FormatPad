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

function isCanceledToolResult(result) {
  return result?.canceled === true;
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

function schemaTypes(schema = {}) {
  const type = schema?.type;
  if (Array.isArray(type)) return type.map(String);
  if (typeof type === 'string') return [type];
  if (Array.isArray(schema?.enum)) return ['enum'];
  if (Object.prototype.hasOwnProperty.call(schema || {}, 'const')) return ['const'];
  return [];
}

function schemaTypeLabel(schema = {}) {
  const types = schemaTypes(schema);
  return types.length ? types.join(' | ') : 'any';
}

function sampleValueForSchema(schema = {}, name = 'value') {
  if (Object.prototype.hasOwnProperty.call(schema || {}, 'default')) return schema.default;
  if (Object.prototype.hasOwnProperty.call(schema || {}, 'const')) return schema.const;
  if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
  const [type] = schemaTypes(schema);
  if (type === 'string') return `<${name}>`;
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'array') return schema.items ? [sampleValueForSchema(schema.items, name)] : [];
  if (type === 'object') return sampleArgsFromSchema(schema);
  return `<${name}>`;
}

function sampleArgsFromSchema(schema = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const names = Object.keys(properties);
  const sample = {};
  for (const name of names) sample[name] = sampleValueForSchema(properties[name], name);
  return sample;
}

function describeToolSchema(tool) {
  const schema = tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const rows = Object.entries(properties).map(([name, prop]) => {
    const description = typeof prop?.description === 'string' ? ` - ${prop.description}` : '';
    return `${name} (${schemaTypeLabel(prop)}${required.has(name) ? ', required' : ''})${description}`;
  });
  if (!rows.length) return ['No arguments required. Leave {} and run.'];
  const requiredList = Array.from(required).filter(name => properties[name]);
  const head = requiredList.length ? `Required: ${requiredList.join(', ')}` : 'No required arguments.';
  return [head, ...rows.slice(0, 8), rows.length > 8 ? `...and ${rows.length - 8} more fields.` : ''].filter(Boolean);
}

function toolMeta(tool) {
  const schema = tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
  const properties = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  if (!properties.length) return 'No args required';
  return required.length
    ? `Args: ${properties.length} fields, required ${required.join(', ')}`
    : `Args: ${properties.length} optional fields`;
}

function plural(count, label) {
  return `${count || 0} ${label}${count === 1 ? '' : 's'}`;
}

export function createMcpController({ panel, hooks, track }) {
  const available = typeof window !== 'undefined' && !!window.mcp;
  let servers = [];
  let statuses = {};
  let statusMessage = '';
  let toolCache = new Map();
  let resourceCache = new Map();
  let aliasMap = new Map();
  let selectedServerId = '';
  let selectedPanel = 'tools';
  let busy = false;
  const callLog = [];

  function loadingStatus(label) {
    const node = el('div', 'ai-action-status');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.append(el('span', 'ai-spinner'), el('span', '', label));
    return node;
  }

  function statusNode() {
    if (!statusMessage) return null;
    if (busy) return loadingStatus(statusMessage);
    const node = el('div', 'ai-action-status', statusMessage);
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    return node;
  }

  async function withBusy(label, fn) {
    busy = true;
    statusMessage = label;
    render();
    try {
      return await fn();
    } finally {
      busy = false;
      render();
    }
  }

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

  async function ensureResources(serverId) {
    const status = statuses[serverId];
    if (status?.state !== 'running') return [];
    const resources = await window.mcp.listResources(serverId);
    resourceCache.set(serverId, resources || []);
    return resources || [];
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
    const permission = await withBusy(`Preparing ${server.label} / ${tool.name} permission...`, () => (
      window.mcp.prepareToolCall(server.id, tool.name)
    ));
    const result = await withBusy(`Running ${server.label} / ${tool.name}...`, () => (
      window.mcp.callTool(server.id, tool.name, args)
    ));
    if (isCanceledToolResult(result)) {
      statusMessage = `${server.label} / ${tool.name} canceled.`;
      track?.('mcp_tool_cancel', { server: server.id, tool: tool.name });
      return null;
    }
    callLog.unshift({
      server: server.label,
      tool: tool.name,
      at: new Date().toLocaleTimeString(),
      text: textFromToolResult(result),
    });
    callLog.splice(12);
    statusMessage = `${server.label} / ${tool.name} completed.`;
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
        if (!result) {
          results.push({
            name: call.name,
            server: mapping.server.label,
            tool: mapping.tool.name,
            error: 'MCP tool call canceled.',
          });
          continue;
        }
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
      await withBusy(`Opening ${resource.name || resource.uri}...`, async () => {
        const result = await window.mcp.readResource(server.id, resource.uri);
        const content = resourceText(result) || JSON.stringify(result, null, 2);
        hooks.createTextTab?.(resource.name || resource.uri, content, guessViewType(resource.uri, resource.mimeType));
        statusMessage = `${resource.name || resource.uri} opened.`;
      });
    } catch (err) {
      hooks.notify?.('MCP resource', err);
    }
  }

  async function openResourcePrompt(server) {
    const uri = await promptText('Open MCP resource', 'Resource URI', '');
    if (!uri) return;
    await openResource(server, { uri, name: uri });
  }

  function showServerUnavailable(server, status, feature) {
    const suffix = status?.lastError ? ` Last error: ${status.lastError}` : '';
    statusMessage = `Enable ${server.label} before using MCP ${feature}. Current state: ${status?.state || 'stopped'}.${suffix}`;
    render();
  }

  function showResourcesUnsupported(server) {
    statusMessage = `${server.label} does not expose MCP resources. Use Tools for this server instead.`;
    resourceCache.set(server.id, []);
    selectedServerId = server.id;
    selectedPanel = 'resources';
    render();
  }

  function renderListRow(title, subtitle, onClick, meta = '') {
    const row = el('button', 'ai-mcp-tool');
    row.type = 'button';
    row.disabled = busy;
    row.append(el('strong', '', title), el('span', '', subtitle || 'No description'));
    if (meta) row.appendChild(el('small', 'ai-mcp-tool-meta', meta));
    row.addEventListener('click', onClick);
    return row;
  }

  function openPanelHeader(title, count, hint) {
    const head = el('div', 'ai-mcp-list-head');
    const copy = el('div', '');
    copy.append(el('strong', '', title), el('span', '', hint));
    head.append(copy, el('span', 'ai-mcp-count-pill', String(count)));
    return head;
  }

  function promptText(title, label, value) {
    return new Promise(resolve => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        hooks.closeModal?.();
        resolve(result);
      };
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
        onClose: () => finish(''),
        footer: [
          { label: 'Cancel', onClick: () => finish('') },
          { label: 'Open', primary: true, onClick: () => finish(input.value.trim()) },
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
              const config = {
                id: fields.id.value.trim(),
                label: fields.label.value.trim(),
                command: fields.command.value.trim(),
                args: JSON.parse(fields.args.value || '[]'),
                env: JSON.parse(fields.env.value || '{}'),
                cwd: fields.cwd.value.trim(),
                enabled: server.enabled === true,
              };
              hooks.closeModal?.();
              await withBusy('Saving MCP server...', async () => {
                await window.mcp.upsertServer(config);
                await refresh();
                statusMessage = `${config.label || config.id || 'MCP server'} saved.`;
              });
            } catch (err) {
              hooks.notify?.('MCP server', err);
            }
          },
        },
      ],
    });
  }

  async function exportConfig() {
    await withBusy('Exporting MCP config...', async () => {
      const config = await window.mcp.exportConfig();
      hooks.createTextTab?.('mcp-servers.json', JSON.stringify(config, null, 2), 'json');
      statusMessage = 'MCP config exported.';
    });
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
              const raw = input.value;
              hooks.closeModal?.();
              await withBusy('Importing MCP config...', async () => {
                await window.mcp.importConfig(raw);
                await refresh();
                statusMessage = 'MCP config imported.';
              });
            } catch (err) {
              hooks.notify?.('MCP import', err);
            }
          },
        },
      ],
    });
  }

  async function runToolPrompt(server, tool) {
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} };
    const body = el('div', 'ai-settings');
    const help = el('div', 'ai-mcp-arg-help');
    help.appendChild(el('p', '', 'Arguments are sent as JSON to the MCP server after the permission prompt.'));
    for (const line of describeToolSchema(tool)) help.appendChild(el('span', '', line));
    body.appendChild(help);
    const input = document.createElement('textarea');
    input.rows = 10;
    input.value = JSON.stringify(sampleArgsFromSchema(schema), null, 2);
    const row = el('label', 'ai-settings-row');
    row.append(el('span', '', 'Arguments JSON'), input);
    body.appendChild(row);
    const details = document.createElement('details');
    details.className = 'ai-mcp-schema';
    details.appendChild(el('summary', '', 'Input schema'));
    const pre = document.createElement('pre');
    pre.textContent = shortJson(schema, 3500);
    details.appendChild(pre);
    body.appendChild(details);
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
              if (!result) {
                render();
                return;
              }
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
    const toolsOpen = selectedServerId === server.id && selectedPanel === 'tools' && toolCache.has(server.id);
    const resourcesOpen = selectedServerId === server.id && selectedPanel === 'resources' && resourceCache.has(server.id);
    const isRunning = status.state === 'running';
    const card = el('article', `ai-mcp-card ${isRunning ? 'running' : 'stopped'} ${toolsOpen || resourcesOpen ? 'expanded' : ''}`);
    const head = el('div', 'ai-mcp-card-head');
    const title = el('div', '');
    const titleLine = el('div', 'ai-mcp-title-line');
    titleLine.append(el('strong', '', server.label), el('span', `ai-mcp-state ${isRunning ? 'running' : ''}`, status.state || 'stopped'));
    const metaLine = el('div', 'ai-mcp-meta');
    metaLine.appendChild(el('span', '', plural(status.toolCount || 0, 'tool')));
    metaLine.appendChild(el('span', '', status.resourcesUnsupported ? 'no resources API' : plural(status.resourceCount || 0, 'resource')));
    title.append(titleLine, metaLine);
    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.checked = !!server.enabled;
    enable.disabled = busy;
    enable.setAttribute('aria-label', `${server.enabled ? 'Disable' : 'Enable'} ${server.label}`);
    enable.addEventListener('change', () => toggleServer(server, enable.checked));
    const enableWrap = el('label', 'ai-mcp-enable');
    enableWrap.append(enable, el('span', '', server.enabled ? 'Enabled' : 'Enable'));
    head.append(title, enableWrap);
    card.appendChild(head);
    card.appendChild(el('p', 'ai-mcp-desc', server.description || `${server.command} ${(server.args || []).join(' ')}`));
    if (status.lastError) card.appendChild(el('pre', 'ai-mcp-error', status.lastError));
    if (status.stderr) card.appendChild(el('pre', 'ai-mcp-stderr', status.stderr));

    const actions = el('div', 'ai-mcp-actions');
    const edit = el('button', '', 'Edit');
    edit.type = 'button';
    edit.disabled = busy;
    edit.addEventListener('click', () => editServer(server));
    const tools = el('button', '', toolsOpen ? 'Hide tools' : 'Tools');
    tools.type = 'button';
    tools.classList.toggle('active', toolsOpen);
    tools.setAttribute('aria-pressed', String(toolsOpen));
    tools.setAttribute('aria-expanded', String(toolsOpen));
    tools.disabled = busy;
    tools.title = status.state === 'running' ? 'List tools exposed by this MCP server.' : 'Enable this server before listing tools.';
    tools.addEventListener('click', async () => {
      if (status.state !== 'running') {
        showServerUnavailable(server, status, 'tools');
        return;
      }
      if (toolsOpen) {
        selectedServerId = '';
        statusMessage = `${server.label}: tools hidden.`;
        render();
        return;
      }
      selectedServerId = server.id;
      selectedPanel = 'tools';
      busy = true;
      statusMessage = `Loading tools from ${server.label}...`;
      render();
      try {
        const items = await ensureTools(server.id);
        statusMessage = items.length
          ? `${server.label}: ${items.length} MCP tools available.`
          : `${server.label}: no tools reported.`;
      } catch (err) {
        toolCache.delete(server.id);
        statusMessage = `${server.label}: failed to list tools - ${err.message || String(err)}`;
        hooks.notify?.('MCP tools', err);
      } finally {
        busy = false;
        render();
      }
    });
    const resources = el('button', '', resourcesOpen ? 'Hide resources' : 'Resources');
    resources.type = 'button';
    resources.classList.toggle('active', resourcesOpen);
    resources.setAttribute('aria-pressed', String(resourcesOpen));
    resources.setAttribute('aria-expanded', String(resourcesOpen));
    resources.disabled = busy;
    resources.title = status.resourcesUnsupported
      ? 'This server does not expose MCP resources.'
      : status.state === 'running'
        ? 'List resources exposed by this MCP server.'
        : 'Enable this server before listing resources.';
    resources.addEventListener('click', async () => {
      if (status.state !== 'running') {
        showServerUnavailable(server, status, 'resources');
        return;
      }
      if (status.resourcesUnsupported) {
        showResourcesUnsupported(server);
        return;
      }
      if (resourcesOpen) {
        selectedServerId = '';
        statusMessage = `${server.label}: resources hidden.`;
        render();
        return;
      }
      selectedServerId = server.id;
      selectedPanel = 'resources';
      busy = true;
      statusMessage = `Loading resources from ${server.label}...`;
      render();
      try {
        const items = await ensureResources(server.id);
        await refresh();
        if (statuses[server.id]?.resourcesUnsupported) {
          resourceCache.set(server.id, []);
          statusMessage = `${server.label} does not expose MCP resources. Use Tools for this server instead.`;
        } else {
          statusMessage = items.length
            ? `${server.label}: ${items.length} MCP resources available.`
            : `${server.label}: no resources reported. Use Open URI if you know a resource URI.`;
        }
      } catch (err) {
        resourceCache.delete(server.id);
        statusMessage = `${server.label}: failed to list resources - ${err.message || String(err)}`;
        hooks.notify?.('MCP resources', err);
      } finally {
        busy = false;
        render();
      }
    });
    const openUri = el('button', '', 'Open URI');
    openUri.type = 'button';
    openUri.disabled = busy;
    openUri.title = status.resourcesUnsupported
      ? 'This server does not expose MCP resources.'
      : status.state === 'running' ? 'Open a resource by URI.' : 'Enable this server before opening resources.';
    openUri.addEventListener('click', () => {
      if (status.state !== 'running') {
        showServerUnavailable(server, status, 'resources');
        return;
      }
      if (status.resourcesUnsupported) {
        showResourcesUnsupported(server);
        return;
      }
      openResourcePrompt(server);
    });
    actions.append(edit, tools, resources, openUri);
    card.appendChild(actions);

    if (selectedServerId === server.id && selectedPanel === 'tools' && toolCache.has(server.id)) {
      const items = toolCache.get(server.id);
      const panelWrap = el('div', 'ai-mcp-open-panel');
      panelWrap.appendChild(openPanelHeader('Tools', items.length, 'Click a tool to inspect arguments and request permission before running it.'));
      const list = el('div', 'ai-mcp-tool-list');
      for (const tool of items) {
        list.appendChild(renderListRow(tool.name, tool.description || 'No description', () => runToolPrompt(server, tool), toolMeta(tool)));
      }
      if (!list.childElementCount) list.appendChild(el('div', 'ai-mcp-empty', 'No tools reported.'));
      panelWrap.appendChild(list);
      card.appendChild(panelWrap);
    }
    if (selectedServerId === server.id && selectedPanel === 'resources' && resourceCache.has(server.id)) {
      const items = resourceCache.get(server.id);
      const panelWrap = el('div', 'ai-mcp-open-panel');
      panelWrap.appendChild(openPanelHeader('Resources', items.length, 'Open a listed resource, or use Open URI if you already know the URI.'));
      const list = el('div', 'ai-mcp-tool-list');
      for (const resource of items) {
        list.appendChild(renderListRow(resource.name || resource.uri, resource.description || resource.uri, () => openResource(server, resource)));
      }
      if (!list.childElementCount) list.appendChild(el('div', 'ai-mcp-empty', 'No resources reported. Use Open URI if you know a resource URI.'));
      panelWrap.appendChild(list);
      card.appendChild(panelWrap);
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
    title.appendChild(el('span', '', 'Enable a server, then open Tools or Resources. Tool calls always require permission.'));
    const buttons = el('div', 'ai-mcp-actions');
    for (const [label, fn] of [
      ['Refresh', async () => withBusy('Refreshing MCP servers...', async () => {
        await refresh();
        statusMessage = 'MCP server status refreshed.';
      })],
      ['Add', () => editServer()],
      ['Export', exportConfig],
      ['Import', importConfig],
    ]) {
      const btn = el('button', '', label);
      btn.type = 'button';
      btn.disabled = busy;
      btn.addEventListener('click', () => {
        const result = fn();
        if (result?.catch) result.catch(err => hooks.notify?.('MCP', err));
      });
      buttons.appendChild(btn);
    }
    head.append(title, buttons);
    panel.appendChild(head);
    const status = statusNode();
    if (status) panel.appendChild(status);
    if (!servers.length) {
      const empty = el('div', 'ai-empty');
      empty.innerHTML = '<strong>No MCP servers configured.</strong><span>Add a server or import an MCP config to get started.</span>';
      panel.appendChild(empty);
    }
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
