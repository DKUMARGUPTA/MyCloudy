/**
 * Worker-side loader for the vendored qpdf 11.0.0 WebAssembly build
 * (PRD §7.4 "Web optimize (linearize)" — engine: qpdf-wasm, Mode D).
 *
 * Self-hosted, unmodified files (Apache-2.0 — LICENSE ships alongside):
 *
 *   /vendor/qpdf/qpdf.js    UMD glue (Emscripten; `var Module` factory)
 *   /vendor/qpdf/qpdf.wasm  the compiled CLI (1.27 MB)
 *
 * Loading recipe (the tesseract/pdf.js/libheif pattern, adapted for a UMD
 * that does not attach a global): the package's own browser entry sets a
 * throwaway `globalThis.exports = {}` before importing the glue — the
 * UMD's `else if (typeof exports === "object")` arm then writes the
 * factory to `globalThis.exports.Module`, which we grab and clean up.
 *
 * The wasm is fetched by the glue itself via `locateFile` (absolute
 * same-origin URL; application/wasm content type → instantiateStreaming
 * — no patching of the vendored build needed).
 *
 * callMain notes (all probe-verified on this exact build):
 *  - qpdf exits 0 on success and does NOT throw; success is judged by the
 *    output file's existence in MEMFS (encrypted input surfaces the same
 *    way: no output, no synchronous throw).
 *  - qpdf's stdout/stderr bypass Module.print — the Emscripten TTY is
 *    bound to console.log/console.warn at factory time. A module-level
 *    tap (installed before the first create) captures stderr for honest
 *    "warnings were emitted" reporting.
 *  - a second callMain on the same instance works (worker-pool reuse).
 *  - after any failed run the instance is treated as poisoned and the
 *    next run re-creates it (CLI state cannot be trusted mid-abort).
 */

/** The tiny slice of the Emscripten module surface this tool uses. */
export interface QpdfInstance {
  callMain(args: string[]): void;
  FS: {
    writeFile(name: string, data: Uint8Array | ArrayBufferView): void;
    readFile(name: string): Uint8Array;
    unlink(name: string): void;
  };
}

interface QpdfFactory {
  (config: {
    locateFile?: (path: string, scriptDirectory: string) => string;
  }): Promise<QpdfInstance>;
}

/**
 * Absolute URL for a same-origin public asset — blob: workers
 * (Turbopack dev serves workers from blob: URLs) recover the origin
 * from the blob URL itself (the stamp-common/tess.ts recipe).
 */
function assetOriginUrl(path: string): string {
  try {
    const viaLocation = new URL(path, self.location.href);
    if (
      viaLocation.protocol === "http:" ||
      viaLocation.protocol === "https:"
    ) {
      return viaLocation.href;
    }
  } catch {
    // opaque base (blob: workers) — fall through to the blob-origin recovery
  }
  const blobOrigin = /^blob:(https?:\/\/[^/]+)/i.exec(self.location.href);
  if (blobOrigin) return `${blobOrigin[1]}${path}`;
  return path;
}

/* ------------------------- stderr tap (once) ------------------------- */

/**
 * qpdf's stderr is bound to console.warn when the Emscripten factory
 * runs, so the tap must be installed before the first create and stay
 * installed for the module's lifetime. A worker's console is private to
 * the worker — nothing else in this thread is affected. Between runs
 * the tap passes through untouched.
 */
let stderrSink: ((line: string) => void) | null = null;
const rawWarn = console.warn.bind(console);

if (typeof console !== "undefined") {
  console.warn = (...args: unknown[]) => {
    if (stderrSink !== null) {
      stderrSink(args.map(String).join(" "));
      return;
    }
    rawWarn(...args);
  };
}

/* --------------------------- module cache ---------------------------- */

let qpdfPromise: Promise<QpdfInstance> | null = null;
/** Set after a failed run — forces a fresh instance next time. */
let poisoned = false;

async function createQpdf(): Promise<QpdfInstance> {
  // A throwaway `exports` global makes the UMD expose its factory.
  const globe = globalThis as Record<string, unknown>;
  const hadExports = "exports" in globe;
  const prevExports = globe.exports;
  globe.exports = {};
  try {
    await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */
      assetOriginUrl("/vendor/qpdf/qpdf.js")
    );
    const factory = (
      globe.exports as { Module?: QpdfFactory } | undefined
    )?.Module;
    if (typeof factory !== "function") {
      throw new Error("wopt.errorEngineLoad");
    }
    return await factory({
      locateFile: (file) => assetOriginUrl(`/vendor/qpdf/${file}`),
    });
  } finally {
    if (hadExports) globe.exports = prevExports;
    else delete globe.exports;
  }
}

/** Loads (and caches) the qpdf engine; a poisoned instance is rebuilt. */
export function loadQpdf(): Promise<QpdfInstance> {
  if (qpdfPromise === null || poisoned) {
    poisoned = false;
    qpdfPromise = createQpdf().catch((cause) => {
      qpdfPromise = null; // a failed load must not poison the cache
      throw cause;
    });
  }
  return qpdfPromise;
}

/** Mark the cached instance unusable (called after a failed run). */
export function poisonQpdf(): void {
  poisoned = true;
}

export interface QpdfRunResult {
  bytes: Uint8Array;
  /** qpdf stderr lines captured during the run (warnings, recoveries). */
  warnings: string[];
}

/**
 * Run `qpdf <args> <inputName> <outName>` and return the bytes of
 * `outName`, or null when the run produced no output (encrypted input,
 * unreadable PDF…). Never throws for qpdf-level failures — the caller
 * maps the null to its honest error keys.
 */
export async function runQpdf(
  inputName: string,
  inputBytes: Uint8Array,
  args: string[],
  outName: string
): Promise<QpdfRunResult | null> {
  const qpdf = await loadQpdf();
  try {
    qpdf.FS.writeFile(inputName, inputBytes);
  } catch {
    poisonQpdf();
    return null;
  }
  const warnings: string[] = [];
  let outBytes: Uint8Array | null = null;
  stderrSink = (line) => {
    if (warnings.length < 40) warnings.push(line);
  };
  try {
    qpdf.callMain([...args, inputName, outName]);
  } catch {
    // This old Emscripten build can surface CLI failures asynchronously
    // (node uncaughtException / console paths); the file check below is
    // the honest success signal.
  } finally {
    stderrSink = null;
  }
  try {
    // readFile throws when the run produced no output (this build's FS
    // has no analyzePath — existence is proven by the read itself).
    const read = qpdf.FS.readFile(outName) as Uint8Array;
    if (read.length > 0) outBytes = read;
  } catch {
    outBytes = null;
  }
  if (outBytes === null) {
    poisonQpdf();
    return null;
  }
  const bytes = outBytes;
  try {
    return { bytes, warnings };
  } finally {
    try {
      qpdf.FS.unlink(inputName);
      qpdf.FS.unlink(outName);
    } catch {
      // best-effort MEMFS cleanup; a failure here is harmless
    }
  }
}
