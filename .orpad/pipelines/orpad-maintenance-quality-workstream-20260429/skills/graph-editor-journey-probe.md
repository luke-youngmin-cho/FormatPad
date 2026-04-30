# Graph Editor Journey Probe

## Purpose

Find workflow blockers in OrPAD graph editing by acting like a real user, not just scanning code.

## Outputs

- Write findings to `discovery/graph-editor-journey.md` under `run.artifactRoot`.
- Stage candidate work items under `run.probeInboxRoot/graph-editor-journey-probe/candidate/`.
- Optional staged events may go to `run.probeInboxRoot/graph-editor-journey-probe/events.jsonl`.
- Include a `## Coverage Evidence` section with structured bullets that name `type`, `target`, `file` or `command`, and a short observed result so the discovery barrier can write `run.coverageManifestPath`.
- Every coverage evidence item must have a stable `id`, `observedAt`, `observationKind`, and either `command` or `artifact` for app/viewport observations.
- Record scenario rows for `open-pipeline-graph-tab`, `enter-nested-graph-layer`, `return-to-parent-layer`, and `verify-viewport-fit`.
- Stage inventory fragment rows under `config.inventoryStageRoot` for every notable observation: `candidate`, `deferred`, `deduped-into`, or `empty-pass`. The discovery barrier, not parallel probes, writes the merged `run.candidateInventoryPath`.
- Every inventory row must include `id`, `lensId`, `status`, `title`, `evidenceIds`, `targetIds`, `riskCheckIds`, `checkResult`, `scenarioIds`, `inspectedTargets`, and either `stagedCandidateId`, `dedupedInto`, or a concrete `reason`.
- Use target ids from `run.discoveryCoveragePolicy.targetMatrix`; do not replace target-level rows with one broad lens-level empty pass.
- Use risk check ids from the matching target. An empty-pass row may cover only one risk check and must include the concrete negative check that was attempted or observed.
- Stage one candidate per independently actionable failed risk check or tightly coupled cluster; do not bundle unrelated risk checks into one broad maintenance item.
- Empty-pass rows must include `negativeCheck.method`, `negativeCheck.expected`, and `negativeCheck.observed`.
- Empty-pass rows must name the exact file, command, selector, assertion, artifact, or observed behavior that cleared the risk. Do not use reusable text such as "current evidence directly probed", "focused tests or audit evidence", "covered without a separate actionable candidate", or "did not leave a separate actionable failure"; mark the row `deferred` when proof is not direct enough.
- Do not drop a weaker duplicate silently. Record it as `deduped-into` with the canonical candidate id and evidence ids.
- For every required risk check that does not produce a candidate, write an `empty-pass`, `deferred`, or `deduped-into` inventory row with inspected targets, scenario ids, evidence ids, and a concrete reason.

## Journey Checklist

1. Open or inspect a pipeline graph with nested graph references.
2. Check whether the current graph layer is visible.
3. Check whether a user can go back to the parent layer.
4. Check whether entering a graph layer fits the viewport to the visible graph.
5. Check whether node inspector controls match the selected graph or tree editor surface.
6. Check whether disabled/run-only states explain what can actually execute locally.

## Evidence Budget

Do not emit an empty pass until you have recorded at least three evidence items:

- One app, DOM, or screenshot/viewport observation from the pipeline Graph tab.
- One code or test path that implements the observed behavior.
- One nested-layer or parent-return observation.

If automation is unavailable, use current renderer/test source evidence and explain the limitation.

## Candidate Rules

- A candidate needs current evidence from the app, DOM, test, screenshot, or code path.
- Do not report a stale issue if the current UI already handles it.
- Prefer user-visible blockers over cosmetic polish.
- Include acceptance criteria that can be checked with a focused Electron test or manual DOM evidence.
- Every staged candidate must include `userImpact`, `reproSteps`, `expectedBehavior`, `actualBehavior`, `sourceOfTruthTargets`, `verificationPlan`, and `coverageEvidenceIds` that reference the evidence ids above.
