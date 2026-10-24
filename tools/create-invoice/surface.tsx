"use client";

/**
 * Create invoice surface (P3-INVOICE — the 64th tool). The user's
 * standalone invoice-generator rebuilt as a DocoPDF workspace: type
 * catalog dropdown (39 templates), business profile, bill-to, items,
 * GST/tax controls, and the A4 sheet previewed LIVE at 1:1 mm geometry
 * — then exported by the worker as a true vector PDF.
 *
 * Ported behaviours (from the standalone app.js, kept byte-exact):
 *  - paise-integer math via the shared model (preview = PDF, always);
 *  - GSTIN auto-uppercase + state auto-pick from the GSTIN prefix;
 *  - place of supply follows the client state; the CGST+SGST / IGST
 *    hint under it;
 *  - type switch regenerates number/terms/stamp only while untouched;
 *  - "New invoice" bumps the trailing digits of the current number;
 *  - per-type last-number memory (updated on export/print), the ₹50,000
 *    e-way warning, HSN/rate checks;
 *  - logo + signature uploads shrunk to 300 px PNG data-URLs (with the
 *    app's HEIC fallback so iPhone photos work too);
 *  - business profile + up to 50 saved invoices in localStorage (the
 *    standalone keys dp_inv / dp_inv_saved carry over);
 *  - drag-to-reorder sheet sections, now with ▲/▼ buttons too (the
 *    original was mouse-only), accent colour, PAID stamp.
 *
 * DocoPDF integration: language = the app locale (the standalone app's
 * own EN/हिंदी toggle is gone); state survives ToolShell phase remounts
 * through the serialized "inv" option (create-card pattern); the export
 * button spawns the worker with labels PRE-RESOLVED via t() so the PDF
 * text always matches the UI language.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import QRCode from "qrcode";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  FileDown,
  Loader2,
  MoveVertical,
  Plus,
  Printer,
  RotateCcw,
  Save,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { resolveHeicPreview } from "@/lib/heic/heic-preview";
import { downloadBlob } from "@/lib/files/output";
import type { WorkerResponse } from "@/lib/workers/protocol";
import {
  BLOCK_KEYS,
  calc,
  duplicateItems,
  fd,
  formatMoney,
  gstOK,
  nextNo,
  parseInvoiceRun,
  plus,
  Q,
  today,
  typeDef,
  upiPayload,
  warnings,
  words,
  applyOcrDraft,
  type BlockKey,
  type InvoiceState,
} from "./model";
import {
  OCR_PREFILL_KEY,
  parseOcrPrefill,
} from "../ocr-pdf/invoice-extract";
import {
  CURRENCY_SYMBOLS,
  GST_STATES,
  INVOICE_CURRENCIES,
  INVOICE_GROUPS,
  INVOICE_TYPES,
  type InvoiceCurrency,
  type InvoiceTypeId,
  currencyLocale,
  gstStateName,
} from "./types";

/* ------------------------------------------------------------------ */
/* Sheet CSS — the standalone app's print-exact A4 sheet, scoped        */
/* ------------------------------------------------------------------ */

const SHEET_CSS = `
#inv-wrap{overflow:hidden}
#inv-sheet{position:relative;width:210mm;min-height:297mm;padding:14mm;background:#fff;color:#111;
  box-shadow:0 2px 14px #0003;transform-origin:0 0;font:12px/1.4 "Noto Sans Devanagari","Nirmala UI",system-ui,"Segoe UI",sans-serif}
#inv-sheet h3{font:600 24px/1.2 "Noto Sans Devanagari","Nirmala UI",system-ui,sans-serif;margin:0 0 6px;color:var(--ac,#111)}
#inv-sheet table{width:100%;border-collapse:collapse}
#inv-sheet th{background:#eef2ec;text-align:left;padding:6px;border-bottom:1.5px solid var(--ac,#111)}
#inv-sheet td{padding:6px;border-bottom:1px solid #e3e6e0;vertical-align:top}
#inv-sheet tr{break-inside:avoid}
#inv-sheet .r{text-align:right}
#inv-sheet .tt td{border:0;padding:3px 6px}
#inv-sheet .tt .gt td{font-weight:700;font-size:15px;border-top:1.5px solid var(--ac,#111);padding-top:6px}
#inv-sheet .mu{color:#555}
#inv-sheet .hd{display:flex;justify-content:space-between;gap:16px;margin-bottom:16px}
#inv-sheet .lg{max-height:56px;max-width:180px;display:block;margin-bottom:6px}
#inv-sheet .stp{position:absolute;right:14mm;top:34mm;transform:rotate(-12deg);border:3px solid var(--ac,#0b6b4d);color:var(--ac,#0b6b4d);
  font:700 22px "Noto Sans Devanagari","Nirmala UI",system-ui,sans-serif;padding:2px 12px;border-radius:6px;opacity:.55;z-index:1}
#inv-sheet [data-b]{position:relative}
#inv-sheet.dz [data-b]{outline:1px dashed var(--ac,#0b6b4d);outline-offset:2px;cursor:move}
#inv-sheet.dz [data-b] .dz-ui{display:flex}
#inv-sheet .dz-ui{display:none;position:absolute;top:2px;right:2px;gap:4px;z-index:3}
@media print{
  body *{visibility:hidden!important}
  #inv-sheet,#inv-sheet *{visibility:visible!important}
  #inv-wrap{height:auto!important;overflow:visible!important}
  #inv-sheet{position:absolute!important;left:0!important;top:0!important;transform:none!important;
    width:auto!important;min-height:0!important;padding:0!important;margin:0!important;box-shadow:none!important}
  #inv-sheet .dz-ui{display:none!important}
  @page{size:A4;margin:12mm}
}`;

/* ------------------------------------------------------------------ */
/* localStorage (the standalone app's keys carry over)                  */
/* ------------------------------------------------------------------ */

interface InvProfile {
  biz?: Partial<InvoiceState["biz"]>;
  cur?: InvoiceCurrency;
  terms?: string;
  tu?: number;
  ty?: InvoiceTypeId;
  l?: Record<string, string>;
  ord?: BlockKey[];
  ac?: string;
}

function readProfile(): InvProfile {
  try {
    return JSON.parse(localStorage.getItem("dp_inv") || "{}");
  } catch {
    return {};
  }
}

type SavedInvoice = Omit<InvoiceState, "biz">;

function readSaved(): SavedInvoice[] {
  try {
    const list = JSON.parse(localStorage.getItem("dp_inv_saved") || "[]");
    return Array.isArray(list) ? list.slice(0, 50) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Image upload → ≤300 px PNG data-URL (HEIC fallback included)         */
/* ------------------------------------------------------------------ */

function fileToPngDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, 300 / im.width);
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(im.width * k));
        cv.height = Math.max(1, Math.round(im.height * k));
        cv.getContext("2d")?.drawImage(im, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL("image/png"));
      };
      im.onerror = () => {
        // Safari photos arrive as HEIC — decode with the app's self-hosted
        // libheif WASM instead of giving up (create-card recipe).
        resolveHeicPreview(file, 300)
          .then((prev) => resolve(prev?.url ?? null))
          .catch(() => resolve(null));
      };
      im.src = String(reader.result);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ */
