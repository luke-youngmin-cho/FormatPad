# Triage and Scope Skill

## Purpose

Turn canonical candidates into a durable maintenance backlog and ordered cycle work plan.

## Inputs

- `run.queueRoot/candidate/*.json`
- `queue/ingestion-proof.md`
- `run.coverageManifestPath`
- `run.candidateInventoryPath`
- `reference-context.md`
- `executionPolicy.selfImprovement`

## Outputs

- `queue/triage-log.md`
- `maintenance-plan.md`
- `scope-gate.md`
- `approval-gate.md`
- Queue state transitions to queued, blocked, or rejected

## Procedure

1. Reject stale, duplicate, speculative, or generated-only candidates.
2. Block approval-required candidates that need credentials, external side effects, destructive git, signing, publishing, broad rewrites, or ambiguous product decisions.
3. If self-improvement is disabled, block candidates that modify this pipeline's source-of-truth files.
4. Before selecting a pipeline-quality or self-improvement candidate, verify that `run.coverageManifestPath` satisfies `run.discoveryCoveragePolicy.minimumLensEvidence` for at least four non-pipeline lenses.
5. Cross-check `run.candidateInventoryPath`: every target id and risk check id from `run.discoveryCoveragePolicy.targetMatrix` must have a concrete disposition, every `candidate` row must become queued, blocked, or rejected, and every `deferred`, `deduped-into`, and `empty-pass` row must appear in the triage log with its reason.
6. Score candidates with this priority order: security/trust boundary, user-visible UX, runtime bug risk, missing regression test, product intent mismatch, then pipeline quality.
7. Queue every bounded, actionable candidate that has current evidence, userImpact, reproSteps, expectedBehavior, actualBehavior, sourceOfTruthTargets, acceptance criteria, verificationPlan, and coverageEvidenceIds.
8. Select a pipeline-quality item only when it blocks pipeline execution/replay, or when all higher-priority product/app candidates are absent, blocked, rejected, or lower-confidence after evidence-backed coverage.
9. For every triage transition, write the destination state file with `state` set to `queued`, `blocked`, or `rejected`, then remove the source `candidate` state file so the item exists in only one active state directory.
10. Record every transition in `run.queueRoot/journal.jsonl` with action `triage`.
11. Do not discard low-priority valid candidates just because this cycle may not reach them. Preserve them as queued backlog or blocked/rejected records with reasons.

## Maintenance Plan Format

- Ordered cycle work plan, including all queued actionable item ids
- Full backlog table covering queued, blocked, and rejected candidates
- Inventory disposition table covering candidate, deferred, deduped-into, and empty-pass rows
- Problem statement for each queued item
- Current evidence for each queued item
- Source-of-truth target files for each queued item
- Acceptance criteria for each queued item
- Verification plan for each queued item
- Coverage evidence ids and scenario ids that justify each item
- Residual risk
- Discovery coverage summary for every lens, including empty-pass evidence
- Candidate scoring table showing ordering without dropping valid lower-priority backlog items
