# OrPAD Workspace Configuration

This `.orpad` folder contains OrPAD workspace assets.

Recommended layout:

```text
.orpad/
  guidelines/
    README.md
    harness-generation.md
  pipelines/
    <pipeline-id>/
      pipeline.or-pipeline
      graphs/
      trees/
      skills/
      rules/
      harness/
      runs/
```

The app ships built-in node packs from the repository-level `nodes/` folder.
User-installed node packs are managed in the OrPAD app data directory.

Future support may add:

- Workspace-local node packs under `.orpad/nodes/`.
- Workspace-level node pack lock files.
- Project-portable custom node pack resolution.
- Workspace override and conflict UI.
