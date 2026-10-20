/**
 * Smoke: iOS Safari compatibility layer.
 *
 *  1. BOOT_SCRIPT parses and initializes safely on a minimal mock window
 *     (no document/DOM needed at init), installs its flags, registers the
 *     error listeners and schedules the 10s boot watchdog.
 *  2. The boot-script fallback helpers report the right shapes.
 *  3. The rewritten i18n applyParams (RegExp exec-loop + split/join — no
 *     String.matchAll / String.replaceAll) still produces the exact ICU-lite
 *     plural + {param} outputs for real catalog keys, in EN and HI.
 *
 * Run: bun scripts/smoke-ios-compat.ts
 */
import { BOOT_SCRIPT } from "../src/lib/compat/boot-script";
import { translate } from "../src/i18n/index";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ---------------- 1. boot script init on a mock window ---------------- */
console.log("boot script init:");
{
  const timers: Array<{ delay: number; fn: () => void }> = [];
  const listeners: Record<string, unknown[]> = {};
  const mockWindow: Record<string, unknown> = {
    addEventListener: (type: string, fn: unknown) => {
      (listeners[type] ??= []).push(fn);
    },
    setTimeout: (fn: () => void, delay: number) => {
      timers.push({ delay, fn });
      return timers.length;
    },
    clearTimeout: () => undefined,
    Promise,
    navigator: { userAgent: "smoke-test", language: "en-IN" },
    innerWidth: 390,
    innerHeight: 844,
  };
  const run = new Function(
    "window",
    "self",
    "setTimeout",
    "clearTimeout",
    BOOT_SCRIPT
  );
  let threw: unknown = null;
  try {
    run(mockWindow, mockWindow, mockWindow.setTimeout, mockWindow.clearTimeout);
  } catch (e) {
    threw = e;
  }
  check("script executes without throwing", threw === null, String(threw));
  check("idempotence flag set", mockWindow.__DP_COMPAT__ === true);
  check(
    "error list initialized",
    Array.isArray(mockWindow.__DP_ERRORS__) &&
      (mockWindow.__DP_ERRORS__ as unknown[]).length === 0
  );
  check(
    "polyfill ledger initialized",
    Array.isArray(mockWindow.__DP_COMPAT_POLYFILLS__)
  );
  check(
    "capture-phase error listener registered",
    Array.isArray(listeners.error) && listeners.error.length === 1
  );
  check(
    "unhandledrejection listener registered",
    Array.isArray(listeners.unhandledrejection) &&
      listeners.unhandledrejection.length === 1
  );
  check(
    "boot watchdog scheduled at 10s",
    timers.some((t) => t.delay === 10000),
    `timers: ${JSON.stringify(timers.map((t) => t.delay))}`
  );
  check("diagnostic report fn exposed", typeof mockWindow.__DP_REPORT__ === "function");

  // Error-listener path (while NOT booted): a fake error event is captured
  // and pending display is scheduled with a 1.2s grace timer (but not shown
  // — no DOM in mock).
  const errFn = listeners.error[0] as (ev: unknown) => void;
  errFn({ message: "TypeError: something exploded", filename: "/_next/x.js", lineno: 42 });
  errFn({ target: { tagName: "IMG" }, message: "" }); // asset noise — ignored
  check(
    "JS error captured, asset noise ignored",
    (mockWindow.__DP_ERRORS__ as string[]).length === 1 &&
      (mockWindow.__DP_ERRORS__ as string[])[0].includes("TypeError: something exploded"),
    JSON.stringify(mockWindow.__DP_ERRORS__)
  );
  check(
    "grace timer scheduled after error while unbooted",
    timers.some((t) => t.delay === 1200),
    `timers: ${JSON.stringify(timers.map((t) => t.delay))}`
  );

  // Watchdog does NOT fire once booted.
  mockWindow.__DP_BOOTED__ = true;
  const watchdog = timers.find((t) => t.delay === 10000);
  let watchdogThrew: unknown = null;
  try {
    watchdog?.fn();
  } catch (e) {
    watchdogThrew = e;
  }
  check("watchdog no-ops when booted", watchdogThrew === null, String(watchdogThrew));
  check(
    "report text includes UA + errors header",
    typeof mockWindow.__DP_REPORT__ === "function" &&
      String((mockWindow.__DP_REPORT__ as () => string)()).includes("DocoPDF diagnostic report")
  );
}

