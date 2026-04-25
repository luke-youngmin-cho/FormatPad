export function createPtyTerminalGroup({ mount }) {
  if (mount) {
    mount.innerHTML = `
      <div class="terminal-pty-root terminal-pty-unavailable">
        <div class="terminal-banner">Full terminal is available only in the Electron desktop app.</div>
      </div>
    `;
  }
  return {
    activate() {},
    newTerminal() {},
    prefill() {},
    focus() {},
    getLastOutput() { return null; },
    destroy() {},
  };
}
