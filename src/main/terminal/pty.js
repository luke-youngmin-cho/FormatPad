const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { filterSecrets, isInsidePath } = require('./runner');

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 28;
let ptyModule = null;
let ptyLoadError = null;

function loadPtyModule() {
  if (ptyModule) return ptyModule;
  if (ptyLoadError) throw ptyLoadError;
  try {
    ptyModule = require('@homebridge/node-pty-prebuilt-multiarch');
    return ptyModule;
  } catch (err) {
    ptyLoadError = err;
    throw err;
  }
}

function ptyAvailability() {
  try {
    loadPtyModule();
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: `Integrated terminal is unavailable on this ${process.platform}/${process.arch} build: ${err.message || err}`,
    };
  }
}

function pathExts() {
  if (process.platform !== 'win32') return [''];
  return (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function findOnPath(name) {
  if (!name) return null;
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = path.extname(name) ? [''] : pathExts();
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function existing(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function gitBashPath() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return existing([
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
    findOnPath('bash.exe'),
  ]);
}

function detectShells() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return [
      {
        id: 'powershell',
        label: 'Windows PowerShell',
        family: 'powershell',
        command: existing([
          path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          findOnPath('powershell.exe'),
        ]),
      },
      {
        id: 'cmd',
        label: 'Command Prompt',
        family: 'cmd',
        command: existing([
          process.env.ComSpec,
          path.join(systemRoot, 'System32', 'cmd.exe'),
          findOnPath('cmd.exe'),
        ]),
      },
      {
        id: 'git-bash',
        label: 'Git Bash',
        family: 'bash',
        command: gitBashPath(),
      },
      {
        id: 'wsl',
        label: 'WSL',
        family: 'wsl',
        command: existing([
          path.join(systemRoot, 'System32', 'wsl.exe'),
          findOnPath('wsl.exe'),
        ]),
      },
    ].filter(item => item.command);
  }

  if (process.platform === 'darwin') {
    return [
      { id: 'zsh', label: 'zsh', family: 'zsh', command: findOnPath('zsh') || '/bin/zsh' },
      { id: 'bash', label: 'bash', family: 'bash', command: findOnPath('bash') || '/bin/bash' },
      { id: 'fish', label: 'fish', family: 'fish', command: findOnPath('fish') },
    ].filter(item => item.command && fs.existsSync(item.command));
  }

  return [
    { id: 'bash', label: 'bash', family: 'bash', command: findOnPath('bash') || '/bin/bash' },
    { id: 'zsh', label: 'zsh', family: 'zsh', command: findOnPath('zsh') },
    { id: 'fish', label: 'fish', family: 'fish', command: findOnPath('fish') },
  ].filter(item => item.command && fs.existsSync(item.command));
}

function shellIntegrationDir() {
  return path.resolve(__dirname, '..', '..', 'renderer', 'terminal', 'shell-integration');
}

function normalizeCwd(input, workspaceRoot, allowOutsideWorkspace) {
  const cwd = path.resolve(input || os.homedir());
  if (!workspaceRoot) {
    if (allowOutsideWorkspace) return cwd;
    throw new Error('Terminal requires a workspace root, or explicit one-time outside-workspace approval.');
  }
  if (!isInsidePath(cwd, workspaceRoot)) {
    if (allowOutsideWorkspace) return cwd;
    throw new Error('Terminal working directory is outside the workspace. Confirm one-time outside-workspace execution first.');
  }
  return cwd;
}

function shellByRequest(requested) {
  const shells = detectShells();
  if (requested) {
    const lower = String(requested).toLowerCase();
    const byId = shells.find(item => item.id === lower || item.label.toLowerCase() === lower);
    if (byId) return byId;
    const explicit = path.resolve(String(requested));
    if (fs.existsSync(explicit)) {
      const base = path.basename(explicit).toLowerCase();
      const family = base.includes('powershell') || base === 'pwsh.exe'
        ? 'powershell'
        : (base.includes('bash') ? 'bash' : (base.includes('zsh') ? 'zsh' : 'custom'));
      return { id: 'custom', label: path.basename(explicit), family, command: explicit };
    }
  }
  if (!shells.length) throw new Error('No supported shell was found on this system.');
  return shells[0];
}

function writeZshRc(appDataPath) {
  const dir = path.join(appDataPath, 'terminal-zdotdir');
  fs.mkdirSync(dir, { recursive: true });
  const zshScript = path.join(shellIntegrationDir(), 'zsh.zsh');
  fs.writeFileSync(path.join(dir, '.zshrc'), `source ${JSON.stringify(zshScript)}\n`, 'utf-8');
  return dir;
}

function buildSpawnArgs(shell, env, appDataPath) {
  const scripts = shellIntegrationDir();
  if (shell.family === 'powershell') {
    return {
      args: ['-NoLogo', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'powershell.ps1')],
      env,
    };
  }
  if (shell.family === 'bash') {
    return {
      args: ['--init-file', path.join(scripts, 'bash.sh'), '-i'],
      env,
    };
  }
  if (shell.family === 'zsh') {
    return {
      args: ['-i'],
      env: { ...env, ZDOTDIR: writeZshRc(appDataPath) },
    };
  }
  if (shell.family === 'cmd') {
    return { args: ['/K'], env };
  }
  return { args: [], env };
}

