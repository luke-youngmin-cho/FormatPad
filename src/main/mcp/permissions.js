const path = require('path');
const fsp = require('fs').promises;

const READ_ONLY_TOOL_RE = /^(list|get|read|search|query)_/i;

function permissionKey(serverId, toolName) {
  return `${serverId}:${toolName}`;
}

function isReadOnlyTool(toolName) {
  return READ_ONLY_TOOL_RE.test(String(toolName || ''));
}

class McpPermissions {
  constructor({ app }) {
    this.configPath = path.join(app.getPath('userData'), 'mcp-permissions.json');
    this.sessionAllowed = new Set();
  }

  async readGlobal() {
    try {
      const raw = await fsp.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : { allowed: {} };
    } catch {
      return { allowed: {} };
    }
  }

  async writeGlobal(config) {
    await fsp.mkdir(path.dirname(this.configPath), { recursive: true });
    await fsp.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  async isGloballyAllowed(serverId, toolName) {
    const config = await this.readGlobal();
    return config.allowed?.[serverId]?.[toolName] === true;
  }

  async hasPermission(serverId, toolName) {
    const key = permissionKey(serverId, toolName);
    if (this.sessionAllowed.has(key)) return true;
    return this.isGloballyAllowed(serverId, toolName);
  }

  async describe(serverId, toolName) {
    const readOnly = isReadOnlyTool(toolName);
    const globallyAllowed = await this.isGloballyAllowed(serverId, toolName);
    const sessionAllowed = this.sessionAllowed.has(permissionKey(serverId, toolName));
    return {
      serverId,
      toolName,
      required: !(globallyAllowed || sessionAllowed),
      readOnly,
      canPersistGlobal: readOnly,
      globallyAllowed,
      sessionAllowed,
    };
  }

  async prepare(serverId, toolName) {
    const desc = await this.describe(serverId, toolName);
    if (!desc.required) return { ...desc, allowed: true };
    return { ...desc, allowed: false };
  }

  async grant(serverId, toolName, scope) {
    const nextScope = scope || 'once';
    if (nextScope === 'once') return { scope: 'once' };
    const key = permissionKey(serverId, toolName);
    if (nextScope === 'session') {
      if (!isReadOnlyTool(toolName)) {
        throw new Error('Session MCP permission can only be saved for read-only tool names.');
      }
      this.sessionAllowed.add(key);
      return { scope: 'session' };
    }
    if (nextScope === 'global') {
      if (!isReadOnlyTool(toolName)) {
        throw new Error('Global MCP permission can only be saved for read-only tool names.');
      }
      const config = await this.readGlobal();
      if (!config.allowed) config.allowed = {};
      if (!config.allowed[serverId]) config.allowed[serverId] = {};
      config.allowed[serverId][toolName] = true;
      await this.writeGlobal(config);
      return { scope: 'global' };
    }
    throw new Error(`Unknown MCP permission scope: ${nextScope}`);
  }

  async revokeGlobal(serverId, toolName) {
    const config = await this.readGlobal();
    if (config.allowed?.[serverId]) {
      delete config.allowed[serverId][toolName];
      if (Object.keys(config.allowed[serverId]).length === 0) delete config.allowed[serverId];
      await this.writeGlobal(config);
    }
    return true;
  }
}

module.exports = {
  McpPermissions,
  isReadOnlyTool,
};
