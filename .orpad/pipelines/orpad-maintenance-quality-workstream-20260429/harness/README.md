# Generated Harness Area

This directory is reserved for generated run evidence.

The source-of-truth pipeline lives in:

- `pipeline.or-pipeline`
- `graphs/`
- `trees/`
- `skills/`
- `rules/`

Agents may write latest run evidence under `generated/latest-run/` and durable future runner evidence under `runs/<runId>/`. Those generated paths should stay out of git. Generated evidence can justify a source-of-truth fix, but restoring or polishing generated evidence alone is not a valid maintenance improvement.
