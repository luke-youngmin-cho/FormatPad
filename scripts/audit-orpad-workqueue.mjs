import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { auditWorkQueue } = require('../src/main/runbooks/work-items');

function usage() {
  return 'Usage: node scripts/audit-orpad-workqueue.mjs <pipeline.or-pipeline> [queueRoot]';
}

function normalizeRef(baseDir, ref) {
  return path.resolve(baseDir, String(ref || '').replace(/\\/g, path.sep));
}

async function resolveQueueConfig(pipelinePath, overrideQueueRoot) {
  const resolvedPipelinePath = path.resolve(pipelinePath);
  const pipelineDir = path.dirname(resolvedPipelinePath);
  const pipeline = JSON.parse(await fs.readFile(resolvedPipelinePath, 'utf-8'));
  if (overrideQueueRoot) {
    return {
      queueRoot: normalizeRef(pipelineDir, overrideQueueRoot),
      queueProtocol: pipeline?.run?.queueProtocol || {},
    };
  }
  const queueRoot = pipeline?.run?.queueRoot;
  if (!queueRoot) throw new Error('Pipeline run.queueRoot is missing. Pass queueRoot as the second argument.');
  return {
    queueRoot: normalizeRef(pipelineDir, queueRoot),
    queueProtocol: pipeline?.run?.queueProtocol || {},
  };
}

const [, , pipelinePath, queueRootArg] = process.argv;
if (!pipelinePath) {
  console.error(usage());
  process.exit(2);
}

try {
  const { queueRoot, queueProtocol } = await resolveQueueConfig(pipelinePath, queueRootArg);
  const result = await auditWorkQueue(queueRoot, { queueProtocol });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  console.error(err?.message || String(err));
  process.exit(2);
}
