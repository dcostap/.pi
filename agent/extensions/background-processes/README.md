# Pi Background Bash Processes

A session-scoped Pi extension for long-running, non-interactive bash commands.

It reuses Pi's public `createLocalBashOperations()` backend, which is the same local backend that Pi's built-in `bash` tool uses. The extension contains no direct process spawning, `taskkill`, shell quoting, native helper, runtime dependency, or skill.

## Bash tool

The extension replaces Pi's `bash` tool with a wrapper around Pi's own implementation (`createBashToolDefinition`). The wrapper changes one behavior: a command that runs too long moves to the background. Pi does not kill it.

- The timeout is 8 minutes (480 seconds) by default. It is also the maximum. A larger `timeout` argument becomes 480.
- When the timeout elapses, the command gets a background ID (`bg-N`). The tool result shows the output so far.
- When the user sends a steering message, the running command moves to the background in the same way.
- Esc (cancellation) still kills the command.

The extension also owns the bash call renderer. It highlights Python heredocs (`_shared/bash-command-highlight.ts`). Do not register `bash` in a different extension: the two registrations conflict.

## Background notice

Some results leave a process running without a final result: a bash timeout, a bash steer, a wait timeout, or a wait steer. Each of these results ends with a static notice for the agent. The notice tells the agent that:

- the process is still running and nothing was killed;
- `bash_bg_wait` can wait again;
- the agent can end its turn, because a completion message wakes it up;
- `bash_bg_kill` stops a process that is not necessary.

The transcript does not show the notice. Expand the row to see the full text that the agent received, without the notice.

## Tools

- `bash_bg_start` — wait up to two seconds, then return the completion result or the background ID
- `bash_bg_status` — inspect one background process without waiting. Without `id`, list the 30 most recent processes.
- `bash_bg_wait` — wait without polling, at most 8 minutes per call. Steering interrupts only the wait.
- `bash_bg_kill` — stop through Pi's bash abort behavior
- `/ps` — responsive TUI dashboard or RPC textual inventory. The dashboard has live status
  summaries, adaptive process columns, selected-process previews, scrollable output, and a
  two-key confirmation before stopping a process.

## Transcript and widget

Background rows look like bash rows. The collapsed view shows the last 5 output lines and a one-line status, for example `✓ exit 0 · 2m 13s · 48KB`. Renderers read structured `details`, not the text for the agent.

While processes run, a widget shows above the editor. It shows one line for each process: spinner, ID, title, elapsed time, and the latest output line. A header line shows only when two or more processes run. The widget shows the 5 newest processes.

Bash commands receive no stdin. Do not add `&`, `start`, `Start-Process`, `nohup`, or daemonization flags: `bash_bg_start` already owns the background lifetime.

Managed subagent coordinators remain parked while owned background processes are active.

Output is a merged stdout/stderr stream. Waiting shows a live, auto-truncated tail like Pi's built-in bash tool. Each process retains only its newest 1 MiB in memory, and output beyond Pi's standard 50KB/2000-line inline limit is also streamed to a temporary full-output file whose path is shown in tool results.

If a command finishes during the first two seconds, `bash_bg_start` returns its completion output. It does not send a second completion message. Commands that continue past two seconds still send their completion message later.

## Tests

The installed Pi executable provides its packages virtually, so standalone Bun tests use `test-preload.ts` only to stub the small formatting/TUI exports needed by unit tests.

```powershell
bun test --preload ./test-preload.ts ./*.test.ts ./ui/*.test.ts
```

Real Pi integration proofs used the installed Pi 1.0.0 and a scripted local mock model. No paid model was used. In RPC mode, the proofs showed three behaviors: a bash timeout moves the command to the background, the completion wakes the agent, and a steer moves a running command to the background.

## Windows semantics

Termination and shutdown intentionally inherit Pi bash's existing semantics. Normal foreground command trees are managed. A descendant that deliberately detaches after every known ancestor exits is outside the guarantee.
