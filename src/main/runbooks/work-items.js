const fs = require('fs');
const path = require('path');

const WORK_ITEM_SCHEMA_VERSION = 'orpad.workItem.v1';
const WORK_ITEM_STATES = Object.freeze(['candidate', 'queued', 'claimed', 'done', 'blocked', 'rejected']);
const REQUIRED_WORK_ITEM_FIELDS = Object.freeze([
  'id',
  'schemaVersion',
  'state',
  'title',
  'sourceNode',
  'contentArea',
  'issueType',
  'severity',
  'confidence',
  'fingerprint',
  'evidence',
  'acceptanceCriteria',
  'userImpact',
  'reproSteps',
  'expectedBehavior',
  'actualBehavior',
  'sourceOfTruthTargets',
  'verificationPlan',
  'coverageEvidenceIds',
  'approvalRequired',
  'createdAt',
  'updatedAt',
]);
const REQUIRED_JOURNAL_FIELDS = Object.freeze([
  'actor',
  'action',
  'itemId',
  'fromState',
  'toState',
  'timestamp',
  'evidence',
]);
const JOURNAL_FROM_STATES = Object.freeze(['inbox', ...WORK_ITEM_STATES]);
const JOURNAL_ACTION_TRANSITIONS = Object.freeze({
  ingest: [['inbox', 'candidate']],
  triage: [['candidate', 'queued'], ['candidate', 'blocked'], ['candidate', 'rejected']],
  claim: [['queued', 'claimed']],
  close: [['claimed', 'done'], ['claimed', 'blocked'], ['claimed', 'queued']],
});

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function workItemDiagnostic(code, message, details = {}) {
  return { code, message, ...details };
}

function timestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validateWorkItem(item, options = {}) {
  const diagnostics = [];
  const expectedState = options.expectedState ? String(options.expectedState) : '';
  const itemId = item && typeof item === 'object' ? String(item.id || '') : '';

  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_INVALID', 'Work item must be a JSON object.', {
      state: expectedState || undefined,
    }));
    return diagnostics;
  }

  for (const field of REQUIRED_WORK_ITEM_FIELDS) {
    if (isBlank(item[field])) {
      diagnostics.push(workItemDiagnostic('WORK_ITEM_FIELD_MISSING', `Work item must include ${field}.`, {
        itemId: itemId || undefined,
        field,
        state: expectedState || undefined,
      }));
    }
  }

  if (item.schemaVersion && item.schemaVersion !== WORK_ITEM_SCHEMA_VERSION) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_SCHEMA_UNSUPPORTED', `Work item schemaVersion must be ${WORK_ITEM_SCHEMA_VERSION}.`, {
      itemId: itemId || undefined,
      schemaVersion: item.schemaVersion,
      state: expectedState || undefined,
    }));
  }

  if (item.state && !WORK_ITEM_STATES.includes(String(item.state))) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_STATE_UNKNOWN', 'Work item state must be a canonical queue state.', {
      itemId: itemId || undefined,
      state: item.state,
    }));
  }

  if (expectedState && item.state && item.state !== expectedState) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_STATE_MISMATCH', 'Work item state must match its queue state directory.', {
      itemId: itemId || undefined,
      expectedState,
      actualState: item.state,
    }));
  }

  if (item.evidence !== undefined && (!Array.isArray(item.evidence) || item.evidence.length === 0)) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_EVIDENCE_INVALID', 'Work item evidence must be a non-empty array.', {
      itemId: itemId || undefined,
      state: expectedState || undefined,
    }));
  }

  if (item.acceptanceCriteria !== undefined && (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length === 0)) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_ACCEPTANCE_CRITERIA_INVALID', 'Work item acceptanceCriteria must be a non-empty array.', {
      itemId: itemId || undefined,
      state: expectedState || undefined,
    }));
  }

  if (item.reproSteps !== undefined && (!Array.isArray(item.reproSteps) || item.reproSteps.length === 0)) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_REPRO_STEPS_INVALID', 'Work item reproSteps must be a non-empty array.', {
      itemId: itemId || undefined,
      state: expectedState || undefined,
    }));
  }

  if (item.sourceOfTruthTargets !== undefined && (!Array.isArray(item.sourceOfTruthTargets) || item.sourceOfTruthTargets.length === 0)) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_SOURCE_TARGETS_INVALID', 'Work item sourceOfTruthTargets must be a non-empty array.', {
      itemId: itemId || undefined,
      state: expectedState || undefined,
    }));
  }

  if (item.coverageEvidenceIds !== undefined && (!Array.isArray(item.coverageEvidenceIds) || item.coverageEvidenceIds.length === 0)) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_COVERAGE_EVIDENCE_IDS_INVALID', 'Work item coverageEvidenceIds must be a non-empty array.', {
      itemId: itemId || undefined,
      state: expectedState || undefined,
    }));
  }

  for (const field of ['userImpact', 'expectedBehavior', 'actualBehavior', 'verificationPlan']) {
    if (item[field] !== undefined && isBlank(item[field])) {
      diagnostics.push(workItemDiagnostic('WORK_ITEM_ACTIONABILITY_FIELD_EMPTY', `Work item ${field} must be non-empty when provided.`, {
        itemId: itemId || undefined,
        field,
        state: expectedState || undefined,
      }));
    }
  }

  if (item.approvalRequired !== undefined && typeof item.approvalRequired !== 'boolean') {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_APPROVAL_REQUIRED_INVALID', 'Work item approvalRequired must be a boolean.', {
      itemId: itemId || undefined,
      state: expectedState || undefined,
    }));
  }

  const createdAt = timestampMs(item.createdAt);
  const updatedAt = timestampMs(item.updatedAt);
  if (!isBlank(item.createdAt) && createdAt === null) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_TIMESTAMP_INVALID', 'Work item createdAt must be a valid timestamp.', {
      itemId: itemId || undefined,
      field: 'createdAt',
      value: item.createdAt,
      state: expectedState || undefined,
    }));
  }
  if (!isBlank(item.updatedAt) && updatedAt === null) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_TIMESTAMP_INVALID', 'Work item updatedAt must be a valid timestamp.', {
      itemId: itemId || undefined,
      field: 'updatedAt',
      value: item.updatedAt,
      state: expectedState || undefined,
    }));
  }
  if (createdAt !== null && updatedAt !== null && updatedAt < createdAt) {
    diagnostics.push(workItemDiagnostic('WORK_ITEM_TIMESTAMP_ORDER_INVALID', 'Work item updatedAt must not be earlier than createdAt.', {
      itemId: itemId || undefined,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      state: expectedState || undefined,
    }));
  }

  return diagnostics;
}

