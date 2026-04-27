const { Client } = require('@modelcontextprotocol/sdk/client');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { version } = require('../../../package.json');

function errorMessage(err) {
  return err?.message || String(err);
}

function compactStderr(chunks) {
  return chunks.join('').slice(-4000);
}

function isMethodNotFound(err) {
  let current = err;
  while (current) {
    if (current.code === -32601) return true;
    const message = String(current.message || '');
    if (message.includes('-32601') || message.toLowerCase().includes('method not found')) return true;
    current = current.cause;
  }
  return false;
}

class McpClientPool {
  constructor({ registry }) {
    this.registry = registry;
    this.entries = new Map();
  }

  statusFor(id) {
    const entry = this.entries.get(id);
    if (!entry) return { state: 'stopped' };
    return {
      state: entry.state,
      lastError: entry.lastError || '',
      stderr: compactStderr(entry.stderr || []),
      pid: entry.transport?.pid || null,
      toolCount: entry.tools?.length || 0,
      resourceCount: entry.resources?.length || 0,
      resourcesUnsupported: entry.resourcesUnsupported === true,
      startedAt: entry.startedAt || null,
    };
  }

  statusesFor(servers) {
    const statuses = {};
    for (const server of servers) statuses[server.id] = this.statusFor(server.id);
    return statuses;
  }

  async enable(server, workspacePath) {
    await this.disable(server.id);
    const resolved = this.registry.resolveServer(server, workspacePath);
    const entry = {
      server: resolved,
      state: 'connecting',
      lastError: '',
      stderr: [],
      tools: [],
      resources: [],
      resourcesUnsupported: false,
      startedAt: new Date().toISOString(),
    };
    this.entries.set(server.id, entry);

    try {
      const transport = new StdioClientTransport({
        command: resolved.command,
        args: resolved.args,
        cwd: resolved.cwd,
        env: { ...getDefaultEnvironment(), ...resolved.env },
        stderr: 'pipe',
      });
      entry.transport = transport;
      if (transport.stderr) {
        transport.stderr.on('data', chunk => {
          entry.stderr.push(Buffer.from(chunk).toString('utf-8'));
          if (entry.stderr.length > 30) entry.stderr.splice(0, entry.stderr.length - 30);
        });
      }
      transport.onerror = (err) => {
        entry.lastError = errorMessage(err);
        if (entry.state !== 'stopped') entry.state = 'error';
      };
      transport.onclose = () => {
        if (entry.state !== 'stopped') entry.state = entry.lastError ? 'error' : 'stopped';
      };

      const client = new Client(
        { name: 'orpad', version },
        { capabilities: {} }
      );
      entry.client = client;
      await client.connect(transport);
      entry.state = 'running';
      await this.refreshMetadata(server.id);
      return this.statusFor(server.id);
    } catch (err) {
      entry.state = 'error';
      entry.lastError = errorMessage(err);
      throw err;
    }
  }

  async disable(id) {
    const entry = this.entries.get(id);
    if (!entry) return { state: 'stopped' };
    entry.state = 'stopped';
    try {
      if (entry.client?.close) await entry.client.close();
      else if (entry.transport?.close) await entry.transport.close();
    } catch (err) {
      entry.lastError = errorMessage(err);
    }
    this.entries.delete(id);
    return { state: 'stopped' };
  }

  requireRunning(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'running' || !entry.client) {
      throw new Error(`MCP server is not running: ${id}`);
    }
    return entry;
  }

  async refreshMetadata(id) {
    const entry = this.requireRunning(id);
    try {
      const toolResult = await entry.client.listTools();
      entry.tools = toolResult?.tools || [];
    } catch {
      entry.tools = [];
    }
    try {
      const resourceResult = await entry.client.listResources();
      entry.resources = resourceResult?.resources || [];
      entry.resourcesUnsupported = false;
    } catch (err) {
      entry.resources = [];
      entry.resourcesUnsupported = isMethodNotFound(err);
    }
    return this.statusFor(id);
  }

  async listTools(id) {
    const entry = this.requireRunning(id);
    const result = await entry.client.listTools();
    entry.tools = result?.tools || [];
    return entry.tools;
  }

  async listResources(id) {
    const entry = this.requireRunning(id);
    try {
      const result = await entry.client.listResources();
      entry.resources = result?.resources || [];
      entry.resourcesUnsupported = false;
    } catch (err) {
      entry.resources = [];
      if (!isMethodNotFound(err)) throw err;
      entry.resourcesUnsupported = true;
    }
    return entry.resources;
  }

  async readResource(id, uri) {
    const entry = this.requireRunning(id);
    try {
      return await entry.client.readResource({ uri });
    } catch (err) {
      if (isMethodNotFound(err)) {
        entry.resourcesUnsupported = true;
        throw new Error(`${entry.server.label || id} does not expose MCP resources.`);
      }
      throw err;
    }
  }

  async callTool(id, name, args) {
    const entry = this.requireRunning(id);
    return entry.client.callTool({
      name,
      arguments: args && typeof args === 'object' ? args : {},
    });
  }
}

module.exports = {
  McpClientPool,
};
