#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  pdf-deep-extract.sh <input.pdf> [output-dir]

If output-dir is omitted, creates a non-destructive artifact folder under the user's temp directory.
The work folder contains:
  _input/                 copied source PDF
  _text/pdftotext-layout.txt
  _text/pdftotext-layout-paged.txt
  _text/page-line-map.tsv
  _text/page-text-stats.tsv
  _text_pages/page-0001.txt ... page-NNNN.txt
  _markitdown/markitdown.md
  _pages/                 rendered page images; all pages only for non-big PDFs by default
  _ocr/                   OCR text when OCR was needed and OCR tools were available
  _ocr_pages/             temporary OCR page renders when tesseract OCR is used
  _summary/manifest.txt   tool versions, PDF info, counts, extraction/render modes
  _summary/qa-report.txt  page-aware extraction QA and caveats

Windows paths such as C:\path\file.pdf and MSYS paths such as /c/path/file.pdf are both accepted.

Environment knobs:
  PDF_BIG_DOC_PAGE_THRESHOLD=50   Enter big-document mode when page count is >= this value.
  PDF_BIG_DOC_CHAR_THRESHOLD=50000
                                  Enter big-document mode when any text dump is larger than this many chars.
  PDF_FULL_RENDER_PAGE_LIMIT=49   Render all page images only when page count is <= this value and not in big-document mode.
  PDF_RENDER_ALL_PAGES=1          Override the page-count gate and render all pages.
  PDF_SAMPLE_PAGES=1,last         For big PDFs, sample pages to render. Use comma-separated page numbers and/or "last".
  PDF_IMAGE_DPI_SMALL=250         DPI for full rendering of non-big PDFs.
  PDF_IMAGE_DPI_SAMPLE=150        DPI for sample rendering of big PDFs.
  PDF_OCR_SPARSE_CHARS_PER_PAGE=100
                                  Run OCR when extracted text is below this density and OCR tools are available.
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

trim_cr() { tr -d '\r'; }

to_msys_path() {
  local p="${1//\\//}"
  if [[ "$p" =~ ^([A-Za-z]):/(.*)$ ]]; then
    local drive="${BASH_REMATCH[1],,}"
    printf '/%s/%s' "$drive" "${BASH_REMATCH[2]}"
  else
    printf '%s' "$p"
  fi
}

to_windows_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$p"
  elif [[ "$p" =~ ^/([A-Za-z])/(.*)$ ]]; then
    local drive="${BASH_REMATCH[1]^^}"
    local rest="${BASH_REMATCH[2]//\//\\}"
    printf '%s:\\%s' "$drive" "$rest"
  else
    printf '%s' "$p"
  fi
}

local_temp_root() {
  local win_tmp=""
  if command -v powershell.exe >/dev/null 2>&1; then
    win_tmp="$(powershell.exe -NoProfile -Command '[System.IO.Path]::GetTempPath()' 2>/dev/null | trim_cr | tr -d '\n' || true)"
  elif command -v pwsh >/dev/null 2>&1; then
    win_tmp="$(pwsh -NoProfile -Command '[System.IO.Path]::GetTempPath()' 2>/dev/null | trim_cr | tr -d '\n' || true)"
  fi

  local root=""
  if [[ -n "$win_tmp" ]]; then
    root="$(to_msys_path "$win_tmp")"
  else
    root="$(to_msys_path "${TMPDIR:-${TEMP:-${TMP:-/tmp}}}")"
  fi
  root="${root%/}"
  printf '%s' "$root"
}

slugify() {
  local s="$1"
  s="${s%.*}"
  s="${s// /-}"
  s="$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.-')"
  printf '%s' "${s:-pdf}"
}

pdf_page_count() {
  local pdf="$1"
  if command -v pdfinfo >/dev/null 2>&1; then
    pdfinfo "$pdf" 2>/dev/null | awk -F: '/^Pages:/ { gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit }'
  fi
}

nonspace_char_count() {
  local f="$1"
  tr -d '[:space:]' < "$f" | wc -c | tr -d ' '
}

