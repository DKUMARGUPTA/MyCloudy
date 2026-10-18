/**
 * Create fillable PDF form — the 5 starter templates (P3-FORM).
 *
 * Templates are TYPED JSON specs: every human-readable string is an i18n
 * KEY resolved through the app's t() at LOAD time, so one spec serves
 * both English and हिंदी (scripts/merge-form-i18n.ts cross-checks that
 * every key referenced here exists in BOTH languages).
 *
 * Honest split, mirroring the pinned field-font constraints:
 *  - headings / notes / field labels / radio option labels → i18n keys
 *    (printed with the embedded Noto font — any script, ₹ included);
 *  - dropdown options and radio EXPORT values stay ASCII (field-side
 *    strings are WinAnsi/Helvetica in AcroForm) — dropdown option lists
 *    in the specs are plain Latin data.
 *
 * Positions are hand-placed px on the A4 canvas (margin 40, model math)
 * and stay inside the parse clamps so template → serialize → parseFormDoc
 * round-trips EXACTLY (smoke-proven).
 */

import type {
  CalcRule,
  FieldKind,
  FormDoc,
  FormElement,
  NumberFormat,
  StaticKind,
} from "./model";

/* ------------------------------------------------------------------ */
/* Spec shapes (i18n keys vs literals)                                  */
/* ------------------------------------------------------------------ */

export interface StaticSpec {
  kind: StaticKind;
  /** i18n key for the printed text (heading/text only). */
  key?: string;
  /** Literal text when the value is data, not UI copy. */
  text?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fs?: number;
}

export interface FieldSpec {
  kind: FieldKind;
  /** i18n key for the printed label. */
  labelKey?: string;
  /** Literal label. */
  label?: string;
  /** Explicit field name (formula-safe slug). */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fs?: number;
  required?: boolean;
  maxLength?: number;
  format?: NumberFormat;
  /** radio: display labels as i18n keys. */
  optionKeys?: string[];
  /** radio: literal display labels. */
  options?: string[];
  /** dropdown: plain ASCII data. */
  dropOptions?: string[];
}

export interface PageSpec {
  elements: (StaticSpec | FieldSpec)[];
}

export interface TemplateSpec {
  id: string;
  /** Card name (i18n). */
  nameKey: string;
  /** Card description (i18n). */
  descKey: string;
  pages: PageSpec[];
  rules: { target: string; expr: string }[];
}

/* ------------------------------------------------------------------ */
/* The five templates                                                   */
/* ------------------------------------------------------------------ */

const W1 = 320; // single-column width
const HALF = 180; // half-column width

