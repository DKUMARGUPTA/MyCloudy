/**
 * Write PDF — starter templates (PRD §8: "templates (letter, application,
 * offer, report)"). Content ships as inline L10n pairs (the config.ts
 * features/FAQ pattern): the template NAMES + descriptions ride the i18n
 * catalog ("write" section), while this file owns the block CONTENT a
 * template prefills. The Hindi application follows the classic भारतीय
 * आवेदन format (सेवा में / विषय / धन्यवाद).
 */

import type { WDoc, WTextBlock } from "./model";

export type TemplateId = "blank" | "letter" | "application" | "offer" | "report";

export interface TemplateDef {
  id: TemplateId;
}

export const TEMPLATE_IDS: TemplateId[] = [
  "blank",
  "letter",
  "application",
  "offer",
  "report",
];

let seq = 0;
function bid(): string {
  seq += 1;
  return `t${seq}`;
}

function doc(title: string, blocks: WDoc["blocks"]): WDoc {
  return {
    title,
    setup: {
      pageSize: "a4",
      landscape: false,
      margins: "normal",
      headerText: "",
      footerText: "",
      pageNumbers: "none",
      pageNumFormat: "n",
      dateText: "",
    },
    blocks,
  };
}

function p(text: string): WTextBlock {
  return { id: bid(), kind: "p", runs: [{ text }], align: "left", family: "sans" };
}

function h1(text: string): WTextBlock {
  return {
    id: bid(),
    kind: "h1",
    runs: [{ text }],
    align: "left",
    family: "sans",
  };
}

function h2(text: string): WTextBlock {
  return {
    id: bid(),
    kind: "h2",
    runs: [{ text }],
    align: "left",
    family: "sans",
  };
}

function bullet(text: string): WTextBlock {
  return {
    id: bid(),
    kind: "bullet",
    runs: [{ text }],
    align: "left",
    family: "sans",
  };
}

function numbered(text: string): WTextBlock {
  return {
    id: bid(),
    kind: "numbered",
    runs: [{ text }],
    align: "left",
    family: "sans",
  };
}

/** A blank document — one empty paragraph, ready to type. */
function blank(): WDoc {
  seq = 0;
  return doc("", [{ id: bid(), kind: "p", runs: [], align: "left", family: "sans" }]);
}

/** Formal English letter. */
function letter(): WDoc {
  seq = 0;
  return doc("Letter", [
    { id: bid(), kind: "p", runs: [{ text: "17 October 2026" }], align: "right", family: "serif" },
    p(""),
    p("To,"),
    p("The Manager,"),
    p("Company Name,"),
    p("City"),
    p(""),
    { id: bid(), kind: "p", runs: [{ text: "Subject: ", bold: true }, { text: "Request for leave" }], align: "left", family: "serif" },
    p(""),
    { ...p("Respected Sir/Madam,"), family: "serif" },
    p(""),
    { ...p("I am writing to request three days of leave from 20 to 22 October 2026 due to a family function at home. I have handed my pending work to a colleague, so nothing will be held up while I am away."), family: "serif" },
    p(""),
    { ...p("Kindly consider my request and grant me the leave for the above dates. I shall be grateful."), family: "serif" },
    p(""),
    { ...p("Thanking you,"), family: "serif" },
    p(""),
    { ...p("Yours sincerely,"), family: "serif" },
    { ...p("Your Name"), family: "serif" },
  ]);
}

/** Hindi आवेदन — the classic Indian formal application. */
function application(): WDoc {
  seq = 0;
  return doc("आवेदन", [
    { id: bid(), kind: "p", runs: [{ text: "सेवा में," }], align: "left", family: "sans" },
    { id: bid(), kind: "p", runs: [{ text: "प्रधानाचार्य महोदय," }], align: "left", family: "sans" },
    { id: bid(), kind: "p", runs: [{ text: "विद्यालय का नाम," }], align: "left", family: "sans" },
    { id: bid(), kind: "p", runs: [{ text: "शहर का नाम" }], align: "left", family: "sans" },
    p(""),
    {
      id: bid(),
      kind: "p",
      runs: [{ text: "विषय: ", bold: true }, { text: "अवकाश हेतु आवेदन" }],
      align: "left",
      family: "sans",
    },
    p(""),
    { id: bid(), kind: "p", runs: [{ text: "महोदय जी," }], align: "left", family: "sans" },
    p(""),
    {
      id: bid(),
      kind: "p",
      runs: [
        {
          text: "सविनय निवेदन है कि मैं आपके विद्यालय की कक्षा 10 का छात्र हूँ। मेरे घर पर एक आवश्यक कार्य के कारण मुझे दिनांक 20 से 22 अक्टूबर 2026 तक तीन दिन का अवकाश चाहिए।",
        },
      ],
      align: "left",
      family: "sans",
    },
    p(""),
    {
      id: bid(),
      kind: "p",
      runs: [{ text: "अतः आपसे निवेदन है कि मुझे उक्त अवधि का अवकाश स्वीकार कर प्रदान करें। मैं आपका आभारी रहूँगा।" }],
      align: "left",
      family: "sans",
    },
    p(""),
    { id: bid(), kind: "p", runs: [{ text: "धन्यवाद," }], align: "left", family: "sans" },
    p(""),
    { id: bid(), kind: "p", runs: [{ text: "आपका आज्ञाकारी शिष्य," }], align: "right", family: "sans" },
    { id: bid(), kind: "p", runs: [{ text: "नाम: राम कुमार" }], align: "right", family: "sans" },
    { id: bid(), kind: "p", runs: [{ text: "कक्षा: 10 'ब'" }], align: "right", family: "sans" },
    { id: bid(), kind: "p", runs: [{ text: "दिनांक: 17 अक्टूबर 2026" }], align: "right", family: "sans" },
  ]);
}

