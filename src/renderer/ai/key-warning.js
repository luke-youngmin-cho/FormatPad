export function confirmWebKeyStorage() {
  if (localStorage.getItem('orpad-ai-web-key-warning-ok') === '1') {
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'ai-warning-overlay';
    overlay.innerHTML = `
      <div class="ai-warning-card" role="dialog" aria-modal="true" aria-labelledby="ai-warning-title">
        <h2 id="ai-warning-title">Store API key in this browser?</h2>
        <p>
          OrPAD Web cannot use Electron safeStorage. Your key will be stored in IndexedDB
          for this browser profile and origin. Do not use this on a shared or untrusted device.
        </p>
        <label class="ai-warning-check">
          <input type="checkbox">
          <span>I understand the browser storage risk.</span>
        </label>
        <div class="ai-warning-actions">
          <button type="button" data-action="cancel">Cancel</button>
          <button type="button" data-action="accept" class="primary" disabled>Save key</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const checkbox = overlay.querySelector('input[type="checkbox"]');
    const accept = overlay.querySelector('[data-action="accept"]');
    checkbox.addEventListener('change', () => { accept.disabled = !checkbox.checked; });

    function finish(ok) {
      overlay.remove();
      if (ok) localStorage.setItem('orpad-ai-web-key-warning-ok', '1');
      resolve(ok);
    }

    overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(false));
    accept.addEventListener('click', () => finish(true));
  });
}
