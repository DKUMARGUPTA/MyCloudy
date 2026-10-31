/**
 * iOS/Safari compatibility boot script (inline, runs before every app chunk).
 *
 * Rendered as the FIRST child of <body> via dangerouslySetInnerHTML in
 * src/app/layout.tsx, so it executes before any Next.js client chunk:
 *
 *  1. Early error capture — window.__DP_ERRORS__ records the first 8 JS
 *     errors/rejections with a capture-phase "error" listener installed
 *     before any React code exists, turning invisible iPhone white-screen
 *     crashes into a reportable diagnostic.
 *  2. Idempotent polyfills for every API this app (or its deps) touches that
 *     Safari gained AFTER the Next.js syntax floor (Safari 12):
 *       String.matchAll (iOS 13), String.replaceAll (iOS 13.1),
 *       Object.fromEntries / Array.flat (iOS 12.1), Promise.allSettled (13),
 *       Blob.arrayBuffer/.text (14), ResizeObserver (13.4),
 *       Object.hasOwn / Array.at (15.4), structuredClone (15.4),
 *       crypto.randomUUID (15.4), queueMicrotask (12.1).
 *     The installed list is exposed as window.__DP_COMPAT_POLYFILLS__ for
 *     diagnostics.
 *  3. Boot watchdog — the React shell marks window.__DP_BOOTED__ on mount
 *     and calls window.__DP_BOOT_OK__() (src/components/doco/app-shell.tsx),
 *     which clears any fallback a slow start may have put on screen. The
 *     watchdog is ADAPTIVE so a genuinely slow start is not mistaken for a
 *     dead one (learned from false "did not finish starting within 10
 *     seconds" reports on otherwise-working loads):
 *       - 10s base patience; 40s when navigator.connection reports 2g /
 *         slow-2g / saveData; 45s minimum in dev (window.__DP_DEV__, set by
 *         layout.tsx — Turbopack cold compiles after every restart/edit can
 *         exceed 10s).
 *       - While document.readyState is still "loading" (chunks streaming /
 *         compiling) it keeps deferring, up to a 90s hard cap.
 *       - If the timeout still fires, a friendly "taking longer than usual"
 *         screen shows — and SELF-HEALS: a poll removes it the moment the
 *         app boots, so a slow start can never permanently cover a working
 *         app (the old overlay stayed on top forever, forcing a reload).
 *     Fatal-error fallback (1.2s grace so React's own error boundary can
 *     win) keeps the crash UI and also self-heals if boot completes.
 *     window.__DP_REPORT__() returns the full diagnostic (UA, viewport,
 *     readyState, network, polyfills, errors).
 *
 * Syntax rules for the script body (it must parse on Safari 12):
 * ES6 max — no optional chaining, nullish coalescing, logical assignment,
 * numeric separators or class fields. No ES2018+ regex features.
 * Stored with String.raw so backslashes stay literal.
 */

