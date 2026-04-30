# Implementation Loop Skill

## Purpose

Implement claimed work items one at a time without drifting into unrelated work, then continue until the queue is empty or a stop condition is reached.

## Inputs

- `run.queueRoot/claimed/*.json`
- `maintenance-plan.md`
- `scope-gate.md`
- Relevant local source files

## Outputs

- `implementation-log.md`
- Item-level files under `run.workItemArtifactRoot/<work-item-id>/`

## Procedure

1. Read the next claimed work item, reproSteps, expectedBehavior, actualBehavior, userImpact, sourceOfTruthTargets, verificationPlan, and acceptance criteria.
2. Confirm the target files match sourceOfTruthTargets and allowed target globs.
3. Edit the smallest source-of-truth files required to satisfy the acceptance criteria.
4. Add or update focused tests when risk justifies it.
5. Do not fix unrelated issues found during implementation; stage them as new candidates if needed.
6. Write an implementation log with changed files, reason for each change, and any skipped alternatives.
7. After verification/proof closes the item, return to the dispatcher for the next queued item unless a stop condition applies.

## Stop Conditions

- The queue is empty.
- Approval-required action is needed.
- The claimed item is broader than expected and should be requeued or split.
- The work cannot be verified locally.
- The evidence no longer reproduces.
- Continuing would exceed local risk, context, or authority and needs handoff.
