# DocoPDF — Webmaster & Analytics Setup Guide (OWNER ACTIONS)

_Last updated: 2025-11-01 · Site: https://www.docopdf.com (canonical www host)_
_Status: SEO layer LIVE · **GA4 G-ZP89M3KQDB WIRED & VERIFIED (consent-gated)** · GSC verified (GoDaddy DNS) · Bing verified (GSC import). Ab sirf dashboard-side actions bache hain (§1, §2, §3 ke “Ab aapke bache hue kaam”)._

This guide lists every OWNER ACTION in priority order. GA4 ID ab code mein
wired hai (`src/lib/analytics/ga4.ts` — `NEXT_PUBLIC_GA_ID` env se override
ya `0` se disable ho sakta hai; Vercel dashboard mein kuch set karne ki
zaroorat NahI hai). GSC/Bing DNS/import se verified hain — meta-tag env vars
ki zaroorat nahi padi.

---

## 1. Google Search Console (sabse pehle — 10 min)

> **✅ VERIFIED — aapne GoDaddy DNS se kar diya (2025-11-01).** Property ab
> live track kar rahi hai. Neeche ke do steps ab bhi bachey hain (2 min).

**Ab aapke bache hue kaam (GSC dashboard mein):**
1. **Sitemap submit:** left menu → **Sitemaps** → enter `sitemap.xml` → Submit.
   (116 URLs submit hongi: 100 tools EN+HI, 10 category hubs, trust pages.)
2. **Request indexing (top 20 URLs):** URL Inspection (top search bar) mein
   ye ek-ek karke paste karein → **Request Indexing**:
   - `/` (home), `/tools`, `/about`, `/privacy`
   - T1 tools: `/tool/merge-pdf`, `/tool/split-pdf`, `/tool/compress-pdf`,
     `/tool/edit-pdf`, `/tool/sign-pdf`, `/tool/word-to-pdf`,
     `/tool/pdf-to-jpg`, `/tool/pdf-to-word`, `/tool/images-to-pdf`,
     `/tool/lock-pdf`, `/tool/unlock-pdf`, `/tool/summarize-pdf`
   - Hindi mirror: `/hi`, `/hi/tool/merge-pdf`, `/hi/tool/compress-pdf`

_(Reference — original HTML-tag method, ab zaroorat nahi padi: URL-prefix
property → HTML tag → `content=` value mujhe bhejna hota tha. DNS verification
permanent hai — domain renewal tak valid.)_

---

## 2. Google Analytics 4 (15 min)

> **✅ DONE — property ban gayi, Measurement ID `G-ZP89M3KQDB` site mein
> wired + live-verified (2025-11-01).** Vercel env ki zaroorat NahI — ID
> code mein default hai (`src/lib/analytics/ga4.ts`); env se sirf override
> hota hai. Data ab collect ho raha hai (jab visitor analytics accept karta
> hai — privacy-first, Consent Mode v2).

**Ab aapke bache hue kaam (GA4 dashboard mein — Reports tab mein data dikhne
lagega, pehle din se hi):**
1. **Data retention:** Admin → **Data settings → Data retention** → 14 months.
2. **Search Console link:** Admin → **Product links → Search Console links** →
   apni verified `https://www.docopdf.com` property select karke link karein
   (isse GA4 mein organic queries/search terms milenge — SEO ke liye gold).
3. **Key events (jab events fire hona shuru karein):** Admin → **Events** →
   `tool_view`, `language_switch` dikhenge; aage `process_success` +
   `download_click` bhi aayenge — in sab ko **Mark as key event** toggle karein.
4. **Custom dimensions:** Admin → **Custom definitions → Create custom
   dimensions** (Event scope, exact naam): `tool_slug`, `category`, `locale`,
   `mode` — Reports mein “kaunsa tool kitna popular” isse pata chalega.

