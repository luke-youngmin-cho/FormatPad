const commands = new Map();
const listeners = new Set();

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeCommand(command) {
  if (!command || typeof command !== 'object') throw new Error('Command must be an object.');
  if (!command.id || typeof command.id !== 'string') throw new Error('Command id is required.');
  if (!command.title || typeof command.title !== 'string') throw new Error(`Command "${command.id}" needs a title.`);
  if (typeof command.run !== 'function') throw new Error(`Command "${command.id}" needs a run handler.`);
  return {
    category: 'General',
    keybinding: '',
    priority: 0,
    searchable: true,
    ...command,
    keywords: asArray(command.keywords),
  };
}

function notifyListeners() {
  for (const listener of listeners) {
    try { listener(); }
    catch (err) { console.warn('[commands] listener failed', err); }
  }
}

export function registerCommand(command) {
  const normalized = normalizeCommand(command);
  commands.set(normalized.id, normalized);
  notifyListeners();
  return () => unregisterCommand(normalized.id);
}

export function registerCommands(items) {
  const disposers = (items || []).map(registerCommand);
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

export function unregisterCommand(id) {
  const existed = commands.delete(id);
  if (existed) notifyListeners();
}

export function clearCommands() {
  commands.clear();
  notifyListeners();
}

export function getCommand(id) {
  return commands.get(id) || null;
}

export function isCommandEnabled(command, context = {}) {
  if (!command) return false;
  if (typeof command.when === 'function' && !command.when(context)) return false;
  if (typeof command.enabled === 'function') return command.enabled(context) !== false;
  return command.enabled !== false;
}

export function getCommands(context = {}, options = {}) {
  const includeHidden = options.includeHidden === true;
  return Array.from(commands.values())
    .filter(command => includeHidden || command.searchable !== false)
    .filter(command => !command.when || command.when(context))
    .sort((a, b) => {
      const category = String(a.category || '').localeCompare(String(b.category || ''));
      if (category) return category;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
}

export async function runCommand(id, args = {}, context = {}) {
  const command = getCommand(id);
  if (!command) throw new Error(`Unknown command: ${id}`);
  if (!isCommandEnabled(command, context)) return false;
  return await command.run(args, context);
}

export function onCommandsChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