function validateJournalEvent(event, options = {}) {
  const diagnostics = [];
  const line = options.line;

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_EVENT_INVALID', 'Queue journal event must be a JSON object.', {
      line,
    }));
    return diagnostics;
  }

  for (const field of REQUIRED_JOURNAL_FIELDS) {
    if (isBlank(event[field])) {
      diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_FIELD_MISSING', `Queue journal event must include ${field}.`, {
        line,
        field,
        itemId: event.itemId || undefined,
      }));
    }
  }

  if (!isBlank(event.fromState) && !JOURNAL_FROM_STATES.includes(String(event.fromState))) {
    diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_FROM_STATE_UNKNOWN', 'Queue journal fromState must be inbox or a canonical queue state.', {
      line,
      itemId: event.itemId || undefined,
      fromState: event.fromState,
    }));
  }

  if (!isBlank(event.toState) && !WORK_ITEM_STATES.includes(String(event.toState))) {
    diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_TO_STATE_UNKNOWN', 'Queue journal toState must be a canonical queue state.', {
      line,
      itemId: event.itemId || undefined,
      toState: event.toState,
    }));
  }

  if (!isBlank(event.action)) {
    const action = String(event.action);
    const transitions = JOURNAL_ACTION_TRANSITIONS[action];
    if (!transitions) {
      diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_ACTION_UNKNOWN', 'Queue journal action must be a known queue transition action.', {
        line,
        itemId: event.itemId || undefined,
        action,
      }));
    } else if (!isBlank(event.fromState) && !isBlank(event.toState)) {
      const fromState = String(event.fromState);
      const toState = String(event.toState);
      if (!transitions.some(([from, to]) => from === fromState && to === toState)) {
        diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_TRANSITION_INVALID', 'Queue journal action must match its fromState and toState.', {
          line,
          itemId: event.itemId || undefined,
          action,
          fromState,
          toState,
        }));
      }
    }
  }

  if (!isBlank(event.timestamp) && timestampMs(event.timestamp) === null) {
    diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_TIMESTAMP_INVALID', 'Queue journal timestamp must be a valid timestamp.', {
      line,
      itemId: event.itemId || undefined,
      timestamp: event.timestamp,
    }));
  }

  return diagnostics;
}

