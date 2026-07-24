# Persistent SSH session extension

User-authorized OpenSSH connection sharing for Pi, with one cache-stable `ssh_session` tool.

## Usage

```text
/reload
/ssh-connect dario@nelec-5
```

Choose either normal access or unrestricted root access until disconnect. Password entry is masked and authentication data never enters model context.

Then prompt normally, for example:

```text
Inspect the server, install the available updates, fix anything that fails, and restart affected services.
```

Commands:

- `/ssh-connect user@host`
- `/ssh-status`
- `/ssh-disconnect`

The model receives one permanently registered `ssh_session` tool. It cannot initiate a connection. Connection state is announced as a tail message, so connecting does not change the tool/system-prompt prefix.

## Current scope

- Interactive connection and sudo authentication require Pi TUI mode.
- Uses `ssh -G` and `ssh-keygen` to resolve OpenSSH host/user/port configuration and known-host fingerprints.
- Uses one cross-platform `ssh2` transport with independent command channels; it does not depend on unsupported Windows `ControlMaster` sockets.
- Uploads and downloads individual regular files through SFTP channels on that same authenticated transport; no second login, temporary SSH key, or shell/base64 encoding is required.
- Transfers stream through temporary sibling files and are committed into place only after size validation. Existing destinations require explicit `overwrite: true`; each result reports the transferred byte count and SHA-256 digest.
- Uploads use the connected user's permissions. For root-owned destinations, upload to a user-writable staging path and use `sudo_exec` to install or move the file.
- Verifies the actual negotiated host key. Unknown keys require explicit session trust; mismatched known keys are rejected.
- Session root access uses one retained broker-controlled privileged PTY and ends on disconnect/reload/shutdown.
- Background jobs are non-privileged. Privileged commands are serialized foreground operations.
- Foreground and background command output is bounded to Pi's standard 50KB/2000-line inline limit. Complete merged output is streamed to a local temp file whenever it exceeds that limit.
- Tool calls and results use Pi's Ctrl+O collapsed/expanded rendering convention; dump paths remain visible in collapsed results.
- Remote commands require a POSIX `/bin/sh` environment.

Granting session root access means exactly that: the agent may execute any command as root on the target until the SSH session closes.
