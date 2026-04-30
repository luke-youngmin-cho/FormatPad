# Verification and Proof Skill

## Purpose

Verify each claimed item change and close the claimed queue item with replayable proof.

## Inputs

- Claimed work item for the current worker-loop iteration
- `implementation-log.md`
- Relevant test files and commands

## Outputs

- `verification-gate.md`
- `proof-of-value.md`
- Item-level proof under `run.workItemArtifactRoot/<work-item-id>/`
- Queue transition to done, blocked, or requeued

## Procedure

1. Run focused local verification commands that match touched files and acceptance criteria.
2. Include default verification commands when they are relevant and affordable.
3. For node-pack, graph, or pipeline contract changes, run `npm run audit:orpad-node-schemas -- .orpad/pipelines/orpad-maintenance-quality-workstream-20260429/pipeline.or-pipeline`.
4. Record command names, pass/fail result, and important output summaries.
5. If verification cannot run, record why and whether the item is blocked or partial.
6. Move the item to done only when acceptance criteria are met.
7. For each close transition, write the destination state file with `state` set to `done`, `blocked`, or `queued`, then remove the source `claimed` state file so the item exists in only one active state directory.
8. Write proof-of-value in product terms: what became safer, clearer, faster, or more reliable.
9. If the item closes as `done` or `queued`, hand control back to the dispatcher unless a stop condition applies.

## Local Verification Boundary

Local read/build/test/check commands are allowed by this pipeline. Dependency installs, networked services, publishing, signing, credential use, destructive git, or broad side-effecting commands require approval.
