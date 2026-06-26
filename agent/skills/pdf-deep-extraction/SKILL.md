---
name: pdf-deep-extraction
description: Page-count-aware PDF-to-Markdown extraction for tax, finance, brokerage, bank, and other table-heavy PDFs. For PDFs under 20 pages, visual verification with rendered page images is allowed; for PDFs with 20+ pages, use programmatic extraction/OCR and only selective image spot-checks.
compatibility: Windows/MSYS bash with Poppler pdftotext/pdftoppm and uvx or MarkItDown. Optional OCR support uses ocrmypdf or tesseract when installed.
---

# PDF Deep Extraction

Shared contract for coordinator agents and worker subagents.

## Page-count policy

Always treat the PDF page count as a hard workflow gate:

- **Small PDFs: fewer than 20 pages**
  - It is acceptable to render and inspect every page image.
  - Page images may be used as the authority for numbers, signs, column alignment, totals, and footnotes.
- **Large PDFs: 20 pages or more**
  - Do **not** render/open/inspect every page image manually.
  - Do **not** ask subagents to visually review pages one by one.
  - Prefer programmatic extraction and auto-OCR: `pdftotext -layout`, MarkItDown, OCR output if needed/available, scripted searches, table/text comparisons, and selective spot checks.
  - Render or open page images only for a small number of targeted pages: first/last page, pages with extraction failures, ambiguous tables, missing totals, or user-specified pages.
  - Final notes must say the PDF was processed in large-document/programmatic mode and must not claim full visual verification.

## Coordinator mode

For multiple PDFs, launch one generic subagent per PDF, up to 4 in parallel. Do not split a large PDF into page-by-page visual-review subagents. The prompt can be short:

```text
Read/use the global skill `pdf-deep-extraction`.
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
"$HOME/.pi/agent/skills/pdf-deep-extraction/scripts/pdf-deep-extract.sh" "<PDF_PATH>"
```

The helper prints both MSYS paths and Windows paths. When using Pi `read` on Windows, prefer the printed `Output directory Windows` path.

The helper is page-count-aware. It renders every page only for PDFs under 20 pages. For PDFs with 20+ pages it skips full page-image rendering and creates only sample/targeted images unless explicitly overridden for a special case.

It creates:

```text
_text/pdftotext-layout.txt
_markitdown/markitdown.md
_pages/page-*.png or _pages/sample-page-*.png
_ocr/ocr*.txt when OCR was needed and OCR tools were available
_summary/manifest.txt
```

4. Read `_summary/manifest.txt` first. Note page count, image render mode, text density, and OCR availability/output.
5. Use `_markitdown/markitdown.md` as the draft/origin text, then verify and correct it according to the page-count policy:
   - **Small PDFs (<20 pages):** verify against `_text/pdftotext-layout.txt` and every rendered page image.
   - **Large PDFs (20+ pages):** verify primarily with programmatic evidence: `_text/pdftotext-layout.txt`, MarkItDown, OCR output if available/needed, scripted page/table searches, totals checks, and selective image spot-checks only. If the document appears scanned or text extraction is sparse and no OCR artifact exists, try OCR tools if available or report that OCR was unavailable.
6. Write the final Markdown next to the original PDF:

```text
example.pdf
example.pdf.md
```

## Final Markdown requirements

Keep it useful and auditable:

- full extracted content, preserving tables where practical
- page breaks/headings where helpful
- corrected numbers/tables when programmatic sources or spot checks show MarkItDown is wrong or incomplete
- short `Verification notes` section with artifact folder path, page count, processing mode, OCR status, sampled/spot-checked pages, and uncertainties

Return only:

```text
Final MD: <path>
Artifacts: <path>
Warnings: <none or concise list>
```

## Commands used by the helper

```bash
pdfinfo "$PDF"                                # page count and metadata, when available
pdftotext -layout -enc UTF-8 "$PDF" "$OUT/_text/pdftotext-layout.txt"
uvx --from 'markitdown[pdf]' markitdown "$PDF" -o "$OUT/_markitdown/markitdown.md"
# Small PDFs only by default:
pdftoppm -png -r 250 -cropbox "$PDF" "$OUT/_pages/page"
# Large PDFs: sample/targeted image rendering only; OCR via ocrmypdf/tesseract when needed and available.
```
