const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const crypto = require('crypto');
const { DEFAULT_MCP_SERVERS, PINNED_MCP_PACKAGES } = require('./defaults');

const REDACTED_ENV_VALUE = '<redacted>';

function stableId(value) {
  const base = String(value || 'server').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = crypto.createHash('sha256').update(String(value || Date.now())).digest('hex').slice(0, 8);
  return `${base || 'server'}-${suffix}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item)).filter(Boolean);
}

function normalizeEnv(value, previousEnv = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const env = {};
  for (const [key, val] of Object.entries(value)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      const next = String(val ?? '');
      env[key] = next === REDACTED_ENV_VALUE ? String(previousEnv[key] ?? '') : next;
    }
  }
  return env;
}

function normalizeServer(server, previous = null) {
  const label = String(server?.label || server?.id || 'MCP server').trim();
  return {
    id: String(server?.id || stableId(label)).replace(/[^A-Za-z0-9_-]/g, '-'),
    label,
    transport: server?.transport === 'stdio' ? 'stdio' : 'stdio',
    enabled: server?.enabled === true,
    command: String(server?.command || '').trim(),
    args: normalizeStringArray(server?.args),
    env: normalizeEnv(server?.env, previous?.env || {}),
    cwd: typeof server?.cwd === 'string' ? server.cwd : '',
    description: typeof server?.description === 'string' ? server.description : '',
    readOnlyDefault: server?.readOnlyDefault === true,
  };
}

function mergeDefaults(servers) {
  const byId = new Map((servers || []).map(item => [item.id, item]));
  const merged = [];
  for (const item of DEFAULT_MCP_SERVERS) {
    const existing = byId.get(item.id);
    merged.push(normalizeServer(existing ? { ...item, ...existing } : item));
    byId.delete(item.id);
  }
  for (const item of byId.values()) merged.push(normalizeServer(item));
  return merged;
}

function template(value, context) {
  let next = String(value || '');
  next = next
    .replace(/\$\{workspacePath\}/g, context.workspacePath || context.userDataPath)
    .replace(/\$\{userData\}/g, context.userDataPath)
    .replace(/\$\{home\}/g, os.homedir());
  next = next.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => process.env[name] || '');
  next = next.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => process.env[name] || '');
  return next;
}

class McpRegistry {
  constructor({ app }) {
    this.app = app;
    this.configPath = path.join(app.getPath('userData'), 'mcp-servers.json');
  }

  async readRaw() {
    try {
      const raw = await fsp.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.servers) ? parsed.servers : [];
    } catch {
      return [];
    }
  }

  async listServers() {
    return mergeDefaults((await this.readRaw()).map(normalizeServer));
  }

  async saveServers(servers) {
    const normalized = mergeDefaults((servers || []).map(normalizeServer));
    await fsp.mkdir(path.dirname(this.configPath), { recursive: true });
    await fsp.writeFile(this.configPath, JSON.stringify({
      version: 1,
      pinnedPackages: PINNED_MCP_PACKAGES,
      servers: normalized,
    }, null, 2), 'utf-8');
    return normalized;
  }

  async getServer(id) {
    const servers = await this.listServers();
    return servers.find(server => server.id === id) || null;
  }

  async upsertServer(input) {
    const servers = await this.listServers();
    const inputId = String(input?.id || '').replace(/[^A-Za-z0-9_-]/g, '-');
    const existing = inputId ? servers.find(item => item.id === inputId) : null;
    const server = normalizeServer(input, existing);
    if (!server.command) throw new Error('MCP server command is required.');
    const index = servers.findIndex(item => item.id === server.id);
    if (index >= 0) servers[index] = { ...servers[index], ...server };
    else servers.push(server);
    await this.saveServers(servers);
    return server;
  }

  async removeServer(id) {
    if (DEFAULT_MCP_SERVERS.some(server => server.id === id)) {
      throw new Error('Default MCP servers can be disabled but not removed.');
    }
    const servers = (await this.listServers()).filter(server => server.id !== id);
    await this.saveServers(servers);
    return servers;
  }

  async setEnabled(id, enabled) {
    const servers = await this.listServers();
    const server = servers.find(item => item.id === id);
    if (!server) throw new Error(`Unknown MCP server: ${id}`);
    server.enabled = enabled === true;
    await this.saveServers(servers);
    return server;
  }

  async importConfig(config) {
    const parsed = typeof config === 'string' ? JSON.parse(config) : config;
    if (!parsed || !Array.isArray(parsed.servers)) throw new Error('Invalid MCP config: expected { servers: [] }.');
    return this.saveServers(parsed.servers);
  }

  async exportConfig() {
    return {
      version: 1,
      pinnedPackages: PINNED_MCP_PACKAGES,
      servers: await this.listServers(),
    };
  }

  resolveServer(server, workspacePath) {
    const context = {
      workspacePath: workspacePath || this.app.getPath('documents'),
      userDataPath: this.app.getPath('userData'),
    };
    const command = process.platform === 'win32' && server.command === 'npx' ? 'npx.cmd' : template(server.command, context);
    const env = {};
    for (const [key, value] of Object.entries(server.env || {})) {
      const next = template(value, context);
      if (next) env[key] = next;
    }
    return {
      ...server,
      command,
      args: (server.args || []).map(arg => template(arg, context)).filter(Boolean),
      cwd: server.cwd ? template(server.cwd, context) : context.workspacePath,
      env,
    };
  }

  ensureConfigDirSync() {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
  }
}

module.exports = {
  McpRegistry,
  mergeDefaults,
  normalizeServer,
  REDACTED_ENV_VALUE,
};
