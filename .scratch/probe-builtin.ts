const p = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
console.log("process:", typeof p);
console.log("getBuiltinModule:", typeof p?.getBuiltinModule);
if (typeof p?.getBuiltinModule === "function") {
  const zlib = p.getBuiltinModule("node:zlib") as { inflateSync?: (d: Uint8Array) => Uint8Array } | null;
  console.log("zlib:", typeof zlib, "inflateSync:", typeof zlib?.inflateSync);
  if (zlib?.inflateSync) {
    const deflated = new Uint8Array([0x78, 0x9c, 0x4b, 0x4c, 0x4a, 0x06, 0x00, 0x02, 0x4d, 0x01, 0x27]); // "hello" zlib
    console.log("inflate:", Buffer.from(zlib.inflateSync(deflated)).toString());
  }
} else {
  const zlib = p?.getBuiltinModule;
  console.log("no getBuiltinModule");
}
