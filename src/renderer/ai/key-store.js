import { confirmWebKeyStorage } from './key-warning.js';

const DB_NAME = 'orpad-ai';
const DB_VERSION = 2;
const STORE = 'keys';
const PROVIDERS = ['openai', 'anthropic', 'openrouter', 'openai-compatible'];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'provider' });
      if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
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

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function keyMask(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return '';
  const prefix = trimmed.startsWith('sk-') ? 'sk-' : trimmed.slice(0, Math.min(3, trimmed.length));
  return `${prefix}****${trimmed.slice(-4)}`;
}

function webStatusFromRows(rows) {
  const ids = new Set([...PROVIDERS, ...rows.map(row => row.provider)]);
  const providers = {};
  for (const id of ids) {
    const row = rows.find(item => item.provider === id);
    providers[id] = {
      hasKey: !!row?.key,
      mask: row?.mask || '',
      updatedAt: row?.updatedAt || null,
    };
  }
  return { encryptionAvailable: false, webStorage: true, providers };
}

async function webStatus() {
  const rows = await withStore('readonly', store => requestToPromise(store.getAll()));
  return webStatusFromRows(rows || []);
}

function createWebKeyStore() {
  return {
    async status() {
      return webStatus();
    },
    async set(provider, key) {
      const ok = await confirmWebKeyStorage();
      if (!ok) return { error: 'Canceled' };
      const row = {
        provider,
        key: String(key || '').trim(),
        mask: keyMask(key),
        updatedAt: new Date().toISOString(),
      };
      await withStore('readwrite', store => store.put(row));
      return { success: true, providers: (await webStatus()).providers };
    },
    async getDecrypted(provider) {
      const row = await withStore('readonly', store => requestToPromise(store.get(provider)));
      return { key: row?.key || '' };
    },
    async remove(provider) {
      await withStore('readwrite', store => store.delete(provider));
      return { success: true, providers: (await webStatus()).providers };
    },
  };
}

function createDesktopKeyStore() {
  async function* chat(request) {
    if (!window.orpad?.aiChat) throw new Error('Desktop AI proxy is unavailable.');
    const requestId = crypto.randomUUID?.() || `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const queue = [];
    let wake = null;
    let stopped = false;
    const notify = () => {
      if (wake) {
        wake();
        wake = null;
      }
    };
    const off = window.orpad.aiChat.onEvent((event) => {
      if (event?.requestId !== requestId) return;
      queue.push(event);
      notify();
    });
    const abort = () => {
      window.orpad.aiChat.cancel(requestId).catch(() => {});
      queue.push({ requestId, type: 'error', message: 'AI request canceled.' });
      notify();
    };
    request.abortSignal?.addEventListener('abort', abort, { once: true });

    try {
      const started = await window.orpad.aiChat.start({
        ...request,
        requestId,
      });
      if (started?.error) throw new Error(started.error);

      while (!stopped) {
        if (!queue.length) {
          await new Promise(resolve => { wake = resolve; });
        }
        while (queue.length) {
          const event = queue.shift();
          if (event.type === 'done') {
            stopped = true;
            break;
          }
          if (event.type === 'error') throw new Error(event.message || 'AI provider request failed.');
          yield event;
        }
      }
    } finally {
      request.abortSignal?.removeEventListener('abort', abort);
      off?.();
      if (!stopped) window.orpad.aiChat.cancel(requestId).catch(() => {});
    }
  }

  return {
    status: () => window.orpad.aiKeys.status(),
    set: (provider, key, metadata) => window.orpad.aiKeys.set(provider, key, metadata),
    remove: (provider) => window.orpad.aiKeys.remove(provider),
    chat,
    desktopProxy: true,
  };
}

export function createAIKeyStore() {
  if (window.orpad?.aiKeys && window.orpad?.platform !== 'web') {
    return createDesktopKeyStore();
  }
  return createWebKeyStore();
}
