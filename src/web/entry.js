// Web build entry. Install the browser platform adapter (which sets
// window.formatpad) before the renderer module runs its top-level code.
import { Workbox } from 'workbox-window';
import { decompressSharedContent } from './url-sharing.js';
import './platform-adapter.js';
import '../renderer/renderer.js';

const PWA_STYLE_ID = 'fp-pwa-style';
const PWA_ROOT_ID = 'fp-pwa-banner-root';
const INSTALL_VISIT_COUNT_KEY = 'fp-pwa-visit-count';
const INSTALL_DISMISSED_UNTIL_KEY = 'fp-pwa-install-dismissed-until';
const DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

function readNumber(key, fallback = 0) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeNumber(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

function ensurePwaStyle() {
  if (document.getElementById(PWA_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PWA_STYLE_ID;
  style.textContent = `
    #${PWA_ROOT_ID} {
      position: fixed;
      left: 50%;
      bottom: 18px;
      z-index: 2400;
      display: grid;
      gap: 8px;
      width: min(520px, calc(100vw - 24px));
      transform: translateX(-50%);
      pointer-events: none;
    }
    .fp-pwa-banner {
      pointer-events: auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 12px 14px;
      border: 1px solid var(--border-color);
      border: 1px solid color-mix(in srgb, var(--accent-color) 45%, var(--border-color));
      border-radius: 14px;
      background: var(--bg-secondary);
      background: color-mix(in srgb, var(--bg-secondary) 94%, black);
      box-shadow: 0 16px 46px rgba(0, 0, 0, 0.35);
      color: var(--text-primary);
    }
    .fp-pwa-banner.offline {
      border-color: var(--syntax-meta, #e0af68);
      border-color: color-mix(in srgb, var(--syntax-meta, #e0af68) 60%, var(--border-color));
    }
    .fp-pwa-banner strong {
      display: block;
      margin-bottom: 2px;
      font-size: 13px;
    }
    .fp-pwa-banner span {
      display: block;
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.45;
    }
    .fp-pwa-actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
    }
    .fp-pwa-actions button {
      padding: 7px 10px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background: transparent;
      color: var(--text-secondary);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .fp-pwa-actions button.primary {
      border-color: var(--accent-color);
      background: var(--accent-color);
      color: var(--bg-primary);
      font-weight: 700;
    }
    .fp-pwa-actions button:hover {
      background: var(--hover-bg);
      color: var(--text-primary);
    }
    .fp-pwa-actions button.primary:hover {
      filter: brightness(1.08);
      color: var(--bg-primary);
    }
    @media (max-width: 560px) {
      .fp-pwa-banner {
        grid-template-columns: 1fr;
      }
      .fp-pwa-actions {
        justify-content: flex-start;
      }
    }
  `;
  document.head.appendChild(style);
}

function pwaRoot() {
  ensurePwaStyle();
  let root = document.getElementById(PWA_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = PWA_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

function createBanner(kind, title, message) {
  const banner = document.createElement('div');
  banner.className = `fp-pwa-banner ${kind}`;
  const copy = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = title;
  const span = document.createElement('span');
  span.textContent = message;
  copy.append(strong, span);
  const actions = document.createElement('div');
  actions.className = 'fp-pwa-actions';
  banner.append(copy, actions);
  return { banner, actions };
}

function recordPwaVisit() {
  const count = readNumber(INSTALL_VISIT_COUNT_KEY) + 1;
  writeNumber(INSTALL_VISIT_COUNT_KEY, count);
  return count;
}

function isStandalonePwa() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function manualInstallHint() {
  const ua = navigator.userAgent || '';
  const isChromium = /\b(?:Chrome|Chromium|CriOS|Edg|OPR|Arc)\b/i.test(ua);
  const isFirefox = /\bFirefox\//i.test(ua);
  const isSafari = /\bSafari\//i.test(ua) && !isChromium && !/\bFxiOS\b/i.test(ua);
  if (isSafari) {
    return navigator.maxTouchPoints > 0
      ? 'Use Share, then Add to Home Screen. Safari does not show the automatic install prompt.'
      : 'Use File, then Add to Dock. Safari does not show the automatic install prompt.';
  }
  if (isFirefox) {
    return 'Firefox does not expose a standard install prompt here. Use Chrome, Edge, or Safari for app-style install.';
  }
  return '';
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    const wb = new Workbox('sw.js', { scope: './' });
    wb.addEventListener('waiting', () => wb.messageSkipWaiting());
    wb.addEventListener('externalwaiting', () => wb.messageSkipWaiting());
    wb.register().catch((err) => {
      console.warn('FormatPad service worker registration failed', err);
    });
  });
}

function installOfflineBanner() {
  let offlineBanner = null;
  const update = () => {
    if (navigator.onLine === false) {
      if (offlineBanner) return;
      const built = createBanner(
        'offline',
        'Offline mode',
        'The app shell is cached. Local editing still works; network features will retry when you reconnect.'
      );
      offlineBanner = built.banner;
      pwaRoot().prepend(offlineBanner);
    } else if (offlineBanner) {
      offlineBanner.remove();
      offlineBanner = null;
    }
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

function installPwaPrompt(visitCount) {
  let installPromptEvent = null;
  let installBanner = null;
  let manualBanner = null;

  const hideInstallBanner = () => {
    installBanner?.remove();
    installBanner = null;
    manualBanner?.remove();
    manualBanner = null;
  };

  const dismissInstallBanner = () => {
    writeNumber(INSTALL_DISMISSED_UNTIL_KEY, Date.now() + DISMISS_MS);
    hideInstallBanner();
  };

  const maybeShowInstallBanner = () => {
    if (!installPromptEvent || installBanner || visitCount < 2 || isStandalonePwa()) return;
    if (Date.now() < readNumber(INSTALL_DISMISSED_UNTIL_KEY)) return;

    const built = createBanner(
      'install',
      'Install FormatPad',
      'Add the web app to your desktop for offline launch and a focused standalone window.'
    );
    installBanner = built.banner;

    const installButton = document.createElement('button');
    installButton.type = 'button';
    installButton.className = 'primary';
    installButton.textContent = 'Install';
    installButton.addEventListener('click', async () => {
      const promptEvent = installPromptEvent;
      installPromptEvent = null;
      hideInstallBanner();
      if (!promptEvent) return;
      try {
        await promptEvent.prompt();
        await promptEvent.userChoice;
      } finally {
        writeNumber(INSTALL_DISMISSED_UNTIL_KEY, Date.now() + DISMISS_MS);
      }
    });

    const laterButton = document.createElement('button');
    laterButton.type = 'button';
    laterButton.textContent = 'Later';
    laterButton.addEventListener('click', dismissInstallBanner);
    built.actions.append(installButton, laterButton);
    pwaRoot().appendChild(installBanner);
  };

  const maybeShowManualInstallBanner = () => {
    if (installPromptEvent || installBanner || manualBanner || visitCount < 2 || isStandalonePwa()) return;
    if (Date.now() < readNumber(INSTALL_DISMISSED_UNTIL_KEY)) return;
    const hint = manualInstallHint();
    if (!hint) return;

    const built = createBanner('install', 'Install FormatPad', hint);
    manualBanner = built.banner;
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Got it';
    dismiss.addEventListener('click', dismissInstallBanner);
    built.actions.append(dismiss);
    pwaRoot().appendChild(manualBanner);
  };

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPromptEvent = event;
    manualBanner?.remove();
    manualBanner = null;
    maybeShowInstallBanner();
  });

  window.addEventListener('appinstalled', () => {
    installPromptEvent = null;
    writeNumber(INSTALL_DISMISSED_UNTIL_KEY, Date.now() + 365 * 24 * 60 * 60 * 1000);
    hideInstallBanner();
  });

  window.addEventListener('load', () => {
    setTimeout(maybeShowManualInstallBanner, 1200);
  }, { once: true });
}

function installLaunchQueueConsumer() {
  if (!('launchQueue' in window) || typeof window.launchQueue?.setConsumer !== 'function') return;
  window.launchQueue.setConsumer((launchParams) => {
    const files = Array.from(launchParams?.files || []);
    if (!files.length) return;
    window.formatpad.openFileHandles?.(files).catch((err) => {
      window.formatpad.showUrlError?.(err);
    });
  });
}

const pwaVisitCount = recordPwaVisit();
registerServiceWorker();
installOfflineBanner();
installPwaPrompt(pwaVisitCount);
installLaunchQueueConsumer();

function hashParamsFromLocation() {
  return new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
}

function migrateLegacyFragmentQuery(params) {
  if (!params.has('fragment')) return;
  const url = new URL(window.location.href);
  const hashParams = new URLSearchParams();
  hashParams.set('fragment', params.get('fragment') || '');
  if (params.has('name')) hashParams.set('name', params.get('name') || '');
  url.searchParams.delete('fragment');
  url.searchParams.delete('name');
  url.hash = hashParams.toString();
  window.history.replaceState(null, '', url.toString());
}

function openSharedUrlFromLocation() {
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = hashParamsFromLocation();
  const params = hashParams.has('fragment') ? hashParams : searchParams;
  if (!params.toString()) return;
  const defer = typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (callback) => Promise.resolve().then(callback);
  defer(async () => {
    try {
      if (params.has('fragment')) {
        if (params === searchParams) migrateLegacyFragmentQuery(params);
        const content = decompressSharedContent(params.get('fragment'));
        await window.formatpad.openTextFromUrl({
          content,
          name: params.get('name') || 'shared.md',
          sourceUrl: window.location.href,
          source: 'fragment',
        });
      } else {
        await window.formatpad.openUrlFromParams(params);
      }
    } catch (err) {
      window.formatpad.showUrlError?.(err);
    }
  });
}

openSharedUrlFromLocation();

// Sentry for web builds. Keep it out of the default bundle when no DSN is
// configured; otherwise the web artifact ships hundreds of KB of inert code.
// This runs after the renderer module body so all error surfaces are live.
// Opt-out: set localStorage["sentry-opt-out"] = "1" to disable.
// TODO: wire SENTRY_DSN via build-time define once the project's Sentry org is set up.
if (process.env.SENTRY_DSN && !localStorage.getItem('sentry-opt-out')) {
  import('@sentry/browser').then((SentryBrowser) => SentryBrowser.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      delete event.user;
      if (event.breadcrumbs?.values) {
        for (const bc of event.breadcrumbs.values) {
          if (typeof bc.message === 'string') {
            bc.message = bc.message.replace(/[^/\\]+\.(?:env|key|pem)\b/gi, '<redacted>');
          }
        }
      }
      return event;
    },
  })).catch(() => {});
}
