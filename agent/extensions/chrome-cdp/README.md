# Chrome CDP Pi extension

`index.ts` is the single supported entry point and canonical implementation. The former standalone `scripts/cdp.mjs` implementation was removed to prevent protocol and behavior drift.

Supporting modules:

- `protocol.ts` — cancellable CDP client, Chrome discovery, session pooling
- `locator.ts` — CSS/role/name/text element locators
- `accessibility.ts` — hierarchical AX-tree formatting
- `inspector.ts` — compact computed/matched-style inspection
- `diagnostics.ts` — per-tab runtime, console, log, and network-failure ring buffers

The `raw` action remains available for CDP features not covered by first-class actions. Once Chrome grants the live debugging connection, the extension can access every available tab and browser-wide CDP method. It does not add Pi tab selectors or confirmation prompts.

Operational safeguards:

- Automatic dumps and screenshots are stored in a private runtime directory with private file permissions on POSIX systems.

Run tests:

```bash
bun test --preload ./test-preload.ts ./*.test.ts
```
