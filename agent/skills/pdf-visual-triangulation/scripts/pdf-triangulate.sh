#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  pdf-triangulate.sh <input.pdf> [output-dir]

If output-dir is omitted, creates a non-destructive artifact folder under the user's temp directory.
The work folder contains:
  _input/                 copied source PDF
  _text/pdftotext-layout.txt
  _markitdown/markitdown.md
  _pages/page-*.png       rendered page images for visual/model inspection
  _summary/manifest.txt   tool versions, PDF info, counts

Windows paths such as C:\path\file.pdf and MSYS paths such as /c/path/file.pdf are both accepted.
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

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
    win_tmp="$(powershell.exe -NoProfile -Command '[System.IO.Path]::GetTempPath()' 2>/dev/null | tr -d '\r\n' || true)"
  elif command -v pwsh >/dev/null 2>&1; then
    win_tmp="$(pwsh -NoProfile -Command '[System.IO.Path]::GetTempPath()' 2>/dev/null | tr -d '\r\n' || true)"
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

[[ ${1:-} == "-h" || ${1:-} == "--help" ]] && { usage; exit 0; }
[[ $# -ge 1 && $# -le 2 ]] || { usage; exit 2; }

need_cmd pdftotext
need_cmd pdftoppm

input_pdf="$(to_msys_path "$1")"
[[ -f "$input_pdf" ]] || die "Input PDF not found: $1"

base="$(basename "$input_pdf")"
slug="$(slugify "$base")"

if [[ $# -eq 2 ]]; then
  outdir="$(to_msys_path "$2")"
else
  tmp_root="$(local_temp_root)"
  outdir="$tmp_root/pi-pdf-visual-triangulation/$slug-$(date +%Y%m%d-%H%M%S)-$$"
fi

mkdir -p "$outdir"/{_input,_text,_markitdown,_pages,_summary}
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
manifest_win="$(to_windows_path "$manifest")"

# 1. Deterministic text extraction preserving layout/columns.
pdftotext -layout -enc UTF-8 "$work_pdf" "$layout_txt"

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

# 3. Render every page for visual/model inspection.
#    250 DPI is a good default for small financial tables without creating huge files.
pdftoppm -png -r 250 -cropbox "$work_pdf" "$pages_prefix"

{
  echo "PDF visual triangulation manifest"
  echo "Generated: $(date -Is)"
  echo "Source: $input_pdf"
  echo "Working copy: $work_pdf"
  echo "Working copy Windows: $work_pdf_win"
  echo "Output dir: $outdir"
  echo "Output dir Windows: $outdir_win"
  echo
  echo "Tool paths:"
  echo "pdftotext: $(command -v pdftotext)"
  echo "pdftoppm:  $(command -v pdftoppm)"
  if command -v uvx >/dev/null 2>&1; then echo "uvx:       $(command -v uvx)"; fi
  if command -v markitdown >/dev/null 2>&1; then echo "markitdown: $(command -v markitdown)"; fi
  echo
  echo "Versions:"
  pdftotext -v 2>&1 | head -2 || true
  pdftoppm -v 2>&1 | head -2 || true
  if command -v uvx >/dev/null 2>&1; then uvx --from 'markitdown[pdf]' markitdown --version 2>&1 || true; fi
  echo
  echo "PDF info:"
  if command -v pdfinfo >/dev/null 2>&1; then pdfinfo "$work_pdf" || true; else echo "pdfinfo not found"; fi
  echo
  echo "Output counts:"
  echo "pdftotext lines: $(wc -l < "$layout_txt")"
  echo "MarkItDown lines: $(wc -l < "$markitdown_md")"
  echo "PNG page images: $(find "$outdir/_pages" -type f -name '*.png' | wc -l)"
} > "$manifest"

echo "Done. Output directory: $outdir"
echo "Done. Output directory Windows: $outdir_win"
echo "- $layout_txt"
echo "- $markitdown_md"
echo "- $outdir/_pages/page-*.png"
echo "- $manifest"
echo "Windows paths for Pi read tool:"
echo "- $layout_txt_win"
echo "- $markitdown_md_win"
echo "- $pages_dir_win\\page-*.png"
echo "- $manifest_win"
