const { BrowserWindow, dialog } = require('electron');
const { McpRegistry, REDACTED_ENV_VALUE } = require('./registry');
const { McpClientPool } = require('./client');
const { McpPermissions } = require('./permissions');

function normalizeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  return JSON.parse(JSON.stringify(args));
}

function redactEnv(env) {
  const redacted = {};
  for (const [key, value] of Object.entries(env || {})) {
    redacted[key] = value ? REDACTED_ENV_VALUE : '';
  }
  return redacted;
}

function publicServer(server) {
  return {
    id: server.id,
    label: server.label,
    transport: server.transport,
    enabled: server.enabled,
    command: server.command,
    args: server.args,
    env: redactEnv(server.env),
    cwd: server.cwd,
    description: server.description,
    readOnlyDefault: server.readOnlyDefault,
  };
}

function redactedConfig(config) {
  return {
    ...config,
    servers: (config.servers || []).map(publicServer),
  };
}

async function listServersWithRuntimeEnabledState(registry, clients) {
  const servers = await registry.listServers();
  let changed = false;
  const normalized = servers.map(server => {
    const status = clients.statusFor(server.id);
    const isRuntimeEnabled = status.state === 'running' || status.state === 'connecting';
    if (server.enabled && !isRuntimeEnabled) {
      changed = true;
      return { ...server, enabled: false };
    }
    return server;
  });
  return changed ? registry.saveServers(normalized) : servers;
}

function shortJson(value, max = 4000) {
  const text = JSON.stringify(value || {}, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

async function promptForToolPermission(event, registry, permissions, serverId, toolName, args) {
  const desc = await permissions.describe(serverId, toolName);
  if (!desc.required) return { scope: 'existing' };

  const server = await registry.getServer(serverId);
  const buttons = ['Cancel', 'Allow once'];
  const scopes = [null, 'once'];
  if (desc.canPersistGlobal) {
    buttons.push('Allow session', 'Always allow read-only');
    scopes.push('session', 'global');
  }

  const parent = BrowserWindow.fromWebContents(event.sender);
  const options = {
    type: desc.readOnly ? 'question' : 'warning',
    title: 'MCP permission required',
    message: `Allow MCP tool call: ${(server?.label || serverId)} / ${toolName}`,
    detail: `${desc.readOnly
      ? 'This tool name looks read-only.'
      : 'This tool may mutate data. OrPAD will not persist this permission.'}\n\nArguments:\n${shortJson(args)}`,
    buttons,
    cancelId: 0,
    defaultId: 1,
    noLink: true,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);

  const scope = scopes[result.response] || null;
  if (!scope) return { scope: 'canceled', canceled: true };
  if (scope !== 'once') await permissions.grant(serverId, toolName, scope);
  return { scope };
}

function canceledToolResult() {
  return {
    canceled: true,
    content: [{ type: 'text', text: 'MCP tool call canceled.' }],
  };
}

function registerMcpHandlers({ ipcMain, app, authority }) {
  const registry = new McpRegistry({ app });
  const permissions = new McpPermissions({ app });
  const clients = new McpClientPool({ registry });

  ipcMain.handle('mcp-list-servers', async () => {
    const servers = await listServersWithRuntimeEnabledState(registry, clients);
    return {
      servers: servers.map(publicServer),
      statuses: clients.statusesFor(servers),
    };
  });

  ipcMain.handle('mcp-upsert-server', async (_event, server) => {
    const saved = await registry.upsertServer(server || {});
    return publicServer(saved);
  });

  ipcMain.handle('mcp-remove-server', async (_event, id) => {
    await clients.disable(String(id || ''));
    const servers = await registry.removeServer(String(id || ''));
    return servers.map(publicServer);
  });

  ipcMain.handle('mcp-set-enabled', async (event, id, enabled) => {
    const serverId = String(id || '');
    if (enabled === true) {
      const server = await registry.getServer(serverId);
      if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
      const workspaceRoot = authority?.getWorkspaceRoot(event.sender) || '';
      if (!workspaceRoot) throw new Error('Open a workspace before enabling MCP servers.');
      try {
        await clients.enable(server, workspaceRoot);
        const saved = await registry.setEnabled(serverId, true);
        const servers = await registry.listServers();
        return {
          server: publicServer(saved),
          statuses: clients.statusesFor(servers),
        };
      } catch (err) {
        await clients.disable(serverId).catch(() => {});
        await registry.setEnabled(serverId, false).catch(() => {});
        throw err;
      }
    }

    const server = await registry.setEnabled(serverId, false);
    await clients.disable(server.id);
    const servers = await registry.listServers();
    return {
      server: publicServer(server),
      statuses: clients.statusesFor(servers),
    };
  });

  ipcMain.handle('mcp-refresh-server', async (_event, id) => {
    return clients.refreshMetadata(String(id || ''));
  });

  ipcMain.handle('mcp-list-tools', async (_event, id) => {
    return clients.listTools(String(id || ''));
  });

  ipcMain.handle('mcp-list-resources', async (_event, id) => {
    return clients.listResources(String(id || ''));
  });

  ipcMain.handle('mcp-read-resource', async (_event, id, uri) => {
    if (!uri) throw new Error('MCP resource URI is required.');
    return clients.readResource(String(id || ''), String(uri));
  });

  ipcMain.handle('mcp-prepare-tool-call', async (_event, serverId, toolName) => {
    if (!serverId || !toolName) throw new Error('MCP server and tool are required.');
    return permissions.prepare(String(serverId), String(toolName));
  });

  ipcMain.handle('mcp-grant-permission', async () => {
    throw new Error('MCP permissions are granted by the main process during tool execution.');
  });

  ipcMain.handle('mcp-revoke-global-permission', async (_event, serverId, toolName) => {
    return permissions.revokeGlobal(String(serverId || ''), String(toolName || ''));
  });

  ipcMain.handle('mcp-call-tool', async (event, serverId, toolName, args) => {
    const sid = String(serverId || '');
    const name = String(toolName || '');
    if (!sid || !name) throw new Error('MCP server and tool are required.');
    const normalizedArgs = normalizeArgs(args);

    const alreadyAllowed = await permissions.hasPermission(sid, name);
    if (!alreadyAllowed) {
      const permission = await promptForToolPermission(event, registry, permissions, sid, name, normalizedArgs);
      if (permission?.canceled) return canceledToolResult();
    }

    return clients.callTool(sid, name, normalizedArgs);
  });

  ipcMain.handle('mcp-export-config', async () => {
    return redactedConfig(await registry.exportConfig());
  });

  ipcMain.handle('mcp-import-config', async (_event, config) => {
    const servers = await registry.importConfig(config);
    return servers.map(publicServer);
  });

  app.on('before-quit', () => {
    for (const id of Array.from(clients.entries.keys())) {
      clients.disable(id).catch(() => {});
    }
  });
}

module.exports = {
  registerMcpHandlers,
};