**Wired & verified (2025-11-01, live test):** gtag.js sirf analytics-accept
karne wale visitors ke liye load hoti hai (zero network before consent),
`anonymize_ip: true`, aur direct tool-page landings pe `tool_view` ab
guaranteed fire hota hai (consent-race + duplicate-count dono fix ho gaye).
Events mein kabhi file name, content ya typed text nahi jata.

---

## 3. Bing Webmaster Tools + IndexNow (10 min)

> **✅ VERIFIED — aapne “Sign in with Google” (GSC import) se kar diya
> (2025-11-01).** Bing/ChatGPT/Copilot ke liye site ab track ho rahi hai.

**Ab aapke bache hue kaam (Bing dashboard mein):**
1. **Sitemap submit:** https://www.bing.com/webmasters → apni site →
   **Sitemaps** → `https://www.docopdf.com/sitemap.xml` → Submit.
2. (Optional, baad mein) **IndexNow:** Settings → IndexNow → key generate —
   key file + ping hook main add kar dunga jab aap key dein.

_(Reference — meta-tag method (`msvalidate.01`) ab zaroorat nahi padi.)_

---

## 4. Vercel Environment Variables (ab zaroorat NahI hai)

GA4 ID code mein wired hai (default `G-ZP89M3KQDB`); GSC/Bing DNS-import se
verified hain. Env vars ab sirf **future override** ke liye hain — agar kabhi
property badalni ho ya analytics band karni ho:
- **Vercel** → Project `mycloudy` → **Settings → Environment Variables** →
  Add (Production + Preview dono):
  - `NEXT_PUBLIC_GA_ID` = naya `G-XXXX...` (property swap) ya `0` (analytics off)
  - `NEXT_PUBLIC_GSC_VERIFICATION` / `NEXT_PUBLIC_BING_VERIFICATION` /
    `NEXT_PUBLIC_YANDEX_VERIFICATION` = tabhi, agar meta-tag method use karna pade
- Redeploy → live verify.

**Note:** GA measurement ID public hota hai (har GA site ke page source mein
dikhta hai) — isliye code mein hona safe hai. Verification tokens bhi public
hote hain, lekin wo ab set hi nahi karne padenge.

---

## 5. Kya already DONE hai (aapko kuch nahi karna)

- ✅ Real crawlable URLs: `/tool/merge-pdf` style (hash routing se migrate)
- ✅ 116-URL dynamic sitemap + robots.txt (www host)
- ✅ Per-tool unique title/description/canonical/hreflang (EN + HI)
- ✅ JSON-LD: WebApplication, FAQPage, BreadcrumbList, Organization, WebSite
- ✅ OG/Twitter cards + 1200×630 social image (WhatsApp/X/LinkedIn ready)
- ✅ Trust pages: /about /contact /privacy /terms (AdSense-grade)
- ✅ GA4 **LIVE**: `G-ZP89M3KQDB` wired, consent-gated, live-verified
  (tool_view dedupe + consent-race fix included)
- ✅ GSC verified (GoDaddy DNS) · Bing verified (GSC import)
- ✅ Keyword research: `seo/keyword-map.csv` (110 rows) +
  `seo/keyword-planner-seed.csv` (756 keywords)

## 6. Ab bachi hui cheezein (priority order)

| # | Kya | Kahan | Kaun karega |
|---|-----|-------|-------------|
| 1 | **Sitemap submit** | GSC → Sitemaps → `sitemap.xml` | Aap (2 min) |
| 2 | **Request indexing** (20 URLs) | GSC → URL Inspection | Aap (10 min) |
| 3 | **Sitemap submit** | Bing → Sitemaps | Aap (2 min) |
| 4 | GA4 data retention + GSC link + key events + custom dimensions | GA4 Admin | Aap (10 min) |
| 5 | (Optional) IndexNow key | Bing → Settings | Aap → main wire karunga |

GA data stream ab live hai — site khud kholke “Accept all” karke GA4 →
Reports → Realtime mein khud ka visit dekh sakte hain!
