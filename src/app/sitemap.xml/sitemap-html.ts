import { absoluteUrl } from "@/lib/seo/site";

/**
 * Human-friendly HTML rendering of the DocoPDF sitemap (R18-SITEMAP-UX).
 *
 * WHY THIS EXISTS: Chrome 156 removed XSLTProcessor and even the classic
 * XML tree view, so opening a raw sitemap.xml in Chrome shows an
 * unstyled wall of text. /sitemap.xml therefore content-negotiates:
 * crawlers/CLI tools get the sitemaps.org XML, browsers that prefer
 * text/html get this branded, searchable page instead. `?raw=1` forces
 * the XML for humans who want it.
 *
 * Design matches the site: DocoPDF LogoMark (teal gradient), slate
 * neutrals, #0b1220 dark mode, all CSS/JS/SVG inline (CSP-safe).
 */

export interface HtmlSitemapEntry {
  path: string;
  priority: number;
  freq: "weekly" | "monthly" | "yearly";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type EntryType = "home" | "index" | "category" | "tool" | "page";

function entryType(path: string): EntryType {
  if (path === "/") return "home";
  if (path === "/tools") return "index";
  if (path.startsWith("/tools/")) return "category";
  if (path.startsWith("/tool/")) return "tool";
  return "page";
}

function priorityClass(priority: number): string {
  if (priority >= 0.95) return "p-max";
  if (priority >= 0.85) return "p-high";
  if (priority >= 0.75) return "p-mid";
  if (priority >= 0.65) return "p-low";
  return "p-min";
}

const CSS = `:root{
  --bg:#f6f7f9;--card:#ffffff;--text:#0f172a;--muted:#64748b;--faint:#94a3b8;
  --border:#e6e9ee;--border-strong:#d8dde4;
  --teal:#0f766e;--teal-hov:#115e59;--teal-soft:#f0fdfa;--teal-line:#b8ece2;
  --btn-pt:#ffffff;
  --shadow:0 1px 2px rgba(15,23,42,.05),0 8px 24px -14px rgba(15,23,42,.14);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0b1220;--card:#101a2c;--text:#e2e8f0;--muted:#94a3b8;--faint:#64748b;
    --border:rgba(148,163,184,.14);--border-strong:rgba(148,163,184,.26);
    --teal:#2dd4bf;--teal-hov:#5eead4;--teal-soft:rgba(45,212,191,.07);--teal-line:rgba(45,212,191,.3);
    --btn-pt:#04211d;
    --shadow:0 1px 2px rgba(0,0,0,.45),0 10px 28px -14px rgba(0,0,0,.55);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:radial-gradient(1100px 380px at 50% -120px,rgba(20,184,166,.08),transparent 70%),var(--bg);
  color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
a{color:var(--teal);text-decoration:none}
a:hover{color:var(--teal-hov)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.top{max-width:1080px;margin:0 auto;padding:40px 24px 6px}
.brandrow{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--text)}
.brand:hover{color:var(--text)}
.mark{width:32px;height:32px;display:block}
.word{font-size:19px;font-weight:700;letter-spacing:-.02em}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:10px;border:1px solid var(--border-strong);color:var(--text);font-size:13px;font-weight:600;background:var(--card)}
.btn:hover{border-color:var(--teal);color:var(--teal)}
.btn.primary{background:var(--teal);border-color:var(--teal);color:var(--btn-pt)}
.btn.primary:hover{background:var(--teal-hov);border-color:var(--teal-hov);color:var(--btn-pt)}
.hero{margin-top:26px}
h1{margin:0;font-size:29px;font-weight:800;letter-spacing:-.03em}
.sub{margin:8px 0 14px;color:var(--muted);font-size:14.5px;max-width:64ch}
.meta{display:flex;gap:8px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;font-size:11.5px;font-weight:700;letter-spacing:.02em;background:var(--teal);color:var(--btn-pt)}
.pill.ghost{background:var(--card);color:var(--muted);border:1px solid var(--border-strong);font-weight:600}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px 56px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0 14px}
.stat{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow)}
.ic{flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;background:var(--teal-soft);border:1px solid var(--teal-line);color:var(--teal)}
.ic svg{width:17px;height:17px;display:block}
.tx{display:flex;flex-direction:column;min-width:0}
.n{font-size:22px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.l{font-size:11.5px;color:var(--muted);font-weight:600;letter-spacing:.03em;text-transform:uppercase;margin-top:2px}
.notice{display:flex;gap:11px;align-items:flex-start;margin:6px 0 18px;padding:13px 16px;border-radius:12px;background:var(--teal-soft);border:1px solid var(--teal-line);color:var(--text);font-size:13.5px}
.notice svg{flex:none;width:17px;height:17px;margin-top:1px;color:var(--teal)}
.notice strong{font-weight:700}
.searchbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;padding:12px 0;margin-bottom:12px;background:transparent}
.field{position:relative;flex:1 1 auto;min-width:0}
.sicon{position:absolute;left:13px;top:50%;transform:translateY(-50%);width:16px;height:16px;color:var(--faint);pointer-events:none}
#q{width:100%;height:44px;padding:0 44px 0 40px;border-radius:11px;border:1px solid var(--border-strong);background:var(--card);color:var(--text);font-size:14px;font-family:inherit;outline:none;box-shadow:var(--shadow)}
#q::placeholder{color:var(--faint)}
#q:focus{border-color:var(--teal);box-shadow:0 0 0 3px rgba(20,184,166,.18)}
.kbd{position:absolute;right:12px;top:50%;transform:translateY(-50%);padding:2px 7px;border-radius:6px;border:1px solid var(--border-strong);border-bottom-width:2px;background:var(--card);color:var(--faint);font:600 11px var(--mono);pointer-events:none}
.count{flex:none;font-size:12.5px;font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;padding-right:2px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse}
thead th{position:sticky;top:67px;z-index:10;background:var(--card);text-align:left;padding:12px 14px;font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border-strong);white-space:nowrap}
tbody td{padding:10px 14px;border-bottom:1px solid var(--border);font-size:13.5px;vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr[data-path]{transition:background .1s ease}
tbody tr[data-path]:hover{background:var(--teal-soft)}
.c-num{width:42px;color:var(--faint);font:600 11.5px var(--mono);font-variant-numeric:tabular-nums}
.c-url{max-width:430px}
.c-url a{font:500 13px var(--mono);color:var(--text);word-break:break-all}
.c-url a:hover{color:var(--teal);text-decoration:underline;text-underline-offset:3px}
.c-date,.c-freq{white-space:nowrap;color:var(--muted);font-size:12.5px}
.c-date{font-variant-numeric:tabular-nums}
.c-prio{width:70px}
.chip{display:inline-block;padding:3px 9px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.lang{display:inline-block;padding:2px 7px;margin-right:4px;border-radius:6px;font:700 10.5px var(--mono);letter-spacing:.05em;background:rgba(148,163,184,.14);color:var(--muted)}
@media (prefers-color-scheme: dark){.lang{background:rgba(148,163,184,.16);color:#cbd5e1}}
.prio{display:inline-block;min-width:40px;text-align:center;padding:3px 9px;border-radius:999px;font-weight:700;font-size:12px;font-variant-numeric:tabular-nums}
.t-home{background:#ecfdf5;color:#047857;border:1px solid #bbf7d0}
.t-index{background:#fff1f2;color:#be123c;border:1px solid #fecdd3}
.t-category{background:#fffbeb;color:#b45309;border:1px solid #fde68a}
.t-tool{background:#f0fdfa;color:#0f766e;border:1px solid #b8ece2}
.t-page{background:#f1f5f9;color:#475569;border:1px solid #e2e8f0}
.p-max{background:#ecfdf5;color:#047857}
.p-high{background:#f0fdfa;color:#0f766e}
.p-mid{background:#fffbeb;color:#b45309}
.p-low{background:#fff7ed;color:#c2410c}
.p-min{background:#f1f5f9;color:#64748b}
@media (prefers-color-scheme: dark){
  .t-home{background:rgba(16,185,129,.1);color:#6ee7b7;border-color:rgba(16,185,129,.28)}
  .t-index{background:rgba(244,63,94,.1);color:#fda4af;border-color:rgba(244,63,94,.28)}
  .t-category{background:rgba(245,158,11,.1);color:#fcd34d;border-color:rgba(245,158,11,.28)}
  .t-tool{background:rgba(45,212,191,.1);color:#5eead4;border-color:rgba(45,212,191,.28)}
  .t-page{background:rgba(148,163,184,.12);color:#cbd5e1;border-color:rgba(148,163,184,.28)}
  .p-max{background:rgba(16,185,129,.12);color:#6ee7b7}
  .p-high{background:rgba(45,212,191,.12);color:#5eead4}
  .p-mid{background:rgba(245,158,11,.12);color:#fcd34d}
  .p-low{background:rgba(249,115,22,.12);color:#fdba74}
  .p-min{background:rgba(148,163,184,.14);color:#94a3b8}
}
.empty{padding:34px 14px;text-align:center;color:var(--muted);font-size:13.5px}
.empty strong{display:block;font-size:15px;color:var(--text);margin-bottom:4px}
.foot{margin-top:26px;text-align:center}
.foot p{margin:0 0 8px;font-size:13px}
.foot a{margin:0 7px;font-weight:600}
.fine{font-size:12px;color:var(--faint)}
@media (max-width:860px){
  .stats{grid-template-columns:repeat(2,1fr)}
  h1{font-size:25px}
}
@media (max-width:720px){
  .top{padding-top:28px;padding-left:16px;padding-right:16px}
  .wrap{padding-left:16px;padding-right:16px;padding-bottom:44px}
  h1{font-size:22px}
  .sub{font-size:13.5px}
  .kbd{display:none}
  #q{padding-right:14px}
  .count{display:none}
  /* table → stacked list rows (type chip / path / meta chips) */
  table,tbody,tr,td{display:block}
  thead{display:none}
  .c-num,.c-date,.c-freq{display:none}
  .c-lang,.c-prio{display:inline-block;vertical-align:middle}
  .c-prio{width:auto;margin-top:2px}
  .c-type{margin-bottom:6px}
  .c-url{margin:0 0 10px}
  .c-url a{font-size:13.5px}
  .c-lang .lang{margin-right:4px}
  tbody tr[data-path]{padding:14px 16px;border-bottom:1px solid var(--border)}
  tbody tr:last-child{border-bottom:none}
  tbody td{padding:0;border-bottom:none}
  .card{border-radius:12px;overflow:hidden}
  .empty{padding:26px 14px}
}
@media (max-width:480px){
  .actions .btn:not(.primary){display:none}
}`;

const JS = `(function () {
  var input = document.getElementById('q');
  var countEl = document.getElementById('count');
  var emptyEl = document.getElementById('empty');
  if (!input) return;
  var rows = [];
  var nodeList = document.querySelectorAll('tbody tr[data-path]');
  for (var i = 0; i < nodeList.length; i++) rows.push(nodeList[i]);
  var total = rows.length;
  function apply() {
    var v = input.value.trim().toLowerCase();
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var hay = (r.getAttribute('data-path') + ' ' + r.getAttribute('data-type')).toLowerCase();
      if (!v || hay.indexOf(v) !== -1) { r.style.display = ''; shown++; }
      else { r.style.display = 'none'; }
    }
    if (countEl) countEl.textContent = (shown === total) ? (total + ' URLs') : (shown + ' of ' + total + ' URLs');
    if (emptyEl) emptyEl.style.display = (shown === 0) ? '' : 'none';
  }
  input.addEventListener('input', apply);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.value = ''; apply(); input.blur(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== input && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
  apply();
})();`;

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='2' y='2' width='28' height='28' rx='8' fill='%230F766E'/%3E%3Cpath d='M11.5 7.5h6.3l4.7 4.7V23a1.8 1.8 0 0 1-1.8 1.8H11.5A1.8 1.8 0 0 1 9.7 23V9.3a1.8 1.8 0 0 1 1.8-1.8Z' fill='%23fff'/%3E%3C/svg%3E";

const ICON = {
  globe:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14.5 14.5 0 0 1 0 18"/><path d="M12 3a14.5 14.5 0 0 0 0 18"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v4h4"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M12 11v5"/></svg>',
  search:
    '<svg class="sicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
};

const LOGO_SVG = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="lg" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0F766E"/>
      <stop offset="1" stop-color="#14B8A6"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#lg)"/>
  <path d="M11.5 7.5h6.3l4.7 4.7V23a1.8 1.8 0 0 1-1.8 1.8H11.5A1.8 1.8 0 0 1 9.7 23V9.3a1.8 1.8 0 0 1 1.8-1.8Z" fill="#FFFFFF"/>
  <path d="M17.8 7.5l4.7 4.7h-4.7Z" fill="#99F6E4"/>
  <text x="16.1" y="20.6" text-anchor="middle" font-size="6.6" font-weight="700" fill="#0F766E" font-family="Inter, system-ui, sans-serif">PDF</text>
</svg>`;

export function buildSitemapHtml(
  entries: HtmlSitemapEntry[],
  generated: Date,
): string {
  const lastmod = generated.toISOString().slice(0, 10);
  const total = entries.length;
  const types = entries.map((e) => entryType(e.path));
  const tools = types.filter((t) => t === "tool").length;
  const cats = types.filter((t) => t === "category").length;
  const pages = types.filter((t) => t === "page" || t === "home" || t === "index").length;

  const rows = entries
    .map((e, i) => {
      const type = types[i];
      const pclass = priorityClass(e.priority);
      const freqLabel = e.freq.charAt(0).toUpperCase() + e.freq.slice(1);
      const loc = absoluteUrl(e.path);
      return `        <tr data-path="${escapeHtml(e.path)}" data-type="${type}">
          <td class="c-num">${i + 1}</td>
          <td class="c-type"><span class="chip t-${type}">${type}</span></td>
          <td class="c-url"><a href="${escapeHtml(loc)}">${escapeHtml(e.path)}</a></td>
          <td class="c-lang"><span class="lang">EN</span><span class="lang">HI</span></td>
          <td class="c-date">${lastmod}</td>
          <td class="c-freq">${freqLabel}</td>
          <td class="c-prio"><span class="prio ${pclass}">${e.priority.toFixed(1)}</span></td>
        </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/>
<meta name="color-scheme" content="light dark"/>
<meta name="description" content="XML sitemap for DocoPDF — every public page, generated from the live tool registry."/>
<title>Sitemap · DocoPDF</title>
<link rel="icon" href="${FAVICON}"/>
<style>
${CSS}
</style>
</head>
<body>
<header class="top">
  <div class="brandrow">
    <a class="brand" href="https://www.docopdf.com/">
      ${LOGO_SVG}
      <span class="word">DocoPDF</span>
    </a>
    <nav class="actions">
      <a class="btn" href="/sitemap.xml?raw=1" target="_blank" rel="noopener">Raw XML</a>
      <a class="btn" href="https://www.docopdf.com/tools">Browse tools</a>
      <a class="btn primary" href="https://www.docopdf.com/">docopdf.com</a>
    </nav>
  </div>
  <div class="hero">
    <h1>XML Sitemap</h1>
    <p class="sub">Every public DocoPDF page — generated from the live tool registry, so new tools appear here automatically with each deploy. Search engines receive the same data as <a href="/sitemap.xml?raw=1" target="_blank" rel="noopener">machine-readable XML</a>; English and Hindi mirrors are paired through hreflang.</p>
    <div class="meta">
      <span class="pill">${total} URLs</span>
      <span class="pill ghost">sitemaps.org 0.9</span>
      <span class="pill ghost">hreflang en · hi</span>
    </div>
  </div>
</header>
<main class="wrap">
  <section class="stats">
    <div class="stat">
      <span class="ic">${ICON.globe}</span>
      <span class="tx"><span class="n">${total}</span><span class="l">Total URLs</span></span>
    </div>
    <div class="stat">
      <span class="ic">${ICON.grid}</span>
      <span class="tx"><span class="n">${tools}</span><span class="l">Tool pages</span></span>
    </div>
    <div class="stat">
      <span class="ic">${ICON.folder}</span>
      <span class="tx"><span class="n">${cats}</span><span class="l">Categories</span></span>
    </div>
    <div class="stat">
      <span class="ic">${ICON.doc}</span>
      <span class="tx"><span class="n">${pages}</span><span class="l">Core pages</span></span>
    </div>
  </section>

