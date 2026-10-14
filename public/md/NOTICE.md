# public/md/md-parser.js

Precompiled classic-script bundle of `mdast-util-from-markdown@2.0.2`
(+ its micromark dependencies), all MIT-licensed:

- mdast-util-from-markdown — MIT © Titus Wormer
- micromark (+ micromark-* extensions) — MIT © Titus Wormer
- mdast — MIT © Titus Wormer

Built with esbuild (`--format=iife --minify`) from
tools/markdown-to-pdf/md-parser-entry.ts — see scripts/build-md-parser.sh.
The bundle exposes `globalThis.__DOCO_MD_PARSE__` (the `fromMarkdown`
function) for classic Web Worker `importScripts` loading; source:
https://github.com/syntax-tree/mdast-util-from-markdown