/* Default state (the standalone app's fresh `S`)                       */
/* ------------------------------------------------------------------ */

function defaultState(profile: InvProfile): InvoiceState {
  return {
    ty:
      profile.ty && profile.ty in INVOICE_TYPES ? profile.ty : "gst-invoice",
    cur: profile.cur ?? "INR",
    biz: {
      name: "",
      addr: "",
      gstin: "",
      state: "",
      phone: "",
      email: "",
      bank: "",
      upi: "",
      logo: "",
      sig: "",
      ...profile.biz,
    },
    cli: { name: "", addr: "", gstin: "", state: "" },
    pos: "",
    no: "",
    date: today(),
    due: plus(15),
    valid: plus(15),
    dMode: "%",
    d: "",
    tr: "",
    ro: true,
    adv: "",
    st: "",
    notes: "",
    terms: profile.tu ? profile.terms ?? "" : "",
    xv: ["", "", ""],
    items: [{ d: "", h: "", q: "1", r: "", g: "18", dp: "" }],
  };
}

interface MetaFlags {
  tno: boolean;
  tterms: boolean;
  tst: boolean;
}

const inputCls =
  "h-11 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const selCls =
  "h-11 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/* ------------------------------------------------------------------ */
/* Surface                                                             */
/* ------------------------------------------------------------------ */

