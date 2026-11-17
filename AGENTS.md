# dsh-runtime-cursor Contributor Guide

Cordis `agentRuntime` adapter (`@local/dsh-runtime-cursor`) exposing `cursor` sessions via `@cursor/sdk` and local Cursor authentication. Separate from the `@local/dsh-cursor` LLM model bridge. See [README.md](README.md) and [../AGENTS.md](../AGENTS.md).

## Layout

- `index.ts`: Cordis plugin `apply` registering the `cursor` runtime and `catalog()` (`Cursor.models.list()`).
- `lib/run.machine.ts`: `cursorRuntimeSession` XState v5 machine.
- `test/`: `run-machine.test.ts`, `runtime.test.ts`.
- `dist/`: compiled TypeScript output (`tsc`).

## Invariants

- **Honest capabilities:** Supports creation, continuation, streaming, and cancellation by exact run ID. `fork`, `Missions`, and plugin-level permission callbacks must remain unsupported (explicit capability error, no emulation).
- **Private auth:** `catalog()` uses existing private DSH credentials; never log or expose tokens/keys.
- **Committed `dist/`:** Commit compiled `dist/` after every edit.

## Verification

```sh
npm ci
npm run check     # tsc --noEmit && tsc && node --test dist/test/*.test.js
```

Sync `../machines` if `lib/run.machine.ts` changes, and update `../repositories.json` snapshot metadata when files here change.
