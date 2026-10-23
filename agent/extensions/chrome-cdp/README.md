# Chrome CDP extension

This extension supplies browser controls. It does not select a workflow or a browser for the agent.

## Tools

### `chrome_browser`

| Action | Inputs | Result |
| --- | --- | --- |
| `list` | None | Browser IDs, ownership, process state, and profile paths |
| `launch` | Optional `headless`, `profilePath`, `executablePath`, `args`, `url`, `timeoutMs` | A new browser ID |
| `attach` | `endpoint` | A browser ID for an existing CDP endpoint |
| `stop` | `browserId` | Stops a browser launched by this session |
| `disconnect` | `browserId` | Disconnects from an attached browser; leaves it open |

`launch` uses a temporary profile and headless mode unless you supply other options.
Set `headless: false` to open a visible window.
Supply `profilePath` to keep cookies, logins, and other browser data between launches.
Use a separate user-data directory, not a profile already open in another browser.
Close the browser before launching its saved profile again.

Relative profile and executable paths use the active working directory (`ctx.cwd`).
Pi finds Chrome, Chromium, or Edge in standard install locations. You can supply another Chrome-compatible executable.
Extra `args` accept Chrome switches. Pi sets profile, headless, and debugging options itself.
The launch timeout defaults to 30 seconds.

`attach` accepts an HTTP debugging endpoint, such as `http://127.0.0.1:9333`, or a browser WebSocket URL.
Pi does not own attached processes and does not close them during cleanup.

The reserved ID `personal` discovers an existing local browser through its `DevToolsActivePort` file.
Listing browsers does not connect to it. Selecting it can trigger Chrome's debugging permission prompt.
For this connection, enable remote debugging at `chrome://inspect/#remote-debugging` if needed.

### `chrome_cdp`

**Every call requires `browserId`.** Use an ID from `chrome_browser`, or select `personal` explicitly.
An unknown, stopped, or disconnected browser never causes a fallback to another browser.
Tab IDs belong to the selected browser.

Actions:

- `list`, `open`, `nav`, `reload`, `close`, `activate`
- `snap`, `html`, `inspect`, `net`, `diagnostics`
- `click`, `clickxy`, `type`, `press`, `wait`
- `eval`, `script`, `raw`, `shot`, `viewport`, `download` 

Use `close` to close one tab. Use `chrome_browser stop` to stop a launched browser.
Use `activate` to select a tab in its browser window.
Use `raw` without `target` to send a browser-root CDP command.
With `target`, `raw` uses the existing domain routing for browser-root or page-session commands.

The same page actions work with launched and attached browsers.
They support accessible locators, trusted input, styles, screenshots, diagnostics, and JavaScript.
There are no site-specific modes or confirmation prompts.
Raw CDP commands retain browser-wide access, including `Browser.close`.
Ownership controls lifecycle cleanup; it does not restrict CDP methods.

## Examples

Launch a browser:

```json
{"action":"launch","headless":true}
```

Use the returned ID:

```json
{"browserId":"browser-12345678","action":"open","url":"http://localhost:3000"}
```

Open a saved profile for visible interaction:

```json
{"action":"launch","headless":false,"profilePath":".browser-profile"}
```

Inspect existing Chrome tabs:

```json
{"browserId":"personal","action":"list"}
```

Stop a launched browser:

```json
{"action":"stop","browserId":"browser-12345678"}
```

## Lifecycle and storage

Pi selects a free debugging port and waits for CDP readiness.
Launched browsers bind their debugging endpoint to loopback.
No cookies move from your normal profile into a new profile.
Saved profiles contain sensitive data. Keep them out of source control.

Each session owns its launched processes.
Session shutdown closes those browsers and disconnects from attached browsers.
Shutdown first requests `Browser.close`. It terminates the owned process if that request does not stop it.
The stop result reports whether forced termination was needed.

Temporary profiles are removed after their process stops. Saved profiles remain.
A `.pi-browser-lock` file prevents simultaneous managed launches with the same profile.
If you close a launched window, the next launch of its profile releases the lock automatically.
After a Pi crash, remove this lock only after checking that its browser has stopped.
A stale `DevToolsActivePort` file also blocks launch. Attach to a running browser instead.
Remove a stale port file only after checking that its browser has stopped.
Pi retains files when it cannot confirm process termination.

Browser connections keep separate target sessions, diagnostics, navigation queues, and inspector state.
Automatic output files use a private runtime directory.
Relative `outputPath` and `expressionPath` values use the working directory at tool-call start.

## Implementation

- `index.ts`: extension entry point and page actions
- `browsers.ts`: browser discovery, launch, attachment, ownership, and cleanup
- `protocol.ts`: cancellable CDP client and target-session pooling
- `locator.ts`: CSS, role, name, and text locators
- `accessibility.ts`: accessibility-tree formatting
- `inspector.ts`: styles and matched rules
- `diagnostics.ts`: runtime errors, console entries, logs, and failed requests

## Tests

From the extension directory:

```bash
bun test --preload ./test-preload.ts ./*.test.ts
```

Include real-browser tests:

```bash
PI_CDP_LIVE_TESTS=1 bun test --preload ./test-preload.ts ./*.test.ts
```

These tests launch separate browsers. They never select `personal`.
If a global Bun preload changes CLI behavior, clear `BUN_OPTIONS` and `NODE_OPTIONS` for the test command.
