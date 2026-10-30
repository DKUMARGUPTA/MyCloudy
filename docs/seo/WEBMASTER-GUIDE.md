# DocoPDF — Webmaster & Analytics Setup Guide (OWNER ACTIONS)

_Last updated: 2025-10-31 · Site: https://www.docopdf.com (canonical www host)_
_Status: SEO layer LIVE (116-URL sitemap, per-tool metadata, JSON-LD, hreflang). GA4 + verification infrastructure SHIPPED and waiting for your IDs._

This guide lists every OWNER ACTION in priority order. Each one gives you a
code/value that I wire into the site via Vercel environment variables — you
never edit code for any of this. Send me the values one by one (chat mein
paste kar do) and I'll finish the wiring + verification.

---

## 1. Google Search Console (sabse pehle — 10 min)

**Why:** Google ko batata hai ki site exist karti hai; indexing sirf iske
baad track hoti hai. Free + fastest impact.

**Steps:**
1. https://search.google.com/search-console kholein (Google account se login).
2. **Add property** (top-left dropdown ya search bar) → choose **URL prefix**.
3. Enter exactly: `https://www.docopdf.com` → Continue.
4. Verification methods mein **HTML tag** choose karein.
5. Google dikhega: `<meta name="google-site-verification" content="ABC123xyz..." />`
6. **Mujhe sirf `content="..."` ke andar ka value bhejein** (e.g. `ABC123xyz...`).
   - Main use `NEXT_PUBLIC_GSC_VERIFICATION` env var mein daal dunga → deploy
     → Verify button dabayen → green tick.
7. **Sitemap submit:** left menu → **Sitemaps** → enter `sitemap.xml` → Submit.
   (116 URLs submit hongi: 100 tools EN+HI, 10 category hubs, trust pages.)
8. **Request indexing (top 20 URLs):** URL Inspection (top search bar) mein
   ye ek-ek karke paste karein → **Request Indexing**:
   - `/` (home), `/tools`, `/about`, `/privacy`
   - T1 tools: `/tool/merge-pdf`, `/tool/split-pdf`, `/tool/compress-pdf`,
     `/tool/edit-pdf`, `/tool/sign-pdf`, `/tool/word-to-pdf`,
     `/tool/pdf-to-jpg`, `/tool/pdf-to-word`, `/tool/images-to-pdf`,
     `/tool/lock-pdf`, `/tool/unlock-pdf`, `/tool/summarize-pdf`
   - Hindi mirror: `/hi`, `/hi/tool/merge-pdf`, `/hi/tool/compress-pdf`

**Optional (stronger):** Domain property `docopdf.com` via DNS TXT record at
your registrar (GoDaddy/Namecheap jahan domain kharida tha). Ye subdomains
bhi cover karti hai. Dono rakh sakte hain — conflict nahi hota.

---

## 2. Google Analytics 4 (15 min)

**Why:** Real users, sessions, tool usage — consent-gated, no PII. Site par
GA4 infrastructure already LIVE hai (Consent Mode v2, default denied, cookie
banner se opt-in). Sirf ID chahiye.

**Steps:**
1. https://analytics.google.com → **Admin** (gear icon, bottom-left).
2. **Create → Property** → name: `DocoPDF` → timezone/currency chunein → Next.
3. Business details kuch bhi → Create.
4. **Data stream** → **Web** → URL: `https://www.docopdf.com` → name
   `docopdf.com` → Create stream.
5. **Measurement ID** dikhega: `G-XXXXXXXXXX` — **yehi mujhe bhejein.**
   - Main `NEXT_PUBLIC_GA_ID` env var mein daal dunga → analytics live.
6. **GA4 Admin (main kar dunga jab ID mile, ya aap khud):**
   - Admin → **Data settings → Data retention** → 14 months.
   - Admin → **Product links → Search Console links** → link (GSC property
     select karke).
   - Events (jab fire hona shuru karein): `process_success` + `download_click`
     ko **Mark as key event** (Admin → Events → toggle).
   - Custom dimensions (Admin → Custom definitions → Create custom
     dimensions): `tool_slug`, `category`, `locale`, `mode` — Event parameter
     scope, inhi naamon se (humari events already ye parameters bhejti hain).