export function InvoiceSurface(props: ToolSurfaceProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const { values, onChange } = props;

  /* ---------- one-time boot: serialized option + profile ---------- */
  const [boot] = useState(() => {
    const profile = readProfile();
    const raw = typeof values.inv === "string" ? values.inv : "";
    let state: InvoiceState | null = null;
    let ord = profile.ord ?? BLOCK_KEYS.slice();
    let ac = profile.ac ?? "#0b6b4d";
    let meta: MetaFlags = { tno: false, tterms: false, tst: false };
    if (raw) {
      // parseInvoiceRun is the worker-boundary parser — it validates and
      // coerces everything, so a stale/corrupt option can never crash us.
      const run = parseRun(raw);
      state = run.state;
      ord = run.ord;
      ac = run.ac;
      meta = run.meta;
    }
    return {
      state,
      ord,
      ac,
      meta,
      lastNos: profile.l ?? {},
      profile,
      saved: readSaved(),
    };
  });

  const [state, setState] = useState<InvoiceState>(
    () => boot.state ?? defaultState(boot.profile)
  );
  const [ord, setOrd] = useState<BlockKey[]>(() => boot.ord);
  const [ac, setAc] = useState<string>(() => boot.ac);
  const [dz, setDz] = useState(false);
  const [savedList, setSavedList] = useState<SavedInvoice[]>(boot.saved);
  const [savedIdx, setSavedIdx] = useState("");
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [qr, setQr] = useState<{ payload: string; svg: string } | null>(null);

  const metaRef = useRef<MetaFlags>(boot.meta);
  const lastNosRef = useRef<Record<string, string>>(boot.lastNos);
  const workerRef = useRef<Worker | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const dragKeyRef = useRef<BlockKey | null>(null);

  /* ---------- derived ---------- */
  const def = typeDef(state.ty);
  const c = useMemo(() => calc(state), [state]);
  const warnList = useMemo(() => warnings(state, c), [state, c]);
  const sym = CURRENCY_SYMBOLS[state.cur];
  const loc = currencyLocale(state.cur);
  const fmt = useCallback(
    (p: number) => formatMoney(p, state.cur, loc),
    [state.cur, loc]
  );
  const money = useCallback(
    (p: number) => sym + "\u00a0" + formatMoney(p, state.cur, loc),
    [sym, state.cur, loc]
  );

  /** Labels for the PDF run — resolved NOW, in the current locale. */
  const buildLabels = useCallback((): Record<string, string> => {
    const defNow = typeDef(state.ty);
    const x = defNow.x ?? ["", "", ""];
    const labels: Record<string, string> = {
      no: t("invoice.no"),
      date: t("invoice.date"),
      due: t("invoice.due"),
      valid: t("invoice.valid"),
      pos: t("invoice.pos"),
      bt: t(defNow.bl ? `invoice.${defNow.bl}` : "invoice.bt"),
      ttl: t(`invoice.${defNow.ttl}`),
      desc: t(defNow.dl ? `invoice.${defNow.dl}` : "invoice.desc"),
      hsn: t("invoice.hsn"),
      qty: t(defNow.ql ? `invoice.${defNow.ql}` : "invoice.qty"),
      rate: t(defNow.rl ? `invoice.${defNow.rl}` : "invoice.rate"),
      dp: t("invoice.dp"),
      tb: t("invoice.tb"),
      gp: t("invoice.gp"),
      amt: t("invoice.amt"),
      sub: t("invoice.sub"),
      idisc: t("invoice.idisc"),
      disc2: t("invoice.disc2"),
      cg: t("invoice.cg"),
      sg: t("invoice.sg"),
      ig: t("invoice.ig"),
      tx: t("invoice.tx"),
      rof: t("invoice.rof"),
      tot: t("invoice.tot"),
      wd: t("invoice.wd"),
      for: t("invoice.for"),
      sig: t("invoice.sig"),
      bank: t("invoice.bank"),
      notes: t("invoice.notes"),
      terms: t("invoice.terms"),
      adv: t("invoice.adv"),
      bal: t("invoice.bal"),
    };
    for (let i = 0; i < 3; i++) {
      if (x[i]) labels["x" + i] = t(`invoice.${x[i]}`);
    }
    return labels;
  }, [state.ty, t]);

  /* ---------- persistence: profile + serialized option ---------- */
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(
          "dp_inv",
          JSON.stringify({
            biz: state.biz,
            cur: state.cur,
            terms: state.terms,
            tu: metaRef.current.tterms ? 1 : 0,
            ty: state.ty,
            l: lastNosRef.current,
            ord,
            ac,
          })
        );
      } catch {
        /* storage full — profile is best-effort */
      }
    }, 400);
    return () => window.clearTimeout(id);
  }, [state.biz, state.cur, state.terms, state.ty, ord, ac]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      onChange(
        "inv",
        JSON.stringify({
          s: state,
          ord,
          ac,
          meta: {
            tno: metaRef.current.tno,
            tterms: metaRef.current.tterms,
            tst: metaRef.current.tst,
          },
        })
      );
    }, 250);
    return () => window.clearTimeout(id);
  }, [state, ord, ac, onChange]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /* ---------- one-shot OCR prefill (R5-c) ----------
   * The ocr tool's "Send to invoice" button stashes the fields it
   * actually found under "dp_inv_ocr" and navigates here. On mount we
   * hydrate the editor with exactly those fields (nothing more — the
   * mapping in model.ts never fabricates), tell the user to review
   * everything, and REMOVE the key so the hand-off is strictly one-shot
   * (a later visit or refresh starts from the profile as always). */
  const ocrPrefillDoneRef = useRef(false);
  useEffect(() => {
    if (ocrPrefillDoneRef.current) return;
    ocrPrefillDoneRef.current = true;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(OCR_PREFILL_KEY);
    } catch {
      raw = null;
    }
    if (!raw) return;
    try {
      localStorage.removeItem(OCR_PREFILL_KEY);
    } catch {
      /* remove is best-effort; the key is ignored when absent */
    }
    const draft = parseOcrPrefill(raw);
    if (!draft) return;
    // setState-in-effect rides a microtask (house pattern — the effect
    // body stays render-safe for the React compiler).
    queueMicrotask(() => {
      setState((prev) => applyOcrDraft(prev, draft));
      if (draft.invoiceNumber !== undefined) metaRef.current.tno = true;
      toast({
        title: t("invoice.ocrPrefillToastTitle"),
        description: t("invoice.ocrPrefillToastDesc"),
      });
    });
    // t/toast are stable for a mounted surface; the ref guard makes this
    // run exactly once per mount even if they ever change identity.
  }, [t, toast]);

  /* ---------- field helpers ---------- */
  const setField = useCallback(
    (path: string, value: string | boolean) => {
      setState((prev) => {
        const next = { ...prev };
        const parts = path.split(".");
        let o = next as unknown as Record<string, unknown>;
        while (parts.length > 1) {
          const k = parts.shift() as string;
          o[k] = { ...(o[k] as object) };
          o = o[k] as Record<string, unknown>;
        }
        o[parts[0]] = value;
        return next;
      });
    },
    []
  );

  const onInput = useCallback(
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const el = e.target;
      const key = el.dataset.k;
      if (!key) return;
      let v: string | boolean = el.value;
      if (/gstin$/.test(key)) {
        const gv = String(v).toUpperCase().replace(/\s/g, "");
        v = gv;
        el.value = gv;
        // auto-pick the state from the GSTIN prefix (standalone behaviour)
        if (GST_STATES.some((st) => st.slice(0, 2) === gv.slice(0, 2))) {
          const sk = key.replace("gstin", "state");
          setField(sk, gv.slice(0, 2));
          if (sk === "cli.state") setField("pos", gv.slice(0, 2));
        }
      }
      if (key === "cli.state") setField("pos", v);
      if (key === "no") metaRef.current.tno = true;
      if (key === "terms") metaRef.current.tterms = true;
      if (key === "st") metaRef.current.tst = true;
      setField(key, v);
    },
    [setField]
  );

  /* ---------- type switch (tpl() port) ---------- */
  const onTypeChange = useCallback(
    (ty: InvoiceTypeId) => {
      const newDef = INVOICE_TYPES[ty];
      setState((prev) => {
        const next: InvoiceState = { ...prev, ty };
        if (!metaRef.current.tno)
          next.no = nextNo(ty, prev.date, lastNosRef.current);
        if (!metaRef.current.tterms)
          next.terms = "tm" in newDef && newDef.tm ? t(`invoice.${newDef.tm}`) : "";
        if (!metaRef.current.tst)
          next.st = ("st" in newDef ? newDef.st : undefined) || "";
        return next;
      });
    },
    [t]
  );

  /* ---------- items ---------- */
  const setItem = useCallback((idx: number, field: string, value: string) => {
    setState((prev) => ({
      ...prev,
      items: prev.items.map((it, i) =>
        i === idx ? { ...it, [field]: value } : it
      ),
    }));
  }, []);

  const addItem = useCallback(() => {
    setState((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        {
          d: "",
          h: "",
          q: "1",
          r: "",
          g: prev.items.length ? prev.items[prev.items.length - 1].g : "18",
          dp: "",
        },
      ],
    }));
  }, []);

  const removeItem = useCallback((idx: number) => {
    setState((prev) => {
      if (prev.items.length <= 1) return prev;
      return { ...prev, items: prev.items.filter((_, i) => i !== idx) };
    });
  }, []);

  /** Duplicate: a full copy of the row inserted right after it (capped). */
  const duplicateItem = useCallback((idx: number) => {
    setState((prev) => ({ ...prev, items: duplicateItems(prev.items, idx) }));
  }, []);

  /* ---------- new invoice ($('#new') port) ---------- */
  const onNew = useCallback(() => {
    metaRef.current.tno = true;
    metaRef.current.tst = true;
    setState((prev) => {
      const s = prev.no;
      const bumped =
        s && /\d/.test(s)
          ? s.replace(/(\d+)(?!.*\d)/, (m) =>
              String(Number(m) + 1).padStart(m.length, "0")
            )
          : "INV-001";
      return {
        ...prev,
        cli: { name: "", addr: "", gstin: "", state: "" },
        pos: "",
        no: bumped,
        xv: ["", "", ""],
        adv: "",
        st: typeDef(prev.ty).st || "",
        date: today(),
        due: plus(15),
        valid: plus(15),
        d: "",
        tr: "",
        notes: "",
        items: [
          {
            d: "",
            h: "",
            q: "1",
            r: "",
            g: prev.items.length ? prev.items[prev.items.length - 1].g : "18",
            dp: "",
          },
        ],
      };
    });
  }, []);

  /* ---------- image uploads ---------- */
  const onLogo = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const url = await fileToPngDataUrl(f);
      if (url) setField("biz.logo", url);
      e.target.value = "";
    },
    [setField]
  );

  const onSig = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const url = await fileToPngDataUrl(f);
      if (url) setField("biz.sig", url);
      e.target.value = "";
    },
    [setField]
  );

  const removeAssets = useCallback(() => {
    setState((prev) => ({
      ...prev,
      biz: { ...prev.biz, logo: "", sig: "" },
    }));
  }, []);

  /* ---------- saved invoices ---------- */
  const saveCurrent = useCallback(() => {
    const { biz: _biz, ...rest } = state;
    const list = savedList.filter(
      (x) => !(x.no === state.no && x.ty === state.ty)
    );
    const next = [rest, ...list].slice(0, 50);
    setSavedList(next);
    setSavedIdx("");
    try {
      localStorage.setItem("dp_inv_saved", JSON.stringify(next));
    } catch {
      /* full storage — the in-memory list still works this session */
    }
  }, [state, savedList]);

  const loadSaved = useCallback(
    (idx: string) => {
      setSavedIdx(idx);
      const x = savedList[Number(idx)];
      if (!x) return;
      metaRef.current.tno = true;
      metaRef.current.tterms = true;
      metaRef.current.tst = true;
      setState((prev) => ({
        ...x,
        biz: prev.biz,
        items: x.items?.length
          ? x.items
          : [{ d: "", h: "", q: "1", r: "", g: "18", dp: "" }],
      }));
    },
    [savedList]
  );

  const deleteSaved = useCallback(() => {
    if (savedIdx === "") return;
    const next = savedList.filter((_, i) => String(i) !== savedIdx);
    setSavedList(next);
    setSavedIdx("");
    try {
      localStorage.setItem("dp_inv_saved", JSON.stringify(next));
    } catch {
      /* best-effort */
    }
  }, [savedIdx, savedList]);

  /* ---------- UPI QR (preview) — payload-keyed, no sync setState ---------- */
  const showQr = !!state.biz.upi && state.cur === "INR" && !c.np;
  const qrPayload = showQr
    ? upiPayload(state.biz.upi, state.biz.name, c.bal, state.no)
    : "";
  const qrHtml = qr && qr.payload === qrPayload ? qr.svg : "";
  useEffect(() => {
    if (!qrPayload) return;
    let cancelled = false;
    QRCode.toString(qrPayload, {
      type: "svg",
      margin: 2,
      errorCorrectionLevel: "M",
    })
      .then((svg) => {
        if (!cancelled) setQr({ payload: qrPayload, svg });
      })
      .catch(() => {
        /* a broken payload just renders no QR */
      });
    return () => {
      cancelled = true;
    };
  }, [qrPayload]);

  /* ---------- fit-to-width (exact port of fit()) ---------- */
  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    const sheet = sheetRef.current;
    if (!wrap || !sheet) return;
    sheet.style.transform = "none";
    const k = Math.min(1, wrap.clientWidth / sheet.offsetWidth);
    sheet.style.transform = `scale(${k})`;
    wrap.style.height = sheet.offsetHeight * k + "px";
  }, []);

  useEffect(() => {
    fit();
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => fit())
        : null;
    if (ro && wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [fit]);

  useEffect(() => {
    fit();
  }, [state, ord, ac, locale, qrHtml, dz, fit]);

  /* ---------- block reorder (drag + ▲▼) ---------- */
  const moveBlock = useCallback((key: BlockKey, dir: -1 | 1) => {
    setOrd((prev) => {
      const i = prev.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const onSheetDragStart = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (!dz) return;
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-b]");
      if (b) {
        dragKeyRef.current = b.dataset.b as BlockKey;
        e.dataTransfer.setData("text/plain", b.dataset.b ?? "");
      }
    },
    [dz]
  );

  const onSheetDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (!dz) return;
      e.preventDefault();
      const dk = dragKeyRef.current;
      dragKeyRef.current = null;
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-b]");
      if (!dk || !b || b.dataset.b === dk) return;
      const r = b.getBoundingClientRect();
      setOrd((prev) => {
        const o = prev.filter((k) => k !== dk);
        o.splice(
          o.indexOf(b.dataset.b as BlockKey) +
            (e.clientY > r.top + r.height / 2 ? 1 : 0),
          0,
          dk
        );
        return o;
      });
    },
    [dz]
  );

  /* ---------- export / print ---------- */
  const recordLastNo = useCallback(() => {
    lastNosRef.current = { ...lastNosRef.current, [state.ty]: state.no };
    try {
      localStorage.setItem(
        "dp_inv",
        JSON.stringify({
          biz: state.biz,
          cur: state.cur,
          terms: state.terms,
          tu: metaRef.current.tterms ? 1 : 0,
          ty: state.ty,
          l: lastNosRef.current,
          ord,
          ac,
        })
      );
    } catch {
      /* best-effort */
    }
  }, [state, ord, ac]);

  const exportPdf = useCallback((): void => {
    if (workerRef.current) return;
    setExportPct(0);
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const runId = Date.now();
    const cleanup = (): void => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.addEventListener(
      "message",
      (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        if (!data || data.runId !== runId) return;
        if (data.type === "progress") {
          setExportPct(data.pct);
          return;
        }
        if (data.type === "result") {
          setExportPct(null);
          const output = data.outputs[0];
          if (output) {
            downloadBlob(output.blob, output.name);
            toast({
              title: t("invoice.doneTitle"),
              description: t("invoice.doneDesc", { name: output.name }),
            });
          }
          cleanup();
          return;
        }
        if (data.type === "error") {
          setExportPct(null);
          toast({
            title: t("tool.errorTitle"),
            description: t("tool.errorGeneric"),
            variant: "destructive",
          });
          cleanup();
        }
      }
    );
    worker.addEventListener("error", () => {
      setExportPct(null);
      toast({
        title: t("tool.errorTitle"),
        description: t("tool.errorGeneric"),
        variant: "destructive",
      });
      cleanup();
    });
    recordLastNo();
    worker.postMessage({
      type: "run",
      runId,
      toolId: "create-invoice",
      options: {
        inv: JSON.stringify({
          s: state,
          ord,
          ac,
          labels: buildLabels(),
        }),
      },
      files: [],
    });
  }, [state, ord, ac, buildLabels, recordLastNo, t, toast]);

  const printSheet = useCallback(() => {
    setDz(false);
    recordLastNo();
    const prevTitle = document.title;
    document.title = state.no || "invoice";
    const restore = () => {
      document.title = prevTitle;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }, [state.no, recordLastNo]);

  /* ---------- preview builders ---------- */
  const billToLabel = t(def.bl ? `invoice.${def.bl}` : "invoice.bt");
  const descLabel = t(def.dl ? `invoice.${def.dl}` : "invoice.desc");
  const qtyLabel = t(def.ql ? `invoice.${def.ql}` : "invoice.qty");
  const rateLabel = t(def.rl ? `invoice.${def.rl}` : "invoice.rate");

  const totalsRows: { label: string; value: string; gt?: boolean }[] = [];
  if (!c.np) {
    totalsRows.push({ label: t("invoice.sub"), value: money(c.sub) });
    if (c.idisc)
      totalsRows.push({ label: t("invoice.idisc"), value: "− " + money(c.idisc) });
    if (c.disc)
      totalsRows.push({ label: t("invoice.disc2"), value: "− " + money(c.disc) });
    if (!c.nt) {
      if (c.g) {
        totalsRows.push({ label: t("invoice.tb"), value: money(c.tb) });
        if (c.intra) {
          totalsRows.push({ label: t("invoice.cg"), value: money(c.cg) });
          totalsRows.push({ label: t("invoice.sg"), value: money(c.sg) });
        } else {
          totalsRows.push({ label: t("invoice.ig"), value: money(c.ig) });
        }
      } else if (c.tx) {
        totalsRows.push({
          label: `${t("invoice.tx")} (${parseFloat(state.tr) || 0}%)`,
          value: money(c.tx),
        });
      }
      if (c.ro) {
        totalsRows.push({
          label: t("invoice.rof"),
          value: (c.ro < 0 ? "− " : "") + money(Math.abs(c.ro)),
        });
      }
    }
    totalsRows.push({ label: t("invoice.tot"), value: money(c.tot), gt: true });
    if (c.adv) {
      totalsRows.push({ label: t("invoice.adv"), value: "− " + money(c.adv) });
      totalsRows.push({ label: t("invoice.bal"), value: money(c.bal), gt: true });
    }
  }

  const bizMuted = [
    state.biz.addr,
    state.biz.phone,
    state.biz.email,
    c.g && state.biz.gstin ? "GSTIN: " + state.biz.gstin : "",
    c.g && state.biz.state
      ? `${gstStateName(state.biz.state)} (${state.biz.state})`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const dzUiFor = (key: BlockKey): ReactNode =>
    dz ? (
      <span className="dz-ui" key={`${key}-ui`}>
        <button
          type="button"
          aria-label={t("invoice.moveUp")}
          onClick={() => moveBlock(key, -1)}
          className="flex size-8 items-center justify-center rounded-md border border-border bg-background/95 text-foreground hover:bg-muted"
        >
          <ArrowUp className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("invoice.moveDown")}
          onClick={() => moveBlock(key, 1)}
          className="flex size-8 items-center justify-center rounded-md border border-border bg-background/95 text-foreground hover:bg-muted"
        >
          <ArrowDown className="size-4" aria-hidden="true" />
        </button>
      </span>
    ) : null;

  const renderBlock = (key: BlockKey): ReactNode => {
    switch (key) {
      case "hd":
        return (
          <div className="hd" data-b="hd" key="hd">
            {dzUiFor("hd")}
            <div>
              {/^data:image\//.test(state.biz.logo) ? (
                <img className="lg" src={state.biz.logo} alt="" />
              ) : null}
              {state.biz.name ? (
                <b style={{ fontSize: "15px" }}>{state.biz.name}</b>
              ) : null}
              <div className="mu" style={{ whiteSpace: "pre-line" }}>
                {bizMuted}
              </div>
            </div>
            <div className="r">
              <h3>{t(`invoice.${def.ttl}`)}</h3>
              <div>
                {t("invoice.no")}: <b>{state.no}</b>
              </div>
              <div>
                {t("invoice.date")}: {fd(state.date)}
              </div>
              {def.dt === "due" ? (
                <div>
                  {t("invoice.due")}: {fd(state.due)}
                </div>
              ) : def.dt === "valid" ? (
                <div>
                  {t("invoice.valid")}: {fd(state.valid)}
                </div>
              ) : null}
              {(def.x ?? []).map((xl, i) =>
                xl && state.xv[i] ? (
                  <div key={i}>
                    {t(`invoice.${xl}`)}: {state.xv[i]}
                  </div>
                ) : null
              )}
            </div>
          </div>
        );
      case "bt":
        return (
          <div data-b="bt" key="bt" style={{ marginBottom: "14px" }}>
            {dzUiFor("bt")}
            <div className="mu">{billToLabel}</div>
            <b>{state.cli.name}</b>
            <div style={{ whiteSpace: "pre-line" }}>
              {[
                state.cli.addr,
                c.g && state.cli.gstin ? "GSTIN: " + state.cli.gstin : "",
                c.g && state.pos
                  ? `${t("invoice.pos")}: ${gstStateName(state.pos)} (${state.pos})`
                  : "",
              ]
                .filter(Boolean)
                .join("\n")}
            </div>
          </div>
        );
      case "it": {
        // The per-item discount % column appears only when some line has
        // one (classic invoices keep their exact old shape).
        const showDp = c.L.some((l) => Q(l.dp) > 0);
        return (
          <div data-b="it" key="it">
            {dzUiFor("it")}
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>{descLabel}</th>
                  {c.g ? <th>{t("invoice.hsn")}</th> : null}
                  <th className="r">{qtyLabel}</th>
                  {!c.np ? (
                    <>
                      <th className="r">{rateLabel}</th>
                      {showDp ? <th className="r">{t("invoice.dp")}</th> : null}
                      {c.g && !c.nt ? (
                        <>
                          <th className="r">{t("invoice.tb")}</th>
                          <th className="r">{t("invoice.gp")}</th>
                        </>
                      ) : (
                        <th className="r">{t("invoice.amt")}</th>
                      )}
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {c.L.map((l, n) => (
                  <tr key={n}>
                    <td>{n + 1}</td>
                    <td style={{ whiteSpace: "pre-line" }}>{l.d || "\u00a0"}</td>
                    {c.g ? <td>{l.h}</td> : null}
                    <td className="r">{l.q}</td>
                    {!c.np ? (
                      <>
                        <td className="r">{fmt(Math.round(Q(l.r) * 100))}</td>
                        {showDp ? (
                          <td className="r">{Q(l.dp) > 0 ? `${String(l.dp).trim()}%` : ""}</td>
                        ) : null}
                        {c.g && !c.nt ? (
                          <>
                            <td className="r">{fmt(l.tb)}</td>
                            <td className="r">{l.rt}%</td>
                          </>
                        ) : (
                          <td className="r">{fmt(l.net)}</td>
                        )}
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case "tt":
        return c.np ? null : (
          <div
            data-b="tt"
            key="tt"
            style={{ width: "270px", margin: "12px 0 0 auto" }}
          >
            {dzUiFor("tt")}
            <table className="tt">
              <tbody>
                {totalsRows.map((r, i) => (
                  <tr className={r.gt ? "gt" : undefined} key={i}>
                    <td className="r">{r.label}</td>
                    <td className="r">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "wd":
        return c.np ? null : (
          <p data-b="wd" key="wd" style={{ margin: "12px 0" }}>
            {dzUiFor("wd")}
            <span className="mu">{t("invoice.wd")}:</span>{" "}
            <b>{words(c.tot, state.cur)}</b>
          </p>
        );
      case "bank":
        return state.biz.bank || (state.biz.upi && qrHtml) ? (
          <div
            data-b="bank"
            key="bank"
            style={{
              marginTop: "10px",
              display: "flex",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            {dzUiFor("bank")}
            <div>
              {state.biz.bank ? (
                <>
                  <div className="mu">{t("invoice.bank")}</div>
                  <div style={{ whiteSpace: "pre-line" }}>{state.biz.bank}</div>
                </>
              ) : null}
              {state.biz.upi && !qrHtml ? (
                <div>UPI: {state.biz.upi}</div>
              ) : null}
            </div>
            {qrHtml ? (
              <div
                aria-label="UPI QR"
                style={{ width: "96px", flex: "0 0 auto" }}
                dangerouslySetInnerHTML={{ __html: qrHtml }}
              />
            ) : null}
          </div>
        ) : null;
      case "notes":
        return state.notes ? (
          <div data-b="notes" key="notes" style={{ marginTop: "10px" }}>
            {dzUiFor("notes")}
            <div className="mu">{t("invoice.notes")}</div>
            <div style={{ whiteSpace: "pre-line" }}>{state.notes}</div>
          </div>
        ) : null;
      case "terms":
        return state.terms ? (
          <div data-b="terms" key="terms" style={{ marginTop: "10px" }}>
            {dzUiFor("terms")}
            <div className="mu">{t("invoice.terms")}</div>
            <div style={{ whiteSpace: "pre-line" }}>{state.terms}</div>
          </div>
        ) : null;
      case "sig":
        return (
          <div
            data-b="sig"
            key="sig"
            className="r"
            style={{ marginTop: "36px" }}
          >
            {dzUiFor("sig")}
            <div>
              {t("invoice.for")} <b>{state.biz.name}</b>
            </div>
            {/^data:image\//.test(state.biz.sig) ? (
              <img
                src={state.biz.sig}
                alt=""
                style={{
                  maxHeight: "48px",
                  maxWidth: "180px",
                  display: "block",
                  margin: "4px 0 4px auto",
                }}
              />
            ) : (
              <div style={{ height: "44px" }} />
            )}
            <span
              style={{
                borderTop: "1px solid #111",
                paddingTop: "4px",
                display: "inline-block",
                minWidth: "170px",
              }}
            >
              {t("invoice.sig")}
            </span>
          </div>
        );
    }
  };

  /* ---------- render ---------- */
  return (
    <div className="flex flex-col gap-4">
      <style dangerouslySetInnerHTML={{ __html: SHEET_CSS }} />
      <div className="grid gap-6 lg:grid-cols-[minmax(320px,430px)_1fr]">
        {/* ---------------- FORM ---------------- */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="rounded-lg border bg-card p-4">
            <Label htmlFor="inv-ty" className="text-xs text-muted-foreground">
              {t("invoice.ty")}
            </Label>
            <select
              id="inv-ty"
              className={`mt-1.5 ${selCls}`}
              value={state.ty}
              onChange={(e) => onTypeChange(e.target.value as InvoiceTypeId)}
            >
              {INVOICE_GROUPS.map((g) => (
                <optgroup key={g.key} label={t(`invoice.${g.key}`)}>
                  {g.ids.map((id) => (
                    <option key={id} value={id}>
                      {t(`invoice.${INVOICE_TYPES[id].n}`)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("invoice.priv")}
            </p>
          </div>

          {/* Your business */}
          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">{t("invoice.yb")}</h2>
            <div className="flex flex-col gap-3">
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="biz-name">
                  {t("invoice.bn")}
                </Label>
                <Input
                  id="biz-name"
                  data-k="biz.name"
                  value={state.biz.name}
                  onChange={onInput}
                  className="mt-1.5 h-11 min-h-11"
                  autoComplete="organization"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="biz-addr">
                  {t("invoice.addr")}
                </Label>
                <Textarea
                  id="biz-addr"
                  data-k="biz.addr"
                  rows={2}
                  value={state.biz.addr}
                  onChange={onInput}
                  className="mt-1.5"
                />
              </div>
              {c.g ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground" htmlFor="biz-gstin">
                      GSTIN
                    </Label>
                    <Input
                      id="biz-gstin"
                      data-k="biz.gstin"
                      value={state.biz.gstin}
                      onChange={onInput}
                      maxLength={15}
                      autoCapitalize="characters"
                      className="mt-1.5 h-11 min-h-11 font-mono text-xs uppercase"
                    />
                    {state.biz.gstin && !gstOK(state.biz.gstin) ? (
                      <p className="mt-1 text-xs text-destructive">
                        {t("invoice.gerr")}
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground" htmlFor="biz-state">
                      {t("invoice.state")}
                    </Label>
                    <select
                      id="biz-state"
                      data-k="biz.state"
                      className={`mt-1.5 ${selCls}`}
                      value={state.biz.state}
                      onChange={onInput}
                    >
                      <option value=""></option>
                      {GST_STATES.map((s) => (
                        <option key={s.slice(0, 2)} value={s.slice(0, 2)}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground" htmlFor="biz-phone">
                    {t("invoice.ph")}
                  </Label>
                  <Input
                    id="biz-phone"
                    data-k="biz.phone"
                    type="tel"
                    value={state.biz.phone}
                    onChange={onInput}
                    className="mt-1.5 h-11 min-h-11"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground" htmlFor="biz-email">
                    {t("invoice.em")}
                  </Label>
                  <Input
                    id="biz-email"
                    data-k="biz.email"
                    type="email"
                    value={state.biz.email}
                    onChange={onInput}
                    className="mt-1.5 h-11 min-h-11"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="biz-bank">
                  {t("invoice.bank")}
                </Label>
                <Textarea
                  id="biz-bank"
                  data-k="biz.bank"
                  rows={2}
                  value={state.biz.bank}
                  onChange={onInput}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="biz-upi">
                  {t("invoice.upi")}
                </Label>
                <Input
                  id="biz-upi"
                  data-k="biz.upi"
                  value={state.biz.upi}
                  onChange={onInput}
                  placeholder="name@bank"
                  className="mt-1.5 h-11 min-h-11"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground" htmlFor="inv-logo">
                    {t("invoice.logo")}
                  </Label>
                  <input
                    id="inv-logo"
                    type="file"
                    accept="image/*"
                    onChange={onLogo}
                    className="mt-1.5 w-full text-xs file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-2.5 file:text-xs hover:file:bg-muted/80"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground" htmlFor="inv-sig">
                    {t("invoice.sgi")}
                  </Label>
                  <input
                    id="inv-sig"
                    type="file"
                    accept="image/*"
                    onChange={onSig}
                    className="mt-1.5 w-full text-xs file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-2.5 file:text-xs hover:file:bg-muted/80"
                  />
                </div>
              </div>
              {state.biz.logo || state.biz.sig ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={removeAssets}
                  className="h-11 min-h-11 w-full text-xs"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  {t("invoice.rm")}
                </Button>
              ) : null}
            </div>
          </div>

          {/* Bill to */}
          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">{billToLabel}</h2>
            <div className="flex flex-col gap-3">
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="cli-name">
                  {t("invoice.cn")}
                </Label>
                <Input
                  id="cli-name"
                  data-k="cli.name"
                  value={state.cli.name}
                  onChange={onInput}
                  className="mt-1.5 h-11 min-h-11"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="cli-addr">
                  {t("invoice.addr")}
                </Label>
                <Textarea
                  id="cli-addr"
                  data-k="cli.addr"
                  rows={2}
                  value={state.cli.addr}
                  onChange={onInput}
                  className="mt-1.5"
                />
              </div>
              {c.g ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs text-muted-foreground" htmlFor="cli-gstin">
                        GSTIN
                      </Label>
                      <Input
                        id="cli-gstin"
                        data-k="cli.gstin"
                        value={state.cli.gstin}
                        onChange={onInput}
                        maxLength={15}
                        autoCapitalize="characters"
                        className="mt-1.5 h-11 min-h-11 font-mono text-xs uppercase"
                      />
                      {state.cli.gstin && !gstOK(state.cli.gstin) ? (
                        <p className="mt-1 text-xs text-destructive">
                          {t("invoice.gerr")}
                        </p>
                      ) : null}
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground" htmlFor="cli-state">
                        {t("invoice.state")}
                      </Label>
                      <select
                        id="cli-state"
                        data-k="cli.state"
                        className={`mt-1.5 ${selCls}`}
                        value={state.cli.state}
                        onChange={onInput}
                      >
                        <option value=""></option>
                        {GST_STATES.map((s) => (
                          <option key={s.slice(0, 2)} value={s.slice(0, 2)}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground" htmlFor="inv-pos">
                      {t("invoice.pos")}
                    </Label>
                    <select
                      id="inv-pos"
                      data-k="pos"
                      className={`mt-1.5 ${selCls}`}
                      value={state.pos}
                      onChange={onInput}
                    >
                      <option value=""></option>
                      {GST_STATES.map((s) => (
                        <option key={s.slice(0, 2)} value={s.slice(0, 2)}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1.5 text-xs text-primary">
                      {state.biz.state && state.pos
                        ? c.intra
                          ? t("invoice.intra")
                          : t("invoice.inter")
                        : t("invoice.pick")}
                    </p>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {/* Invoice details */}
          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">{t("invoice.det")}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="inv-no">
                  {t("invoice.no")}
                </Label>
                <Input
                  id="inv-no"
                  data-k="no"
                  value={state.no}
                  onChange={onInput}
                  className="mt-1.5 h-11 min-h-11"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="inv-cur">
                  {t("invoice.cur")}
                </Label>
                <select
                  id="inv-cur"
                  data-k="cur"
                  className={`mt-1.5 ${selCls}`}
                  value={state.cur}
                  onChange={onInput}
                >
                  {INVOICE_CURRENCIES.map((cu) => (
                    <option key={cu} value={cu}>
                      {cu}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="inv-date">
                  {t("invoice.date")}
                </Label>
                <Input
                  id="inv-date"
                  data-k="date"
                  type="date"
                  value={state.date}
                  onChange={onInput}
                  className="mt-1.5 h-11 min-h-11"
                />
              </div>
              {def.dt === "due" ? (
                <div>
                  <Label className="text-xs text-muted-foreground" htmlFor="inv-due">
                    {t("invoice.due")}
                  </Label>
                  <Input
                    id="inv-due"
                    data-k="due"
                    type="date"
                    value={state.due}
                    onChange={onInput}
                    className="mt-1.5 h-11 min-h-11"
                  />
                </div>
              ) : def.dt === "valid" ? (
                <div>
                  <Label className="text-xs text-muted-foreground" htmlFor="inv-valid">
                    {t("invoice.valid")}
                  </Label>
                  <Input
                    id="inv-valid"
                    data-k="valid"
                    type="date"
                    value={state.valid}
                    onChange={onInput}
                    className="mt-1.5 h-11 min-h-11"
                  />
                </div>
              ) : null}
              {(def.x ?? []).map((xl, i) =>
                xl ? (
                  <div key={i}>
                    <Label className="text-xs text-muted-foreground" htmlFor={`inv-x${i}`}>
                      {t(`invoice.${xl}`)}
                    </Label>
                    <Input
                      id={`inv-x${i}`}
                      value={state.xv[i]}
                      onChange={(e) => {
                        setState((prev) => {
                          const xv = prev.xv.slice() as [string, string, string];
                          xv[i] = e.target.value;
                          return { ...prev, xv };
                        });
                      }}
                      className="mt-1.5 h-11 min-h-11"
                    />
                  </div>
                ) : null
              )}
            </div>
          </div>

          {/* Items */}
          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">{t("invoice.itm")}</h2>
            <datalist id="inv-gr">
              {["0", "0.25", "3", "5", "12", "18", "28", "40"].map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <div className="flex flex-col gap-2">
              {state.items.map((it, i) => (
                <div
                  key={i}
                  className="grid gap-1.5 border-t border-dashed pt-2 first:border-t-0 first:pt-0"
                  style={{
                    gridTemplateColumns: "repeat(auto-fit,minmax(70px,1fr))",
                  }}
                >
                  <input
                    className={`col-span-full ${inputCls}`}
                    value={it.d}
                    onChange={(e) => setItem(i, "d", e.target.value)}
                    placeholder={descLabel}
                    aria-label={descLabel}
                  />
                  {c.g ? (
                    <input
                      className={inputCls}
                      value={it.h}
                      onChange={(e) => setItem(i, "h", e.target.value)}
                      placeholder={t("invoice.hsn")}
                      aria-label={t("invoice.hsn")}
                    />
                  ) : null}
                  <input
                    className={inputCls}
                    type="number"
                    min="0"
                    step="any"
                    value={it.q}
                    onChange={(e) => setItem(i, "q", e.target.value)}
                    placeholder={qtyLabel}
                    aria-label={qtyLabel}
                  />
                  {!c.np ? (
                    <input
                      className={inputCls}
                      type="number"
                      min="0"
                      step="any"
                      value={it.r}
                      onChange={(e) => setItem(i, "r", e.target.value)}
                      placeholder={rateLabel}
                      aria-label={rateLabel}
                    />
                  ) : null}
                  {!c.np ? (
                    <input
                      className={inputCls}
                      type="number"
                      min="0"
                      step="any"
                      value={it.dp}
                      onChange={(e) => setItem(i, "dp", e.target.value)}
                      placeholder={t("invoice.dp")}
                      aria-label={t("invoice.dp")}
                      title={t("invoice.dpHint")}
                    />
                  ) : null}
                  {c.g && !c.nt ? (
                    <input
                      className={inputCls}
                      type="number"
                      min="0"
                      step="any"
                      list="inv-gr"
                      value={it.g}
                      onChange={(e) => setItem(i, "g", e.target.value)}
                      placeholder={t("invoice.gp")}
                      aria-label={t("invoice.gp")}
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => duplicateItem(i)}
                    aria-label={t("invoice.dupItem")}
                    title={t("invoice.dupItem")}
                    className="flex size-11 min-h-11 items-center justify-center self-center justify-self-end rounded-md text-muted-foreground transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <Copy className="size-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    aria-label={t("invoice.removeItem")}
                    className="flex size-11 min-h-11 items-center justify-center self-center justify-self-end rounded-md text-lg text-destructive transition-colors hover:bg-destructive/10 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addItem}
              className="mt-3 h-11 min-h-11 w-full text-xs"
            >
              <Plus className="size-4" aria-hidden="true" />
              {t("invoice.add")}
            </Button>

            {!c.np ? (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground" htmlFor="inv-d">
                    {t("invoice.disc")}
                  </Label>
                  <Input
                    id="inv-d"
                    data-k="d"
                    type="number"
                    min="0"
                    step="any"
                    value={state.d}
                    onChange={onInput}
                    className="mt-1.5 h-11 min-h-11"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground" htmlFor="inv-dt">
                    {"\u00a0"}
                  </Label>
                  <select
                    id="inv-dt"
                    data-k="dMode"
                    className={`mt-1.5 ${selCls}`}
                    value={state.dMode}
                    onChange={onInput}
                  >
                    <option value="%">%</option>
                    <option value="f">{t("invoice.flat")}</option>
                  </select>
                </div>
                {!c.g ? (
                  <div>
                    <Label className="text-xs text-muted-foreground" htmlFor="inv-tr">
                      {t("invoice.trate")}
                    </Label>
                    <Input
                      id="inv-tr"
                      data-k="tr"
                      type="number"
                      min="0"
                      step="any"
                      value={state.tr}
                      onChange={onInput}
                      className="mt-1.5 h-11 min-h-11"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            <label
              htmlFor="inv-ro"
              className="mt-3 flex items-center gap-2 text-sm"
            >
              <Checkbox
                id="inv-ro"
                checked={state.ro}
                onCheckedChange={(v) => setField("ro", v === true)}
                className="size-5"
              />
              {t("invoice.ro")}
            </label>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="inv-adv">
                  {t("invoice.adv")}
                </Label>
                <Input
                  id="inv-adv"
                  data-k="adv"
                  type="number"
                  min="0"
                  step="any"
                  value={state.adv}
                  onChange={onInput}
                  className="mt-1.5 h-11 min-h-11"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="inv-st">
                  {t("invoice.st")}
                </Label>
                <select
                  id="inv-st"
                  data-k="st"
                  className={`mt-1.5 ${selCls}`}
                  value={state.st}
                  onChange={onInput}
                >
                  <option value=""></option>
                  <option>PAID</option>
                  <option>UNPAID</option>
                  <option>PARTIALLY PAID</option>
                  <option>DRAFT</option>
                </select>
              </div>
            </div>
          </div>

          {/* Notes & terms */}
          <div className="rounded-lg border bg-card p-4">
            <div className="flex flex-col gap-3">
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="inv-notes">
                  {t("invoice.notes")}
                </Label>
                <Textarea
                  id="inv-notes"
                  data-k="notes"
                  rows={2}
                  value={state.notes}
                  onChange={onInput}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="inv-terms">
                  {t("invoice.terms")}
                </Label>
                <Textarea
                  id="inv-terms"
                  data-k="terms"
                  rows={2}
                  value={state.terms}
                  onChange={onInput}
                  className="mt-1.5"
                />
              </div>
            </div>
          </div>

          {/* GST warnings */}
          {warnList.length ? (
            <div
              role="status"
              className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40"
            >
              <h2 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-amber-900 dark:text-amber-200">
                <TriangleAlert className="size-4" aria-hidden="true" />
                {t("invoice.warnTitle")}
              </h2>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-900 dark:text-amber-200">
                {warnList.map((w, i) => (
                  <li key={i}>
                    {t(`invoice.${w.key}`)}
                    {w.item ? ` #${w.item}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {/* ---------------- PREVIEW ---------------- */}
        <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <div className="flex flex-wrap items-center gap-2 pb-3">
            <Button
              type="button"
              onClick={exportPdf}
              disabled={exportPct !== null}
              className="h-11 min-h-11 gap-1.5 text-xs"
            >
              {exportPct !== null ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <FileDown className="size-4" aria-hidden="true" />
              )}
              {t("invoice.pdf")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={printSheet}
              className="h-11 min-h-11 gap-1.5 text-xs"
            >
              <Printer className="size-4" aria-hidden="true" />
              {t("invoice.print")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onNew}
              className="h-11 min-h-11 gap-1.5 text-xs"
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              {t("invoice.new")}
            </Button>
            <Button
              type="button"
              variant={dz ? "default" : "outline"}
              aria-pressed={dz}
              onClick={() => setDz((v) => !v)}
              className="h-11 min-h-11 gap-1.5 text-xs"
            >
              <MoveVertical className="size-4" aria-hidden="true" />
              {t("invoice.dz")}
            </Button>
            <input
              type="color"
              value={ac}
              onChange={(e) => setAc(e.target.value)}
              title={t("invoice.accent")}
              aria-label={t("invoice.accent")}
              className="size-11 cursor-pointer rounded-md border border-input bg-background p-1"
            />
            <Button
              type="button"
              variant="outline"
              onClick={saveCurrent}
              className="h-11 min-h-11 gap-1.5 text-xs"
            >
              <Save className="size-4" aria-hidden="true" />
              {t("invoice.sv")}
            </Button>
            <select
              aria-label={t("invoice.open")}
              className="h-11 min-h-11 min-w-40 max-w-56 rounded-md border border-input bg-background px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={savedIdx}
              onChange={(e) => loadSaved(e.target.value)}
            >
              <option value="">{t("invoice.open")}</option>
              {savedList.map((x, i) => (
                <option key={i} value={String(i)}>
                  {x.no} · {x.cli.name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={deleteSaved}
              disabled={savedIdx === ""}
              aria-label={t("invoice.delSaved")}
              title={t("invoice.delSaved")}
              className="size-11 min-h-11"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>

          <div ref={wrapRef} id="inv-wrap">
            <div
              id="inv-sheet"
              ref={sheetRef}
              className={dz ? "dz" : ""}
              style={{ "--ac": ac } as CSSProperties}
              onDragStart={onSheetDragStart}
              onDragOver={(e) => {
                if (dz && dragKeyRef.current) e.preventDefault();
              }}
              onDrop={onSheetDrop}
            >
              {state.st ? <div className="stp">{state.st}</div> : null}
              {ord.map((key) => renderBlock(key))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Boot helper: parse the serialized option (worker parser + meta)      */
/* ------------------------------------------------------------------ */

function parseRun(raw: string): {
  state: InvoiceState;
  ord: BlockKey[];
  ac: string;
  meta: MetaFlags;
} {
  const run = parseInvoiceRun(raw);
  let meta: MetaFlags = { tno: false, tterms: false, tst: false };
  try {
    const m = (JSON.parse(raw) as { meta?: Partial<MetaFlags> }).meta;
    if (m && typeof m === "object") {
      meta = {
        tno: m.tno === true,
        tterms: m.tterms === true,
        tst: m.tst === true,
      };
    }
  } catch {
    /* unreadable meta — defaults */
  }
  return { state: run.s, ord: run.ord, ac: run.ac, meta };
}
