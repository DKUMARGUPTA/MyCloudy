#!/usr/bin/env bash
# Rebuild public/md/md-parser.js (the classic-script markdown parser bundle).
# See tools/markdown-to-pdf/md-parser-entry.ts for why this exists:
# Turbopack dev workers are classic blob scripts; ESM-only mdast/micromark
# cannot be imported there. --conditions=worker keeps
# decode-named-character-reference on its DOM-free variant.
set -euo pipefail
cd "$(dirname "$0")/.."
bunx esbuild tools/markdown-to-pdf/md-parser-entry.ts \
  --bundle --format=iife --minify --legal-comments=none \
  --platform=neutral --conditions=worker \
  --outfile=public/md/md-parser.js
echo "built public/md/md-parser.js"
