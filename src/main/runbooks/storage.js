const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

const RUN_RECORD_VERSION = 1;
const EVENT_SCHEMA_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function createRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function relativePath(root, target) {
  return path.relative(path.resolve(root), path.resolve(target)).replace(/\\/g, '/');
}

function isPipelineFilePath(filePath) {
  return /\.or-pipeline$/i.test(String(filePath || ''));
}

function runRoot(workspaceRoot, pipelinePath = '') {
  if (isPipelineFilePath(pipelinePath)) {
    return path.join(path.dirname(path.resolve(pipelinePath)), 'runs');
  }
  return path.join(path.resolve(workspaceRoot), '.orch-runs');
}

function runRecordFileName(pipelinePath = '') {
  return isPipelineFilePath(pipelinePath) ? 'run.or-run' : 'run.json';
}

function runDir(workspaceRoot, runId, pipelinePath = '') {
  return path.join(runRoot(workspaceRoot, pipelinePath), String(runId));
}

function eventRecord(type, payload = {}, options = {}) {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: options.eventId || crypto.randomUUID(),
    type,
    timestamp: options.timestamp || nowIso(),
    redacted: options.redacted !== false,
    nodeId: options.nodeId || null,
    payload: payload && typeof payload === 'object' ? payload : {},
  };
}

async function appendRunEvent(targetRunDir, event) {
  const record = event?.schemaVersion ? event : eventRecord(event?.type || 'run.event', event?.payload || {}, event || {});
  await fsp.mkdir(targetRunDir, { recursive: true });
  await fsp.appendFile(
    path.join(targetRunDir, 'events.jsonl'),
    JSON.stringify(record) + '\n',
    'utf-8',
  );
  return record;
}

async function createRunRecord({ workspaceRoot, runbookPath, validation, createdBy = 'orpad-local', title = '' }) {
  if (!workspaceRoot) throw new Error('Workspace root is required.');
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const runId = createRunId();
  const targetRunDir = runDir(resolvedWorkspace, runId, runbookPath);
  const createdAt = nowIso();
  const runbookRelativePath = runbookPath ? relativePath(resolvedWorkspace, runbookPath) : '';
  const isPipeline = isPipelineFilePath(runbookPath);
  const runRecord = {
    version: RUN_RECORD_VERSION,
    runId,
    status: 'created',
    title: title || 'OrPAD run',
    createdAt,
    updatedAt: createdAt,
    createdBy,
    workspaceRoot: resolvedWorkspace,
    runbookPath: runbookRelativePath,
    pipelinePath: isPipeline ? runbookRelativePath : '',
    targetPath: runbookRelativePath,
    targetKind: isPipeline ? 'pipeline' : 'legacy-runbook',
    trustLevel: validation?.trustLevel || 'local-authored',
    schemaVersion: validation?.schemaVersion || '',
    format: validation?.format || '',
    entryGraph: validation?.entryGraph || '',
    nodeCount: validation?.nodeCount || 0,
    canExecute: validation?.canExecute === true,
  };

  await fsp.mkdir(path.join(targetRunDir, 'artifacts'), { recursive: true });
  await fsp.mkdir(path.join(targetRunDir, 'context'), { recursive: true });
  await fsp.mkdir(path.join(targetRunDir, 'checkpoints'), { recursive: true });
  await fsp.writeFile(path.join(targetRunDir, runRecordFileName(runbookPath)), JSON.stringify(runRecord, null, 2), 'utf-8');
  await appendRunEvent(targetRunDir, eventRecord('run.created', {
    runId,
    runbookPath: runbookRelativePath,
    pipelinePath: runRecord.pipelinePath,
    trustLevel: runRecord.trustLevel,
    canExecute: runRecord.canExecute,
  }));
  if (validation) {
    await appendRunEvent(targetRunDir, eventRecord('runbook.validated', {
      ok: validation.ok,
      canExecute: validation.canExecute,
      diagnostics: validation.diagnostics || [],
    }));
  }
  return { runId, runDir: targetRunDir, run: runRecord };
}

async function updateRunRecord(targetRunDir, patch = {}) {
  const filePath = await findRunRecordPath(targetRunDir);
  const existing = await readJsonIfExists(filePath, null);
  if (!existing) throw new Error('Run record not found.');
  const updatedAt = nowIso();
  const next = {
    ...existing,
    ...patch,
    updatedAt,
  };
  await fsp.writeFile(filePath, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function findRunRecordPath(targetRunDir) {
  const pipelineRunPath = path.join(targetRunDir, 'run.or-run');
  try {
    await fsp.access(pipelineRunPath);
    return pipelineRunPath;
  } catch {}
  return path.join(targetRunDir, 'run.json');
}

async function readRunRecord(targetRunDir) {
  const run = await readJsonIfExists(await findRunRecordPath(targetRunDir), null);
  if (!run) throw new Error('Run record not found.');
  let events = [];
  try {
    const raw = await fsp.readFile(path.join(targetRunDir, 'events.jsonl'), 'utf-8');
    events = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch {
    events = [];
  }
  return { run, events };
}

module.exports = {
  RUN_RECORD_VERSION,
  EVENT_SCHEMA_VERSION,
  createRunId,
  runRoot,
  runDir,
  isPipelineFilePath,
  eventRecord,
  appendRunEvent,
  createRunRecord,
  updateRunRecord,
  readRunRecord,
};
