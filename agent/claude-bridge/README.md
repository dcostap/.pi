# Claude Bridge

Use Pi subagents from Claude Code. Open Claude Code sessions in Pi.

## Parts

- `mod/`: the Claude Code mod `pi-bridge`.
- `hub/hub.ts`: starts and stops one headless Pi hub for each Claude Code session.
- `mirror/`: converts Claude Code transcripts to Pi session files.
- `../extensions/subagents/bridge-server.ts`: the local HTTP server of the hub.

## Install

The mod needs `bun` and `pi` on `PATH`.

Add the mod folder to the `env` block of `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\Dario Costa\\.pi\\agent\\claude-bridge\\mod" }
```

Claude Code reads the mod from this folder. Edits load in the next session.

## Subagents

Claude Code gets the Pi subagent tools as `mcp__pi-bridge__subagent_*`.
The tools and their rules come from the Pi subagents extension.

1. The first tool call starts a hub: `pi --mode rpc` with `PI_SUBAGENT_BRIDGE_DIR` set.
2. The subagents extension in the hub serves its tools on `127.0.0.1`.
3. When the session is idle, the mod gets the batched updates and sends them as a prompt.
4. A band above the prompt shows the agent tree.
5. The hub stops when the session ends, or after 15 minutes without requests.
6. A new hub restores the agents of the session from `results.jsonl`.

The hub state is in `~/.pi/agent/claude-bridge-state/<claude-session-id>/`.
The child Pi sessions are in its `sessions/` folder.

## Mirrors

After each main turn, the mod writes a Pi copy of the session.
The copy goes to the usual Pi session folder for the working directory.
Its name starts with `[Claude]`.

You can continue a mirror in Pi. Then the sync does not change that file again.
Later Claude Code turns go to a new mirror, with a number in the name.

## Commands

Run these from this folder:

```sh
bun hub/hub.ts state --session <id>        # agent tree of a hub
bun hub/hub.ts call subagent_list --session <id>
bun hub/hub.ts stop --session <id>
bun mirror/sync.ts session <id>            # mirror one session
bun mirror/sync.ts backfill                # mirror all Claude Code sessions
```

## Tests

Run these from the repository root:

```sh
bun test agent/claude-bridge/mirror
bun test agent/extensions/subagents
claude plugin test agent/claude-bridge/mod
```

## Limits

- The mirror does not include the transcripts of Claude Code subagents (the Agent tool).
- After a rewind, the mirror shows only the active branch.
- A message that you type during a turn stops a running wait in the terminal.
  In `claude -p` stream-json mode, Claude Code gives the message after the tool ends.
