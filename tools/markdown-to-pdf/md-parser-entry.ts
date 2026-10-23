/**
 * Entry for the precompiled markdown parser bundle (public/md/md-parser.js).
 *
 * WHY THIS EXISTS: Turbopack's dev-mode worker loader compiles
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
 * into a CLASSIC blob worker whose bootstrap loads chunks via
 * `importScripts(...)` — classic scripts cannot contain ESM syntax, so the
 * ESM-only mdast-util-from-markdown/micromark graph throws a SyntaxError
 * with no error message and the worker dies silently (found in P4.1 QA).
 * The parser therefore ships precompiled as a self-hosted classic IIFE
 * (the same separate-asset pattern as public/libheif) and the worker loads it
 * at runtime. Never import this file from app code — it exists only for
 * `bunx esbuild` (see scripts/build-md-parser.sh).
 */
import { fromMarkdown } from "mdast-util-from-markdown";

(globalThis as unknown as Record<string, unknown>).__DOCO_MD_PARSE__ =
  fromMarkdown;
