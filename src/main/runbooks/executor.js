const fs = require('fs');
const path = require('path');
const {
  appendRunEvent,
  createRunRecord,
  eventRecord,
  updateRunRecord,
} = require('./storage');

const fsp = fs.promises;
const MAX_SOURCE_BYTES = 200 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function normalizeApproval(approval = {}) {
  return {
    allowed: approval.allowed === true,
    action: String(approval.action || 'provider-send'),
    scope: String(approval.scope || 'run'),
    target: String(approval.target || 'local MVP dry run'),
    reason: String(approval.reason || ''),
  };
}

function relativePath(root, target) {
  return path.relative(path.resolve(root), path.resolve(target)).replace(/\\/g, '/');
}

function splitRefAnchor(ref) {
  const raw = String(ref || '');
  const hashIndex = raw.indexOf('#');
  if (hashIndex === -1) return { file: raw, anchor: '' };
  return {
    file: raw.slice(0, hashIndex),
    anchor: raw.slice(hashIndex + 1),
  };
}

function isInsidePath(child, parent) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  if (resolvedChild === resolvedParent) return true;
  const rel = path.relative(resolvedParent, resolvedChild);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function realpathIfExists(targetPath) {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function resolveLocalRef(baseDir, ref, allowedRootDir = baseDir) {
  const { file } = splitRefAnchor(ref);
  if (!file || /^[a-z][a-z0-9+.-]*:\/\//i.test(file)) return null;
  const resolved = path.resolve(baseDir, file);
  const allowedRoot = path.resolve(allowedRootDir || baseDir);
  if (!isInsidePath(resolved, allowedRoot)) return null;

  const realResolved = realpathIfExists(resolved);
  if (realResolved) {
    const realAllowedRoot = realpathIfExists(allowedRoot) || allowedRoot;
    if (!isInsidePath(realResolved, realAllowedRoot)) return null;
  }

  return resolved;
}

async function readRunbookObject(runbookPath) {
  return JSON.parse(await fsp.readFile(runbookPath, 'utf-8'));
}

function isPipelineDocument(doc) {
  return doc?.kind === 'orpad.pipeline' || !!doc?.entryGraph;
}

function graphObjectFromDocument(doc) {
  return doc?.graph && typeof doc.graph === 'object' && !Array.isArray(doc.graph)
    ? doc.graph
    : (Array.isArray(doc?.nodes) ? doc : null);
}

function treeObjectFromDocument(doc) {
  if (doc?.root && typeof doc.root === 'object' && !Array.isArray(doc.root)) return doc;
  return Array.isArray(doc?.trees) ? doc.trees[0] : null;
}

async function readJsonFile(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf-8'));
}

function normalizeRefItem(item, fallbackId = '') {
  if (!item) return null;
  if (typeof item === 'string') return { id: fallbackId || path.basename(item), file: item };
  if (typeof item !== 'object' || Array.isArray(item)) return null;
  const file = item.file || item.path || item.ref || '';
  const id = item.id || item.name || fallbackId || (file ? path.basename(file) : '');
  return file ? { ...item, id: String(id), file: String(file) } : null;
}

function isSkillNodeType(type) {
  return type === 'Skill' || type === 'orpad.skill';
}

function isTreeNodeType(type) {
  return type === 'OrchTree' || type === 'orpad.tree';
}

function collectPipelineRefItems(value) {
  if (Array.isArray(value)) return value.map(item => normalizeRefItem(item)).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([id, item]) => normalizeRefItem(typeof item === 'string' ? item : { id, ...item }, id))
      .filter(Boolean);
  }
  return [];
}

function addContextFile(files, role, filePath, extra = {}) {
  if (!filePath) return;
  const key = path.resolve(filePath).toLowerCase();
  if (files.some(item => item.path && path.resolve(item.path).toLowerCase() === key && item.role === role)) return;
  files.push({ role, path: filePath, ...extra });
}

async function attachReferencedTreesToNode(node, baseDir, pipelineDir, files, visited = new Set()) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  if (isTreeNodeType(node.type)) {
    const treeRef = node.treeRef || node.config?.treeRef || node.ref || node.config?.ref || '';
    if (treeRef && !node.tree) {
      const treePath = resolveLocalRef(baseDir, treeRef, pipelineDir);
      if (treePath) {
        const visitKey = path.resolve(treePath).toLowerCase();
        addContextFile(files, 'tree', treePath);
        if (!visited.has(visitKey)) {
          visited.add(visitKey);
          try {
            const treeDoc = await readJsonFile(treePath);
            const tree = treeObjectFromDocument(treeDoc);
            if (tree?.root) {
              tree.__baseDir = path.dirname(treePath);
              node.tree = tree;
              await attachReferencedTreesToNode(tree.root, tree.__baseDir, pipelineDir, files, visited);
            }
          } catch {
            addContextFile(files, 'tree', treePath, { missing: true });
          }
        }
      }
    } else if (node.tree?.root) {
      await attachReferencedTreesToNode(node.tree.root, node.tree.__baseDir || baseDir, pipelineDir, files, visited);
    }
  }

  for (const child of Array.isArray(node.children) ? node.children : []) {
    await attachReferencedTreesToNode(child, baseDir, pipelineDir, files, visited);
  }
}

