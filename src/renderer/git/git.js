import * as git from 'isomorphic-git';
import { getFs } from './fs-adapter.js';

const cache = {};

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

export function relativePath(dir, filePath) {
  const root = normalizePath(dir).replace(/\/+$/, '');
  const full = normalizePath(filePath);
  if (root === '' || root === '/') return full.replace(/^\/+/, '');
  if (full.toLowerCase().startsWith((root + '/').toLowerCase())) {
    return full.slice(root.length + 1);
  }
  return full.replace(/^\/+/, '');
}

export function absolutePath(dir, filepath) {
  if (!filepath) return dir;
  if (normalizePath(dir) === '/') return '/' + normalizePath(filepath).replace(/^\/+/, '');
  const sep = String(dir).includes('\\') ? '\\' : '/';
  return String(dir).replace(/[\\/]+$/, '') + sep + normalizePath(filepath).replace(/\//g, sep);
}

function isNotRepoError(err) {
  return [
    'NotFoundError',
    'ENOENT',
    'RepositoryNotFoundError',
    'NotFoundFail',
    'NoRefspecError',
    'ResolveRefError',
  ].includes(err?.code) || /not found|could not find|ENOENT|Expected a git repo/i.test(err?.message || '');
}

export function badgeFromMatrixRow(row) {
  if (!row) return null;
  const [, head, workdir, stage] = row;
  if (head === 0 && workdir === 2 && stage === 0) return 'U';
  if (workdir === 0) return 'D';
  if (head === 0 && (workdir === 2 || stage === 2 || stage === 3)) return 'A';
  if (head !== workdir || head !== stage || workdir !== stage) return 'M';
  return null;
}

export async function status(dir) {
  const fs = await getFs();
  try {
    const matrix = await git.statusMatrix({ fs, dir, cache, ignored: false });
    return {
      isRepo: true,
      matrix,
      statuses: new Map(matrix.map(row => [row[0], badgeFromMatrixRow(row)]).filter(([, badge]) => badge)),
    };
  } catch (err) {
    if (isNotRepoError(err)) return { isRepo: false, matrix: [], statuses: new Map() };
    throw err;
  }
}

export async function currentBranch(dir) {
  const fs = await getFs();
  try {
    return await git.currentBranch({ fs, dir, fullname: false, cache });
  } catch (err) {
    if (isNotRepoError(err)) return null;
    throw err;
  }
}

async function ancestors(fs, dir, ref, maxDepth = 2000) {
  try {
    const commits = await git.log({ fs, dir, ref, depth: maxDepth, cache });
    return commits.map(item => item.oid);
  } catch {
    return [];
  }
}

export async function aheadBehind(dir) {
  const fs = await getFs();
  const branch = await currentBranch(dir);
  if (!branch) return null;
  try {
    const remote = await git.getConfig({ fs, dir, path: `branch.${branch}.remote`, cache });
    const merge = await git.getConfig({ fs, dir, path: `branch.${branch}.merge`, cache });
    if (!remote || !merge) return { branch, ahead: null, behind: null };
    const upstream = `${remote}/${String(merge).replace(/^refs\/heads\//, '')}`;
    const localOids = await ancestors(fs, dir, 'HEAD');
    const upstreamOids = await ancestors(fs, dir, upstream);
    if (!localOids.length || !upstreamOids.length) return { branch, ahead: null, behind: null };
    const upstreamSet = new Set(upstreamOids);
    const localSet = new Set(localOids);
    const aheadIndex = localOids.findIndex(oid => upstreamSet.has(oid));
    const behindIndex = upstreamOids.findIndex(oid => localSet.has(oid));
    return {
      branch,
      ahead: aheadIndex < 0 ? localOids.length : aheadIndex,
      behind: behindIndex < 0 ? upstreamOids.length : behindIndex,
    };
  } catch {
    return { branch, ahead: null, behind: null };
  }
}

export async function fileStatus(dir, filePath) {
  const fs = await getFs();
  try {
    return await git.status({ fs, dir, filepath: relativePath(dir, filePath), cache });
  } catch (err) {
    if (isNotRepoError(err)) return null;
    throw err;
  }
}

export function lcsLineDiff(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  if (a.length * b.length > 300_000) {
    return [
      ...a.map((text, index) => ({ op: 'del', oldLine: index + 1, text })),
      ...b.map((text, index) => ({ op: 'add', newLine: index + 1, text })),
    ];
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: 'equal', oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: 'del', oldLine: i + 1, text: a[i++] });
    } else {
      ops.push({ op: 'add', newLine: j + 1, text: b[j++] });
    }
  }
  while (i < a.length) ops.push({ op: 'del', oldLine: i + 1, text: a[i++] });
  while (j < b.length) ops.push({ op: 'add', newLine: j + 1, text: b[j++] });
  return ops;
}

function opsToHunks(ops) {
  const hunks = [];
  let current = null;
  let oldCursor = 1;
  let newCursor = 1;
  const close = () => {
    if (!current) return;
    current.oldLinesCount = current.oldLines.length;
    current.newLinesCount = current.newLines.length;
    hunks.push(current);
    current = null;
  };
  for (const op of ops) {
    if (op.op === 'equal') {
      close();
      oldCursor++;
      newCursor++;
      continue;
    }
    if (!current) {
      current = {
        id: `h${hunks.length + 1}`,
        oldStart: oldCursor,
        newStart: newCursor,
        oldLines: [],
        newLines: [],
        markers: [],
      };
    }
    if (op.op === 'del') {
      current.oldLines.push(op.text);
      current.markers.push({ line: Math.max(1, newCursor), type: 'deleted' });
      oldCursor++;
    } else {
      current.newLines.push(op.text);
      current.markers.push({ line: newCursor, type: current.oldLines.length ? 'modified' : 'added' });
      newCursor++;
    }
  }
  close();
  return hunks;
}

export async function headText(dir, filePath) {
  const fs = await getFs();
  const filepath = relativePath(dir, filePath);
  try {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD', cache });
    const { blob } = await git.readBlob({ fs, dir, oid: head, filepath, cache });
    return new TextDecoder().decode(blob);
  } catch {
    return '';
  }
}

export async function diffAgainstHead(dir, filePath, currentText = null) {
  const fs = await getFs();
  const filepath = relativePath(dir, filePath);
  const before = await headText(dir, filePath);
  let after = currentText;
  if (after == null) {
    try { after = await fs.promises.readFile(absolutePath(dir, filepath), 'utf8'); }
    catch { after = ''; }
  }
  const ops = lcsLineDiff(before, after);
  return {
    filepath,
    oldText: before,
    newText: after,
    ops,
    hunks: opsToHunks(ops).filter(hunk => hunk.oldLinesCount || hunk.newLinesCount),
  };
}

export async function listBranches(dir) {
  const fs = await getFs();
  try {
    return await git.listBranches({ fs, dir, cache });
  } catch (err) {
    if (isNotRepoError(err)) return [];
    throw err;
  }
}

export async function checkoutBranch(dir, ref) {
  const fs = await getFs();
  await git.checkout({ fs, dir, ref, cache });
}

export async function revertFile(dir, filePath) {
  const fs = await getFs();
  await git.checkout({
    fs,
    dir,
    ref: 'HEAD',
    filepaths: [relativePath(dir, filePath)],
    noUpdateHead: true,
    force: true,
    cache,
  });
}
