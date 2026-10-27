import "regenerator-runtime/runtime";
const notoBytes = new Uint8Array(await Bun.file("public/fonts/NotoSansDevanagari-Regular.ttf").arrayBuffer());
const messages: unknown[] = [];
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
};
workerGlobal.postMessage = (msg: unknown): void => { messages.push(msg); };
workerGlobal.location = { href: "http://localhost/" };
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;
globalThis.fetch = (async (): Promise<Response> => new Response(notoBytes)) as typeof fetch;
console.log("pre-import");
const mod = await import("./tools/publisher-to-pdf/worker");
console.log("imported:", typeof workerGlobal.onmessage, "File:", typeof globalThis.File);
process.exit(0);