export const BOOT_SCRIPT = String.raw`
(function () {
  "use strict";
  var W = window;
  if (W.__DP_COMPAT__) return;
  W.__DP_COMPAT__ = true;

  /* ---------------- 1. early error capture ---------------- */
  var ERRS = (W.__DP_ERRORS__ = []);
  var POLY = (W.__DP_COMPAT_POLYFILLS__ = []);
  var currentReason = "The app stopped during startup on this device.";
  var errTimer = null;
  var bootTimer = null;
  var healTimer = null;
  var shown = false;
  var shownAt = 0;
  var startAt = Date.now();

  function cap(msg, extra) {
    if (ERRS.length >= 8) return;
    try {
      ERRS.push(String(msg) + (extra ? " | " + String(extra).slice(0, 240) : ""));
    } catch (e) {}
  }

  W.addEventListener("error", function (ev) {
    try {
      var t = ev && ev.target;
      if (t && t !== W && (t.tagName === "IMG" || t.tagName === "LINK")) return;
      var msg = ev && ev.message ? String(ev.message) : "";
      var src = ev && ev.filename ? String(ev.filename) : "";
      if (!msg && !src) return;
      if (msg.indexOf("ResizeObserver") !== -1) return;
      var extra = src
        ? src.split("?")[0].slice(-90) + ":" + (ev.lineno || 0)
        : ev && ev.error && ev.error.stack
          ? String(ev.error.stack).slice(0, 240)
          : "";
      cap(msg || "Script/resource error", extra);
      currentReason = msg
        ? "Startup error: " + msg.slice(0, 160)
        : "A script or resource failed to load during startup.";
      maybeShow();
    } catch (e) {}
  }, true);

  W.addEventListener("unhandledrejection", function (ev) {
    try {
      var r = ev && ev.reason;
      cap("Unhandled rejection: " + ((r && r.message) || r));
    } catch (e) {}
  });

  /* ---------------- 2. polyfills (idempotent) ---------------- */
  function def(obj, key, fn, label) {
    try {
      if (!(key in obj)) {
        Object.defineProperty(obj, key, { value: fn, writable: true, configurable: true });
        if (label) POLY.push(label);
      }
    } catch (e) {}
  }

  def(String.prototype, "replaceAll", function (search, repl) {
    if (search instanceof RegExp) {
      if (!search.global) throw new TypeError("replaceAll must be called with a global RegExp");
      return this.replace(search, repl);
    }
    return String(this).split(String(search)).join(String(repl));
  }, "String.replaceAll");

  if (!String.prototype.matchAll) {
    String.prototype.matchAll = function (re) {
      var s = String(this);
      var src = re instanceof RegExp ? re.source : String(re);
      var flags = "";
      try { flags = re instanceof RegExp ? String(re.flags || "") : ""; } catch (e) { flags = ""; }
      if (flags.indexOf("g") === -1) flags += "g";
      var g = new RegExp(src, flags);
      var it = {};
      it[Symbol.iterator] = function () {
        var m;
        g.lastIndex = 0;
        return {
          next: function () {
            m = g.exec(s);
            if (m === null) return { done: true, value: undefined };
            if (m.index === g.lastIndex) g.lastIndex++;
            return { done: false, value: m };
          },
        };
      };
      return it;
    };
    POLY.push("String.matchAll");
  }

  def(Object, "fromEntries", function (iter) {
    var out = {};
    if (iter == null) return out;
    var list = Array.isArray(iter) ? iter : typeof iter[Symbol.iterator] === "function" ? Array.from(iter) : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] != null) out[list[i][0]] = list[i][1];
    }
    return out;
  }, "Object.fromEntries");

  def(Object, "hasOwn", function (o, k) {
    return Object.prototype.hasOwnProperty.call(Object(o), k);
  }, "Object.hasOwn");

  def(Array.prototype, "at", function (i) {
    var n = Math.trunc(Number(i) || 0);
    if (n < 0) n += this.length;
    if (n < 0 || n >= this.length) return undefined;
    return this[n];
  }, "Array.at");

  if (!Array.prototype.flat) {
    Array.prototype.flat = function (d) {
      var depth = d === undefined ? 1 : Math.floor(Number(d) || 0);
      var out = [];
      function rec(a, dd) {
        for (var i = 0; i < a.length; i++) {
          if (dd > 0 && Array.isArray(a[i])) rec(a[i], dd - 1);
          else out.push(a[i]);
        }
      }
      rec(this, depth);
      return out;
    };
    Array.prototype.flatMap = function (fn) {
      var self = this;
      return Array.prototype.flat.call(
        Array.prototype.map.call(self, function (x, i) { return fn(x, i, self); }),
        1
      );
    };
    POLY.push("Array.flat/flatMap");
  }

  if (W.Promise && !W.Promise.allSettled) {
    W.Promise.allSettled = function (list) {
      return W.Promise.all(
        Array.prototype.map.call(list, function (p) {
          return W.Promise.resolve(p).then(
            function (v) { return { status: "fulfilled", value: v }; },
            function (e) { return { status: "rejected", reason: e }; }
          );
        })
      );
    };
    POLY.push("Promise.allSettled");
  }

  def(W, "structuredClone", function (v) {
    return JSON.parse(JSON.stringify(v));
  }, "structuredClone");

  def(W, "queueMicrotask", function (cb) {
    W.Promise.resolve().then(cb);
  }, "queueMicrotask");

  try {
    if (W.crypto && !W.crypto.randomUUID) {
      W.crypto.randomUUID = function () {
        var b = new Uint8Array(16);
        W.crypto.getRandomValues(b);
        b[6] = (b[6] & 15) | 64;
        b[8] = (b[8] & 63) | 128;
        var h = [];
        for (var i = 0; i < 16; i++) h.push(("0" + b[i].toString(16)).slice(-2));
        return (
          h[0] + h[1] + h[2] + h[3] + "-" + h[4] + h[5] + "-" + h[6] + h[7] + "-" +
          h[8] + h[9] + "-" + h[10] + h[11] + h[12] + h[13] + h[14] + h[15]
        );
      };
      POLY.push("crypto.randomUUID");
    }
  } catch (e) {}

  try {
    if (W.Blob && !W.Blob.prototype.arrayBuffer) {
      W.Blob.prototype.arrayBuffer = function () {
        var blob = this;
        return new W.Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () { res(fr.result); };
          fr.onerror = function () { rej(fr.error); };
          fr.readAsArrayBuffer(blob);
        });
      };
      W.Blob.prototype.text = function () {
        var blob = this;
        return new W.Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () { res(String(fr.result)); };
          fr.onerror = function () { rej(fr.error); };
          fr.readAsText(blob);
        });
      };
      POLY.push("Blob.arrayBuffer/text");
    }
  } catch (e) {}

  if (!W.ResizeObserver) {
    var RO = function (cb) { this.cb = cb; };
    RO.prototype.observe = function (el) {
      var cb = this.cb;
      var self = this;
      W.Promise.resolve().then(function () {
        try {
          var r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
          cb([{ target: el, contentRect: r }], self);
        } catch (e) {}
      });
    };
    RO.prototype.unobserve = function () {};
    RO.prototype.disconnect = function () {};
    W.ResizeObserver = RO;
    POLY.push("ResizeObserver(stub)");
  }

  if (!W.IntersectionObserver) {
    var IO = function (cb) { this.cb = cb; };
    IO.prototype.observe = function (el) {
      var cb = this.cb;
      var self = this;
      W.Promise.resolve().then(function () {
        try {
          cb(
            [{
              target: el,
              isIntersecting: true,
              intersectionRatio: 1,
              boundingClientRect: el.getBoundingClientRect ? el.getBoundingClientRect() : {},
              rootBounds: null,
              time: Date.now(),
            }],
            self
          );
        } catch (e) {}
      });
    };
    IO.prototype.unobserve = function () {};
    IO.prototype.disconnect = function () {};
    IO.prototype.takeRecords = function () { return []; };
    W.IntersectionObserver = IO;
    POLY.push("IntersectionObserver(stub)");
  }

  /* ---------------- 3. boot watchdog + fallback screen ---------------- */

  /* Adaptive patience: 10s normally; 40s on slow/save-data connections;
   * 45s in dev (window.__DP_DEV__ — layout.tsx sets it in dev because
   * Turbopack cold compiles after every restart/edit can exceed 10s). */
  function limitMs() {
    var t = 10000;
    try {
      var c = W.navigator && W.navigator.connection;
      if (c && (c.saveData === true || c.effectiveType === "2g" || c.effectiveType === "slow-2g")) t = 40000;
    } catch (e) {}
    if (W.__DP_DEV__ && t < 45000) t = 45000;
    return t;
  }

  var HARD_CAP = 90000;

  function reportText() {
    var nav = W.navigator || {};
    var conn = "unknown";
    try {
      var c = nav.connection;
      if (c) {
        conn = String(c.effectiveType || "?");
        if (c.downlink) conn += " ~" + c.downlink + "Mbps";
        if (c.saveData) conn += " saveData";
      }
    } catch (e) {}
    return (
      "DocoPDF diagnostic report" +
      "\nReason: " + currentReason +
      "\nTime: " + new Date().toISOString() +
      "\nUA: " + (nav.userAgent || "unknown") +
      "\nViewport: " + (W.innerWidth || "?") + "x" + (W.innerHeight || "?") +
      "\nLanguage: " + (nav.language || "?") +
      "\nReadyState: " + (W.document && W.document.readyState ? W.document.readyState : "?") +
      "\nNetwork: " + conn +
      "\nBoot: " + (W.__DP_BOOTED__ ? "complete" : "pending") +
      "\nDev: " + (W.__DP_DEV__ ? "yes" : "no") +
      "\nPolyfills: " + (POLY.length ? POLY.join(",") : "(none needed)") +
      "\nErrors:\n" + (ERRS.length ? ERRS.join("\n") : "(none captured)")
    );
  }
  W.__DP_REPORT__ = function () { return reportText(); };

  function maybeShow() {
    if (shown || W.__DP_BOOTED__) return;
    if (errTimer) clearTimeout(errTimer);
    errTimer = setTimeout(function () { showFallback(currentReason, false); }, 1200);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /* Removes any fallback overlay (with a short fade) and stops every
   * watchdog timer. Called when the app finishes starting — a slow start
   * must never permanently cover a working app. */
  function hideFallback() {
    if (healTimer) { clearInterval(healTimer); healTimer = null; }
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    if (errTimer) { clearTimeout(errTimer); errTimer = null; }
    shown = false;
    try {
      var doc = W.document;
      if (!doc || !doc.body) return;
      var nodes = doc.querySelectorAll('[data-dp-fallback="boot"]');
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        try {
          node.style.transition = "opacity 200ms ease";
          node.style.opacity = "0";
          W.setTimeout(function (n) {
            return function () {
              try { if (n.parentNode) n.parentNode.removeChild(n); } catch (e) {}
            };
          }(node), 240);
        } catch (e) {
          try { if (node.parentNode) node.parentNode.removeChild(node); } catch (e2) {}
        }
      }
    } catch (e) {}
  }

  /* The React shell calls this on mount: marks boot complete and clears
   * whatever the watchdog may have put on screen during a slow start. */
  W.__DP_BOOT_OK__ = function () {
    W.__DP_BOOTED__ = true;
    hideFallback();
  };

  function showFallback(reason, isTimeout) {
    if (shown || W.__DP_BOOTED__) return;
    shown = true;
    shownAt = Date.now();
    if (bootTimer) clearTimeout(bootTimer);
    if (errTimer) clearTimeout(errTimer);
    try {
      var doc = W.document;
      if (!doc || !doc.body) return;
      var d = doc.createElement("div");
      d.setAttribute("data-dp-fallback", "boot");
      d.setAttribute("role", "alert");
      d.setAttribute("dir", "ltr");
      d.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;background:#ffffff;color:#0f172a;" +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;" +
        "display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto;";
      var errs = ERRS.length
        ? ERRS.slice(0, 4).join("\n\n")
        : "No JavaScript error was captured. The page may have been blocked by the network or browser settings.";
      if (isTimeout) {
        /* Slow-start screen: reassuring, bilingual, and it closes itself
         * the moment the app finishes starting (self-heal poll below). */
        d.innerHTML =
          '<div style="max-width:440px;width:100%;">' +
          '<div style="font-size:36px;line-height:1;margin-bottom:12px;">\u23F3</div>' +
          '<h1 style="font-size:20px;font-weight:700;margin:0 0 6px;">The app is taking longer than usual</h1>' +
          '<p style="font-size:14px;color:#475569;margin:0 0 6px;">\u0910\u092A \u0936\u0941\u0930\u0942 \u0939\u094B\u0928\u0947 \u092E\u0947\u0902 \u0905\u0927\u093F\u0915 \u0938\u092E\u092F \u0932\u0917 \u0930\u0939\u093E \u0939\u0948\u0964 \u0915\u0943\u092A\u092F\u093E \u092A\u094D\u0930\u0924\u0940\u0915\u094D\u0937\u093E \u0915\u0930\u0947\u0902\u0964</p>' +
          '<p style="font-size:13px;color:#0f766e;margin:10px 0 0;">The app will open by itself \u2014 this screen closes automatically once it is ready.</p>' +
          '<p style="font-size:12px;color:#64748b;margin:12px 0 0;">' + esc(reason) + '</p>' +
          '<div style="margin-top:10px;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;color:#334155;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:10px;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;">' + esc(errs) + '</div>' +
          '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">' +
          '<button id="dpwait" type="button" style="flex:1;min-height:44px;min-width:140px;border:1px solid #cbd5e1;border-radius:10px;background:#ffffff;color:#0f172a;font-size:15px;font-weight:600;padding:10px 18px;cursor:pointer;">Continue waiting</button>' +
          '<button id="dpretry" type="button" style="flex:1;min-height:44px;min-width:140px;border:0;border-radius:10px;background:#0f766e;color:#ffffff;font-size:15px;font-weight:600;padding:10px 18px;cursor:pointer;">Reload / \u092B\u093F\u0930 \u0938\u0947 \u0932\u094B\u0921</button>' +
          '</div>' +
          '<textarea id="dpbox" readonly style="position:absolute;left:-9999px;top:0;width:400px;height:200px;"></textarea>' +
          '<p style="font-size:12px;color:#94a3b8;margin:14px 0 0;">DocoPDF \u2014 free PDF tools. Files stay on your device.</p>' +
          '</div>';
      } else {
        d.innerHTML =
          '<div style="max-width:440px;width:100%;">' +
          '<div style="font-size:36px;line-height:1;margin-bottom:12px;">\u26A0\uFE0F</div>' +
          '<h1 style="font-size:20px;font-weight:700;margin:0 0 6px;">The app couldn\u2019t load on this device</h1>' +
          '<p style="font-size:14px;color:#475569;margin:0 0 6px;">\u0910\u092A \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B \u092A\u093E \u0930\u0939\u093E \u0939\u0948\u0964 \u0915\u0943\u092A\u092F\u093E \u0930\u093F\u092A\u094B\u0930\u094D\u091F \u0915\u093E \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0947\u0902\u0964</p>' +
          '<p style="font-size:12px;color:#64748b;margin:12px 0 0;">' + esc(reason) + '</p>' +
          '<div style="margin-top:10px;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;">' + esc(errs) + '</div>' +
          '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">' +
          '<button id="dpretry" type="button" style="flex:1;min-height:44px;min-width:140px;border:0;border-radius:10px;background:#0f766e;color:#ffffff;font-size:15px;font-weight:600;padding:10px 18px;cursor:pointer;">Reload / \u092B\u093F\u0930 \u0938\u0947 \u0932\u094B\u0921</button>' +
          '<button id="dpcopy" type="button" style="flex:1;min-height:44px;min-width:140px;border:1px solid #cbd5e1;border-radius:10px;background:#ffffff;color:#0f172a;font-size:15px;font-weight:600;padding:10px 18px;cursor:pointer;">Copy report</button>' +
          '</div>' +
          '<textarea id="dpbox" readonly style="position:absolute;left:-9999px;top:0;width:400px;height:200px;"></textarea>' +
          '<p style="font-size:12px;color:#94a3b8;margin:14px 0 0;">DocoPDF \u2014 free PDF tools. Files stay on your device.</p>' +
          '</div>';
      }
      doc.body.appendChild(d);
      var retry = d.querySelector("#dpretry");
      var wait = d.querySelector("#dpwait");
      var copy = d.querySelector("#dpcopy");
      var box = d.querySelector("#dpbox");
      if (retry) retry.onclick = function () { W.location.reload(); };
      if (wait) wait.onclick = function () { hideFallback(); };
      if (copy && box) {
        copy.onclick = function () {
          box.value = reportText();
          var done = function () { try { copy.textContent = "Copied \u2713"; } catch (e) {} };
          var legacy = function () {
            try {
              box.style.position = "relative";
              box.style.left = "0";
              box.style.top = "0";
              box.focus();
              box.select();
              doc.execCommand("copy");
              box.style.position = "absolute";
              box.style.left = "-9999px";
              done();
            } catch (e) {}
          };
          if (W.navigator && W.navigator.clipboard && W.navigator.clipboard.writeText) {
            W.navigator.clipboard.writeText(box.value).then(done, legacy);
          } else legacy();
        };
      }
      /* Self-heal: if the app finishes starting later, quietly remove the
       * overlay — a slow start must never permanently cover a working
       * app. The poll retires itself after 90s. */
      healTimer = setInterval(function () {
        if (W.__DP_BOOTED__) { hideFallback(); return; }
        if (Date.now() - shownAt > 90000 && healTimer) { clearInterval(healTimer); healTimer = null; }
      }, 800);
    } catch (e) {}
  }

  /* Watchdog tick: re-checked every 2.5s past the limit while the document
   * is still loading (dev cold compiles, slow chunk downloads), up to the
   * 90s hard cap; only then is a genuinely stalled boot reported. */
  function tick() {
    bootTimer = null;
    if (W.__DP_BOOTED__) return;
    var elapsed = Date.now() - startAt;
    var stillLoading = false;
    try {
      stillLoading = !!(W.document && W.document.readyState !== "complete");
    } catch (e) {}
    if (elapsed < limitMs() || (stillLoading && elapsed < HARD_CAP)) {
      bootTimer = setTimeout(tick, 2500);
      return;
    }
    currentReason = "The app did not finish starting within " + Math.round(elapsed / 1000) + " seconds \u2014 the connection may be slow or blocked.";
    showFallback(currentReason, true);
  }
  bootTimer = setTimeout(tick, limitMs());
})();
`;