function expectedJournalActor(event, options = {}) {
  const action = String(event?.action || '');
  const protocol = options.queueProtocol || {};
  const singleWriter = protocol.singleWriter && typeof protocol.singleWriter === 'object' ? protocol.singleWriter : {};
  if (action === 'ingest') return protocol.ingestPolicy?.journalActor || singleWriter.ingest || '';
  return singleWriter[action] || '';
}

function validateJournalReplay(events, options = {}) {
  const diagnostics = [];
  const eventsByItem = new Map();

  for (const event of events) {
    if (!eventsByItem.has(event.itemId)) eventsByItem.set(event.itemId, []);
    eventsByItem.get(event.itemId).push(event);
  }

  for (const [itemId, itemEvents] of eventsByItem.entries()) {
    let currentState = 'inbox';
    let previousTimestamp = null;
    itemEvents.forEach((event, index) => {
      const expectedActor = expectedJournalActor(event, options);
      if (expectedActor && event.actor !== expectedActor) {
        diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_ACTOR_MISMATCH', 'Queue journal actor must match the queueProtocol single-writer contract.', {
          itemId,
          line: event.line,
          action: event.action,
          expectedActor,
          actualActor: event.actor,
        }));
      }
      if (event.fromState !== currentState) {
        diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_REPLAY_STATE_MISMATCH', 'Queue journal transitions must replay from the previous item state.', {
          itemId,
          line: event.line,
          expectedFromState: currentState,
          actualFromState: event.fromState,
          toState: event.toState,
        }));
      }
      if (index === 0 && (event.fromState !== 'inbox' || event.toState !== 'candidate')) {
        diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_REPLAY_START_INVALID', 'First queue journal transition for an item must be inbox to candidate.', {
          itemId,
          line: event.line,
          fromState: event.fromState,
          toState: event.toState,
        }));
      }
      const currentTimestamp = timestampMs(event.timestamp);
      if (previousTimestamp !== null && currentTimestamp !== null && currentTimestamp < previousTimestamp) {
        diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_TIMESTAMP_ORDER_INVALID', 'Queue journal timestamps must not move backward for the same item.', {
          itemId,
          line: event.line,
          timestamp: event.timestamp,
        }));
      }
      if (currentTimestamp !== null) previousTimestamp = currentTimestamp;
      currentState = event.toState;
    });
  }

  return diagnostics;
}

async function readJsonFile(filePath) {
  const source = await fs.promises.readFile(filePath, 'utf-8');
  return JSON.parse(source);
}

async function listJsonFiles(dirPath) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map(entry => path.join(dirPath, entry.name));
}

