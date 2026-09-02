# Codex web search

This Pi extension adds `codex_web_search`.

The tool uses the OpenAI Codex search endpoint and the existing Pi Codex login.
It does not require a separate search API key.

Pi enables the tool only while an `openai-codex` or `openai-codex-secondary` model is active.
Pi removes its schema and prompt instructions for all other models.

While active, it replaces `firecrawl_search` as the preferred discovery tool.
`fetch_url` remains active for exact URLs, PDFs, source files, and focused extraction.
`firecrawl_crawl` remains active for multi-page site crawls.

Run this command if authentication is missing:

```text
/login openai-codex
```

The tool supports these operations:

- `search_query` searches the web.
- `open` opens a result reference or URL.
- `click` follows a numbered link.
- `find` finds text in an opened result.

Optional environment variables:

- `PI_CODEX_SEARCH_URL` overrides the search endpoint.
- `PI_CODEX_WEB_SEARCH_MODEL` overrides `gpt-5.6-luna`.
- `PI_CODEX_WEB_SEARCH_MAX_TOKENS` changes the output limit.

## Source note

The protocol follows the MIT-licensed `web_run` implementation from:

https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion/src/tools/web-run

This extension uses a small TypeScript client. It does not copy the native binary or broad conversion package.

OpenAI does not document this Codex endpoint as a public search API. It can change without notice.