async function loadPipelineExecutionDocument(pipelinePath, pipeline) {
  const pipelineDir = path.dirname(pipelinePath);
  const graphRefs = collectPipelineRefItems(pipeline.graphs);
  const treeRefs = collectPipelineRefItems(pipeline.trees);
  const skillRefs = collectPipelineRefItems(pipeline.skills);
  const ruleRefs = collectPipelineRefItems(pipeline.rules);
  const pipelineSkills = new Map();
  const entryGraph = pipeline.entryGraph
    || pipeline.entry?.graph
    || pipeline.graph?.file
    || graphRefs[0]?.file
    || '';
  if (!entryGraph) return { doc: pipeline, files: [] };
  const graphPath = resolveLocalRef(pipelineDir, entryGraph, pipelineDir);
  if (!graphPath) return { doc: pipeline, files: [] };
  const graphDoc = await readJsonFile(graphPath);
  const files = [];
  addContextFile(files, 'graph', graphPath);

  for (const item of graphRefs) {
    const resolved = resolveLocalRef(pipelineDir, item.file, pipelineDir);
    if (resolved) addContextFile(files, 'graph', resolved);
  }
  for (const item of treeRefs) {
    const resolved = resolveLocalRef(pipelineDir, item.file, pipelineDir);
    if (resolved) addContextFile(files, 'tree', resolved);
  }
  for (const item of skillRefs) {
    const resolved = resolveLocalRef(pipelineDir, item.file, pipelineDir);
    if (resolved) {
      pipelineSkills.set(item.id, resolved);
      addContextFile(files, 'skill', resolved);
    }
  }
  for (const item of ruleRefs) {
    const resolved = resolveLocalRef(pipelineDir, item.file, pipelineDir);
    if (resolved) addContextFile(files, 'rule', resolved);
  }

  const graph = graphObjectFromDocument(graphDoc);
  if (graph?.nodes) {
    for (const node of graph.nodes) {
      await attachReferencedTreesToNode(node, path.dirname(graphPath), pipelineDir, files);
    }
  }
  return { doc: graphDoc, files, pipelineDir, pipelineSkills };
}

function walkNodes(node, out = [], baseDir = '') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  out.push({
    id: String(node.id || ''),
    type: String(node.type || ''),
    label: String(node.label || node.name || node.id || node.type || ''),
    file: node.file || node.config?.file || '',
    skillRef: node.skillRef || node.config?.skillRef || '',
    baseDir,
  });
  if (isTreeNodeType(node.type) && node.tree?.root) {
    walkNodes(node.tree.root, out, node.tree.__baseDir || baseDir);
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    walkNodes(child, out, baseDir);
  }
  return out;
}

function collectRunbookNodes(runbook, baseDir = '') {
  const nodes = [];
  for (const tree of Array.isArray(runbook?.trees) ? runbook.trees : []) {
    walkNodes(tree.root, nodes, tree.__baseDir || baseDir);
  }
  if (runbook?.root) {
    walkNodes(runbook.root, nodes, runbook.__baseDir || baseDir);
  }
  const graph = graphObjectFromDocument(runbook);
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    walkNodes(node, nodes, baseDir);
  }
  return nodes;
}

async function fileInfo(workspaceRoot, filePath, role) {
  const stat = await fsp.stat(filePath);
  return {
    role,
    path: relativePath(workspaceRoot, filePath),
    bytes: stat.size,
    redacted: false,
  };
}