async function collectStagedInboxCandidates(queueRoot) {
  const inboxRoot = path.join(queueRoot, 'inbox');
  let probeEntries = [];
  try {
    probeEntries = await fs.promises.readdir(inboxRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const candidates = [];
  for (const probeEntry of probeEntries) {
    if (!probeEntry.isDirectory()) continue;
    const probeId = probeEntry.name;
    const candidateDir = path.join(inboxRoot, probeId, 'candidate');
    for (const filePath of await listJsonFiles(candidateDir)) {
      candidates.push({ probeId, path: filePath });
    }
  }
  return candidates;
}

function queueRelativePath(queueRoot, filePath) {
  return path.relative(queueRoot, filePath).replace(/\\/g, '/');
}

function inboxEvidencePath(evidence) {
  const normalized = String(evidence || '').replace(/\\/g, '/');
  const index = normalized.indexOf('inbox/');
  return index >= 0 ? normalized.slice(index) : '';
}

async function auditWorkQueue(queueRoot, options = {}) {
  const resolvedQueueRoot = path.resolve(String(queueRoot || ''));
  const diagnostics = [];
  const items = [];
  const stagedCandidates = [];
  const idsByState = new Map();
  const itemStateKeys = new Set();
  const idsByFingerprint = new Map();
  const stagedPathsById = new Map();

  let stagedCandidateFiles = [];
  try {
    stagedCandidateFiles = await collectStagedInboxCandidates(resolvedQueueRoot);
  } catch (err) {
    diagnostics.push(workItemDiagnostic('WORK_QUEUE_INBOX_UNREADABLE', 'Queue inbox could not be read.', {
      path: path.join(resolvedQueueRoot, 'inbox'),
      error: err.message,
    }));
  }

  for (const stagedFile of stagedCandidateFiles) {
    let item;
    try {
      item = await readJsonFile(stagedFile.path);
    } catch (err) {
      diagnostics.push(workItemDiagnostic('WORK_QUEUE_INBOX_CANDIDATE_JSON_INVALID', 'Staged inbox candidate must contain valid JSON.', {
        probeId: stagedFile.probeId,
        path: stagedFile.path,
        error: err.message,
      }));
      continue;
    }

    const itemId = String(item?.id || path.basename(stagedFile.path, '.json'));
    stagedCandidates.push({
      id: itemId,
      probeId: stagedFile.probeId,
      path: stagedFile.path,
      coverageEvidenceIds: Array.isArray(item?.coverageEvidenceIds) ? item.coverageEvidenceIds : [],
    });
    if (!stagedPathsById.has(itemId)) stagedPathsById.set(itemId, []);
    stagedPathsById.get(itemId).push(stagedFile.path);
    for (const itemDiagnostic of validateWorkItem(item, { expectedState: 'candidate' })) {
      diagnostics.push({ ...itemDiagnostic, path: stagedFile.path, probeId: stagedFile.probeId });
    }
  }

  for (const [itemId, stagedPaths] of stagedPathsById.entries()) {
    if (stagedPaths.length > 1) {
      diagnostics.push(workItemDiagnostic('WORK_QUEUE_INBOX_CANDIDATE_DUPLICATE', 'A staged inbox candidate id must be unique before ingestion.', {
        itemId,
        paths: stagedPaths,
      }));
    }
  }

  for (const state of WORK_ITEM_STATES) {
    const stateDir = path.join(resolvedQueueRoot, state);
    let entries = [];
    try {
      entries = await fs.promises.readdir(stateDir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        diagnostics.push(workItemDiagnostic('WORK_QUEUE_STATE_DIR_UNREADABLE', 'Queue state directory could not be read.', {
          state,
          path: stateDir,
          error: err.message,
        }));
      }
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const filePath = path.join(stateDir, entry.name);
      let item;
      try {
        item = await readJsonFile(filePath);
      } catch (err) {
        diagnostics.push(workItemDiagnostic('WORK_ITEM_JSON_INVALID', 'Work item file must contain valid JSON.', {
          state,
          path: filePath,
          error: err.message,
        }));
        continue;
      }

      const itemId = String(item?.id || path.basename(entry.name, '.json'));
      items.push({
        id: itemId,
        state,
        path: filePath,
        coverageEvidenceIds: Array.isArray(item?.coverageEvidenceIds) ? item.coverageEvidenceIds : [],
      });
      itemStateKeys.add(`${itemId}\0${state}`);
      if (!idsByState.has(itemId)) idsByState.set(itemId, new Set());
      idsByState.get(itemId).add(state);
      if (!isBlank(item?.fingerprint)) {
        const fingerprint = String(item.fingerprint);
        if (!idsByFingerprint.has(fingerprint)) idsByFingerprint.set(fingerprint, new Set());
        idsByFingerprint.get(fingerprint).add(itemId);
      }
      for (const itemDiagnostic of validateWorkItem(item, { expectedState: state })) {
        diagnostics.push({ ...itemDiagnostic, path: filePath });
      }
    }
  }

  for (const [itemId, states] of idsByState.entries()) {
    if (states.size > 1) {
      diagnostics.push(workItemDiagnostic('WORK_ITEM_DUPLICATE_ACTIVE_STATE', 'Work item must appear in only one active queue state directory.', {
        itemId,
        states: [...states].sort(),
      }));
    }
  }

  for (const [fingerprint, itemIds] of idsByFingerprint.entries()) {
    if (itemIds.size > 1) {
      diagnostics.push(workItemDiagnostic('WORK_ITEM_DUPLICATE_FINGERPRINT', 'Work item fingerprints must be unique across active queue items.', {
        fingerprint,
        itemIds: [...itemIds].sort(),
      }));
    }
  }

  const journalPath = path.join(resolvedQueueRoot, 'journal.jsonl');
  const journalEvents = [];
  try {
    const journal = await fs.promises.readFile(journalPath, 'utf-8');
    journal.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_JSON_INVALID', 'Queue journal must contain valid JSONL.', {
          path: journalPath,
          line: index + 1,
          error: err.message,
        }));
        return;
      }

      const lineNumber = index + 1;
      for (const journalDiagnostic of validateJournalEvent(event, { line: lineNumber })) {
        diagnostics.push({ ...journalDiagnostic, path: journalPath });
      }
      if (
        event
        && typeof event === 'object'
        && !Array.isArray(event)
        && !isBlank(event.itemId)
        && !isBlank(event.actor)
        && !isBlank(event.action)
        && !isBlank(event.fromState)
        && !isBlank(event.toState)
        && JOURNAL_FROM_STATES.includes(String(event.fromState))
        && WORK_ITEM_STATES.includes(String(event.toState))
      ) {
        journalEvents.push({
          itemId: String(event.itemId),
          actor: String(event.actor),
          action: String(event.action),
          fromState: String(event.fromState),
          toState: String(event.toState),
          timestamp: String(event.timestamp),
          line: lineNumber,
        });
      }
    });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_UNREADABLE', 'Queue journal could not be read.', {
        path: journalPath,
        error: err.message,
      }));
    }
  }

  diagnostics.push(...validateJournalReplay(journalEvents, options));

  const ingestedIds = new Set(journalEvents
    .filter(event => event.action === 'ingest' && event.fromState === 'inbox' && event.toState === 'candidate')
    .map(event => event.itemId));
  for (const stagedCandidate of stagedCandidates) {
    if (!ingestedIds.has(stagedCandidate.id)) {
      diagnostics.push(workItemDiagnostic('WORK_QUEUE_INBOX_CANDIDATE_NOT_INGESTED', 'Every staged inbox candidate must have an ingest journal transition.', {
        itemId: stagedCandidate.id,
        probeId: stagedCandidate.probeId,
        path: stagedCandidate.path,
      }));
    }
  }
  for (const event of journalEvents.filter(item => item.action === 'ingest')) {
    if (!stagedPathsById.has(event.itemId)) {
      diagnostics.push(workItemDiagnostic('WORK_QUEUE_INGEST_WITHOUT_STAGED_CANDIDATE', 'Every ingest journal transition must correspond to a staged inbox candidate.', {
        itemId: event.itemId,
        line: event.line,
      }));
      continue;
    }
    const evidencePath = inboxEvidencePath(event.evidence);
    if (evidencePath && !stagedPathsById.get(event.itemId).some(filePath => queueRelativePath(resolvedQueueRoot, filePath) === evidencePath)) {
      diagnostics.push(workItemDiagnostic('WORK_QUEUE_INGEST_EVIDENCE_MISMATCH', 'Ingest journal evidence should point at the staged inbox candidate file for the item.', {
        itemId: event.itemId,
        line: event.line,
        evidence: event.evidence,
      }));
    }
  }

  const journaledItemStates = new Set(journalEvents.map(event => `${event.itemId}\0${event.toState}`));
  for (const { id, state, path: itemPath } of items) {
    if (!journaledItemStates.has(`${id}\0${state}`)) {
      diagnostics.push(workItemDiagnostic('WORK_QUEUE_STATE_FILE_UNJOURNALED', 'Queue state file must have a matching journal transition.', {
        itemId: id,
        state,
        path: itemPath,
      }));
    }
  }

  const latestJournalStateByItem = new Map();
  for (const event of journalEvents) latestJournalStateByItem.set(event.itemId, event);
  for (const [itemId, event] of latestJournalStateByItem.entries()) {
    if (!itemStateKeys.has(`${itemId}\0${event.toState}`)) {
      diagnostics.push(workItemDiagnostic('WORK_QUEUE_JOURNAL_FINAL_STATE_MISSING', 'Latest journal transition must have a matching queue state file.', {
        itemId,
        state: event.toState,
        line: event.line,
      }));
    }
  }

  return {
    ok: diagnostics.length === 0,
    queueRoot: resolvedQueueRoot,
    stagedCandidateCount: stagedCandidates.length,
    stagedCandidates,
    itemCount: items.length,
    items,
    diagnostics,
  };
}

module.exports = {
  JOURNAL_ACTION_TRANSITIONS,
  REQUIRED_JOURNAL_FIELDS,
  REQUIRED_WORK_ITEM_FIELDS,
  WORK_ITEM_SCHEMA_VERSION,
  WORK_ITEM_STATES,
  auditWorkQueue,
  validateJournalEvent,
  validateWorkItem,
};