export const TEMPLATES: TemplateSpec[] = [
  {
    id: "leave",
    nameKey: "tpl.leave.name",
    descKey: "tpl.leave.desc",
    pages: [
      {
        elements: [
          {
            kind: "heading",
            key: "tpl.leave.title",
            x: 40,
            y: 40,
            w: 460,
            h: 24,
          },
          {
            kind: "text",
            key: "tpl.leave.note",
            x: 40,
            y: 76,
            w: 660,
            h: 18,
          },
          {
            kind: "text",
            labelKey: "tpl.leave.fieldName",
            name: "applicant",
            x: 40,
            y: 112,
            w: W1,
            h: 40,
            required: true,
          },
          {
            kind: "text",
            labelKey: "tpl.leave.fieldDesignation",
            name: "designation",
            x: 380,
            y: 112,
            w: W1,
            h: 40,
          },
          {
            kind: "text",
            labelKey: "tpl.leave.fieldDepartment",
            name: "department",
            x: 40,
            y: 164,
            w: W1,
            h: 40,
          },
          {
            kind: "dropdown",
            labelKey: "tpl.leave.fieldType",
            name: "leave_type",
            x: 380,
            y: 164,
            w: W1,
            h: 40,
            dropOptions: ["Casual", "Sick", "Earned", "Unpaid"],
          },
          {
            kind: "date",
            labelKey: "tpl.leave.fieldFrom",
            name: "leave_from",
            x: 40,
            y: 216,
            w: HALF,
            h: 40,
            required: true,
          },
          {
            kind: "date",
            labelKey: "tpl.leave.fieldTo",
            name: "leave_to",
            x: 260,
            y: 216,
            w: HALF,
            h: 40,
            required: true,
          },
          {
            kind: "multiline",
            labelKey: "tpl.leave.fieldReason",
            name: "reason",
            x: 40,
            y: 268,
            w: 660,
            h: 98,
            required: true,
          },
          {
            kind: "checkbox",
            labelKey: "tpl.leave.fieldContact",
            name: "reachable",
            x: 40,
            y: 382,
            w: 16,
            h: 34,
          },
          {
            kind: "divider",
            x: 40,
            y: 438,
            w: 714,
            h: 8,
          },
          {
            kind: "date",
            labelKey: "tpl.leave.fieldSign",
            name: "signature_date",
            x: 40,
            y: 462,
            w: HALF,
            h: 40,
          },
        ],
      },
    ],
    rules: [],
  },
  {
    id: "event",
    nameKey: "tpl.event.name",
    descKey: "tpl.event.desc",
    pages: [
      {
        elements: [
          {
            kind: "heading",
            key: "tpl.event.title",
            x: 40,
            y: 40,
            w: 460,
            h: 24,
          },
          {
            kind: "text",
            key: "tpl.event.note",
            x: 40,
            y: 76,
            w: 660,
            h: 18,
          },
          {
            kind: "text",
            labelKey: "tpl.event.fieldName",
            name: "attendee",
            x: 40,
            y: 112,
            w: W1,
            h: 40,
            required: true,
          },
          {
            kind: "text",
            labelKey: "tpl.event.fieldEmail",
            name: "email",
            x: 380,
            y: 112,
            w: W1,
            h: 40,
            required: true,
          },
          {
            kind: "text",
            labelKey: "tpl.event.fieldPhone",
            name: "phone",
            x: 40,
            y: 164,
            w: W1,
            h: 40,
          },
          {
            kind: "text",
            labelKey: "tpl.event.fieldOrg",
            name: "organization",
            x: 380,
            y: 164,
            w: W1,
            h: 40,
          },
          {
            kind: "radio",
            labelKey: "tpl.event.fieldWorkshop",
            name: "workshop",
            x: 40,
            y: 216,
            w: 420,
            h: 72,
            optionKeys: [
              "tpl.event.optAi",
              "tpl.event.optWeb",
              "tpl.event.optDesign",
            ],
          },
          {
            kind: "dropdown",
            labelKey: "tpl.event.fieldSize",
            name: "tshirt",
            x: 40,
            y: 300,
            w: 160,
            h: 40,
            dropOptions: ["S", "M", "L", "XL"],
          },
          {
            kind: "date",
            labelKey: "tpl.event.fieldDate",
            name: "reg_date",
            x: 260,
            y: 300,
            w: HALF,
            h: 40,
            required: true,
          },
          {
            kind: "number",
            labelKey: "tpl.event.fieldDonation",
            name: "donation",
            x: 40,
            y: 352,
            w: 160,
            h: 40,
            format: "rupee",
          },
          {
            kind: "multiline",
            labelKey: "tpl.event.fieldComments",
            name: "comments",
            x: 40,
            y: 404,
            w: 660,
            h: 98,
          },
          {
            kind: "checkbox",
            labelKey: "tpl.event.fieldAgree",
            name: "terms",
            x: 40,
            y: 518,
            w: 16,
            h: 34,
            required: true,
          },
        ],
      },
    ],
    rules: [],
  },
  {
    id: "order",
    nameKey: "tpl.order.name",
    descKey: "tpl.order.desc",
    pages: [
      {
        elements: [
          {
            kind: "heading",
            key: "tpl.order.title",
            x: 40,
            y: 40,
            w: 420,
            h: 24,
          },
          {
            kind: "text",
            key: "tpl.order.note",
            x: 40,
            y: 76,
            w: 660,
            h: 18,
          },
          {
            kind: "text",
            labelKey: "tpl.order.fieldCustomer",
            name: "customer",
            x: 40,
            y: 112,
            w: W1,
            h: 40,
            required: true,
          },
          {
            kind: "date",
            labelKey: "tpl.order.fieldDate",
            name: "order_date",
            x: 380,
            y: 112,
            w: HALF,
            h: 40,
          },
          {
            kind: "text",
            labelKey: "tpl.order.fieldProduct",
            name: "product",
            x: 40,
            y: 164,
            w: 420,
            h: 40,
            required: true,
          },
          {
            kind: "number",
            labelKey: "tpl.order.fieldQty",
            name: "qty",
            x: 40,
            y: 216,
            w: 100,
            h: 40,
            required: true,
          },
          {
            kind: "number",
            labelKey: "tpl.order.fieldPrice",
            name: "price",
            x: 160,
            y: 216,
            w: 140,
            h: 40,
            format: "rupee",
            required: true,
          },
          {
            kind: "number",
            labelKey: "tpl.order.fieldTotal",
            name: "total",
            x: 320,
            y: 216,
            w: 140,
            h: 40,
            format: "rupee",
          },
          {
            kind: "number",
            labelKey: "tpl.order.fieldDiscount",
            name: "discount",
            x: 40,
            y: 268,
            w: 140,
            h: 40,
            format: "rupee",
          },
          {
            kind: "number",
            labelKey: "tpl.order.fieldTax",
            name: "tax",
            x: 200,
            y: 268,
            w: 140,
            h: 40,
            format: "rupee",
          },
          {
            kind: "number",
            labelKey: "tpl.order.fieldGrand",
            name: "grand",
            x: 360,
            y: 268,
            w: 140,
            h: 40,
            format: "rupee",
          },
          {
            kind: "box",
            x: 40,
            y: 330,
            w: 460,
            h: 60,
          },
          {
            kind: "text",
            key: "tpl.order.calcNote",
            x: 56,
            y: 346,
            w: 430,
            h: 18,
          },
          {
            kind: "multiline",
            labelKey: "tpl.order.fieldNotes",
            name: "notes",
            x: 40,
            y: 410,
            w: 660,
            h: 98,
          },
        ],
      },
    ],
    rules: [
      { target: "total", expr: "qty * price" },
      { target: "tax", expr: "total * 0.18" },
      { target: "grand", expr: "total + tax - discount" },
    ],
  },
  {
    id: "feedback",
    nameKey: "tpl.feedback.name",
    descKey: "tpl.feedback.desc",
    pages: [
      {
        elements: [
          {
            kind: "heading",
            key: "tpl.feedback.title",
            x: 40,
            y: 40,
            w: 420,
            h: 24,
          },
          {
            kind: "text",
            key: "tpl.feedback.note",
            x: 40,
            y: 76,
            w: 660,
            h: 18,
          },
          {
            kind: "text",
            labelKey: "tpl.feedback.fieldName",
            name: "respondent",
            x: 40,
            y: 112,
            w: W1,
            h: 40,
          },
          {
            kind: "date",
            labelKey: "tpl.feedback.fieldDate",
            name: "feedback_date",
            x: 380,
            y: 112,
            w: HALF,
            h: 40,
          },
          {
            kind: "radio",
            labelKey: "tpl.feedback.fieldRating",
            name: "rating",
            x: 40,
            y: 164,
            w: 420,
            h: 90,
            options: [
              "5 Excellent",
              "4 Good",
              "3 Okay",
              "2 Poor",
              "1 Very poor",
            ],
          },
          {
            kind: "text",
            labelKey: "tpl.feedback.fieldBest",
            name: "best_part",
            x: 40,
            y: 266,
            w: W1,
            h: 40,
          },
          {
            kind: "text",
            labelKey: "tpl.feedback.fieldImprove",
            name: "improve",
            x: 380,
            y: 266,
            w: W1,
            h: 40,
          },
          {
            kind: "multiline",
            labelKey: "tpl.feedback.fieldComments",
            name: "comments",
            x: 40,
            y: 318,
            w: 660,
            h: 98,
          },
          {
            kind: "checkbox",
            labelKey: "tpl.feedback.fieldRecommend",
            name: "recommend",
            x: 40,
            y: 432,
            w: 16,
            h: 34,
          },
        ],
      },
    ],
    rules: [],
  },
  {
    id: "blank",
    nameKey: "tpl.blank.name",
    descKey: "tpl.blank.desc",
    pages: [{ elements: [] }],
    rules: [],
  },
];

