const { app, dialog, shell } = require('electron');
const https = require('https');
const path = require('path');
const fs = require('fs');

const GITHUB_OWNER = 'luke-youngmin-cho';
const GITHUB_REPO = 'FormatPad';

// --- Version comparison (semver-lite) ---
// Splits "1.2.3-beta.4" into { base: [1,2,3], pre: ['beta', 4] }. Any release with a
// prerelease tag sorts BELOW the same base without one (so 1.0.0-beta.9 < 1.0.0).
function parseVersion(v) {
  const clean = v.replace(/^v/, '').trim();
  const [basePart, prePart] = clean.split('-', 2);
  const base = basePart.split('.').map(n => parseInt(n, 10) || 0);
  while (base.length < 3) base.push(0);
  const pre = prePart
    ? prePart.split('.').map(x => /^\d+$/.test(x) ? parseInt(x, 10) : x)
    : null;
  return { base, pre };
}

function compareVersions(current, latest) {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  for (let i = 0; i < 3; i++) {
    if (b.base[i] > a.base[i]) return 1;
    if (b.base[i] < a.base[i]) return -1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre && b.pre) return -1;
  if (a.pre && !b.pre) return 1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const ap = a.pre[i], bp = b.pre[i];
    if (ap === undefined) return 1;
    if (bp === undefined) return -1;
    const aNum = typeof ap === 'number';
    const bNum = typeof bp === 'number';
    if (aNum && !bNum) return 1;
    if (!aNum && bNum) return -1;
    if (ap > bp) return -1;
    if (ap < bp) return 1;
  }
  return 0;
}

// --- Skip version persistence ---
function getSkipPath() {
  return path.join(app.getPath('userData'), 'skipped-version');
}

function getSkippedVersion() {
  try { return fs.readFileSync(getSkipPath(), 'utf-8').trim(); }
  catch { return null; }
}

function setSkippedVersion(version) {
  try { fs.writeFileSync(getSkipPath(), version, 'utf-8'); } catch {}
}

// --- Update-in-progress marker ---
// Written right before launching the NSIS installer so that any new app
// instance (e.g. user double-clicking the icon while the installer runs)
// can detect the in-flight install and bow out instead of starting up
// half-baked. The marker self-clears when the next launch's app version
// matches marker.targetVersion (install completed) or after 5 minutes
// (install was abandoned).
const STALE_MARKER_MS = 5 * 60 * 1000;

function getMarkerPath() {
  return path.join(app.getPath('userData'), 'update-in-progress');
}

function writeMarker(targetVersion) {
  try {
    fs.writeFileSync(getMarkerPath(), JSON.stringify({
      targetVersion,
      timestamp: Date.now(),
    }), 'utf-8');
  } catch {}
}

function clearMarker() {
  try { fs.unlinkSync(getMarkerPath()); } catch {}
}

function checkUpdateInProgress() {
  let marker;
  try { marker = JSON.parse(fs.readFileSync(getMarkerPath(), 'utf-8')); }
  catch { return null; }
  if (!marker) return null;
  if (marker.targetVersion && marker.targetVersion === app.getVersion()) {
    clearMarker();
    return null;
  }
  if (!marker.timestamp || Date.now() - marker.timestamp > STALE_MARKER_MS) {
    clearMarker();
    return null;
  }
  return marker;
}

// --- HTTPS helpers ---
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': `FormatPad/${app.getVersion()}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        httpsGet(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const doDownload = (downloadUrl) => {
      const req = https.get(downloadUrl, {
        headers: { 'User-Agent': `FormatPad/${app.getVersion()}` },
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          doDownload(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        let receivedBytes = 0;
        const file = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0 && onProgress) onProgress(receivedBytes / totalBytes);
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
      });
      req.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    };
    doDownload(url);
  });
}

// Pending update state per-window. Cleared when the user dismisses the prompt.
const pending = new Map();

async function checkForUpdates(win, t) {
  if (win.isDestroyed()) return;
  try {
    const raw = await httpsGet(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
    );
    const release = JSON.parse(raw);
    const latestVersion = release.tag_name.replace(/^v/, '');
    const currentVersion = app.getVersion();

    if (compareVersions(currentVersion, latestVersion) <= 0) return;
    if (getSkippedVersion() === latestVersion) return;

    const installerAsset = release.assets.find((a) => {
      if (process.platform === 'darwin') return a.name.endsWith('.dmg');
      return a.name.endsWith('.exe') && !a.name.includes('blockmap');
    });

    pending.set(win.id, { release, installerAsset, t });

    if (win.isDestroyed()) return;
    win.webContents.send('show-update-dialog', {
      currentVersion,
      latestVersion,
      releaseBody: release.body ? release.body.substring(0, 500) : '',
      releaseUrl: release.html_url,
      hasInstaller: !!installerAsset,
    });
  } catch {
    // Silent fail — don't bother user if offline or API unreachable
  }
}

async function handleUpdateAction(win, action) {
  const entry = pending.get(win.id);
  if (!entry) return;
  const { release, installerAsset, t } = entry;
  const latestVersion = release.tag_name.replace(/^v/, '');

  if (action === 'download-install' && installerAsset) {
    pending.delete(win.id);
    const safeFilename = path.basename(installerAsset.name);
    const destPath = path.join(app.getPath('temp'), safeFilename);
    win.setProgressBar(0.01);
    if (!win.isDestroyed()) win.webContents.send('update-progress', 0);
    try {
      await downloadFile(
        installerAsset.browser_download_url,
        destPath,
        (progress) => {
          win.setProgressBar(progress);
          if (!win.isDestroyed()) win.webContents.send('update-progress', progress);
        }
      );
      win.setProgressBar(-1);
      if (!win.isDestroyed()) win.webContents.send('update-progress', 1);
      writeMarker(latestVersion);
      const openErr = await shell.openPath(destPath);
      if (openErr) {
        clearMarker();
        if (!win.isDestroyed()) win.webContents.send('update-error', openErr);
        dialog.showErrorBox(t('update.errorTitle'), openErr);
      } else {
        setTimeout(() => app.quit(), 1500);
      }
    } catch (err) {
      win.setProgressBar(-1);
      if (!win.isDestroyed()) win.webContents.send('update-error', err.message);
      dialog.showErrorBox(t('update.errorTitle'), err.message);
    }
  } else if (action === 'view-release') {
    shell.openExternal(release.html_url);
    pending.delete(win.id);
  } else if (action === 'skip') {
    setSkippedVersion(latestVersion);
    pending.delete(win.id);
  } else {
    pending.delete(win.id);
  }
}

module.exports = { checkForUpdates, handleUpdateAction, checkUpdateInProgress };
