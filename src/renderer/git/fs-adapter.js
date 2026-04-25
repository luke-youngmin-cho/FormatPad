import LightningFS from '@isomorphic-git/lightning-fs';

let cachedFs = null;

function notFound(path) {
  const err = new Error(`ENOENT: no such file or directory, ${path}`);
  err.code = 'ENOENT';
  return err;
}

function reviveStat(raw) {
  if (!raw) throw notFound('');
  const type = raw.type || (raw.isDirectory ? 'dir' : 'file');
  return {
    type,
    mode: raw.mode || (type === 'dir' ? 0o040000 : 0o100644),
    size: raw.size || 0,
    mtimeMs: raw.mtimeMs || 0,
    ctimeMs: raw.ctimeMs || raw.mtimeMs || 0,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => type === 'symlink',
  };
}

function reviveDirent(entry) {
  if (!entry || typeof entry === 'string') return entry;
  const type = entry.type || (entry.isDirectory ? 'dir' : 'file');
  return {
    name: entry.name,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => type === 'symlink',
  };
}

function normalizeReadResult(value, options) {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  if (encoding) return typeof value === 'string' ? value : new TextDecoder().decode(value);
  if (value instanceof Uint8Array) return value;
  if (value?.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer);
  return new TextEncoder().encode(String(value ?? ''));
}

function bridgeFs(api) {
  return {
    promises: {
      async readFile(path, options) {
        const value = await api.readFile(String(path), options || null);
        if (value == null || value?.error) throw notFound(path);
        return normalizeReadResult(value, options);
      },
      async writeFile(path, data, options) {
        const result = await api.writeFile(String(path), data, options || null);
        if (result?.error) throw new Error(result.error);
      },
      async unlink(path) {
        const result = await api.unlink(String(path));
        if (result?.error) throw new Error(result.error);
      },
      async readdir(path, options) {
        const result = await api.readdir(String(path), options || null);
        if (result?.error) throw notFound(path);
        return options?.withFileTypes ? result.map(reviveDirent) : result;
      },
      async mkdir(path, options) {
        const result = await api.mkdir(String(path), options || null);
        if (result?.error && result.error !== 'EEXIST') throw new Error(result.error);
      },
      async rmdir(path) {
        const result = await api.rmdir(String(path));
        if (result?.error) throw new Error(result.error);
      },
      async stat(path) {
        const result = await api.stat(String(path));
        if (result?.error) throw notFound(path);
        return reviveStat(result);
      },
      async lstat(path) {
        const result = await api.lstat(String(path));
        if (result?.error) throw notFound(path);
        return reviveStat(result);
      },
      async readlink(path) {
        throw notFound(path);
      },
      async symlink() {
        const err = new Error('Symlink is not supported by FormatPad git fs');
        err.code = 'ENOSYS';
        throw err;
      },
    },
  };
}

export async function getFs() {
  if (cachedFs) return cachedFs;
  if (window.formatpad?.gitFs) {
    cachedFs = bridgeFs(window.formatpad.gitFs);
    return cachedFs;
  }
  const fs = new LightningFS('formatpad-git-cache', { wipe: false });
  cachedFs = fs;
  return cachedFs;
}
