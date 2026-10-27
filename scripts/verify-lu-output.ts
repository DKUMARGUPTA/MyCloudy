/** Verify the E2E browser output with the qpdf oracle (P3.15 QA; NOT shipped). */
import { readFile } from "node:fs/promises";

const output: string[] = [];
const origLog = console.log;
const origWarn = console.warn;
console.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
console.warn = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
const { default: init } = await import("@jspawn/qpdf-wasm");

const wasmPath = new URL("../node_modules/@jspawn/qpdf-wasm/qpdf.wasm", import.meta.url).pathname;
const wasmBytes = new Uint8Array(await readFile(wasmPath));
const qpdf: any = await init({
  instantiateWasm: (imports: unknown, cb: (inst: unknown) => void) => {
    WebAssembly.instantiate(wasmBytes, imports as WebAssembly.Imports).then(
      (r: { instance: unknown }) => cb(r.instance)
    );
    return {};
  },
});
console.log = origLog;
console.warn = origWarn;

const target = process.argv[2];
const pw = process.argv[3] ?? "";
const bytes = new Uint8Array(await readFile(target));
qpdf.FS.writeFile("v.pdf", bytes);
output.length = 0;
const rc = qpdf.callMain(pw ? ["--show-encryption", `--password=${pw}`, "v.pdf"] : ["--show-encryption", "v.pdf"]);
const info = output.join("\n");
console.log(`file: ${target} (${bytes.length} bytes), rc=${rc}`);
console.log(info);
