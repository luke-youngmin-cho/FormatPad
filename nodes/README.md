# OrPAD Built-In Node Packs

This folder contains node packs shipped with OrPAD.

Built-in packs are immutable at runtime and are loaded before user-installed packs.

Recommended loading order:

1. Built-in packs from this folder.
2. User-installed packs from the OrPAD app data directory.

Core `orpad.*` node type ids are reserved for built-in OrPAD packs.

Future support may add workspace-local node packs under `.orpad/nodes/`, workspace-level node pack locks, and project-portable custom pack resolution. These are intentionally not part of the initial node pack structure.
