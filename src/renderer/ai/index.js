import { createAISidebar } from './sidebar.js';
import { createAIKeyStore } from './key-store.js';
import { createConversationStore } from './conversation-store.js';

export function initAISidebar({ workspaceEl, hooks, track }) {
  const controller = createAISidebar({
    workspaceEl,
    hooks,
    track,
    keyStore: createAIKeyStore(),
    conversationStore: createConversationStore({ getWorkspacePath: hooks.getWorkspacePath }),
  });

  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'l' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      controller.toggle();
    }
  });

  return controller;
}
