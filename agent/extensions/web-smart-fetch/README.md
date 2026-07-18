# web-smart-fetch

Pi extension for:

- `fetch_url` — one smart URL fetch tool with GitHub-special handling and focused-question support
- `firecrawl_search` — Firecrawl-backed search
- `firecrawl_crawl` — Firecrawl-backed site crawl

## Design

- cheap/local extraction first
  - HTML main-content extraction with Defuddle
  - Turndown/plain-text fallback if Defuddle cannot extract the page
- deterministic ordinary-page handling
  - usable extracted content up to the configured threshold is returned directly
  - the fast model is used for focused questions, oversized summaries, and ambiguous quality only
- GitHub URLs use the cheapest targeted path
  - `raw.githubusercontent.com` files are fetched directly and never wait on a repository cache lock
  - GitHub `/blob/` pages are rewritten to direct raw-file requests
  - GitHub `/tree/` paths use the Contents API first, with a sparse checkout fallback
  - repository roots use an atomic `--depth=1 --filter=blob:none --sparse` cache
  - Git/API operations and repository-lock waits time out after five minutes
- weak local extraction escalates automatically
  - Jina Reader first
  - Firecrawl if configured
  - credential-bearing/signed URLs never escalate to third-party readers automatically
- HTTP errors, empty responses, challenge pages, thin HTML, and JS shells are explicit escalation signals
- fetch results include selected strategy, status, timing, extraction sizes, truncation state, and per-attempt diagnostics
- abort-aware concurrency limiting protects parallel `fetch_url` batches
- response bodies are streamed with hard limits before raw artifacts or PDFs are parsed
- URL routing normalizes Markdown-wrapped or punctuation-damaged URLs, rejects unsupported protocols and URL credentials, preserves transport-significant punctuation/slashes, and emits stable deduplication keys
- a small adapter registry owns GitHub/YouTube special handling and rewrites supported Apple Developer pages to Sosumi Markdown while preserving the Apple canonical URL; cross-origin rewrites do not forward query values
- oversized results auto-summarize with:
  - the configured `fastCheap` model role (`/fast-model status`, `/fast-model set provider/model`)
- if `fetch_url` gets a `prompt`, it answers from extracted content; weak extraction escalates to Firecrawl when configured
- full artifacts always saved locally in per-request, atomically unique directories
- Firecrawl crawl failures/cancellations are errors, and crawl startup plus polling share one deadline
- fetched content is explicitly framed as untrusted data for fast-model quality checks and summaries

## Config

Set Firecrawl via env:

```bash
set FIRECRAWL_API_KEY=fc-...
```

Or create:

`%USERPROFILE%\.pi\web-smart-fetch.json`

```json
{
  "firecrawlApiKey": "fc-...",
  "summaryThresholdChars": 18000,
  "previewChars": 5000,
  "maxConcurrentFetches": 4,
  "maxTextResponseBytes": 5242880,
  "maxPdfResponseBytes": 26214400,
  "maxFirecrawlResponseBytes": 20971520
}
```

The character limits can also be set with `WEB_SMART_FETCH_SUMMARY_THRESHOLD_CHARS` and
`WEB_SMART_FETCH_PREVIEW_CHARS`.

Resource limits can also be set with:

- `WEB_SMART_FETCH_MAX_CONCURRENCY`
- `WEB_SMART_FETCH_MAX_TEXT_BYTES`
- `WEB_SMART_FETCH_MAX_PDF_BYTES`
- `WEB_SMART_FETCH_MAX_FIRECRAWL_BYTES`

## Install deps

```bash
cd %USERPROFILE%\.pi\agent\extensions\web-smart-fetch
npm install
```

Then reload Pi:

```text
/reload
```