export function templateById(id: string): TemplateSpec | undefined {
  return TEMPLATES.find((tpl) => tpl.id === id);
}

/* ------------------------------------------------------------------ */
/* Instantiate a spec into a live FormDoc (labels resolved NOW)         */
/* ------------------------------------------------------------------ */

/**
 * Turn a spec into a FormDoc with every i18n key resolved through `t`.
 * The template's field names are explicit slugs (already formula-safe);
 * radio option labels resolve through t() (any script — they print via
 * the embedded Noto font), dropdown options are plain ASCII data.
 */
export function instantiateTemplate(
  spec: TemplateSpec,
  title: string,
  t: (key: string) => string,
): FormDoc {
  const pages = spec.pages.map((page, pi) => {
    const elements: FormElement[] = page.elements.map((el, ei) => {
      const id = `${spec.id}-p${pi + 1}-e${ei + 1}`;
      if ("name" in el) {
        const f = el;
        const options =
          f.kind === "radio"
            ? f.optionKeys
              ? f.optionKeys.map((k) => t(k))
              : (f.options ?? [])
            : f.kind === "dropdown"
              ? (f.dropOptions ?? [])
              : [];
        return {
          id,
          kind: f.kind,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
          fs: f.fs ?? 12,
          label: f.labelKey ? t(f.labelKey) : (f.label ?? ""),
          name: f.name,
          nameMan: true,
          required: f.required === true,
          maxLength: f.maxLength ?? 0,
          format: f.format ?? "plain",
          options,
        };
      }
      const s = el;
      return {
        id,
        kind: s.kind,
        x: s.x,
        y: s.y,
        w: s.w,
        h: s.h,
        fs: s.fs ?? (s.kind === "heading" ? 16 : 12),
        text:
          s.kind === "divider" || s.kind === "box"
            ? ""
            : s.key
              ? t(s.key)
              : (s.text ?? ""),
      };
    });
    return { id: `${spec.id}-p${pi + 1}`, elements };
  });
  const rules: CalcRule[] = spec.rules.map((r, i) => ({
    id: `${spec.id}-r${i + 1}`,
    target: r.target,
    expr: r.expr,
  }));
  return { title, pages, rules };
}
