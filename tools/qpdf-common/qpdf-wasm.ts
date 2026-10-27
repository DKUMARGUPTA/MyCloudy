/**
 * Shared qpdf-wasm engine (P9-C) — loads the self-hosted Emscripten
 * build (public/vendor/qpdf-wasm) and runs one qpdf invocation per
 * job inside the virtual FS.
 *
 * The Emscripten build has NO wasmBinary support — it always fetch()
 * es the .wasm via locateFile(). We therefore give it an ABSOLUTE URL:
 *   - browser worker: origin-absolutized /vendor path
 *   - node/bun (smoke): the running dev server's URL (fallback)
 * `var process;` masks Bun's `process` so the wrapper's Node branch
 * (require("fs") + __dirname, absent inside new Function) is skipped.
 */

interface QpdfFS {
  writeFile(name: string, data: Uint8Array): void;
  readFile(name: string): Uint8Array;
  unlink(name: string): void;
}

type QpdfModule = {
  FS: QpdfFS;
  callMain(argv: string[]): number;
};

type QpdfFactory = (opts: Record<string, unknown>) => Promise<QpdfModule>;

let cached: QpdfModule | null = null;

const QPDF_JS_URL = "/vendor/qpdf-wasm/qpdf.js";
const QPDF_WASM_PATH = "/vendor/qpdf-wasm/qpdf.wasm";
/** Node/Bun disk path — public/ is served at the URL root in browsers. */
const QPDF_JS_DISK = "./public/vendor/qpdf-wasm/qpdf.js";

function resolveWasmUrl(devServer = "http://localhost:3000"): string {
  if (typeof self !== "undefined" && (self as { location?: Location }).location) {
    return new URL(QPDF_WASM_PATH, (self as { location: Location }).location.origin).href;
  }
  return `${devServer}${QPDF_WASM_PATH}`;
}

async function loadWithFactory(
  code: string,
  wasmUrl: string
): Promise<QpdfModule> {
  const wrapped = new Function(
    "moduleArg",
    `var process; ${code}\nreturn Module;`
  ) as (arg: Record<string, unknown>) => QpdfFactory;
  const factory = wrapped({});
  return await factory({
    locateFile: () => wasmUrl,
    noInitialRun: true,
  });
}

export interface FsLike {
  readFile(path: string): Uint8Array | Buffer;
}

/** Get (and cache) the qpdf module for the current context. */
export async function getQpdf(fsLike?: FsLike, devServer = "http://localhost:3000"): Promise<QpdfModule> {
  if (cached) return cached;
  let code: string;
  if (fsLike) {
    code = fsLike.readFile(QPDF_JS_DISK).toString("utf8");
  } else if (typeof fetch === "function") {
    code = await (await fetch(new URL(QPDF_JS_URL, resolveWasmUrl()).href)).text();
  } else {
    throw new Error("qpdf-wasm: no loader for this context");
  }
  cached = await loadWithFactory(code, resolveWasmUrl(devServer));
  return cached;
}

export interface QpdfRunResult {
  ok: boolean;
  bytes: Uint8Array | null;
  exitCode: number;
}

/**
 * Run one qpdf job: write `input` into the virtual FS, callMain with
 * full qpdf args + input/output paths, read the output back.
 * `args` example: ["--linearize"] or ["--object-streams=disable"].
 */
export async function runQpdf(
  input: Uint8Array,
  args: string[],
  inName = "in.pdf",
  outName = "out.pdf"
): Promise<QpdfRunResult> {
  const qpdf = await getQpdf();
  const FS = qpdf.FS;
  const inPath = `/work/${inName}`;
  const outPath = `/work/${outName}`;
  let actualIn = inPath;
  let actualOut = outPath;
  try {
    FS.writeFile(inPath, input);
  } catch {
    // /work missing on a cold module — fall back to root paths.
    actualIn = inName;
    actualOut = outName;
    FS.writeFile(actualIn, input);
  }
  const exit = qpdf.callMain([...args, actualIn, actualOut]);
  let bytes: Uint8Array | null = null;
  try {
    bytes = FS.readFile(actualOut);
    try {
      FS.unlink(actualOut);
      FS.unlink(actualIn);
    } catch {
      /* best effort */
    }
  } catch {
    // No output file — qpdf failed; ok stays false.
  }
  return { ok: exit === 0 && bytes !== null, bytes, exitCode: exit };
}
