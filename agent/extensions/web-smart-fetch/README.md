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
  - the configured `fastCheap` model role (`/fast-model status`, `/fast-model set provider/model`)
- if `fetch_url` gets a `prompt`, it answers from extracted content; weak extraction escalates to Firecrawl when configured
- full artifacts always saved locally

## Config

Set Firecrawl via env:

```bash
set FIRECRAWL_API_KEY=fc-...
```

Or create:

`%USERPROFILE%\.pi\web-smart-fetch.json`

```json
{
  "firecrawlApiKey": "fc-..."
}
```

## Install deps

```bash
cd %USERPROFILE%\.pi\agent\extensions\web-smart-fetch
npm install
```

Then reload Pi:

```text
/reload
```
