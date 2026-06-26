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
  _markitdown/markitdown.md
  _pages/                 rendered page images; all pages only for small PDFs by default
  _ocr/                   OCR text when OCR was needed and OCR tools were available
  _ocr_pages/             temporary OCR page renders when tesseract OCR is used
  _summary/manifest.txt   tool versions, PDF info, counts, extraction/render modes

Windows paths such as C:\path\file.pdf and MSYS paths such as /c/path/file.pdf are both accepted.

Environment knobs:
  PDF_FULL_RENDER_PAGE_LIMIT=19   Render all page images only when page count is <= this value.
  PDF_RENDER_ALL_PAGES=1          Override the page-count gate and render all pages.
  PDF_SAMPLE_PAGES=1,last         For large PDFs, sample pages to render. Use comma-separated page numbers and/or "last".
  PDF_IMAGE_DPI_SMALL=250         DPI for full rendering of small PDFs.
  PDF_IMAGE_DPI_SAMPLE=150        DPI for sample rendering of large PDFs.
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

full_render_page_limit="${PDF_FULL_RENDER_PAGE_LIMIT:-19}"
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

mkdir -p "$outdir"/{_input,_text,_markitdown,_pages,_ocr,_ocr_pages,_summary}
work_pdf="$outdir/_input/$base"
cp -f "$input_pdf" "$work_pdf"

layout_txt="$outdir/_text/pdftotext-layout.txt"
markitdown_md="$outdir/_markitdown/markitdown.md"
pages_prefix="$outdir/_pages/page"
manifest="$outdir/_summary/manifest.txt"
outdir_win="$(to_windows_path "$outdir")"
work_pdf_win="$(to_windows_path "$work_pdf")"
layout_txt_win="$(to_windows_path "$layout_txt")"
markitdown_md_win="$(to_windows_path "$markitdown_md")"
pages_dir_win="$(to_windows_path "$outdir/_pages")"
ocr_dir_win="$(to_windows_path "$outdir/_ocr")"
manifest_win="$(to_windows_path "$manifest")"

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

# 3. Page-count-aware image rendering. Full visual/model inspection is only
#    appropriate for small PDFs by default. Large PDFs get sample images only.
image_render_mode="sample only"
if [[ "$render_all_pages" == "1" ]]; then
  pdftoppm -png -r "$image_dpi_small" -cropbox "$work_pdf" "$pages_prefix"
  image_render_mode="all pages override"
elif [[ "$page_count" =~ ^[0-9]+$ && "$page_count" -le "$full_render_page_limit" ]]; then
  pdftoppm -png -r "$image_dpi_small" -cropbox "$work_pdf" "$pages_prefix"
  image_render_mode="all pages small-pdf"
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

ocr_status="not needed"
ocr_output=""
run_ocr_if_needed
ocr_output_win=""
if [[ -n "$ocr_output" ]]; then ocr_output_win="$(to_windows_path "$ocr_output")"; fi

png_count="$(find "$outdir/_pages" -type f -name '*.png' | wc -l | tr -d ' ')"
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
  echo "Full render page limit: $full_render_page_limit"
  echo "Image render mode: $image_render_mode"
  echo "PDF_RENDER_ALL_PAGES: $render_all_pages"
  echo "Sample pages requested: $sample_pages_csv"
  echo "Text non-space chars: $text_nonspace_chars"
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
  echo "MarkItDown lines: $(wc -l < "$markitdown_md")"
  echo "PNG page/sample images: $png_count"
  echo "OCR page images: $ocr_page_png_count"
} > "$manifest"

echo "Done. Output directory: $outdir"
echo "Done. Output directory Windows: $outdir_win"
echo "- $layout_txt"
echo "- $markitdown_md"
echo "- $outdir/_pages/page-*.png or sample-page-*.png"
echo "- $outdir/_ocr/ocr*.txt (when created)"
echo "- $manifest"
echo "Windows paths for Pi read tool:"
echo "- $layout_txt_win"
echo "- $markitdown_md_win"
echo "- $pages_dir_win\\page-*.png or sample-page-*.png"
echo "- $ocr_dir_win\\ocr*.txt"
echo "- $manifest_win"