  <p class="notice">
    ${ICON.info}
    <span><strong>What is this file?</strong> An XML sitemap is a machine-readable roadmap that helps search engines discover every DocoPDF page. Humans do not need it — <a href="https://www.docopdf.com/tools">browse the full tool directory instead</a>.</span>
  </p>

  <div class="searchbar">
    <div class="field">
      ${ICON.search}
      <input id="q" type="search" placeholder="Search URLs — try ocr, invoice, /tools/ …" aria-label="Search sitemap URLs" autocomplete="off" spellcheck="false"/>
      <span class="kbd" aria-hidden="true">/</span>
    </div>
    <span id="count" class="count" aria-live="polite">${total} URLs</span>
  </div>

  <div class="card">
    <table>
      <caption class="sr-only">All URLs in the DocoPDF XML sitemap</caption>
      <thead>
        <tr>
          <th class="c-num" scope="col">#</th>
          <th class="c-type" scope="col">Type</th>
          <th class="c-url" scope="col">Path</th>
          <th class="c-lang" scope="col">Locales</th>
          <th class="c-date" scope="col">Updated</th>
          <th class="c-freq" scope="col">Frequency</th>
          <th class="c-prio" scope="col">Priority</th>
        </tr>
      </thead>
      <tbody>
${rows}
        <tr id="empty" style="display:none">
          <td colspan="7">
            <div class="empty">
              <strong>No URLs match.</strong>
              <span>Try a shorter query — e.g. pdf, ocr, invoice.</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <footer class="foot">
    <p>
      <a href="https://www.docopdf.com/">Home</a>·
      <a href="https://www.docopdf.com/tools">All tools</a>·
      <a href="https://www.docopdf.com/about">About</a>·
      <a href="https://www.docopdf.com/contact">Contact</a>·
      <a href="/sitemap.xml?raw=1" target="_blank" rel="noopener">Raw XML</a>
    </p>
    <p class="fine">Styled HTML for browsers · raw XML for crawlers · generated ${lastmod} from the live tool registry</p>
  </footer>
</main>
<noscript><style>.searchbar{display:none}</style></noscript>
<script>
${JS}
</script>
</body>
</html>
`;
}
