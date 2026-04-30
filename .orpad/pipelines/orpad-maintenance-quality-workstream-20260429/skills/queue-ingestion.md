# Queue Ingestion Skill

## Purpose

Merge parallel probe staged candidates into canonical queue state without journal races.

## Inputs

- `run.probeInboxRoot/*/candidate/*.json`
- `run.probeInboxRoot/*/inventory/*.json`
- `run.probeInboxRoot/*/events.jsonl`
- `run.coverageManifestPath`
- `run.candidateInventoryPath`
- `run.queueRoot`

## Outputs

- `queue/ingestion-proof.md` under `run.artifactRoot`
- Canonical candidate files under `run.queueRoot/candidate/`
- Canonical journal at `run.queueRoot/journal.jsonl`

## Procedure

1. Read staged candidate JSON files from each probe inbox.
2. Read `run.coverageManifestPath` and fail ingestion if any required lens coverage is missing or below policy.
3. Read probe-local inventory fragments and the merged `run.candidateInventoryPath`; verify the merged inventory is a single-writer barrier output, not a set of racing probe writes.
4. Verify that every staged candidate appears as an inventory row with `status: "candidate"`.
5. Verify that every inventory row with `status: "candidate"` has a matching staged inbox candidate file.
6. Verify that inventory rows cover every target id and every risk check id in `run.discoveryCoveragePolicy.targetMatrix`, and that empty-pass rows are risk-check-level rather than broad target-level summaries.
7. Verify that `deduped-into`, `deferred`, and `empty-pass` inventory rows have evidence-backed reasons, `checkResult`, and are not silently discarded.
8. Reject boilerplate empty-pass rows. An empty pass must cite the specific file, command, selector, assertion, artifact, or observed behavior that cleared one risk check; otherwise keep the row as `deferred`.
9. Treat deferred rows as unresolved cycle work: they do not create queue items by themselves, but they prevent `## Status: done` unless resolved, converted to a candidate, or recorded as partial/blocked cycle residue.
10. Validate required work item fields.
11. Sort candidates by severity, fingerprint, sourceNode, then id.
12. Dedupe by fingerprint and evidence file, while preserving duplicate observations in the candidate inventory as `deduped-into`.
13. Write canonical candidates under `run.queueRoot/candidate/`.
14. Append one JSONL journal event per canonical transition as actor `maintenance-quality-queue`.
15. Write the ingestion proof with counts, rejected malformed items, duplicate fingerprints, inventory target coverage, inventory risk-check coverage, inventory status counts, coverage status, and resulting canonical item ids.

## Guardrails

- This is the first node allowed to write `run.queueRoot/journal.jsonl`.
- Do not mutate queued, claimed, done, blocked, or rejected states here.
