const fs = require('fs').promises;
const path = require('path');

const ID_RE = /^[a-z0-9_-]{1,80}$/i;

function requireWorkspace(workspacePath) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    throw new Error('Workspace is required');
  }
  return path.resolve(workspacePath);
}

function conversationDir(workspacePath) {
  return path.join(requireWorkspace(workspacePath), '.formatpad', 'conversations');
}

function workspaceForEvent(event, workspacePath, authority) {
  if (authority) {
    const requested = workspacePath || authority.getWorkspaceRoot(event.sender);
    return authority.assertWorkspacePath(event.sender, requested, { label: 'Conversation workspace' });
  }
  return requireWorkspace(workspacePath);
}

function safeConversationPath(workspacePath, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid conversation id');
  const dir = conversationDir(workspacePath);
  const filePath = path.resolve(dir, `${id}.json`);
  const rel = path.relative(dir, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid conversation path');
  return filePath;
}

function summarize(conv, fallbackId, mtimeMs = 0) {
  return {
    id: conv?.id || fallbackId,
    title: conv?.title || 'New chat',
    updatedAt: conv?.updatedAt || (mtimeMs ? new Date(mtimeMs).toISOString() : null),
    messageCount: Array.isArray(conv?.messages) ? conv.messages.length : 0,
  };
}

async function listConversations(workspacePath) {
  const dir = conversationDir(workspacePath);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    try {
      const filePath = path.join(dir, entry.name);
      const [raw, stat] = await Promise.all([fs.readFile(filePath, 'utf-8'), fs.stat(filePath)]);
      items.push(summarize(JSON.parse(raw), id, stat.mtimeMs));
    } catch {
      items.push({ id, title: id, updatedAt: null, messageCount: 0 });
    }
  }
  return items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function normalizeConversation(conv) {
  if (!conv || typeof conv !== 'object') throw new Error('Conversation payload is required');
  if (typeof conv.id !== 'string' || !ID_RE.test(conv.id)) throw new Error('Invalid conversation id');
  return {
    id: conv.id,
    title: String(conv.title || 'New chat').slice(0, 120),
    createdAt: conv.createdAt || new Date().toISOString(),
    updatedAt: conv.updatedAt || new Date().toISOString(),
    provider: conv.provider || '',
    model: conv.model || '',
    messages: Array.isArray(conv.messages) ? conv.messages.slice(0, 200) : [],
  };
}

function registerAiConversationHandlers({ ipcMain, authority }) {
  ipcMain.handle('ai-conversations-list', async (event, workspacePath) => {
    try {
      const workspace = workspaceForEvent(event, workspacePath, authority);
      return { conversations: await listConversations(workspace) };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai-conversation-load', async (event, workspacePath, id) => {
    try {
      const workspace = workspaceForEvent(event, workspacePath, authority);
      const raw = await fs.readFile(safeConversationPath(workspace, id), 'utf-8');
      return { conversation: JSON.parse(raw) };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai-conversation-save', async (event, workspacePath, conv) => {
    try {
      const workspace = workspaceForEvent(event, workspacePath, authority);
      const normalized = normalizeConversation(conv);
      const filePath = safeConversationPath(workspace, normalized.id);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf-8');
      return { success: true, conversation: summarize(normalized, normalized.id) };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai-conversation-delete', async (event, workspacePath, id) => {
    try {
      const workspace = workspaceForEvent(event, workspacePath, authority);
      await fs.rm(safeConversationPath(workspace, id), { force: true });
      return { success: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai-conversations-search', async (event, workspacePath, query) => {
    try {
      const workspace = workspaceForEvent(event, workspacePath, authority);
      const q = String(query || '').toLowerCase();
      const summaries = await listConversations(workspace);
      if (!q) return { conversations: summaries };
      const matched = [];
      for (const item of summaries) {
        const raw = await fs.readFile(safeConversationPath(workspace, item.id), 'utf-8');
        if (raw.toLowerCase().includes(q)) matched.push(item);
      }
      return { conversations: matched };
    } catch (err) {
      return { error: err.message };
    }
  });
}

module.exports = { registerAiConversationHandlers };