**Privacy promise (already implemented):** gtag.js sirf tab load hoti hai
jab user cookie banner mein analytics accept kare. Default = denied (EEA/UK/
CH compliant). Events mein kabhi file name, content ya typed text nahi jata.

---

## 3. Bing Webmaster Tools + IndexNow (10 min)

**Why:** Bing/ChatGPT/Copilot search mein indexing (ChatGPT search Bing data
use karta hai — free traffic source).

**Steps:**
1. https://www.bing.com/webmasters → login (Google/Microsoft account).
2. **Import from Google Search Console** (fastest — 2 clicks) YA manual add
   `https://www.docopdf.com` with meta tag.
3. Agar meta-tag route: **Bing dikhega** `<meta name="msvalidate.01"
   content="CODE..." />` → **content value mujhe bhejein** → main
   `NEXT_PUBLIC_BING_VERIFICATION` mein daal dunga.
4. **Sitemaps** → `https://www.docopdf.com/sitemap.xml` → Submit.
5. (Optional, baad mein) **IndexNow**: Settings → IndexNow → key generate —
   key file + ping hook main add kar dunga jab aap key dein.

---

## 4. Vercel Environment Variables (main kar dunga / ya aap)

Jab aap mujhe upar ke values bhejte hain, main ye set karta hoon:
- **Vercel** → Project `mycloudy` → **Settings → Environment Variables** →
  Add (Production + Preview dono):
  - `NEXT_PUBLIC_GSC_VERIFICATION` = Google content value
  - `NEXT_PUBLIC_BING_VERIFICATION` = Bing content value
  - `NEXT_PUBLIC_YANDEX_VERIFICATION` = (optional) Yandex value
  - `NEXT_PUBLIC_GA_ID` = `G-XXXXXXXXXX`
- Redeploy → verify meta tags live.

**Note:** ye values public web page par dikhti hain (wo unka design hai —
verification tokens secret nahi hote), lekin git mein kabhi commit nahi
honge — sirf Vercel env mein rahenge.

---

## 5. Kya already DONE hai (aapko kuch nahi karna)

- ✅ Real crawlable URLs: `/tool/merge-pdf` style (hash routing se migrate)
- ✅ 116-URL dynamic sitemap + robots.txt (www host)
- ✅ Per-tool unique title/description/canonical/hreflang (EN + HI)
- ✅ JSON-LD: WebApplication, FAQPage, BreadcrumbList, Organization, WebSite
- ✅ OG/Twitter cards + 1200×630 social image (WhatsApp/X/LinkedIn ready)
- ✅ Trust pages: /about /contact /privacy /terms (AdSense-grade)
- ✅ GA4 consent-gated loader + tool_view/language_switch events (ID ka wait)
- ✅ Verification meta env support (GSC/Bing/Yandex values ka wait)
- ✅ Keyword research: `seo/keyword-map.csv` (110 rows) +
  `seo/keyword-planner-seed.csv` (756 keywords)

## 6. Aap mujhe bhejne wali cheezein (priority order)

| # | Kya bhejna hai | Kahan se | Main kya karunga |
|---|----------------|----------|------------------|
| 1 | GSC `content=` value | Search Console → HTML tag | Env set + verify + sitemap guide |
| 2 | GA4 `G-XXXX` Measurement ID | Analytics → Data stream | Env set + events live |
| 3 | Bing `msvalidate.01` value | Bing Webmaster | Env set + verify |
| 4 | (Optional) IndexNow key | Bing → Settings | Key file + ping hook |
| 5 | (Optional) Yandex verification | yandex.com/webmaster | Env set |

Ek-ek karke bhejein, main turant wire + verify karke report dunga.
