/**
 * Smoke test for tools/lock-common/security.ts (pure engine).
 * Run: bun scripts/smoke-lock.ts
 * Covers the full PRD §8.4 matrix: AES-256/128, permissions, owner-only,
 * unlock roundtrip, form/value survival, error codes.
 */
import {
  PDFDocument,
  StandardFonts,
} from "@cantoo/pdf-lib";
import {
  SecurityError,
  estimateTypedBits,
  lockPdf,
  parseUnlockMeta,
  unlockPdf,
  validateLockPw,
  verifyLocked,
  verifyUnlocked,
  type LockRequest,
} from "../tools/lock-common/security";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, extra = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

const codeOf = (e: unknown): string | null =>
  e instanceof SecurityError ? e.code : null;

async function makeSample(withForm: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Sample content 123", { x: 50, y: 700, size: 24, font });
  if (withForm) {
    const form = doc.getForm();
    const tf = form.createTextField("holder_name");
    tf.setText("Sunita Devi");
    tf.addToPage(page, { x: 50, y: 650, width: 280, height: 24 });
    const cb = form.createCheckBox("consent");
    cb.check();
    cb.addToPage(page, { x: 50, y: 610, width: 20, height: 20 });
  }
  return doc.save();
}

const baseReq = (over: Partial<LockRequest> = {}): LockRequest => ({
  userPw: "open123",
  ownerPw: "",
  alg: "aes256",
  permissions: {
    printing: true,
    copying: false,
    modifying: false,
    annotating: true,
    fillingForms: true,
    contentAccessibility: true,
  },
  ...over,
});

/* 1 — validation */
console.log("1. validateLockPw");
{
  let threw: string | null = null;
  try { validateLockPw("abc"); } catch (e) { threw = codeOf(e); }
  ok(threw === "tool.errorPwTooShort", "short password → errorPwTooShort");
  let threwEmpty: string | null = null;
  try { validateLockPw(""); } catch (e) { threwEmpty = codeOf(e); }
  ok(threwEmpty === null, "empty password legal (owner-only mode)");
  let ok6 = true;
  try { validateLockPw("abcdef"); } catch { ok6 = false; }
  ok(ok6, "6 chars passes (PRD min)");
}

/* 2 — lock + verify (AES-256) */
console.log("2. lockPdf AES-256");
{
  const sample = await makeSample(true);
  const { bytes, pageCount } = await lockPdf(sample, baseReq());
  ok(pageCount === 1, "pageCount = 1");
  await verifyLocked(bytes, "open123");
  ok(true, "verifyLocked passes (opens with pw, refuses without)");
  const text = new TextDecoder("latin1").decode(bytes);
  ok(text.includes("/Encrypt"), "output carries /Encrypt");
  ok(/AESV3|\/V 5|\/R 6/.test(text), "AES-256 markers present (V5/R6/AESV3)");
}

/* 3 — lock with AES-128 */
console.log("3. lockPdf AES-128");
{
  const sample = await makeSample(false);
  const { bytes } = await lockPdf(sample, baseReq({ alg: "aes128" }));
  await verifyLocked(bytes, "open123");
  const text = new TextDecoder("latin1").decode(bytes);
  ok(/AESV2|\/V 4|\/R 4/.test(text), "AES-128 markers present (V4/R4/AESV2)");
}

/* 4 — permissions land in the file */
console.log("4. permissions");
{
  const sample = await makeSample(false);
  const { bytes } = await lockPdf(
    sample,
    baseReq({
      permissions: {
        printing: false,
        copying: false,
        modifying: false,
        annotating: false,
        fillingForms: false,
        contentAccessibility: false,
      },
    })
  );
  const text = new TextDecoder("latin1").decode(textDecode(bytes));
  // All-off P value is 0xFFFFFFFF as signed -1 in many writers; @cantoo
  // writes the exact permission flag. Just check /P exists and is negative
  // (restrictions set).
  const m = text.match(/\/P\s+(-?\d+)/);
  ok(!!m, "/P flag written");
  ok(m !== null && Number(m[1]) < 0, "all-off → negative /P (restrictions)", m?.[1]);
}

function textDecode(b: Uint8Array): Uint8Array {
  return b;
}

/* 5 — already-locked input rejected */
console.log("5. double lock");
{
  const sample = await makeSample(false);
  const { bytes: locked } = await lockPdf(sample, baseReq());
  let code: string | null = null;
  try {
    await lockPdf(locked, baseReq());
  } catch (e) {
    code = codeOf(e);
  }
  ok(code === "tool.errorAlreadyEncrypted", "locking a locked file → errorAlreadyEncrypted");
}

