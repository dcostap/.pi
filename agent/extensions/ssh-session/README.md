# Persistent SSH session extension

User-authorized OpenSSH connection sharing for Pi, with one cache-stable `ssh_session` tool.

## Usage

```text
/reload
/ssh-connect dario@nelec-5
/ssh-connect root@hero-1
```

Choose either normal access or unrestricted root access until disconnect. Root logins skip this choice, because each command already runs as root. Password entry is masked and authentication data never enters model context.

Then prompt normally, for example:

```text
Inspect the server, install the available updates, fix anything that fails, and restart affected services.
```

Commands:

- `/ssh-connect user@host`
- `/ssh-status [session_id]`
- `/ssh-disconnect [session_id]`

Run `/ssh-connect` again to add another server. Existing connections stay available.
Each connection receives an ID, such as `ssh-1`. Status messages show these IDs and their server names.
The extension rejects duplicate connections to the same resolved host, user, and port.

Run `/ssh-status` to see all connections, root permissions, and background jobs.
Use `/ssh-status ssh-1` to inspect one connection.
Use `/ssh-disconnect ssh-1` to close one connection without closing the others.
Without an ID, disconnect selects the only connection or asks you to choose one.
Disconnect does not wait for the agent.
It requests termination for tracked background jobs, then closes the selected connection.

## Tool selection

The agent uses `ssh_session` with a `session_id`:

```json
{"action":"list"}
{"action":"exec","session_id":"ssh-1","command":"hostname"}
{"action":"exec","session_id":"ssh-2","command":"hostname"}
```

With multiple connections, every action except an unfiltered `list` requires an explicit ID.
With one connection, the agent can omit the ID. The tool never selects the latest connection by default.
Unknown IDs fail instead of selecting another server. Closed IDs stay invalid until reload.

Each connection has separate root permission and background jobs. Job IDs belong to their connection.
For example, `bg-1` on `ssh-1` is separate from `bg-1` on `ssh-2`.
Results and progress messages identify the connection. `list` also reports connection IDs and permissions in result details.

The model receives one permanently registered `ssh_session` tool. It cannot initiate a connection.
Connection setup does not wait for the agent to finish. The agent can continue working during configuration and authentication.
The tool cannot use the new session until setup completes. Only one connection setup can run at a time.
After setup, the authorization message steers a working agent at the next steering boundary.
When idle, the message waits for the next turn. Connecting alone does not start agent work.
These messages do not change the tool or system-prompt prefix.

## Current scope

- Interactive connection and sudo authentication require Pi TUI mode.
- Uses `ssh -G` and `ssh-keygen` to resolve OpenSSH connection settings and known-host fingerprints.
- Tries each readable OpenSSH `IdentityFile` before password authentication. Encrypted keys use a masked passphrase prompt.
- Uses one cross-platform `ssh2` transport per connection, with independent command channels. It does not require Windows `ControlMaster` sockets.
- Uploads and downloads individual regular files through SFTP channels on that same authenticated transport; no second login, temporary SSH key, or shell/base64 encoding is required.
- Transfers stream through temporary sibling files and are committed into place only after size validation. Existing destinations require explicit `overwrite: true`; each result reports the transferred byte count and SHA-256 digest.
- Uploads use the connected user's permissions. For root-owned destinations, upload to a user-writable staging path and use `sudo_exec` to install or move the file.
- Verifies the actual negotiated host key. Unknown keys require explicit session trust; mismatched known keys are rejected.
- Each authorized connection uses one retained privileged PTY. Root access ends when that connection closes or Pi reloads or exits.
- Background jobs run as the login user, without the sudo channel. Root logins also run background jobs as root.
- The sudo channel runs one foreground command at a time, separately for each connection.
- Foreground and background command output is bounded to Pi's standard 50KB/2000-line inline limit. Complete merged output is streamed to a local temp file whenever it exceeds that limit.
- Tool calls and results use Pi's Ctrl+O collapsed/expanded rendering convention; dump paths remain visible in collapsed results.
- Remote commands require a POSIX `/bin/sh` environment.

Granting session root access means exactly that: the agent may execute any command as root on the target until the SSH session closes.