function createPtyManager({ app }) {
  const sessions = new Map();
  const listeners = new Map();
  const restorePath = path.join(app.getPath('userData'), 'terminal-sessions.json');
  const appDataPath = app.getPath('userData');
  let shuttingDown = false;

  function emit(ownerId, payload) {
    const sender = listeners.get(ownerId);
    if (!sender || sender.isDestroyed()) return;
    sender.send('terminal.pty.event', payload);
  }

  async function readRestoreEntries() {
    try {
      const raw = await fs.promises.readFile(restorePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.sessions)
        ? parsed.sessions
            .filter(item => item && item.cwd)
            .map(item => ({ shell: item.shell || '', cwd: item.cwd }))
            .slice(0, 8)
        : [];
    } catch {
      return [];
    }
  }

  async function persistRestoreEntries() {
    const sessionsToSave = Array.from(sessions.values())
      .filter(item => item.restore === true)
      .map(item => ({ shell: item.shell.id, cwd: item.cwd }))
      .slice(0, 8);
    await fs.promises.mkdir(path.dirname(restorePath), { recursive: true });
    await fs.promises.writeFile(restorePath, JSON.stringify({
      version: 1,
      sessions: sessionsToSave,
    }, null, 2), 'utf-8');
  }

  function getOwnedSession(ownerWebContents, sessionId) {
    const session = sessions.get(String(sessionId || ''));
    if (!session) return null;
    if (!ownerWebContents || ownerWebContents.isDestroyed()) {
      throw new Error('Terminal window is not available.');
    }
    if (session.ownerId !== ownerWebContents.id) {
      throw new Error('PTY session is owned by another window.');
    }
    return session;
  }

  function spawnPty(ownerWebContents, input = {}) {
    if (!ownerWebContents || ownerWebContents.isDestroyed()) throw new Error('Terminal window is not available.');
    const availability = ptyAvailability();
    if (!availability.available) throw new Error(availability.reason);
    const ownerId = ownerWebContents.id;
    listeners.set(ownerId, ownerWebContents);

    const cwd = normalizeCwd(input.cwd, input.workspaceRoot, input.allowOutsideWorkspace === true);
    const shell = shellByRequest(input.shell || input.defaultShell);
    const mergedEnv = {
      ...process.env,
      TERM_PROGRAM: 'FormatPad',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORMATPAD_TERMINAL: '1',
      ...(input.env && typeof input.env === 'object' ? input.env : {}),
    };
    const { env, maskedCount } = filterSecrets(mergedEnv);
    const spawnSpec = buildSpawnArgs(shell, env, appDataPath);
    const cols = Math.max(20, Math.min(500, Number(input.cols) || DEFAULT_COLS));
    const rows = Math.max(5, Math.min(200, Number(input.rows) || DEFAULT_ROWS));
    const id = crypto.randomUUID();

    const proc = loadPtyModule().spawn(shell.command, spawnSpec.args, {
      name: 'xterm-256color',
      cwd,
      env: spawnSpec.env,
      cols,
      rows,
    });

    const session = {
      id,
      ownerId,
      proc,
      shell,
      cwd,
      restore: input.restore !== false,
    };
    sessions.set(id, session);

    proc.onData(chunk => {
      emit(ownerId, { type: 'data', sessionId: id, chunk });
    });
    proc.onExit(event => {
      sessions.delete(id);
      emit(ownerId, {
        type: 'exit',
        sessionId: id,
        exitCode: event.exitCode,
        signal: event.signal,
      });
      if (!shuttingDown) persistRestoreEntries().catch(() => {});
    });

    persistRestoreEntries().catch(() => {});
    return {
      sessionId: id,
      shell: { id: shell.id, label: shell.label, command: shell.command, family: shell.family },
      cwd,
      cols,
      rows,
      maskedEnvCount: maskedCount,
    };
  }

  function write(ownerWebContents, sessionId, data) {
    const session = getOwnedSession(ownerWebContents, sessionId);
    if (!session) return false;
    session.proc.write(String(data || ''));
    return true;
  }

  function resize(ownerWebContents, sessionId, cols, rows) {
    const session = getOwnedSession(ownerWebContents, sessionId);
    if (!session) return false;
    session.proc.resize(
      Math.max(20, Math.min(500, Number(cols) || DEFAULT_COLS)),
      Math.max(5, Math.min(200, Number(rows) || DEFAULT_ROWS)),
    );
    return true;
  }

  function killSession(sessionId, options = {}) {
    const session = sessions.get(String(sessionId || ''));
    if (!session) return false;
    try {
      if (options.preserveRestore !== true) session.restore = false;
      session.proc.kill();
    } catch {}
    sessions.delete(session.id);
    if (options.preserveRestore !== true && !shuttingDown) persistRestoreEntries().catch(() => {});
    return true;
  }

  function kill(ownerWebContents, sessionId, options = {}) {
    const session = getOwnedSession(ownerWebContents, sessionId);
    if (!session) return false;
    return killSession(session.id, options);
  }

  function killAll(options = {}) {
    for (const id of Array.from(sessions.keys())) killSession(id, options);
  }

  async function shutdown() {
    shuttingDown = true;
    await persistRestoreEntries().catch(() => {});
    killAll({ preserveRestore: true });
  }

  return {
    availability: ptyAvailability,
    detectShells,
    spawnPty,
    write,
    resize,
    kill,
    killAll,
    shutdown,
    readRestoreEntries,
    persistRestoreEntries,
  };
}

module.exports = {
  createPtyManager,
  detectShells,
  shellByRequest,
  ptyAvailability,
};
