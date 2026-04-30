# UX/UI Probe

## Purpose

Find user-visible issues that slow down OrPAD authoring and maintenance.

## Outputs

- Write findings to `discovery/ux-ui-findings.md`.
- Stage candidates under `run.probeInboxRoot/ux-ui-probe/candidate/`.
- Include a `## Coverage Evidence` section with structured bullets that name `type`, `target`, `file` or `command`, and a short observed result so the discovery barrier can write `run.coverageManifestPath`.
- Every coverage evidence item must include a stable `id`, `observedAt`, `observationKind`, and current-run `command` or `artifact` for live app/viewport evidence.
- Record scenario rows for `open-pipes-list`, `edit-pipeline-manifest`, `inspect-graph-editor`, and `validate-broken-ref-feedback`.
- Stage inventory fragment rows under `config.inventoryStageRoot` for every notable observation: `candidate`, `deferred`, `deduped-into`, or `empty-pass`. The discovery barrier, not parallel probes, writes the merged `run.candidateInventoryPath`.
- Every inventory row must include `id`, `lensId`, `status`, `title`, `evidenceIds`, `targetIds`, `riskCheckIds`, `checkResult`, `scenarioIds`, `inspectedTargets`, and either `stagedCandidateId`, `dedupedInto`, or a concrete `reason`.
- Use target ids from `run.discoveryCoveragePolicy.targetMatrix`; do not replace target-level rows with one broad lens-level empty pass.
- Use risk check ids from the matching target. An empty-pass row may cover only one risk check and must include the concrete negative check that was attempted or observed.
- Stage one candidate per independently actionable failed risk check or tightly coupled cluster; do not bundle unrelated risk checks into one broad maintenance item.
- Empty-pass rows must include `negativeCheck.method`, `negativeCheck.expected`, and `negativeCheck.observed`.
- Empty-pass rows must name the exact file, command, selector, assertion, artifact, or observed behavior that cleared the risk. Do not use reusable text such as "current evidence directly probed", "focused tests or audit evidence", "covered without a separate actionable candidate", or "did not leave a separate actionable failure"; mark the row `deferred` when proof is not direct enough.
- Do not drop a weaker duplicate silently. Record it as `deduped-into` with the canonical candidate id and evidence ids.
- For every required risk check that does not produce a candidate, write an `empty-pass`, `deferred`, or `deduped-into` inventory row with inspected targets, scenario ids, evidence ids, and a concrete reason.

## Lenses

- Information scent: users should know whether they are editing a pipeline, graph, tree, or run.
- Navigation: nested graph layers need clear location, parent return, and viewport fit.
- Editing affordances: controls should expose valid node types only for the active surface.
- Inspector placement: graph node inspection should feel part of the graph editor.
- Feedback: validation states should explain whether something is broken, agent-ready, or only unsupported by the local MVP runner.
- Density: maintenance and authoring UI should stay compact and scannable.

## Evidence Budget

Inspect and record at least four current evidence items before writing an empty pass:

- Runbook/Pipes list surface.
- Pipeline editor Graph tab.
- Graph editor node/layer/inspector behavior.
- Manifest editor form/scroll/editing behavior.

Prefer Playwright/DOM evidence. Code evidence is acceptable only when UI automation is unavailable and the artifact explains why.

## Candidate Rules

- Provide observed behavior, expected behavior, and affected workflow.
- Include a focused verification method.
- Avoid purely subjective style changes unless they block task completion.
- Every staged candidate must include `userImpact`, `reproSteps`, `expectedBehavior`, `actualBehavior`, `sourceOfTruthTargets`, `verificationPlan`, and `coverageEvidenceIds` that point at this run's coverage evidence.
