---
name: pdf-visual-triangulation
description: Coordinate or execute verified PDF-to-Markdown extraction for tax, finance, brokerage, bank, and other table-heavy PDFs. Use one worker/subagent per PDF when possible. Workers create pdftotext, MarkItDown, and page-image artifacts, then write a verified final file next to the PDF as original.pdf.md.
compatibility: Windows/MSYS bash with Poppler pdftotext/pdftoppm and uvx or MarkItDown. Tested with uvx --from 'markitdown[pdf]'.
---

# PDF Visual Triangulation

Shared contract for coordinator agents and worker subagents.

## Coordinator mode

For multiple PDFs, launch one generic subagent per PDF, up to 4 in parallel. The prompt can be short:

```text
Read/use the global skill `pdf-visual-triangulation`.
Process this PDF in worker mode:
<PDF_PATH>

Write the verified Markdown next to the PDF as `<PDF_PATH>.md`.
Return only: final md path, artifact folder path, warnings/uncertainties.
```

For one PDF, either process directly in worker mode or launch one worker.

## Worker mode

Given exactly one PDF:

1. Do not modify the PDF.
2. Create artifacts in an appropriate OS local temp folder (away from the user's visible folders).
3. Run the helper script with a generous timeout, at least 300 seconds:

```bash
"$HOME/.pi/agent/skills/pdf-visual-triangulation/scripts/pdf-triangulate.sh" "<PDF_PATH>"
```

The helper prints both MSYS paths and Windows paths. When using Pi `read` on Windows, prefer the printed `Output directory Windows` path.

It creates:

```text
_text/pdftotext-layout.txt
_markitdown/markitdown.md
_pages/page-*.png
_summary/manifest.txt
```

4. Use `_markitdown/markitdown.md` as the draft/origin text.
5. Verify and correct it against `_text/pdftotext-layout.txt` and the rendered page images. Page images are authoritative for numbers, signs, column alignment, totals, and footnotes.
   - If the PDF has 30 pages or fewer, inspect every rendered page image.
   - If the PDF has more than 30 pages, warn that there are too many pages to fully inspect manually; process as many pages as practical and report how many were inspected.
6. Write the final verified Markdown next to the original PDF:

```text
example.pdf
example.pdf.md
```

## Final Markdown requirements

Keep it useful and auditable:

- full verified extracted content, preserving tables where practical
- page breaks/headings where helpful
- corrected numbers/tables when MarkItDown is wrong or incomplete
- short `Verification notes` section with artifact folder path and uncertainties

Return only:

```text
Final MD: <path>
Artifacts: <path>
Warnings: <none or concise list>
```

## Commands used by the helper

```bash
pdftotext -layout -enc UTF-8 "$PDF" "$OUT/_text/pdftotext-layout.txt"
uvx --from 'markitdown[pdf]' markitdown "$PDF" -o "$OUT/_markitdown/markitdown.md"
pdftoppm -png -r 250 -cropbox "$PDF" "$OUT/_pages/page"
```
