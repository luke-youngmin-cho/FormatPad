# Queue Harness Validation

Use this skill after `orpad.workQueue` ingests staged probe outputs and before `orpad.triage` mutates canonical queue state.

When running inside the OrPAD repository, prefer the read-only checker:

```bash
npm run audit:orpad-queue -- <path-to-pipeline.or-pipeline>
```

## Required Checks

- Every configured probe has an inbox under `queue/inbox/<probe-node-id>/`.
- Every probe wrote either staged candidate JSON under `queue/inbox/<probe-node-id>/candidate/` or an empty-pass event in `events.jsonl`.
- Probe stages do not write canonical state directories or append directly to `queue/journal.jsonl`.
- `orpad.workQueue` is the single writer for staged candidate ingestion into `queue/candidate/`.
- Canonical candidate files parse as JSON and contain `schemaVersion`, `id`, `state`, `title`, `sourceNode`, `contentArea`, `issueType`, `severity`, `confidence`, `fingerprint`, `evidence`, `acceptanceCriteria`, `approvalRequired`, `createdAt`, and `updatedAt`.
- `state` must match the canonical queue directory that contains the item, or the validator must report a state mismatch.
- No work item id appears in more than one active state directory.
- Canonical candidate fingerprints are unique after ingestion.
- If the pipeline declares `executionPolicy.selfImprovement`, canonical candidates obey it. Generated run evidence may appear in evidence fields, but candidates must not use generated evidence paths as their only write targets.
- `queue/journal.jsonl` parses as JSONL.
- Ingestion journal entries use `actor: maintenance-quality-queue`, `action: ingest`, `fromState: inbox`, and `toState: candidate`.
- Ingestion order follows the graph's stable order policy.

## Output

Write a validation artifact named by the graph or pipeline, normally `harness/generated/latest-run/artifacts/queue-harness-validation.md`, with:

- `Result: PASS`, `WARN`, or `FAIL`
- probe inbox summary
- staged and canonical candidate counts
- duplicate handling
- journal parse result
- single-writer result
- self-improvement policy result, when present
- deterministic ordering result
- any blocker that should stop triage