async function buildContextManifest({ workspaceRoot, runbookPath, validation, workspaceSummary, runbook, contextFiles = [], pipelineDir = '', pipelineSkills = new Map() }) {
  const baseDir = path.dirname(runbookPath);
  const allowedRoot = pipelineDir || baseDir;
  const included = [await fileInfo(workspaceRoot, runbookPath, isPipelineDocument(runbook) || /\.or-pipeline$/i.test(runbookPath) ? 'pipeline' : 'runbook')];
  const nodes = collectRunbookNodes(runbook, contextFiles[0]?.path ? path.dirname(contextFiles[0].path) : baseDir);
  const seen = new Set([path.resolve(runbookPath).toLowerCase()]);

  for (const item of contextFiles) {
    if (!item?.path) continue;
    const key = path.resolve(item.path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      included.push(await fileInfo(workspaceRoot, item.path, item.role || 'pipeline-ref'));
    } catch {
      included.push({
        role: item.role || 'pipeline-ref',
        path: relativePath(workspaceRoot, item.path),
        bytes: 0,
        redacted: false,
        missing: true,
      });
    }
  }

  for (const node of nodes.filter(item => isSkillNodeType(item.type))) {
    const ref = node.file || pipelineSkills.get(node.skillRef) || '';
    const refPath = resolveLocalRef(node.baseDir || baseDir, ref, allowedRoot);
    if (!refPath) continue;
    const key = path.resolve(refPath).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      included.push(await fileInfo(workspaceRoot, refPath, 'skill'));
    } catch {
      included.push({
        role: 'skill',
        path: relativePath(workspaceRoot, refPath),
        bytes: 0,
        redacted: false,
        missing: true,
      });
    }
  }

  const excluded = (workspaceSummary?.risky || []).slice(0, 50).map(item => ({
    role: 'redaction-candidate',
    path: relativePath(workspaceRoot, item.path),
    redacted: true,
    reason: 'filename matches secret/token/password/key redaction policy',
  }));

  const tokenEstimate = Math.ceil(included.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0) / 4);
  return {
    version: 1,
    createdAt: nowIso(),
    workspaceRoot,
    runbookPath: relativePath(workspaceRoot, runbookPath),
    pipelinePath: /\.or-pipeline$/i.test(runbookPath) ? relativePath(workspaceRoot, runbookPath) : '',
    trustLevel: validation?.trustLevel || 'local-authored',
    schemaVersion: validation?.schemaVersion || '',
    included,
    excluded,
    indexFacts: {
      workspaceType: workspaceSummary?.workspaceType || 'Project workspace',
      fileCount: workspaceSummary?.fileCount || 0,
      dirCount: workspaceSummary?.dirCount || 0,
      runbookCount: workspaceSummary?.runbooks?.length || 0,
      pipelineCount: workspaceSummary?.pipelines?.length || 0,
      redactionCandidateCount: workspaceSummary?.risky?.length || 0,
      topExts: workspaceSummary?.topExts || [],
    },
    activeNode: nodes.find(item => isSkillNodeType(item.type)) || nodes[0] || null,
    tokenEstimate,
    redaction: {
      defaultPolicy: 'Exclude .env, private-key-like files, and secret/token/password/key-like filenames from default context.',
      contentIncluded: false,
    },
  };
}

async function readSmallText(filePath) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_SOURCE_BYTES) return '';
  return fsp.readFile(filePath, 'utf-8');
}

