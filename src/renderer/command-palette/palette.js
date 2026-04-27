import { isCommandEnabled, onCommandsChanged } from '../commands/registry.js';

const OWNER = 'command-palette';
const MAX_VISIBLE = 50;
const RECENT_KEY = 'orpad-command-palette-recent';

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function loadRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 30) : [];
  } catch {
    return [];
  }
}

function saveRecent(items) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, 30))); }
  catch {}
}

function pushRecent(id) {
  const next = [id, ...loadRecent().filter(item => item !== id)];
  saveRecent(next);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function scoreFuzzy(query, text) {
  const q = normalize(query);
  const hay = normalize(text);
  if (!q) return { score: 1, positions: [] };
  if (!hay) return { score: Number.NEGATIVE_INFINITY, positions: [] };

  let cursor = 0;
  let score = 0;
  let streak = 0;
  const positions = [];
  for (const ch of q) {
    const found = hay.indexOf(ch, cursor);
    if (found < 0) return { score: Number.NEGATIVE_INFINITY, positions: [] };
    positions.push(found);
    const boundary = found === 0 || /[\s./:_-]/.test(hay[found - 1]);
    streak = found === cursor ? streak + 1 : 1;
    score += 8 + streak * 3 + (boundary ? 6 : 0) - Math.min(found - cursor, 24) * 0.15;
    cursor = found + 1;
  }
  if (hay.includes(q)) score += 30;
  if (hay.startsWith(q)) score += 45;
  score -= Math.max(0, hay.length - q.length) * 0.02;
  return { score, positions };
}

function commandText(command) {
  return [
    command.title,
    command.category,
    command.id,
    command.keybinding,
    ...(command.keywords || []),
  ].filter(Boolean).join(' ');
}

function scoreCommand(command, query, recentRank) {
  const fuzzy = scoreFuzzy(query, commandText(command));
  if (fuzzy.score === Number.NEGATIVE_INFINITY) return null;
  const recentBoost = recentRank >= 0 ? 20 - Math.min(recentRank, 19) : 0;
  const priority = Number(command.priority || 0);
  return { command, score: fuzzy.score + recentBoost + priority };
}

function compareMatches(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const cat = String(a.command.category || '').localeCompare(String(b.command.category || ''));
  if (cat) return cat;
  return String(a.command.title || '').localeCompare(String(b.command.title || ''));
}

function isTextInputTarget(target) {
  if (!target) return false;
  if (target.closest?.('.cm-editor')) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function createCommandPalette({ root, getCommands, runCommand, getContext, notify }) {
  const overlay = el('div', 'cmdk-overlay hidden');
  overlay.innerHTML = `
    <div class="cmdk-shell" role="dialog" aria-modal="true" aria-label="Command Palette">
      <div class="cmdk-topline">
        <span>Command Palette</span>
        <kbd>Ctrl Shift P</kbd>
      </div>
      <input class="cmdk-input" type="text" spellcheck="false" autocomplete="off" placeholder="Type a command...">
      <div class="cmdk-results" role="listbox"></div>
      <div class="cmdk-footer"><span>Enter to run</span><span>Esc to close</span><span>50 visible max</span></div>
    </div>
  `;
  root.appendChild(overlay);

  const input = overlay.querySelector('.cmdk-input');
  const resultsEl = overlay.querySelector('.cmdk-results');
  let selected = 0;
  let matches = [];
  let lastFocus = null;

  function isOpen() {
    return !overlay.classList.contains('hidden');
  }

  function close() {
    if (!isOpen()) return;
    overlay.classList.add('hidden');
    matches = [];
    selected = 0;
    if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) {
      lastFocus.focus();
    }
  }

  function render() {
    const query = input.value;
    const context = getContext?.() || {};
    const recent = loadRecent();
    matches = (getCommands?.(context) || [])
      .map(command => scoreCommand(command, query, recent.indexOf(command.id)))
      .filter(Boolean)
      .sort(compareMatches)
      .slice(0, MAX_VISIBLE);

    selected = Math.max(0, Math.min(selected, matches.length - 1));
    resultsEl.innerHTML = '';
    if (!matches.length) {
      resultsEl.appendChild(el('div', 'cmdk-empty', query ? 'No matching commands.' : 'No commands registered.'));
      return;
    }

    matches.forEach((match, index) => {
      const { command } = match;
      const enabled = isCommandEnabled(command, context);
      const item = el('button', 'cmdk-item');
      item.type = 'button';
      item.role = 'option';
      item.disabled = !enabled;
      item.classList.toggle('selected', index === selected);
      item.setAttribute('aria-selected', String(index === selected));

      const main = el('span', 'cmdk-item-main');
      main.appendChild(el('strong', '', command.title));
      main.appendChild(el('small', '', command.category || 'General'));
      item.appendChild(main);
      if (command.keybinding) item.appendChild(el('kbd', 'cmdk-keybinding', command.keybinding));
      if (!enabled) item.appendChild(el('span', 'cmdk-disabled', 'Unavailable'));

      item.addEventListener('mousemove', () => {
        selected = index;
        render();
      });
      item.addEventListener('click', () => accept(index));
      resultsEl.appendChild(item);
    });
  }

  async function accept(index = selected) {
    const match = matches[index];
    if (!match) return;
    const context = getContext?.() || {};
    if (!isCommandEnabled(match.command, context)) return;
    pushRecent(match.command.id);
    close();
    try {
      await runCommand(match.command.id, {}, context);
    } catch (err) {
      console.error('[commands] command failed', err);
      notify?.('Command Palette', err);
    }
  }

  function open(initialQuery = '') {
    window.dispatchEvent(new CustomEvent('orpad-overlay-open', { detail: { owner: OWNER } }));
    lastFocus = document.activeElement;
    overlay.classList.remove('hidden');
    input.value = initialQuery;
    selected = 0;
    render();
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  input.addEventListener('input', () => {
    selected = 0;
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = matches.length ? (selected + 1) % matches.length : 0;
      render();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = matches.length ? (selected - 1 + matches.length) % matches.length : 0;
      render();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      accept();
    }
  });
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener('orpad-overlay-open', (event) => {
    if (event.detail?.owner !== OWNER) close();
  });
  onCommandsChanged(() => { if (isOpen()) render(); });

  return {
    open,
    close,
    refresh: render,
    isOpen,
    toggle() {
      if (isOpen()) close();
      else open();
    },
    shouldHandleShortcut(event) {
      if (!event.ctrlKey && !event.metaKey) return false;
      if (!event.shiftKey || event.altKey) return false;
      if (event.key.toLowerCase() !== 'p') return false;
      return !isTextInputTarget(event.target) || event.target === input;
    },
  };
}
