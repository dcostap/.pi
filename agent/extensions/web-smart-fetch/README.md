# web-smart-fetch

Pi extension for:

- `fetch_url` — one smart URL fetch tool with GitHub-special handling and focused-question support
- `firecrawl_search` — Firecrawl-backed search
- `firecrawl_crawl` — Firecrawl-backed site crawl

## Design

- cheap/local extraction first
- GitHub URLs handled specially via local cached checkout
- weak local extraction escalates automatically
  - Jina Reader first
  - Firecrawl if configured
- oversized results auto-summarize with:
  - `openai-codex/gpt-5.3-codex-spark`
- if `fetch_url` gets a `prompt`, it answers from extracted content; weak extraction escalates to Firecrawl when configured
- full artifacts always saved locally

## Config

Set Firecrawl via env:

```bash
set FIRECRAWL_API_KEY=fc-...
```

Or create:

`C:\Users\Dario Costa\.pi\web-smart-fetch.json`

```json
{
  "firecrawlApiKey": "fc-..."
}
```

## Install deps

```bash
cd C:\Users\Dario Costa\.pi\agent\extensions\web-smart-fetch
npm install
```

Then reload Pi:

```text
/reload
```