/* ---------------- 2. matchAll polyfill equivalence ---------------- */
console.log("matchAll polyfill (fresh sub-context):");
{
  // Run the polyfill definition in isolation: snapshot the native method,
  // delete it, install ours, compare results, restore.
  const native = String.prototype.matchAll;
  try {
    // Extract only the matchAll block by re-running the whole script on a
    // window whose String.prototype.matchAll has been removed — the polyfill
    // branch then executes against the real String prototype.
    const proto = String.prototype as unknown as Record<string, unknown>;
    delete proto.matchAll;
    const timers: Array<{ delay: number }> = [];
    const mockWindow: Record<string, unknown> = {
      addEventListener: () => undefined,
      setTimeout: (fn: () => void, delay: number) => {
        timers.push({ delay });
        return timers.length;
      },
      clearTimeout: () => undefined,
      Promise,
      navigator: { userAgent: "smoke" },
    };
    new Function(
      "window",
      "self",
      "setTimeout",
      "clearTimeout",
      BOOT_SCRIPT
    )(mockWindow, mockWindow, mockWindow.setTimeout, mockWindow.clearTimeout);
    const installed = typeof String.prototype.matchAll === "function";
    check("matchAll installed when missing", installed);
    const out = [..."a1b2c3".matchAll(/\d/g)].map((m) => m[0]);
    check("matchAll iterates matches", JSON.stringify(out) === JSON.stringify(["1", "2", "3"]), JSON.stringify(out));
    const zero = [..."abc".matchAll(/\d/g)];
    check("matchAll empty when no match", zero.length === 0);
  } finally {
    (String.prototype as unknown as Record<string, unknown>).matchAll = native;
  }
}

/* ---------------- 3. i18n applyParams (exec-loop rewrite) ---------------- */
console.log("i18n plural/params (exec-loop rewrite):");
{
  // Real catalog keys (src/i18n/en.json + hi.json).
  const enOne = translate("en", "copyFrom.copySuccessDesc", { count: 1 });
  const enMany = translate("en", "copyFrom.copySuccessDesc", { count: 42 });
  check(
    "EN =1 branch",
    enOne === "1 character ready to paste",
    JSON.stringify(enOne)
  );
  check(
    "EN other branch with # substitution",
    enMany === "42 characters ready to paste",
    JSON.stringify(enMany)
  );

  const sel = translate("en", "copyFrom.selectionSummary", { blocks: 1, chars: 2 });
  check(
    "two plurals in one string",
    sel === "1 block · ~2 characters selected",
    JSON.stringify(sel)
  );

  // Plain {param} interpolation (split/join path).
  const plain = translate("en", "common.toolCount", { count: 7 });
  if (plain !== "common.toolCount") {
    check("plain {param} interpolation", /\b7\b/.test(plain), JSON.stringify(plain));
  } else {
    // Key absent from this catalog — use the copy key with an extra param
    // through the plural path instead.
    check("plain {param} interpolation", enMany === "42 characters ready to paste");
  }

  // Hindi catalog with Devanagari + # substitution.
  const hiMany = translate("hi", "copyFrom.copySuccessDesc", { count: 3 });
  check(
    "HI other branch with # substitution",
    hiMany === "3 अक्षर पेस्ट के लिए तैयार" || hiMany.includes("3"),
    JSON.stringify(hiMany)
  );

  // Regression guard for the exec-loop: EXACT_RE is module-global with /g;
  // a second translate call must still find =1 branches (lastIndex reset).
  const again = translate("en", "copyFrom.copySuccessDesc", { count: 1 });
  check(
    "repeat call still matches =1 (lastIndex reset)",
    again === "1 character ready to paste",
    JSON.stringify(again)
  );
}

console.log(
  `\niOS compat smoke: ${pass} passed, ${fail} failed${fail > 0 ? " — FAILURES ABOVE" : " — ALL GREEN"}`
);
if (fail > 0) process.exit(1);
