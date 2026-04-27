# OrPAD Agent Guide

This project is being transitioned from an old autonomous Claude harness to
supervised Codex work. Treat the sibling harness directory as the task ledger
and prompt source, not as an execution engine.

## Layout

- `src/main/` - Electron main process, preload, updater, future privileged IPC.
- `src/renderer/` - Vanilla JS renderer, CodeMirror setup, viewers, UI.
- `src/web/` - Web/PWA adapter and entrypoint.
- `scripts/` - build and bundle-size tooling.
- `tests/e2e/` - Playwright smoke tests.
- `SECURITY.md` - current security baseline and Phase 1 constraints.

## Commands

- `npm run build:renderer` - default verification for renderer/desktop changes.
- `npm run size` - web bundle and installer-size budget report.
- `npm run test:electron -- --workers=1 --grep <name>` - focused Electron E2E.
- `npm run test:web` - web-only Playwright project after web build output exists.
- `npm run dist:win` - packaging verification; ask before running because it is slow.

## Safety Rules

- Do not commit, push, reset, or clean without explicit user approval.
- Do not install dependencies or use network access without explaining the need and
  getting approval.
- Do not place generated source docs under `docs/`; it is build output.
- Do not store API keys, tokens, or secrets in `localStorage`.
- For AI provider keys, use Electron `safeStorage` on desktop and explicit
  IndexedDB risk consent on web.
- For MCP and terminal work, require user approval before side-effecting tool or
  command execution.
- AI-suggested shell commands may be prefilled for the user, but never
  auto-executed.
- Keep `SECURITY.md` updated when changing IPC, CSP, key storage, URL fetching,
  terminal execution, MCP integration, or telemetry.

## Done Criteria

- Match the active task brief from the harness task ledger.
- Run relevant verification or explicitly document why it was not run.
- Update the matching harness task summary.
- End the summary with `## Status: done`, `## Status: partial`, or
  `## Status: blocked`.