/** Job offer letter. */
function offer(): WDoc {
  seq = 0;
  return doc("Offer Letter", [
    h1("Offer of Employment"),
    p(""),
    p("Dear Candidate,"),
    p(""),
    p("We are pleased to offer you the position of Software Engineer at Doco Technologies Pvt. Ltd. This letter summarises the terms of your employment."),
    p(""),
    h2("Terms"),
    numbered("Your date of joining will be 1 November 2026 at our Pune office."),
    numbered("Your annual cost to company will be ₹8,40,000 with the breakup shared in Annexure A."),
    numbered("Your working hours are 9:30 AM to 6:30 PM, Monday to Friday."),
    numbered("You will report to the Engineering Manager."),
    p(""),
    h2("Conditions"),
    bullet("This offer is valid until 31 October 2026."),
    bullet("Employment is subject to satisfactory background verification."),
    bullet("A notice period of two months applies after confirmation."),
    p(""),
    p("To accept this offer, please sign and return a copy of this letter."),
    p(""),
    p("We look forward to welcoming you to the team."),
    p(""),
    p(""),
    p("Warm regards,"),
    { ...p("Priya Sharma"), family: "serif" },
    { ...p("Head of People Operations"), family: "serif" },
  ]);
}

/** Report with sections, a table and a page break. */
function report(): WDoc {
  seq = 0;
  return doc("Quarterly Report", [
    h1("Quarterly Progress Report"),
    { id: bid(), kind: "p", runs: [{ text: "Prepared by the Project Office — Q3 2026" }], align: "center", family: "sans" },
    { id: bid(), kind: "hr" },
    h2("1. Summary"),
    p("The third quarter closed ahead of plan on delivery while staying inside budget. Two major features shipped, uptime held at 99.95%, and the support queue shrank by 18% after the new help centre launched in August."),
    h2("2. Highlights"),
    bullet("Editor beta shipped to all users; crash-free sessions at 99.8%."),
    bullet("Hindi OCR reached 95% mean confidence on the test bench."),
    bullet("Median file processing time dropped from 3.1s to 2.2s."),
    h2("3. Numbers"),
    {
      id: bid(),
      kind: "table",
      header: true,
      rows: [
        ["Metric", "Q2 2026", "Q3 2026", "Change"],
        ["Active users", "1,20,000", "1,58,000", "+31.7%"],
        ["Files processed", "9.4 lakh", "12.1 lakh", "+28.7%"],
        ["Support tickets", "4,120", "3,378", "−18.0%"],
        ["Uptime", "99.91%", "99.95%", "+0.04 pts"],
      ],
    },
    { id: bid(), kind: "pagebreak" },
    h2("4. Plans for Q4"),
    numbered("Ship the collaboration review workflow."),
    numbered("Open the invoice template library with GST support."),
    numbered("Reduce p95 export latency below 1.5 seconds."),
    p(""),
    { id: bid(), kind: "quote", runs: [{ text: "Shipping is a habit — the team kept the weekly rhythm for eleven straight weeks." }], align: "left", family: "serif" },
    p(""),
    p(""),
    p("— End of report —"),
  ]);
}

/** Builds a fresh template document (ids regenerate per call). */
export function buildTemplate(id: TemplateId, dateText: string): WDoc {
  const built =
    id === "letter"
      ? letter()
      : id === "application"
        ? application()
        : id === "offer"
          ? offer()
          : id === "report"
            ? report()
            : blank();
  return { ...built, setup: { ...built.setup, dateText } };
}