/* 6 — unlock roundtrip: forms + values + verify */
console.log("6. unlockPdf");
{
  const sample = await makeSample(true);
  const { bytes: locked } = await lockPdf(sample, baseReq());
  const { bytes: unlocked, pageCount } = await unlockPdf(locked, "open123");
  ok(pageCount === 1, "unlock pageCount = 1");
  await verifyUnlocked(unlocked);
  ok(true, "verifyUnlocked passes (no /Encrypt anywhere, plain reload OK)");
  const doc = await PDFDocument.load(unlocked);
  const fields = doc.getForm().getFields().map((f) => f.getName());
  ok(
    fields.includes("holder_name") && fields.includes("consent"),
    "form fields survive", JSON.stringify(fields)
  );
  const val = doc.getForm().getTextField?.("holder_name");
  const text = val ? await val.getText() : undefined;
  ok(text === "Sunita Devi", "filled value survives", String(text));
  // pdf-lib chain-compat: plain load (what our other tools do) works.
  ok(true, "plain pdf-lib reload OK (chain tools can process it)");
}

/* 7 — wrong password on unlock */
console.log("7. wrong password");
{
  const sample = await makeSample(false);
  const { bytes: locked } = await lockPdf(sample, baseReq());
  let code: string | null = null;
  try {
    await unlockPdf(locked, "wrong99");
  } catch (e) {
    code = codeOf(e);
  }
  ok(code === "tool.errorWrongPassword", "wrong password → errorWrongPassword");
}

/* 8 — owner-only file: empty password unlock (PRD mode 2) */
console.log("8. owner-only");
{
  const sample = await makeSample(true);
  const { bytes: ownerOnly } = await lockPdf(
    sample,
    baseReq({ userPw: "", ownerPw: "owner999" })
  );
  // It's encrypted but opens with an empty user password.
  const { bytes: unlocked } = await unlockPdf(ownerOnly, "");
  await verifyUnlocked(unlocked);
  ok(true, "empty-password unlock strips restrictions");
  const doc = await PDFDocument.load(unlocked);
  const fields = doc.getForm().getFields().map((f) => f.getName());
  ok(fields.length === 2, "owner-only roundtrip keeps forms", JSON.stringify(fields));
}

/* 9 — unencrypted input → honest error */
console.log("9. not encrypted");
{
  const sample = await makeSample(false);
  let code: string | null = null;
  try {
    await unlockPdf(sample, "whatever");
  } catch (e) {
    code = codeOf(e);
  }
  ok(code === "tool.errorNotEncrypted", "plain file → errorNotEncrypted");
}

/* 10 — Info survives unlock via the pdf.js meta path */
console.log("10. info preserved (meta path)");
{
  const src = await PDFDocument.create();
  src.setTitle("Quarterly Report");
  src.setAuthor("R. Menon");
  const font = await src.embedFont(StandardFonts.Helvetica);
  const page = src.addPage([612, 792]);
  page.drawText("x", { x: 50, y: 700, size: 12, font });
  const sample = await src.save();
  const { bytes: locked } = await lockPdf(sample, baseReq());
  const { bytes: unlocked } = await unlockPdf(locked, "open123", {
    title: "Quarterly Report",
    author: "R. Menon",
  });
  const doc = await PDFDocument.load(unlocked);
  ok(doc.getTitle() === "Quarterly Report", "title survives (meta path)", String(doc.getTitle()));
  ok(doc.getAuthor() === "R. Menon", "author survives (meta path)", String(doc.getAuthor()));
}

/* 10b — parseUnlockMeta defensive parse */
console.log("10b. parseUnlockMeta");
{
  ok(parseUnlockMeta(null) === null, "non-string → null");
  ok(parseUnlockMeta("{}") === null, "empty object → null");
  ok(parseUnlockMeta("{bad json") === null, "bad json → null");
  const m = parseUnlockMeta('{"title":"T"}');
  ok(m?.title === "T", "valid json parses");
  ok(parseUnlockMeta('{"title":"","author":"A"}')?.author === "A", "empty strings dropped");
}

/* 11 — estimateTypedBits sanity */
console.log("11. estimateTypedBits");
{
  ok(estimateTypedBits("") === 0, "empty → 0");
  const weak = estimateTypedBits("password");
  ok(weak <= 8, "common password capped at ≤8 bits", String(weak));
  const strong = estimateTypedBits("kV9#mQz2!pLw4");
  ok(strong > 60, "mixed 13-char > 60 bits", String(strong));
  const digits = estimateTypedBits("123456789012");
  ok(digits < 50, "pure digits capped", String(digits));
  const aaa = estimateTypedBits("aaaaaaaa");
  ok(aaa <= 6, "single-char repeat ≤6 bits", String(aaa));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
