const actions = [];

function list(value) {
  return Array.isArray(value) ? value : [value];
}

export function registerAction(action) {
  if (!action?.id || !action?.format || !action?.scope || typeof action.run !== 'function') {
    throw new Error('Invalid AI action registration');
  }
  if (actions.some(item => item.id === action.id)) return;
  actions.push(action);
}

export function getActionsFor(format, scopes = ['document']) {
  const fmt = String(format || '').toLowerCase();
  const scopeSet = new Set(list(scopes).map(scope => String(scope || '').toLowerCase()));
  return actions.filter(action => {
    const formats = list(action.format).map(item => String(item).toLowerCase());
    const actionScopes = list(action.scope).map(item => String(item).toLowerCase());
    return formats.includes(fmt) && actionScopes.some(scope => scopeSet.has(scope));
  });
}

export function getAction(id) {
  return actions.find(action => action.id === id) || null;
}

export function getAllActions() {
  return actions.slice();
}
