const DB_NAME = 'formatpad-ai';
const DB_VERSION = 2;
const STORE = 'conversations';

function uid() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'provider' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (err) { reject(err); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  } finally {
    db.close();
  }
}

function workspaceKey(workspacePath) {
  return workspacePath || 'default';
}

function normalizeConversation(conv) {
  const now = new Date().toISOString();
  return {
    id: conv.id || uid(),
    title: conv.title || 'New chat',
    createdAt: conv.createdAt || now,
    updatedAt: conv.updatedAt || now,
    provider: conv.provider || '',
    model: conv.model || '',
    messages: Array.isArray(conv.messages) ? conv.messages : [],
  };
}

function toSummary(conv) {
  return {
    id: conv.id,
    title: conv.title || 'New chat',
    updatedAt: conv.updatedAt || null,
    messageCount: conv.messages?.length || 0,
  };
}

async function webList(workspacePath) {
  const ws = workspaceKey(workspacePath);
  const rows = await withStore('readonly', store => reqPromise(store.getAll()));
  return (rows || [])
    .filter(row => row.workspace === ws)
    .map(row => toSummary(row.conversation))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function webSave(workspacePath, conv) {
  const ws = workspaceKey(workspacePath);
  const conversation = normalizeConversation({ ...conv, updatedAt: new Date().toISOString() });
  await withStore('readwrite', store => store.put({ key: `${ws}:${conversation.id}`, workspace: ws, conversation }));
  return toSummary(conversation);
}

async function webLoad(workspacePath, id) {
  const ws = workspaceKey(workspacePath);
  const row = await withStore('readonly', store => reqPromise(store.get(`${ws}:${id}`)));
  return row?.conversation || null;
}

async function webSearch(workspacePath, query) {
  const q = String(query || '').toLowerCase();
  const ws = workspaceKey(workspacePath);
  const rows = await withStore('readonly', store => reqPromise(store.getAll()));
  return (rows || [])
    .filter(row => row.workspace === ws)
    .filter(row => !q || JSON.stringify(row.conversation).toLowerCase().includes(q))
    .map(row => toSummary(row.conversation));
}

export function createConversationStore({ getWorkspacePath }) {
  const hasDesktopStore = !!window.formatpad?.aiConversations && window.formatpad?.platform !== 'web';

  return {
    create(title = 'New chat') {
      return normalizeConversation({ id: uid(), title, messages: [] });
    },
    async list() {
      const workspacePath = getWorkspacePath?.() || null;
      if (hasDesktopStore && workspacePath) {
        const res = await window.formatpad.aiConversations.list(workspacePath);
        if (!res?.error) return res.conversations || [];
      }
      return webList(workspacePath);
    },
    async load(id) {
      const workspacePath = getWorkspacePath?.() || null;
      if (hasDesktopStore && workspacePath) {
        const res = await window.formatpad.aiConversations.load(workspacePath, id);
        if (!res?.error) return res.conversation || null;
      }
      return webLoad(workspacePath, id);
    },
    async save(conversation) {
      const workspacePath = getWorkspacePath?.() || null;
      const normalized = normalizeConversation(conversation);
      if (hasDesktopStore && workspacePath) {
        const res = await window.formatpad.aiConversations.save(workspacePath, normalized);
        if (!res?.error) return res.conversation;
      }
      return webSave(workspacePath, normalized);
    },
    async search(query) {
      const workspacePath = getWorkspacePath?.() || null;
      if (hasDesktopStore && workspacePath) {
        const res = await window.formatpad.aiConversations.search(workspacePath, query);
        if (!res?.error) return res.conversations || [];
      }
      return webSearch(workspacePath, query);
    },
  };
}
