# Pi Background Processes

A session-scoped Pi extension for long-running, non-interactive commands.

It reuses Pi's public `createLocalBashOperations()` backend. The extension contains no direct process spawning, `taskkill`, shell quoting, native helper, runtime dependency, or skill.

## Tools

- `bg_start` — start and return immediately
- `bg_status` — inspect one process without waiting
- `bg_list` — list tracked processes
- `bg_wait` — wait without polling; timeout/cancellation leaves processes alive
- `bg_kill` — stop through Pi's bash abort behavior
- `/ps` — TUI dashboard or RPC textual inventory

Commands receive no stdin. Do not add `&`, `start`, `Start-Process`, `nohup`, or daemonization flags: `bg_start` already owns the background lifetime.

Output is a merged stdout/stderr stream. Each process retains only its newest 1 MiB in memory. Older bytes are discarded; version 1 intentionally has no persistent full-log spill.

## Tests

The installed Pi executable provides its packages virtually, so standalone Bun tests use `test-preload.ts` only to stub the small formatting/TUI exports needed by unit tests.

```powershell
bun test --preload ./test-preload.ts ./*.test.ts ./ui/*.test.ts
```

Real Pi integration proofs were run from the isolated Desktop build folder before promotion. They use the actual Pi 0.80.6 backend and a local mock model—no paid model.

## Windows semantics

Termination and shutdown intentionally inherit Pi bash's existing semantics. Normal foreground command trees are managed. A descendant that deliberately detaches after every known ancestor exits is outside the guarantee.
