const path = require('path');

function normalizeForCompare(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsidePath(child, parent) {
  if (!child || !parent) return false;
  const resolvedChild = normalizeForCompare(child);
  const resolvedParent = normalizeForCompare(parent);
  if (resolvedChild === resolvedParent) return true;
  const rel = path.relative(resolvedParent, resolvedChild);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function senderId(senderOrEvent) {
  const sender = senderOrEvent?.sender || senderOrEvent?.webContents || senderOrEvent;
  return sender?.id || null;
}

function createAuthorityManager() {
  const entries = new Map();

  function entryFor(senderOrEvent) {
    const id = senderId(senderOrEvent);
    if (!id) throw new Error('Renderer authority is unavailable.');
    if (!entries.has(id)) {
      entries.set(id, {
        workspaceRoot: '',
        files: new Set(),
      });
    }
    return entries.get(id);
  }

  function grantWorkspace(senderOrEvent, dirPath) {
    if (!dirPath) return '';
    const root = path.resolve(String(dirPath));
    const entry = entryFor(senderOrEvent);
    entry.workspaceRoot = root;
    return root;
  }

  function grantFile(senderOrEvent, filePath) {
    if (!filePath) return '';
    const resolved = path.resolve(String(filePath));
    entryFor(senderOrEvent).files.add(normalizeForCompare(resolved));
    return resolved;
  }

  function getWorkspaceRoot(senderOrEvent) {
    const id = senderId(senderOrEvent);
    if (!id) return '';
    return entries.get(id)?.workspaceRoot || '';
  }

  function isGrantedFile(senderOrEvent, filePath) {
    const id = senderId(senderOrEvent);
    if (!id || !filePath) return false;
    return entries.get(id)?.files.has(normalizeForCompare(filePath)) === true;
  }

  function isInWorkspace(senderOrEvent, targetPath, { checkParent = false } = {}) {
    const workspaceRoot = getWorkspaceRoot(senderOrEvent);
    if (!workspaceRoot || !targetPath) return false;
    const candidate = checkParent ? path.dirname(path.resolve(String(targetPath))) : path.resolve(String(targetPath));
    return isInsidePath(candidate, workspaceRoot);
  }

  function assertWorkspacePath(senderOrEvent, targetPath, options = {}) {
    const {
      label = 'Path',
      allowFileCapability = false,
      checkParent = false,
    } = options;
    if (!targetPath) throw new Error(`${label} is required.`);
    const resolved = path.resolve(String(targetPath));
    if (isInWorkspace(senderOrEvent, resolved, { checkParent })) return resolved;
    if (!checkParent && allowFileCapability && isGrantedFile(senderOrEvent, resolved)) return resolved;
    const workspaceRoot = getWorkspaceRoot(senderOrEvent);
    const scope = workspaceRoot ? `workspace ${workspaceRoot}` : 'the approved workspace';
    throw new Error(`${label} is outside ${scope}.`);
  }

  function forget(senderOrEvent) {
    const id = senderId(senderOrEvent);
    if (id) entries.delete(id);
  }

  return {
    grantWorkspace,
    grantFile,
    getWorkspaceRoot,
    isGrantedFile,
    isInWorkspace,
    assertWorkspacePath,
    forget,
  };
}

module.exports = {
  createAuthorityManager,
  isInsidePath,
  normalizeForCompare,
};