async function fileExists(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function buildClaimRegisterArtifact(workspaceRoot, artifactPath) {
  const packagePath = path.join(workspaceRoot, 'package.json');
  const sourceNames = ['README.md', 'CHANGELOG.md', 'release-notes-draft.md'];
  let packageVersion = '';
  const rows = [];

  if (await fileExists(packagePath)) {
    try {
      const pkg = JSON.parse(await readSmallText(packagePath));
      packageVersion = String(pkg.version || '');
      rows.push({
        claim: `package.json version is ${packageVersion || '(missing)'}`,
        source: 'package.json',
        status: packageVersion ? 'source-of-truth' : 'needs-review',
        evidence: packageVersion || 'No version field found.',
      });
    } catch (err) {
      rows.push({
        claim: 'package.json could not be parsed',
        source: 'package.json',
        status: 'needs-review',
        evidence: err.message,
      });
    }
  }

  for (const name of sourceNames) {
    const sourcePath = path.join(workspaceRoot, name);
    if (!(await fileExists(sourcePath))) continue;
    const text = await readSmallText(sourcePath);
    const versions = [...new Set((text.match(/\b\d+\.\d+\.\d+\b/g) || []))];
    if (!versions.length) {
      rows.push({
        claim: `${name} has no semantic-version claim`,
        source: name,
        status: 'ok',
        evidence: 'No x.y.z string detected.',
      });
      continue;
    }
    for (const version of versions) {
      rows.push({
        claim: `${name} mentions version ${version}`,
        source: name,
        status: packageVersion && version !== packageVersion ? 'mismatch' : 'ok',
        evidence: packageVersion ? `package.json=${packageVersion}` : 'No package version source-of-truth.',
      });
    }
  }

  const markdown = [
    '# Claim Register',
    '',
    '| Claim | Source | Status | Evidence |',
    '| --- | --- | --- | --- |',
    ...(rows.length ? rows : [{
      claim: 'No default release claim sources found',
      source: 'workspace',
      status: 'needs-review',
      evidence: 'Add README.md, CHANGELOG.md, release-notes-draft.md, or package.json.',
    }]).map(row => `| ${row.claim.replace(/\|/g, '\\|')} | ${row.source.replace(/\|/g, '\\|')} | ${row.status} | ${row.evidence.replace(/\|/g, '\\|')} |`),
    '',
    'Generated by OrPAD local MVP run. Review before publishing.',
    '',
  ].join('\n');

  await fsp.writeFile(artifactPath, markdown, 'utf-8');
  return {
    path: relativePath(workspaceRoot, artifactPath),
    kind: 'claim-register',
    format: 'markdown',
    rows: rows.length,
    sources: [packagePath, ...sourceNames.map(name => path.join(workspaceRoot, name))]
      .filter(file => fs.existsSync(file))
      .map(file => relativePath(workspaceRoot, file)),
  };
}

async function writeJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function startLocalRun({ workspaceRoot, runbookPath, validation, workspaceSummary, approval, title }) {
  const decision = normalizeApproval(approval);
  if (!decision.allowed) {
    return {
      blocked: true,
      reason: decision.reason || 'User denied approval.',
      approval: decision,
      run: null,
      runDir: '',
      runId: '',
      contextManifest: null,
      artifactManifest: null,
    };
  }

  const runbook = await readRunbookObject(runbookPath);
  const loaded = isPipelineDocument(runbook)
    ? await loadPipelineExecutionDocument(runbookPath, runbook)
    : { doc: runbook, files: [], pipelineDir: '' };
  const result = await createRunRecord({
    workspaceRoot,
    runbookPath,
    validation,
    createdBy: 'orpad-local',
    title: title || path.basename(runbookPath),
  });
  const { runDir } = result;
  await appendRunEvent(runDir, eventRecord('run.started', {
    runId: result.runId,
    mode: 'local-mvp',
    executableNodeTypes: validation?.executableNodeTypes || [],
  }));

  const contextManifest = await buildContextManifest({
    workspaceRoot,
    runbookPath,
    validation,
    workspaceSummary,
    runbook: loaded.doc,
    contextFiles: loaded.files,
    pipelineDir: loaded.pipelineDir,
    pipelineSkills: loaded.pipelineSkills,
  });
  await writeJson(path.join(runDir, 'context', 'context-manifest.json'), contextManifest);
  await appendRunEvent(runDir, eventRecord('context.bundle.created', {
    included: contextManifest.included.length,
    excluded: contextManifest.excluded.length,
    tokenEstimate: contextManifest.tokenEstimate,
  }));

  await appendRunEvent(runDir, eventRecord('approval.requested', {
    action: decision.action,
    scope: decision.scope,
    target: decision.target,
  }));

  await appendRunEvent(runDir, eventRecord('approval.allowed', decision));

  const firstSkill = contextManifest.activeNode;
  if (firstSkill) {
    await appendRunEvent(runDir, eventRecord('node.started', {
      nodeId: firstSkill.id,
      nodeType: firstSkill.type,
      label: firstSkill.label,
    }, { nodeId: firstSkill.id }));
  }

  const artifact = await buildClaimRegisterArtifact(
    workspaceRoot,
    path.join(runDir, 'artifacts', 'claim-register.md'),
  );
  const artifactManifest = {
    version: 1,
    createdAt: nowIso(),
    artifacts: [artifact],
  };
  await writeJson(path.join(runDir, 'artifacts', 'manifest.json'), artifactManifest);
  await appendRunEvent(runDir, eventRecord('artifact.created', artifact));

  if (firstSkill) {
    await appendRunEvent(runDir, eventRecord('node.completed', {
      nodeId: firstSkill.id,
      nodeType: firstSkill.type,
      artifact: artifact.path,
    }, { nodeId: firstSkill.id }));
  }

  const run = await updateRunRecord(runDir, {
    status: 'completed',
    completedAt: nowIso(),
    approval: decision,
    artifactCount: artifactManifest.artifacts.length,
  });
  await appendRunEvent(runDir, eventRecord('run.completed', {
    artifactCount: artifactManifest.artifacts.length,
  }));
  return { ...result, run, contextManifest, artifactManifest };
}

module.exports = {
  buildContextManifest,
  collectRunbookNodes,
  startLocalRun,
};
