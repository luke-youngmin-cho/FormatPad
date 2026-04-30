# OrPAD Pipelines

Workspace pipelines live under `.orpad/pipelines/<pipeline-id>/`.

Recommended pipeline shape:

```text
<pipeline-id>/
  pipeline.or-pipeline
  graphs/
    <graph-name>.or-graph
  trees/
    <tree-name>.or-tree
  skills/
    <skill-name>.md
  rules/
    <rule-name>.or-rule
  harness/
    generated/
  runs/
```

`harness/generated/` and `runs/` store generated execution evidence and are ignored by git. Durable design assets should live in `pipeline.or-pipeline`, `graphs/`, `trees/`, `skills/`, and `rules/`.

Maintenance pipelines are repeatable cycles. A `latest-run/summary.md` status such as `## Status: done` closes only that cycle; it does not mean the pipeline definition is complete or inactive.