file_char_count() {
  local f="$1"
  if [[ -s "$f" ]]; then wc -c < "$f" | tr -d ' '; else printf '0'; fi
}

generate_page_text_artifacts() {
  paged_txt="$outdir/_text/pdftotext-layout-paged.txt"
  page_line_map="$outdir/_text/page-line-map.tsv"
  page_text_stats="$outdir/_text/page-text-stats.tsv"

  : > "$paged_txt"
  printf 'pdf_page\tpage_file\tcombined_start_line\tcombined_end_line\tnonspace_chars\tstatus\n' > "$page_line_map"
  printf 'pdf_page\tpage_file\tlines\tnonspace_chars\tstatus\n' > "$page_text_stats"

  if ! [[ "$page_count" =~ ^[0-9]+$ && "$page_count" -gt 0 ]]; then
    printf 'unknown\t\t\t\t\tpage_count_unavailable\n' >> "$page_line_map"
    printf 'unknown\t\t\t\tpage_count_unavailable\n' >> "$page_text_stats"
    return 0
  fi

  local width=${#page_count}
  if [[ "$width" -lt 4 ]]; then width=4; fi

  local page page_file rel_file status lines chars start_line end_line before_lines after_lines
  for ((page=1; page<=page_count; page++)); do
    page_file="$(printf "$outdir/_text_pages/page-%0${width}d.txt" "$page")"
    rel_file="$(printf "_text_pages/page-%0${width}d.txt" "$page")"
    status="ok"
    if ! pdftotext -layout -enc UTF-8 -f "$page" -l "$page" "$work_pdf" "$page_file" 2>"$page_file.stderr.txt"; then
      status="pdftotext_failed"
      : > "$page_file"
    else
      rm -f "$page_file.stderr.txt"
    fi

    lines="$(wc -l < "$page_file" | tr -d ' ')"
    chars="$(nonspace_char_count "$page_file")"
    before_lines="$(wc -l < "$paged_txt" | tr -d ' ')"
    start_line=$((before_lines + 1))
    {
      printf '===== PDF PAGE %0'"$width"'d / %s =====\n' "$page" "$page_count"
      cat "$page_file"
      printf '\n'
    } >> "$paged_txt"
    after_lines="$(wc -l < "$paged_txt" | tr -d ' ')"
    end_line="$after_lines"

    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$page" "$rel_file" "$start_line" "$end_line" "$chars" "$status" >> "$page_line_map"
    printf '%s\t%s\t%s\t%s\t%s\n' "$page" "$rel_file" "$lines" "$chars" "$status" >> "$page_text_stats"
  done
}

write_qa_report() {
  qa_report="$outdir/_summary/qa-report.txt"
  {
    echo "PDF deep extraction QA report"
    echo "Generated: $(date -Is)"
    echo "Source: $input_pdf"
    echo
    echo "Mode: $document_mode"
    echo "Mode reason: $document_mode_reason"
    echo "Big-document page threshold: $big_doc_page_threshold"
    echo "Big-document char threshold: $big_doc_char_threshold"
    echo "Page count: ${page_count:-unknown}"
    echo "pdftotext chars: $layout_chars"
    echo "MarkItDown chars: $markitdown_chars"
    if [[ -n "${ocr_output:-}" ]]; then echo "OCR chars: $(file_char_count "$ocr_output")"; fi
    echo
    echo "Page-aware artifacts:"
    echo "- _text_pages/page-XXXX.txt: one pdftotext extraction per physical PDF page"
    echo "- _text/pdftotext-layout-paged.txt: combined text with explicit PDF page headers"
    echo "- _text/page-line-map.tsv: line ranges in the combined paged text"
    echo "- _text/page-text-stats.tsv: per-page line/non-space character counts"
    echo
    if [[ -f "$page_text_stats" ]]; then
      echo "Sparse pages (non-space chars < $ocr_sparse_chars_per_page; first 200 shown):"
      awk -F '\t' -v threshold="$ocr_sparse_chars_per_page" 'NR>1 && $4 ~ /^[0-9]+$/ && $4 < threshold { print "- PDF page " $1 ": " $4 " non-space chars (" $2 ")"; count++; if (count>=200) exit } END { if (count==0) print "- none" }' "$page_text_stats"
    fi
    echo
    echo "Caveats:"
    if [[ "$document_mode" == "big" ]]; then
      echo "- Big-document mode does not imply full visual verification. Use rg against _text_pages, then render/check only target PDF pages."
      echo "- Page numbers in artifacts are physical PDF pages; printed page numbers inside bundled/signed documents may differ or reset."
      echo "- MarkItDown is auxiliary and is not treated as the page-grounded source of truth."
    else
      echo "- Non-big mode may support fuller visual review, but PDF text extraction can still misread table structure."
    fi
  } > "$qa_report"
}

render_sample_page() {
  local page="$1"
  [[ "$page" =~ ^[0-9]+$ ]] || return 0
  [[ "$page" -ge 1 ]] || return 0
  if [[ "$page_count" =~ ^[0-9]+$ && "$page" -gt "$page_count" ]]; then return 0; fi
  local prefix="$outdir/_pages/sample-page-$page"
  pdftoppm -png -r "$image_dpi_sample" -cropbox -f "$page" -l "$page" "$work_pdf" "$prefix"
}

run_ocr_if_needed() {
  local status="not needed"
  ocr_output=""

  if [[ "$ocr_needed" != "yes" ]]; then
    ocr_status="$status"
    return 0
  fi

  if command -v ocrmypdf >/dev/null 2>&1; then
    local ocr_pdf="$outdir/_ocr/ocrmypdf-output.pdf"
    local ocr_txt="$outdir/_ocr/ocrmypdf-pdftotext.txt"
    if ocrmypdf --skip-text --optimize 0 "$work_pdf" "$ocr_pdf" >/dev/null 2>"$outdir/_ocr/ocrmypdf.stderr.txt"; then
      pdftotext -layout -enc UTF-8 "$ocr_pdf" "$ocr_txt" || true
      if [[ -s "$ocr_txt" ]]; then
        ocr_status="created with ocrmypdf"
        ocr_output="$ocr_txt"
        return 0
      fi
    fi
  fi

  if command -v tesseract >/dev/null 2>&1; then
    local tesseract_txt="$outdir/_ocr/tesseract.txt"
    local ocr_prefix="$outdir/_ocr_pages/page"
    # This may render every page, but it is for automated OCR, not manual/model visual inspection.
    if pdftoppm -png -r 200 -cropbox "$work_pdf" "$ocr_prefix"; then
      : > "$tesseract_txt"
      local img
      for img in "$outdir"/_ocr_pages/*.png; do
        [[ -e "$img" ]] || continue
        {
          echo
          echo "--- OCR $(basename "$img") ---"
          tesseract "$img" stdout 2>/dev/null || true
        } >> "$tesseract_txt"
      done
      if [[ -s "$tesseract_txt" ]]; then
        ocr_status="created with tesseract"
        ocr_output="$tesseract_txt"
        return 0
      fi
    fi
  fi

  ocr_status="needed but no usable OCR output was created"
  ocr_output=""
}

[[ ${1:-} == "-h" || ${1:-} == "--help" ]] && { usage; exit 0; }
[[ $# -ge 1 && $# -le 2 ]] || { usage; exit 2; }

need_cmd pdftotext
need_cmd pdftoppm

big_doc_page_threshold="${PDF_BIG_DOC_PAGE_THRESHOLD:-50}"
big_doc_char_threshold="${PDF_BIG_DOC_CHAR_THRESHOLD:-50000}"
full_render_page_limit="${PDF_FULL_RENDER_PAGE_LIMIT:-49}"
render_all_pages="${PDF_RENDER_ALL_PAGES:-0}"
sample_pages_csv="${PDF_SAMPLE_PAGES:-1,last}"
image_dpi_small="${PDF_IMAGE_DPI_SMALL:-250}"
image_dpi_sample="${PDF_IMAGE_DPI_SAMPLE:-150}"
ocr_sparse_chars_per_page="${PDF_OCR_SPARSE_CHARS_PER_PAGE:-100}"

input_pdf="$(to_msys_path "$1")"
[[ -f "$input_pdf" ]] || die "Input PDF not found: $1"

base="$(basename "$input_pdf")"
slug="$(slugify "$base")"

if [[ $# -eq 2 ]]; then
  outdir="$(to_msys_path "$2")"
else
  tmp_root="$(local_temp_root)"
  outdir="$tmp_root/pi-pdf-deep-extraction/$slug-$(date +%Y%m%d-%H%M%S)-$$"
fi

mkdir -p "$outdir"/{_input,_text,_text_pages,_markitdown,_pages,_ocr,_ocr_pages,_summary}
work_pdf="$outdir/_input/$base"
cp -f "$input_pdf" "$work_pdf"

layout_txt="$outdir/_text/pdftotext-layout.txt"
paged_txt="$outdir/_text/pdftotext-layout-paged.txt"
page_line_map="$outdir/_text/page-line-map.tsv"
page_text_stats="$outdir/_text/page-text-stats.tsv"
markitdown_md="$outdir/_markitdown/markitdown.md"
pages_prefix="$outdir/_pages/page"
manifest="$outdir/_summary/manifest.txt"
qa_report="$outdir/_summary/qa-report.txt"
outdir_win="$(to_windows_path "$outdir")"
work_pdf_win="$(to_windows_path "$work_pdf")"
layout_txt_win="$(to_windows_path "$layout_txt")"
paged_txt_win="$(to_windows_path "$paged_txt")"
page_line_map_win="$(to_windows_path "$page_line_map")"
text_pages_dir_win="$(to_windows_path "$outdir/_text_pages")"
markitdown_md_win="$(to_windows_path "$markitdown_md")"
pages_dir_win="$(to_windows_path "$outdir/_pages")"
ocr_dir_win="$(to_windows_path "$outdir/_ocr")"
manifest_win="$(to_windows_path "$manifest")"
qa_report_win="$(to_windows_path "$qa_report")"

page_count="$(pdf_page_count "$work_pdf" || true)"
page_count="${page_count//$'\r'/}"

# 1. Deterministic text extraction preserving layout/columns.
pdftotext -layout -enc UTF-8 "$work_pdf" "$layout_txt"

text_nonspace_chars="$(nonspace_char_count "$layout_txt")"
chars_per_page="unknown"
if [[ "$page_count" =~ ^[0-9]+$ && "$page_count" -gt 0 ]]; then
  chars_per_page=$(( text_nonspace_chars / page_count ))
fi

ocr_needed="no"
if [[ "$chars_per_page" =~ ^[0-9]+$ ]]; then
  if [[ "$chars_per_page" -lt "$ocr_sparse_chars_per_page" ]]; then ocr_needed="yes"; fi
elif [[ "$text_nonspace_chars" -lt 500 ]]; then
  ocr_needed="yes"
fi

# 2. MarkItDown extraction. Prefer uvx with the [pdf] extra, because a plain
#    markitdown install may not include PDF dependencies.
if command -v uvx >/dev/null 2>&1; then
  uvx --from 'markitdown[pdf]' markitdown "$work_pdf" -o "$markitdown_md"
elif command -v markitdown >/dev/null 2>&1; then
  markitdown "$work_pdf" -o "$markitdown_md"
elif python -c 'import markitdown' >/dev/null 2>&1; then
  python -m markitdown "$work_pdf" -o "$markitdown_md"
else
  die "MarkItDown unavailable. Install uv/uvx or install Python package markitdown[pdf]."
fi

layout_chars="$(file_char_count "$layout_txt")"
markitdown_chars="$(file_char_count "$markitdown_md")"

document_mode="standard"
document_mode_reason="below big-document thresholds"
if [[ "$page_count" =~ ^[0-9]+$ && "$page_count" -ge "$big_doc_page_threshold" ]]; then
  document_mode="big"
  document_mode_reason="page count $page_count >= threshold $big_doc_page_threshold"
elif [[ "$layout_chars" =~ ^[0-9]+$ && "$layout_chars" -gt "$big_doc_char_threshold" ]]; then
  document_mode="big"
  document_mode_reason="pdftotext dump chars $layout_chars > threshold $big_doc_char_threshold"
elif [[ "$markitdown_chars" =~ ^[0-9]+$ && "$markitdown_chars" -gt "$big_doc_char_threshold" ]]; then
  document_mode="big"
  document_mode_reason="MarkItDown dump chars $markitdown_chars > threshold $big_doc_char_threshold"
fi

# 3. Page-aware text artifacts. These are the canonical search/index artifacts,
#    because each file maps directly to a physical PDF page.
generate_page_text_artifacts

# 4. OCR, if the embedded/extracted text is sparse. OCR output can itself push
#    a document into big-document mode before image rendering decisions are made.
ocr_status="not needed"
ocr_output=""
run_ocr_if_needed
ocr_output_win=""
ocr_chars="0"
if [[ -n "$ocr_output" ]]; then
  ocr_output_win="$(to_windows_path "$ocr_output")"
  ocr_chars="$(file_char_count "$ocr_output")"
  if [[ "$document_mode" != "big" && "$ocr_chars" =~ ^[0-9]+$ && "$ocr_chars" -gt "$big_doc_char_threshold" ]]; then
    document_mode="big"
    document_mode_reason="OCR dump chars $ocr_chars > threshold $big_doc_char_threshold"
  fi
fi

# 5. Page-count/size-aware image rendering. Full visual/model inspection is only
#    appropriate outside big-document mode by default. Big documents get sample
#    images only unless explicitly overridden.
image_render_mode="sample only"
if [[ "$render_all_pages" == "1" ]]; then
  pdftoppm -png -r "$image_dpi_small" -cropbox "$work_pdf" "$pages_prefix"
  image_render_mode="all pages override"
elif [[ "$document_mode" != "big" && "$page_count" =~ ^[0-9]+$ && "$page_count" -le "$full_render_page_limit" ]]; then
  pdftoppm -png -r "$image_dpi_small" -cropbox "$work_pdf" "$pages_prefix"
  image_render_mode="all pages non-big-pdf"
else
  IFS=',' read -r -a sample_pages <<< "$sample_pages_csv"
  declare -A seen_samples=()
  for raw_page in "${sample_pages[@]}"; do
    page="$(printf '%s' "$raw_page" | tr -d '[:space:]')"
    if [[ "$page" == "last" ]]; then page="$page_count"; fi
    [[ -n "$page" ]] || continue
    [[ -n "${seen_samples[$page]:-}" ]] && continue
    seen_samples[$page]=1
    render_sample_page "$page" || true
  done
fi

write_qa_report

png_count="$(find "$outdir/_pages" -type f -name '*.png' | wc -l | tr -d ' ')"
text_page_file_count="$(find "$outdir/_text_pages" -type f -name 'page-*.txt' | wc -l | tr -d ' ')"
ocr_page_png_count="$(find "$outdir/_ocr_pages" -type f -name '*.png' | wc -l | tr -d ' ')"

{
  echo "PDF deep extraction manifest"
  echo "Generated: $(date -Is)"
  echo "Source: $input_pdf"
  echo "Working copy: $work_pdf"
  echo "Working copy Windows: $work_pdf_win"
  echo "Output dir: $outdir"
  echo "Output dir Windows: $outdir_win"
  echo
  echo "Extraction policy:"
  echo "Page count: ${page_count:-unknown}"
  echo "Document mode: $document_mode"
  echo "Document mode reason: $document_mode_reason"
  echo "Big-document page threshold: $big_doc_page_threshold"
  echo "Big-document char threshold: $big_doc_char_threshold"
  echo "Full render page limit: $full_render_page_limit"
  echo "Image render mode: $image_render_mode"
  echo "PDF_RENDER_ALL_PAGES: $render_all_pages"
  echo "Sample pages requested: $sample_pages_csv"
  echo "Text non-space chars: $text_nonspace_chars"
  echo "pdftotext chars: $layout_chars"
  echo "MarkItDown chars: $markitdown_chars"
  echo "OCR chars: $ocr_chars"
  echo "Text chars/page: $chars_per_page"
  echo "OCR sparse chars/page threshold: $ocr_sparse_chars_per_page"
  echo "OCR needed: $ocr_needed"
  echo "OCR status: $ocr_status"
  if [[ -n "$ocr_output" ]]; then
    echo "OCR output: $ocr_output"
    echo "OCR output Windows: $ocr_output_win"
  fi
  echo
  echo "Tool paths:"
  echo "pdftotext: $(command -v pdftotext)"
  echo "pdftoppm:  $(command -v pdftoppm)"
  if command -v pdfinfo >/dev/null 2>&1; then echo "pdfinfo:   $(command -v pdfinfo)"; else echo "pdfinfo:   not found"; fi
  if command -v uvx >/dev/null 2>&1; then echo "uvx:       $(command -v uvx)"; fi
  if command -v markitdown >/dev/null 2>&1; then echo "markitdown: $(command -v markitdown)"; fi
  if command -v ocrmypdf >/dev/null 2>&1; then echo "ocrmypdf:  $(command -v ocrmypdf)"; else echo "ocrmypdf:  not found"; fi
  if command -v tesseract >/dev/null 2>&1; then echo "tesseract: $(command -v tesseract)"; else echo "tesseract: not found"; fi
  echo
  echo "Versions:"
  pdftotext -v 2>&1 | head -2 || true
  pdftoppm -v 2>&1 | head -2 || true
  if command -v pdfinfo >/dev/null 2>&1; then pdfinfo -v 2>&1 | head -2 || true; fi
  if command -v uvx >/dev/null 2>&1; then uvx --from 'markitdown[pdf]' markitdown --version 2>&1 || true; fi
  if command -v tesseract >/dev/null 2>&1; then tesseract --version 2>&1 | head -2 || true; fi
  echo
  echo "PDF info:"
  if command -v pdfinfo >/dev/null 2>&1; then pdfinfo "$work_pdf" || true; else echo "pdfinfo not found"; fi
  echo
  echo "Output counts:"
  echo "pdftotext lines: $(wc -l < "$layout_txt")"
  echo "paged pdftotext lines: $(wc -l < "$paged_txt")"
  echo "per-page text files: $text_page_file_count"
  echo "MarkItDown lines: $(wc -l < "$markitdown_md")"
  echo "PNG page/sample images: $png_count"
  echo "OCR page images: $ocr_page_png_count"
  echo
  echo "Page-aware artifacts:"
  echo "paged pdftotext: $paged_txt"
  echo "paged pdftotext Windows: $paged_txt_win"
  echo "page-line map: $page_line_map"
  echo "page-line map Windows: $page_line_map_win"
  echo "text pages dir: $outdir/_text_pages"
  echo "text pages dir Windows: $text_pages_dir_win"
  echo "QA report: $qa_report"
  echo "QA report Windows: $qa_report_win"
} > "$manifest"

echo "Done. Output directory: $outdir"
echo "Done. Output directory Windows: $outdir_win"
echo "- $layout_txt"
echo "- $paged_txt"
echo "- $page_line_map"
echo "- $outdir/_text_pages/page-*.txt"
echo "- $markitdown_md"
echo "- $outdir/_pages/page-*.png or sample-page-*.png"
echo "- $outdir/_ocr/ocr*.txt (when created)"
echo "- $manifest"
echo "- $qa_report"
echo "Windows paths for Pi read tool:"
echo "- $layout_txt_win"
echo "- $paged_txt_win"
echo "- $page_line_map_win"
echo "- $text_pages_dir_win\\page-*.txt"
echo "- $markitdown_md_win"
echo "- $pages_dir_win\\page-*.png or sample-page-*.png"
echo "- $ocr_dir_win\\ocr*.txt"
echo "- $manifest_win"
echo "- $qa_report_win"
