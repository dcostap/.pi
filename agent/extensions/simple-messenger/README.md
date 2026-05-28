# messenger

A lightweight, project-scoped messenger extension for Pi.

## What it does

- join / leave a project-local mesh
- pick a messenger name and role before joining from `/messenger`
- show the current agent roster and presence
- send direct messages
- broadcast to all agents in the current project
- optionally configure private idle/working-time warnings for yourself
- open a prompt-area UI with Agents / Chats tabs

## What it does **not** do

- no Crew
- no planner
- no task graph
- no worker spawning
- no swarm / claims / orchestration
- no file reservations or locking
- no shared activity feed
- no free-form status messages

## Tool

`messenger`

### Actions

- `join`
- `leave`
- `status`
- `send`
- `broadcast`
- `rename`
- `warn_me_when_idle`
- `warn_me_when_idle.list`
- `warn_me_when_idle.remove`
- `warn_me_when_idle.clear`
- `warn_me_when_working`
- `warn_me_when_working.list`
- `warn_me_when_working.remove`
- `warn_me_when_working.clear`

### Examples

```ts
messenger({ action: "join" })
messenger({ action: "status" })
messenger({ action: "send", to: "AmberFox", message: "Need src/foo.ts next" })
messenger({ action: "broadcast", message: "I finished the parser pass." })
messenger({ action: "warn_me_when_idle", targetName: "AmberFox", minutes: 15 })
messenger({ action: "warn_me_when_working", targetRole: "implementer", minutes: 45 })
messenger({
  action: "send",
  to: "AmberFox",
  message: "Start over and solve this from scratch.",
  completely_wipe_recipient_context_before_message: true,
})
```

## Dangerous reset-before-delivery option

For `send` and `broadcast`, you can optionally pass:

- `completely_wipe_recipient_context_before_message: true`

When enabled, each recipient:

1. resets their active conversation context to the empty root,
2. keeps their messenger identity and presence intact,
3. receives the messenger payload as the first prompt of a new root branch.

This is intentionally named to be hard to use accidentally.

Reset results are partial per recipient:

- idle recipients succeed,
- busy recipients fail,
- successful deliveries still preserve messenger identity (same name, role, branch, presence).

## `/messenger` UI

When you are not joined yet, `/messenger` opens a setup screen where you can edit:

- **agent name**
- **role**

Both must be non-blank before joining.

After joining, `/messenger` opens the main prompt-area messenger UI.

### Keys

- `Tab` / `Shift+Tab` or `←` / `→` — switch tabs / move between setup fields
- `↑` / `↓` — move selection
- `Enter` — join, message selected agent, or reply in selected thread
- `b` — compose broadcast
- `Esc` — cancel compose or close messenger UI

## Message payloads

Normal incoming direct messages are wrapped like:

```xml
<direct_messenger_message>
  <sender>EchoHill</sender>
  <role>orchestrator</role>
  <note>To reply, use the messenger tool.</note>
  <contents>
Please reply back with this exact dummy message: PING-ECHO-17
  </contents>
</direct_messenger_message>
```

Normal incoming broadcasts are wrapped like:

```xml
<global_messenger_broadcast>
  <sender>EchoHill</sender>
  <role>orchestrator</role>
  <note>To reply, use the messenger tool.</note>
  <contents>
Stop editing shared headers now.
  </contents>
</global_messenger_broadcast>
```

When `completely_wipe_recipient_context_before_message: true` is used, that same wrapped payload becomes the first user prompt in the recipient's fresh root branch.

## Storage

Shared state lives in:

```text
~/.pi/agent/messenger/projects/<project-key>/
  registry/
  inbox/
  control-results/
  messages.jsonl
```

Project identity is based on:

1. git common dir (so worktrees share a project scope)
2. otherwise cwd

## Optional config

Create `~/.pi/agent/messenger.json` or `.pi/messenger.json`:

```json
{
  "autoJoin": false,
  "autoJoinPaths": ["~/projects/my-repo", "~/projects/team/*"],
  "inboxPollIntervalMs": 1500,
  "heartbeatIntervalMs": 10000,
  "messageRetention": 2000
}
```

## Recommended cleanup

If you are replacing `pi-messenger`, remove it from `~/.pi/agent/settings.json` packages.
