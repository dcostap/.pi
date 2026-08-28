# Pi Background Bash Processes

A session-scoped Pi extension for long-running, non-interactive bash commands.

It reuses Pi's public `createLocalBashOperations()` backend—the same local backend used by Pi's built-in `bash` tool. The extension contains no direct process spawning, `taskkill`, shell quoting, native helper, runtime dependency, or skill.

## Tools

- `bash_bg_start` — start a bash command and return immediately
- `bash_bg_status` — inspect one background bash process without waiting
- `bash_bg_list` — list the 30 most recent tracked processes and summarize older history
- `bash_bg_wait` — wait without polling; steering interrupts only the wait
- `bash_bg_kill` — stop through Pi's bash abort behavior
- `/ps` — responsive TUI dashboard or RPC textual inventory. The dashboard has live status
  summaries, adaptive process columns, selected-process previews, scrollable output, and a
  two-key confirmation before stopping a process.

While jobs are running, a permanent TUI widget above the editor shows every active background
terminal with its state, ID, title, elapsed time, captured-output size, and latest output line.
The widget adapts to narrow terminals, refreshes live, and disappears when no jobs remain.

Background tool rows show the readable process title beside IDs (for example,
`bg-2 (Dev server)`) wherever that title is available.

Bash commands receive no stdin. Do not add `&`, `start`, `Start-Process`, `nohup`, or daemonization flags: `bash_bg_start` already owns the background lifetime.

A steering message interrupts an active `bash_bg_wait`. The underlying processes continue running. Managed subagent coordinators remain parked while owned background processes are active.

Output is a merged stdout/stderr stream. Waiting shows a live, auto-truncated tail like Pi's built-in bash tool. Each process retains only its newest 1 MiB in memory, and output beyond Pi's standard 50KB/2000-line inline limit is also streamed to a temporary full-output file whose path is shown in tool results.

## Tests

The installed Pi executable provides its packages virtually, so standalone Bun tests use `test-preload.ts` only to stub the small formatting/TUI exports needed by unit tests.

```powershell
bun test --preload ./test-preload.ts ./*.test.ts ./ui/*.test.ts
```

Real Pi integration proofs were run from the isolated Desktop build folder before promotion. They use the actual Pi 0.80.6 backend and a local mock model—no paid model.

## Windows semantics

Termination and shutdown intentionally inherit Pi bash's existing semantics. Normal foreground command trees are managed. A descendant that deliberately detaches after every known ancestor exits is outside the guarantee.
