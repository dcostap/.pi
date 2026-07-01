---
name: pdf-deep-extraction
description: Page-aware PDF text extraction for tax, finance, brokerage, bank, procurement, and other table-heavy PDFs. Uses big-document mode for PDFs with 50+ pages or large text dumps (>50k chars), producing searchable page-mapped artifacts instead of pretending to fully visually verify huge PDFs.
compatibility: Windows/MSYS bash with Poppler pdftotext/pdftoppm and uvx or MarkItDown. Optional OCR support uses ocrmypdf or tesseract when installed.
---

# PDF Deep Extraction

Shared contract for coordinator agents and worker subagents.

## Document-size policy

Always treat document size as a hard workflow gate. The helper determines `Document mode` in `_summary/manifest.txt`.

- **Standard mode** applies only when:
  - PDF page count is known and below 50 pages, **and**
  - no generated text dump is larger than approximately 50,000 characters/bytes.
- **Big-document mode** applies when either:
  - PDF page count is 50 pages or more, **or**
  - any generated text dump (`pdftotext`, MarkItDown, OCR) is larger than approximately 50,000 characters/bytes.

### Standard mode

- Full-page image rendering/review is allowed when useful.
- A curated final Markdown can be produced, verified against text artifacts and page images where practical.

### Big-document mode

- Do **not** claim full visual verification.
- Do **not** manually inspect all pages or ask subagents to review pages one by one.
- The primary deliverable is a **page-aware searchable corpus**, not a polished “fully verified” Markdown reconstruction.
- Treat `_text_pages/page-XXXX.txt` and `_text/pdftotext-layout-paged.txt` as the canonical search/index artifacts.
- Use MarkItDown as an auxiliary readability/structure source only.
- Use OCR only when embedded text is sparse and OCR tools are available.
- Render/open page images only for targeted pages: pages found by search, sparse pages, ambiguous tables, missing totals, first/last page, or user-specified pages.
- Page numbers in artifacts are **physical PDF pages**. Printed page numbers inside the PDF may differ or reset, especially in signed/bundled PDFs.

## Coordinator mode

For multiple PDFs, launch one generic subagent per PDF, up to 4 in parallel. Do not split a big PDF into page-by-page visual-review subagents. The prompt can be short:

```text
Read/use the global skill `pdf-deep-extraction`.
Process this PDF in worker mode:
<PDF_PATH>

Return only: document mode, primary page-aware artifact path, artifact folder path, warnings/uncertainties.
```

For one PDF, either process directly in worker mode or launch one worker.

## Worker mode

Given exactly one PDF:

1. Do not modify the PDF.
2. Create artifacts in an appropriate OS local temp folder (away from the user's visible folders).
3. Run the helper script with a generous timeout: at least 300 seconds for ordinary PDFs, and 600+ seconds for known/likely big PDFs because page-aware extraction creates one text file per physical page:

```bash
"$HOME/.pi/agent/skills/pdf-deep-extraction/scripts/pdf-deep-extract.sh" "<PDF_PATH>"
```

The helper prints both MSYS paths and Windows paths. When using Pi `read` on Windows, prefer the printed `Output directory Windows` path.

The helper creates:

```text
_text/pdftotext-layout.txt               # raw full pdftotext dump
_text/pdftotext-layout-paged.txt         # combined text with explicit physical PDF page headers
_text/page-line-map.tsv                  # line ranges in the paged combined text -> physical PDF page
_text/page-text-stats.tsv                # per-page line and non-space character counts
_text_pages/page-0001.txt ...            # one pdftotext extraction per physical PDF page
_markitdown/markitdown.md                # auxiliary Markdown-ish extraction
_pages/page-*.png or sample-page-*.png   # rendered page images; all pages only outside big-doc mode by default
_ocr/ocr*.txt                            # OCR text when OCR was needed and OCR tools were available
_summary/manifest.txt                    # tool versions, PDF info, counts, extraction/render modes
_summary/qa-report.txt                   # page-aware QA, sparse-page report, caveats
```

4. Read `_summary/manifest.txt` first. Note document mode, page count, mode reason, image render mode, text density, OCR status, and page-aware artifact paths.
5. Read `_summary/qa-report.txt` second. Note sparse pages and caveats.
6. If answering questions about a big document:
   - Search `_text_pages/` first, e.g. `rg -n "flota mínima" _text_pages`.
   - The matching filename gives the physical PDF page, e.g. `_text_pages/page-0016.txt` = PDF page 16.
   - Render only the relevant PDF pages when visual/table verification is needed.
   - Cite or mention physical PDF pages when useful.
7. If extracting a big document for the user, prefer delivering/copying the page-aware text corpus (`_text/pdftotext-layout-paged.txt`) or raw dump, not a fake fully verified Markdown.

## Final output guidance

### Standard mode

A final Markdown next to the PDF is acceptable:

```text
example.pdf
example.pdf.md
```

Keep it useful and auditable:

- extracted content, preserving tables where practical
- page breaks/headings where helpful
- corrected numbers/tables when text sources or visual checks show extraction errors
- short `Verification notes` section with artifact folder path, page count, processing mode, OCR status, checked pages, and uncertainties

### Big-document mode

Do not default to a curated full Markdown. Return or provide the page-aware artifacts instead:

```text
Primary text corpus: <artifact>/_text/pdftotext-layout-paged.txt
Per-page text dir:  <artifact>/_text_pages
Page-line map:      <artifact>/_text/page-line-map.tsv
QA report:          <artifact>/_summary/qa-report.txt
Artifacts:          <artifact>
Warnings:           big-document mode; no full visual verification
```

If the user explicitly wants a file next to the PDF, copy the requested corpus there (usually `.txt`), and clearly state whether it is raw machine extraction or page-aware extraction.

## Commands used by the helper

```bash
pdfinfo "$PDF"                                # page count and metadata, when available
pdftotext -layout -enc UTF-8 "$PDF" "$OUT/_text/pdftotext-layout.txt"
pdftotext -layout -enc UTF-8 -f N -l N "$PDF" "$OUT/_text_pages/page-NNNN.txt"
uvx --from 'markitdown[pdf]' markitdown "$PDF" -o "$OUT/_markitdown/markitdown.md"
# Non-big PDFs only by default:
pdftoppm -png -r 250 -cropbox "$PDF" "$OUT/_pages/page"
# Big PDFs: sample/targeted image rendering only; OCR via ocrmypdf/tesseract when needed and available.
```
