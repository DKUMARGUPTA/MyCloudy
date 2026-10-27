/**
 * DocoPDF own PDF engine — the Devanagari shaper (P6-g).
 *
 * A faithful reimplementation of @pdf-lib/fontkit's shaping pipeline (the
 * HarfBuzz algorithm) for text runs in an embedded TrueType font, specialized
 * to this font's script coverage:
 *
 *   shapeText(font, text) → shaped glyphs (ids, codePoints, advances)
 *
 * Pipeline (mirrors fontkit layout()/OTLayoutEngine/IndicShaper exactly):
 *   1. glyphsForString: 1:1 cmap mapping (missing glyphs → .notdef).
 *   2. script detection: first non-Common/Inherited/Unknown codepoint's script
 *      (deva/dev2 → IndicShaper; the font's other scripts → the DefaultShaper
 *      with the latn/grek/cyrl/DFLT langsys; scripts without a GSUB entry fall
 *      back through DFLT→dflt→latn).
 *   3. assignFeatures: split-matra decompositions (DECOMPOSITIONS table).
 *   4. setupSyllables: the syllable machine (see matchRuns).
 *   5. initialReordering / finalReordering (base search, matra + reph
 *      reordering, feature staging: rphf/rkrf/pref/blwf/abvf/half/pstf/vatu/
 *      cjct/cfar/init + pres/abvs/blws/psts/haln) — a direct port.
 *   6. GSUB feature stages in the fontkit order.
 *   7. hideDefaultIgnorables: surviving default-ignorables → space glyph.
 *   8. RTL scripts (fontkit's list) reverse the glyph order.
 *
 * Zero external dependencies; indic-data.ts carries the Unicode
 * classification tables (extracted at dev time from the oracle).
 */

import {
  DECOMPOSITIONS,
  indicCatPos,
  isCfOrMn,
  scriptClass,
  SCRIPT_DEVA,
  SCRIPT_LATN,
  SCRIPT_GREK,
  SCRIPT_CYRL,
  SCRIPT_RTL,
} from "./indic-data";
import { GsubEngine, type GlyphInfo } from "./gsub";
import type { ParsedTtfFont } from "./font-ttf";

/* ─── categories + positions (bit values, per the fontkit shaper) ────────── */

const CAT = {
  X: 1 << 0,
  C: 1 << 1,
  V: 1 << 2,
  N: 1 << 3,
  H: 1 << 4,
  ZWNJ: 1 << 5,
  ZWJ: 1 << 6,
  M: 1 << 7,
  SM: 1 << 8,
  VD: 1 << 9,
  A: 1 << 10,
  Placeholder: 1 << 11,
  Dotted_Circle: 1 << 12,
  RS: 1 << 13,
  Coeng: 1 << 14,
  Repha: 1 << 15,
  Ra: 1 << 16,
  CM: 1 << 17,
  Symbol: 1 << 18,
} as const;

/** Category bit INDEX per codepoint (the machine alphabet). */
const CAT_INDEX = [
  CAT.X, CAT.C, CAT.V, CAT.N, CAT.H, CAT.ZWNJ, CAT.ZWJ, CAT.M, CAT.SM,
  CAT.VD, CAT.A, CAT.Placeholder, CAT.Dotted_Circle, CAT.RS, CAT.Coeng,
  CAT.Repha, CAT.Ra, CAT.CM, CAT.Symbol,
] as const;

const POS = {
  Start: 1 << 0,
  Ra_To_Become_Reph: 1 << 1,
  Pre_M: 1 << 2,
  Pre_C: 1 << 3,
  Base_C: 1 << 4,
  After_Main: 1 << 5,
  Above_C: 1 << 6,
  Before_Sub: 1 << 7,
  Below_C: 1 << 8,
  After_Sub: 1 << 9,
  Before_Post: 1 << 10,
  Post_C: 1 << 11,
  After_Post: 1 << 12,
  Final_C: 1 << 13,
  SMVD: 1 << 14,
  End: 1 << 15,
} as const;

const CONSONANT_FLAGS = CAT.C | CAT.Ra | CAT.CM | CAT.V | CAT.Placeholder | CAT.Dotted_Circle;
const JOINER_FLAGS = CAT.ZWJ | CAT.ZWNJ;
const HALANT_OR_COENG_FLAGS = CAT.H | CAT.Coeng;

const INDIC_CONFIG = {
  hasOldSpec: true,
  virama: 0x094d,
  basePos: "Last" as "Last" | "First",
  rephPos: POS.Before_Post,
  rephMode: "Implicit" as "Implicit" | "Explicit" | "Log_Repha" | "Vis_Repha",
  blwfMode: "Pre_And_Post" as "Pre_And_Post" | "Post_Only",
} as const;

/* ─── the syllable machine (rule grammar, DFA-equivalent) ────────────────── */

/** Machine alphabet symbols as plain indices (CAT_INDEX slots). */
const S = {
  X: 0, C: 1, V: 2, N: 3, H: 4, ZWNJ: 5, ZWJ: 6, M: 7, SM: 8, VD: 9,
  A: 10, PLC: 11, DC: 12, RS: 13, COENG: 14, REPHA: 15, RA: 16, CM: 17,
  SYM: 18,
} as const;

/**
 * The syllable matcher — a semantic position-automaton reproducing the
 * fontkit/HarfBuzz indic machine's exact observable behavior ([start, end,
 * firstTag] runs + the tagless continuation states), verified by an
 * exhaustive dev-time fuzz against the real DFA (smoke-pdf-core §17).
 *
 * Runner semantics mirror fontkit's StateMachine.match: greedy transitions
 * with last-accepting checkpoints; on failure the run restarts AT the failing
 * symbol; the emitted tag comes from the state BEFORE the failure (which can
 * be a tagless trailing-joiner state → undefined tag, exactly like fontkit's
 * empty-tags states).
 */

/* machine positions */
const enum MP {
  DEAD = 0,
  BASE,
  NUKTA,
  MED_CM,
  MED_COENG,
  H_TAIL,
  H_ZWJ,
  H_ZWNJ,
  CHAIN_C,
  CHAIN_N,
  MATRA,
  MATRA_N,
  MATRA_H,
  SIGN_SM,
  SIGN_A,
  SIGN_ZWNJ,
  RS_ST,
  REPHA,
  SYM,
  ZWJ_BASE,          // accepting trailing ZWJ (after base/chain contexts)
  TRAIL_ZWJ,         // tagless trailing ZWJ (after nukta/matras/signs)
  TRAIL_ZWNJ,        // tagless trailing ZWNJ
  TL_COENG,          // tagless Coeng (after halant/matra/coeng contexts)
  TL_ZWJ_SYM,        // tagless joiner after a symbol
  TL_ZWNJ2,          // second trailing joiner — only a matra may follow
  NU2,               // second nukta in a broken-start run (no third)
  SM2,               // second SM in a broken-start run (no third)
  MED_COENG2,        // limited Coeng (reached from trails/Repha — no V)
  COENG_V,           // the V consumed after a full Coeng (Khmer coeng+V)
  TR_M_ZWNJ,         // ZWNJ after a matra — M/SM continue
  TR_M_ZWJ,          // ZWJ after a matra — M/SM continue, H consumed tagless
  TR_ZWNJ_N,         // ZWNJ after nukta/RS contexts — no RS/Coeng continuation
  TL_NOTHING,        // tagless terminal
  BASE_RA,           // a Ra base (its halant forms a reph, not a plain tail)
  H_REPH,            // halant right after the Ra base — the reph slot
  ZWJ_COENG,         // accepting ZWJ after a Coeng context
  SIGN_ZWNJ_C,       // ZWNJ after a Coeng context (SM continues)
  H_TAIL2,           // halant after a broken CM context — no C/Ra chain
  SYM_N,             // the single nukta after a symbol
  SYM_SM,            // SM run after a symbol (no nukta follows)
  SYM_A,             // A after a symbol — terminal
  SYM_SM_Z,          // ZWNJ after symbol+SM (accepting)
  CHAIN_C2,          // chain C via a tagless Coeng — no H/Coeng after
  TL_COENG_N,        // Coeng after the limited Coeng — nothing follows
  COENG_V2,          // V after a tagless Coeng — accepting, null-tag for broken
  TR_ZWNJ_MN,        // ZWNJ after matra+nukta — RS lands accepting-null
  RS_TL,             // the accepting-null RS (via TR_ZWNJ_MN)
  NU2_H,             // nukta after H+ZWJ — C/Ra chain afterwards
  MATRA2,            // single M after a broken matra+halant (no second M)
  TRAIL_ZWNJ_P,      // ZWNJ inside a proper run — C/Ra chain afterwards
}

/** entry position per start symbol (0 = never starts). */
const ENTRY: Record<number, MP> = {
  [S.C]: MP.BASE, [S.RA]: MP.BASE_RA, [S.V]: MP.BASE, [S.PLC]: MP.BASE, [S.DC]: MP.BASE,
  [S.SYM]: MP.SYM,
  [S.N]: MP.NUKTA,
  [S.H]: MP.H_TAIL,
  [S.COENG]: MP.MED_COENG,
  [S.M]: MP.MATRA,
  [S.SM]: MP.SIGN_SM,
  [S.A]: MP.SIGN_A,
  [S.RS]: MP.RS_ST,
  [S.REPHA]: MP.REPHA,
  [S.CM]: MP.MED_CM,
  [S.ZWNJ]: MP.TRAIL_ZWNJ,
  [S.ZWJ]: MP.TRAIL_ZWJ,
};

/** family (tag) decided by the start symbol. */
type Family = "consonant_syllable" | "vowel_syllable" | "standalone_cluster" | "symbol_cluster" | "broken_cluster";
function familyFor(sym: number): Family {
  if (sym === S.C || sym === S.RA) return "consonant_syllable";
  if (sym === S.V) return "vowel_syllable";
  if (sym === S.PLC || sym === S.DC) return "standalone_cluster";
  if (sym === S.SYM) return "symbol_cluster";
  return "broken_cluster";
}

/**
 * One transition. Returns the next position, or a FAMILY FLIP when the run is
 * re-tagged (Repha + base re-enters the syllable as that base's family), or
 * DEAD for failures. Family-dependent entries: the trailing ZWJ after a
 * C/Ra/V base accepts (ZWJ_BASE) while after Plc/DC it goes tagless — the
 * caller resolves that with the family in hand.
 */
const FLIP_PREFIX = 1000;
type FlipKind = "consonant_syllable" | "vowel_syllable" | "standalone_cluster" | "ra_base";
const FLIP_KINDS: FlipKind[] = [
  "consonant_syllable",
  "vowel_syllable",
  "standalone_cluster",
  "ra_base",
];
function flip(kind: FlipKind): number {
  return FLIP_PREFIX + FLIP_KINDS.indexOf(kind);
}

function step(pos: MP, sym: number): number {
  switch (pos) {
    case MP.BASE:
      switch (sym) {
        case S.N: return MP.NUKTA;
        case S.H: return MP.H_TAIL;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.RS: return MP.RS_ST;
        default: return MP.DEAD;
      }
    case MP.BASE_RA:
      switch (sym) {
        case S.N: return MP.NUKTA;
        case S.H: return MP.H_REPH;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.RS: return MP.RS_ST;
        default: return MP.DEAD;
      }
    case MP.H_REPH:
      // the reph slot: bases re-enter with their family; the broken tail
      // continues in the broken machine (family flips to broken)
      switch (sym) {
        case S.N: return MP.NUKTA;
        case S.M: return MP.MATRA;
        case S.H: return MP.H_TAIL;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.RS: return MP.RS_ST;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        default: return MP.DEAD;
      }
    case MP.NUKTA:
      switch (sym) {
        case S.N: return MP.NUKTA;
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        default: return MP.DEAD;
      }
    case MP.MED_CM:
      switch (sym) {
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.MED_COENG;
        default: return MP.DEAD;
      }
    case MP.MED_COENG:
      switch (sym) {
        case S.C: return MP.CHAIN_C;
        case S.RA: return MP.CHAIN_C;
        case S.V: return MP.COENG_V;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.TL_COENG;
        default: return MP.DEAD;
      }
    case MP.H_TAIL:
      switch (sym) {
        case S.ZWJ: return MP.H_ZWJ;
        case S.ZWNJ: return MP.H_ZWNJ;
        case S.C: return MP.CHAIN_C;
        case S.RA: return MP.CHAIN_C;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.TL_COENG;
        default: return MP.DEAD;
      }
    case MP.H_TAIL2:
      switch (sym) {
        case S.ZWJ: return MP.H_ZWJ;
        case S.ZWNJ: return MP.H_ZWNJ;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.TL_COENG;
        default: return MP.DEAD;
      }
    case MP.H_ZWJ:
      switch (sym) {
        case S.C: return MP.CHAIN_C;
        case S.RA: return MP.CHAIN_C;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.N: return MP.NU2_H;
        case S.COENG: return MP.TL_COENG;
        default: return MP.DEAD;
      }
    case MP.H_ZWNJ:
      switch (sym) {
        case S.C: return MP.CHAIN_C;
        case S.RA: return MP.CHAIN_C;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.TL_COENG;
        default: return MP.DEAD;
      }
    case MP.CHAIN_C:
      switch (sym) {
        case S.N: return MP.CHAIN_N;
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.RS: return MP.RS_ST;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        case S.ZWJ: return MP.ZWJ_BASE;
        case S.ZWNJ: return MP.TRAIL_ZWNJ;
        default: return MP.DEAD;
      }
    case MP.CHAIN_N:
      switch (sym) {
        case S.N: return MP.CHAIN_N;
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        default: return MP.DEAD;
      }
    case MP.MATRA:
      switch (sym) {
        case S.M: return MP.MATRA;
        case S.N: return MP.MATRA_N;
        case S.H: return MP.MATRA_H;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.TL_COENG;
        default: return MP.DEAD;
      }
    case MP.MATRA_N:
      switch (sym) {
        case S.H: return MP.MATRA_H;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.TL_COENG;
        default: return MP.DEAD;
      }
    case MP.MATRA_H:
      return MP.DEAD;
    case MP.SIGN_SM:
      switch (sym) {
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.ZWNJ: return MP.SIGN_ZWNJ;
        default: return MP.DEAD;
      }
    case MP.SM2:
      switch (sym) {
        case S.A: return MP.SIGN_A;
        case S.ZWNJ: return MP.SIGN_ZWNJ;
        default: return MP.DEAD;
      }
    case MP.SIGN_A:
      switch (sym) {
        case S.A: return MP.SIGN_A;
        default: return MP.DEAD;
      }
    case MP.SIGN_ZWNJ:
      return sym === S.A ? MP.SIGN_A : MP.DEAD;
    case MP.SIGN_ZWNJ_C:
      switch (sym) {
        case S.A: return MP.SIGN_A;
        case S.SM: return MP.SIGN_SM;
        case S.COENG: return MP.TL_COENG;
        case S.ZWNJ: return MP.TL_ZWNJ2;
        case S.ZWJ: return MP.TL_ZWNJ2;
        default: return MP.DEAD;
      }
    case MP.RS_ST:
      switch (sym) {
        case S.M: return MP.MATRA;
        case S.H: return MP.H_TAIL;
        case S.N: return MP.NUKTA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        default: return MP.DEAD;
      }
    case MP.REPHA:
      switch (sym) {
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.N: return MP.NUKTA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.RS: return MP.RS_ST;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        case S.C: return flip("consonant_syllable");
        case S.RA: return flip("ra_base");
        case S.V: return flip("vowel_syllable");
        case S.PLC: return flip("standalone_cluster");
        case S.DC: return flip("standalone_cluster");
        default: return MP.DEAD;
      }
    case MP.SYM:
      switch (sym) {
        case S.N: return MP.SYM_N;
        case S.SM: return MP.SYM_SM;
        case S.A: return MP.SYM_A;
        case S.ZWNJ: return MP.TL_ZWJ_SYM;
        case S.ZWJ: return MP.TL_ZWJ_SYM;
        default: return MP.DEAD;
      }
    case MP.SYM_N:
      switch (sym) {
        case S.SM: return MP.SYM_SM;
        case S.A: return MP.SYM_A;
        default: return MP.DEAD;
      }
    case MP.SYM_SM:
      switch (sym) {
        case S.SM: return MP.SYM_SM;
        case S.A: return MP.SYM_A;
        case S.ZWNJ: return MP.SYM_SM_Z;
        default: return MP.DEAD;
      }
    case MP.SYM_A:
      return sym === S.A ? MP.SYM_A : MP.DEAD;
    case MP.SYM_SM_Z:
      return MP.DEAD;
    case MP.ZWJ_BASE:
      switch (sym) {
        case S.N: return MP.NUKTA;
        case S.M: return MP.MATRA;
        case S.H: return MP.H_TAIL;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.RS: return MP.RS_ST;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        default: return MP.DEAD;
      }
    case MP.TRAIL_ZWJ:
      switch (sym) {
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.COENG: return MP.MED_COENG2;
        case S.ZWNJ: return MP.TL_ZWNJ2;
        case S.ZWJ: return MP.TL_ZWNJ2;
        default: return MP.DEAD;
      }
    case MP.TRAIL_ZWNJ:
      switch (sym) {
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.RS: return MP.RS_ST;
        case S.COENG: return MP.MED_COENG2;
        case S.ZWNJ: return MP.TL_ZWNJ2;
        case S.ZWJ: return MP.TL_ZWNJ2;
        default: return MP.DEAD;
      }
    case MP.MED_COENG2:
      switch (sym) {
        case S.C: return MP.CHAIN_C;
        case S.RA: return MP.CHAIN_C;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.TL_COENG_N;
        default: return MP.DEAD;
      }
    case MP.COENG_V:
      switch (sym) {
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        default: return MP.DEAD;
      }
    case MP.TR_M_ZWNJ:
      switch (sym) {
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        default: return MP.DEAD;
      }
    case MP.TR_M_ZWJ:
      switch (sym) {
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.H: return MP.TL_NOTHING;
        default: return MP.DEAD;
      }
    case MP.TR_ZWNJ_N:
      switch (sym) {
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.COENG: return MP.MED_COENG2;
        default: return MP.DEAD;
      }
    case MP.TL_NOTHING:
      return MP.DEAD;
    case MP.ZWJ_COENG:
      switch (sym) {
        case S.C: return MP.CHAIN_C;
        case S.RA: return MP.CHAIN_C;
        case S.N: return MP.NUKTA;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.TL_COENG;
        default: return MP.DEAD;
      }
    case MP.TL_COENG:
      switch (sym) {
        case S.C: return MP.CHAIN_C2;
        case S.RA: return MP.CHAIN_C2;
        case S.V: return MP.COENG_V2;
        default: return MP.DEAD;
      }
    case MP.CHAIN_C2:
      switch (sym) {
        case S.N: return MP.CHAIN_N;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.RS: return MP.RS_ST;
        case S.CM: return MP.MED_CM;
        case S.ZWJ: return MP.ZWJ_BASE;
        case S.ZWNJ: return MP.TRAIL_ZWNJ;
        default: return MP.DEAD;
      }
    case MP.TL_COENG_N:
      return MP.DEAD;
    case MP.COENG_V2:
      switch (sym) {
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        default: return MP.DEAD;
      }
    case MP.TR_ZWNJ_MN:
      switch (sym) {
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.RS: return MP.RS_TL;
        default: return MP.DEAD;
      }
    case MP.RS_TL:
      return MP.DEAD;
    case MP.MATRA2:
      switch (sym) {
        case S.N: return MP.MATRA_N;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        default: return MP.DEAD;
      }
    case MP.TRAIL_ZWNJ_P:
      switch (sym) {
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.RS: return MP.RS_ST;
        case S.COENG: return MP.MED_COENG;
        case S.ZWNJ: return MP.TL_ZWNJ2;
        case S.ZWJ: return MP.TL_ZWNJ2;
        default: return MP.DEAD;
      }
    case MP.TL_ZWNJ2:
      switch (sym) {
        case S.M: return MP.MATRA;
        case S.ZWNJ: return MP.TL_NOTHING;
        default: return MP.DEAD;
      }
    case MP.NU2:
      switch (sym) {
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        default: return MP.DEAD;
      }
    case MP.NU2_H:
      switch (sym) {
        case S.H: return MP.H_TAIL;
        case S.M: return MP.MATRA;
        case S.SM: return MP.SIGN_SM;
        case S.A: return MP.SIGN_A;
        case S.COENG: return MP.MED_COENG;
        case S.CM: return MP.MED_CM;
        case S.C: return MP.CHAIN_C2;
        case S.RA: return MP.CHAIN_C2;
        default: return MP.DEAD;
      }
    case MP.TL_ZWJ_SYM:
      return sym === S.SM ? MP.SYM_SM : MP.DEAD;
    default:
      return MP.DEAD;
  }
}

/** accepting positions emit the run's family tag; tagless ones emit none. */
const ACCEPTING: ReadonlySet<MP> = new Set([
  MP.BASE, MP.NUKTA, MP.MED_CM, MP.MED_COENG, MP.H_TAIL, MP.H_ZWJ, MP.H_ZWNJ,
  MP.CHAIN_C, MP.CHAIN_N, MP.MATRA, MP.MATRA_N, MP.MATRA_H, MP.SIGN_SM,
  MP.SIGN_A, MP.SIGN_ZWNJ, MP.RS_ST, MP.REPHA, MP.SYM, MP.ZWJ_BASE, MP.NU2,
  MP.SM2, MP.MED_COENG2, MP.COENG_V, MP.BASE_RA, MP.H_REPH, MP.ZWJ_COENG,
  MP.SIGN_ZWNJ_C, MP.H_TAIL2, MP.SYM_N, MP.SYM_SM, MP.SYM_A, MP.SYM_SM_Z,
  MP.CHAIN_C2, MP.COENG_V2, MP.RS_TL, MP.MATRA2,
]);

/** accepting positions that emit NO tag (fontkit's empty-tags states). */
const NULL_TAG: ReadonlySet<MP> = new Set([MP.RS_TL, MP.COENG_V2]);

interface RunState {
  pos: MP;
  family: Family;
  /** 1 when the run was entered via a leading ZWNJ/ZWJ (joiner-start). */
  depth: number;
}

/**
 * Context-dependent joiner continuations fontkit models with dedicated
 * tagless/accepting states: step() returns DEAD for these; this fallback
 * resolves them with the family in hand (e.g. the trailing ZWJ accepts only
 * after a consonant/vowel base, not after a standalone base).
 */
function joinerFallback(run: RunState, sym: number): MP | null {
  if (sym !== S.ZWJ && sym !== S.ZWNJ) return null;
  const zwj = sym === S.ZWJ;
  switch (run.pos) {
    case MP.BASE:
    case MP.BASE_RA:
      if (zwj && run.family !== "standalone_cluster") return MP.ZWJ_BASE;
      return zwj ? MP.TRAIL_ZWJ : MP.TRAIL_ZWNJ_P;
    case MP.NUKTA:
    case MP.RS_ST:
      // vowel-family runs accept the trailing ZWJ; others go tagless
      if (run.family === "vowel_syllable") return zwj ? MP.ZWJ_BASE : MP.TRAIL_ZWNJ;
      return zwj ? MP.TRAIL_ZWJ : MP.TRAIL_ZWNJ;
    case MP.CHAIN_C:
    case MP.CHAIN_N:
    case MP.MED_CM:
    case MP.MATRA_N:
    case MP.MATRA_H:
    case MP.NU2:
    case MP.REPHA:
      return zwj ? MP.TRAIL_ZWJ : MP.TRAIL_ZWNJ;
    case MP.SYM_N:
      return MP.TL_NOTHING;
    case MP.MED_COENG:
      return zwj ? MP.ZWJ_COENG : MP.SIGN_ZWNJ_C;
    case MP.MED_COENG2:
      return zwj ? MP.ZWJ_COENG : MP.TRAIL_ZWNJ;
    case MP.SIGN_ZWNJ_C:
    case MP.ZWJ_COENG:
      return zwj ? MP.TRAIL_ZWJ : MP.TRAIL_ZWNJ;
    case MP.MED_CM:
      return zwj ? MP.TRAIL_ZWJ : MP.TR_ZWNJ_N;
    case MP.ZWJ_BASE:
    case MP.H_ZWJ:
    case MP.H_ZWNJ:
    case MP.COENG_V:
      return zwj ? MP.TRAIL_ZWJ : MP.TRAIL_ZWNJ;
    default:
      return null;
  }
}

function transition(run: RunState, sym: number): RunState | null {
  // family/context-dependent transitions (fontkit keeps separate productions
  // per syllable type — these slots genuinely differ between them)
  if (run.pos === MP.H_REPH) {
    // the reph slot: a base re-enters as that base's family (the reph is
    // absorbed); the broken-machine symbols flip the run to broken
    if (sym === S.C || sym === S.RA) {
      return { pos: sym === S.RA ? MP.BASE_RA : MP.BASE, family: "consonant_syllable", depth: run.depth };
    }
    if (sym === S.V) return { pos: MP.BASE, family: "vowel_syllable", depth: run.depth };
    if (sym === S.N || sym === S.M || sym === S.H || sym === S.RS || sym === S.COENG || sym === S.CM) {
      // continue in the BROKEN machine — the run's tag becomes broken
      return { pos: step(MP.H_REPH, sym), family: "broken_cluster", depth: run.depth };
    }
    // SM/A/joiners keep the consonant-first dual tag
    if (sym === S.ZWJ) return { pos: MP.H_ZWJ, family: run.family, depth: run.depth };
    if (sym === S.ZWNJ) return { pos: MP.H_ZWNJ, family: run.family, depth: run.depth };
  }
  if (run.pos === MP.MED_CM && sym === S.H) {
    return { pos: MP.H_TAIL2, family: run.family, depth: run.depth };
  }
  if (run.pos === MP.ZWJ_BASE && run.family === "vowel_syllable" &&
      (sym === S.N || sym === S.A || sym === S.RS || sym === S.CM)) {
    return null;
  }
  if (run.pos === MP.ZWJ_BASE && run.family === "broken_cluster" &&
      (sym === S.C || sym === S.RA)) {
    return { pos: MP.CHAIN_C, family: run.family, depth: run.depth };
  }
  if (run.pos === MP.ZWJ_BASE && run.family === "broken_cluster" && sym === S.RS) {
    return null;
  }
  if (run.pos === MP.SIGN_SM && sym === S.SM && run.family === "broken_cluster") {
    return { pos: MP.SM2, family: run.family };
  }
  if (run.pos === MP.MATRA_H) {
    if (sym === S.M) return { pos: MP.MATRA2, family: run.family };
    if (run.family === "broken_cluster") {
      if (sym === S.SM) return { pos: MP.SIGN_SM, family: run.family };
      if (sym === S.A) return { pos: MP.SIGN_A, family: run.family };
    }
    if (sym === S.COENG) return { pos: MP.TL_COENG, family: run.family };
  }
  if (run.pos === MP.MATRA_N && sym === S.M) {
    return { pos: MP.MATRA, family: run.family };
  }
  if (run.pos === MP.MATRA_N && sym === S.ZWNJ) {
    return { pos: MP.TR_ZWNJ_MN, family: run.family, depth: run.depth };
  }
  if (run.pos === MP.MATRA && (sym === S.ZWNJ || sym === S.ZWJ)) {
    return { pos: sym === S.ZWJ ? MP.TR_M_ZWJ : MP.TR_M_ZWNJ, family: run.family, depth: run.depth };
  }
  if (run.pos === MP.H_TAIL && run.depth === 1 && sym === S.ZWNJ) {
    return { pos: MP.TRAIL_ZWNJ, family: run.family, depth: run.depth };
  }
  if ((run.pos === MP.NUKTA || run.pos === MP.NU2 || run.pos === MP.RS_ST) && sym === S.ZWNJ) {
    return { pos: MP.TR_ZWNJ_N, family: run.family, depth: run.depth };
  }
  if (run.pos === MP.NUKTA && sym === S.N) {
    return { pos: run.family === "broken_cluster" ? MP.NU2 : MP.NUKTA, family: run.family };
  }
  if (run.pos === MP.H_ZWNJ && run.family !== "broken_cluster" && (sym === S.C || sym === S.RA)) {
    return null;
  }

  const next = step(run.pos, sym);
  if (next >= FLIP_PREFIX) {
    const kind = FLIP_KINDS[next - FLIP_PREFIX]!;
    if (kind === "ra_base") {
      return { pos: MP.BASE_RA, family: "consonant_syllable", depth: 0 };
    }
    return { pos: MP.BASE, family: kind, depth: 0 };
  }
  if (next !== MP.DEAD) return { pos: next, family: run.family, depth: run.depth };
  const fallback = joinerFallback(run, sym);
  if (fallback !== null) return { pos: fallback, family: run.family, depth: run.depth };
  return null;
}

/** fontkit StateMachine.match, position-automaton edition. */
export function matchRuns(cats: number[]): Array<[number, number, string | undefined]> {
  const out: Array<[number, number, string | undefined]> = [];

  const tagOf = (run: RunState | null): string | undefined =>
    run && ACCEPTING.has(run.pos)
      ? NULL_TAG.has(run.pos)
        ? undefined
        : run.family
      : undefined;

  const enter = (sym: number): RunState | null => {
    const entry = ENTRY[sym];
    if (entry === undefined) return null;
    return { pos: entry, family: familyFor(sym), depth: sym === S.ZWJ || sym === S.ZWNJ ? 1 : 0 };
  };

  let state: RunState | null = null;
  let startRun: number | null = null;
  let lastAccepting: number | null = null;
  let lastState: RunState | null = null;

  for (let p = 0; p < cats.length; p++) {
    const c = cats[p]!;
    lastState = state;
    state = state ? transition(state, c) : enter(c);

    if (state === null) {
      if (startRun !== null && lastAccepting !== null && lastAccepting >= startRun) {
        out.push([startRun, lastAccepting, tagOf(lastState)]);
      }
      state = enter(c);
      startRun = null;
    }
    if (state !== null && startRun === null) startRun = p;
    if (state !== null && ACCEPTING.has(state.pos)) lastAccepting = p;
  }

  if (startRun !== null && lastAccepting !== null && lastAccepting >= startRun) {
    out.push([startRun, lastAccepting, tagOf(state)]);
  }
  return out;
}

/* ─── the shaper ────────────────────────────────────────────────────────── */

export interface ShapedGlyph {
  id: number;
  codePoints: number[];
  advanceWidth: number;
}

const isConsonant = (g: GlyphInfo): boolean =>
  ((g.shaperInfo?.category ?? 0) & CONSONANT_FLAGS) !== 0;
const isJoiner = (g: GlyphInfo): boolean =>
  ((g.shaperInfo?.category ?? 0) & JOINER_FLAGS) !== 0;
const isHalantOrCoeng = (g: GlyphInfo): boolean =>
  ((g.shaperInfo?.category ?? 0) & HALANT_OR_COENG_FLAGS) !== 0;

function nextSyllable(glyphs: GlyphInfo[], start: number): number {
  if (start >= glyphs.length) return start;
  const syllable = glyphs[start]!.shaperInfo!.syllable;
  let s = start + 1;
  while (s < glyphs.length && glyphs[s]!.shaperInfo?.syllable === syllable) s++;
  return s;
}

/** Unicode script tag for the first meaningful codepoint (fontkit forString). */
function scriptTagForString(text: string): { tag: string; rtl: boolean } {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (0xd800 <= code && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (0xdc00 <= next && next <= 0xdfff) i++;
    }
    const cls = scriptClass(text.codePointAt(i)!);
    if (cls !== 0) {
      // SKIP is 0; anything else decides
      // fontkit's UNICODE_SCRIPTS maps Devanagari to ['dev2', 'deva'] — the
      // new-spec tag resolves first when present in the font's script list.
      if (cls === SCRIPT_DEVA) return { tag: "dev2", rtl: false };
      if (cls === SCRIPT_LATN) return { tag: "latn", rtl: false };
      if (cls === SCRIPT_GREK) return { tag: "grek", rtl: false };
      if (cls === SCRIPT_CYRL) return { tag: "cyrl", rtl: false };
      if (cls === SCRIPT_RTL) return { tag: "zzzz", rtl: true };
      return { tag: "zzzz", rtl: false }; // GSUB fallback chain
    }
  }
  return { tag: "DFLT", rtl: false };
}

/** fontkit's shaper selection over this font's script list. */
function isIndic(scriptTag: string): boolean {
  return scriptTag === "dev2";
}

/* ─── feature stages ────────────────────────────────────────────────────── */

const INDIC_GLOBAL_FEATURES = [
  "rvrn", "ltra", "ltrm", // preprocessing (global)
  "locl", "ccmp", // stage 2 (global)
  "nukt", "akhn", // global
  "rkrf", "vatu", "cjct", // global
  "pres", "abvs", "blws", "psts", "haln", "dist", "abvm", "blwm", // global final
  "calt", "clig",
  "rlig", "mark", "mkmk", "liga", "rclt", "curs", "kern", // postprocessing appends
] as const;

const INDIC_STAGE_FEATURES: string[][] = [
  ["rvrn", "ltra", "ltrm"],
  ["locl", "ccmp"],
  ["nukt"],
  ["akhn"],
  ["rphf"],
  ["rkrf"],
  ["pref"],
  ["blwf"],
  ["abvf"],
  ["half"],
  ["pstf"],
  ["vatu"],
  ["cjct"],
  ["cfar"],
  [
    "pres", "abvs", "blws", "psts", "haln", "dist", "abvm", "blwm", "calt",
    "clig", "init", "rlig", "mark", "mkmk", "liga", "rclt", "curs", "kern",
  ],
];

const DEFAULT_STAGE_FEATURES = [
  "rvrn", "ltra", "ltrm", "frac", "numr", "dnom", "ccmp", "locl", "rlig",
  "mark", "mkmk", "calt", "clig", "liga", "rclt", "curs", "kern",
] as const;

const DEFAULT_GLOBAL_FEATURES = DEFAULT_STAGE_FEATURES;

/* ─── the public API ────────────────────────────────────────────────────── */

export function shapeText(font: ParsedTtfFont, text: string): ShapedGlyph[] {
  const engine = new GsubEngine(font);

  /* 1. glyphsForString: 1:1 cmap mapping */
  const raw: GlyphInfo[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let cp = code;
    if (0xd800 <= code && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (0xdc00 <= next && next <= 0xdfff) {
        cp = ((code & 0x3ff) << 10) + (next & 0x3ff) + 0x10000;
        i++;
      }
    }
    raw.push(engine.glyph(font.glyphForCodePoint(cp), [cp]));
  }
  if (raw.length === 0) return [];

  /* 2-3. script detection + langsys + shaper selection */
  const { tag: scriptTag, rtl } = scriptTagForString(text);
  const resolved = engine.selectScript(scriptTag);
  const indic = isIndic(scriptTag);

  /* 4. assignFeatures — split-matra decompositions */
  const glyphs: GlyphInfo[] = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    const cp = raw[i]!.codePoints[0]!;
    const d = DECOMPOSITIONS.get(cp);
    if (d) {
      for (const part of d) {
        glyphs.push(engine.glyph(font.glyphForCodePoint(part), [part]));
      }
    } else {
      glyphs.push(raw[i]!);
    }
  }
  glyphs.reverse();

  /* 5. assign global features */
  const globalFeatures: string[] = indic
    ? [...INDIC_GLOBAL_FEATURES]
    : [...DEFAULT_GLOBAL_FEATURES];
  for (const g of glyphs) {
    for (const f of globalFeatures) g.features[f] = true;
  }

  /* 6. shaper */
  if (indic) {
    shapeIndic(font, engine, glyphs);
  } else {
    // DefaultShaper.assignFeatures: contextual fractions around U+2044
    for (let i = 0; i < glyphs.length; i++) {
      const glyph = glyphs[i]!;
      if (glyph.codePoints[0] === 0x2044) {
        let start = i;
        let end = i + 1;
        while (start > 0 && isDigitCp(glyphs[start - 1]!.codePoints[0] ?? 0)) {
          glyphs[start - 1]!.features.numr = true;
          glyphs[start - 1]!.features.frac = true;
          start--;
        }
        while (end < glyphs.length && isDigitCp(glyphs[end]!.codePoints[0] ?? 0)) {
          glyphs[end]!.features.dnom = true;
          glyphs[end]!.features.frac = true;
          end++;
        }
        glyph.features.frac = true;
        i = end - 1;
      }
    }
    engine.applyFeatures([...DEFAULT_STAGE_FEATURES], glyphs);
  }

  /* 7. hideDefaultIgnorables — surviving default ignorables → space glyph */
  const space = font.spaceGid;
  for (let i = 0; i < glyphs.length; i++) {
    const cp = glyphs[i]!.codePoints[0];
    if (cp !== undefined && isDefaultIgnorable(cp)) {
      glyphs[i] = engine.glyph(space, [0x20]);
    }
  }

  /* 8. RTL reversal */
  if (rtl) {
    glyphs.reverse();
  }
  void resolved;

  /* 8b. fontkit's glyph objects are SHARED per glyph id and getGlyph assigns
   * the caller's codePoints on EVERY call — so within one layout every
   * position showing glyph N extracts as the LAST text position that
   * produced glyph N (e.g. इ and ई share their shaped glyph in this font:
   * "इ ई" extracts both as ई). Replicate that last-write-wins semantics so
   * pdf-lib's ToUnicode lineage matches the oracle byte-for-byte. */
  const lastCps = new Map<number, number[]>();
  for (const g of glyphs) {
    if (g.codePoints.length > 0) lastCps.set(g.id, g.codePoints);
  }

  return glyphs.map((g) => ({
    id: g.id,
    codePoints: lastCps.get(g.id) ?? g.codePoints,
    advanceWidth: font.advanceWidth(g.id),
  }));
}

function isDigitCp(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x39;
}

function isDefaultIgnorable(cp: number): boolean {
  if (cp < 0 || cp > 0x10ffff) return false;
  const plane = cp >> 16;
  if (plane === 0) {
    switch (cp >> 8) {
      case 0x00:
        return cp === 0x00ad;
      case 0x03:
        return cp === 0x034f;
      case 0x06:
        return cp === 0x061c;
      case 0x17:
        return 0x17b4 <= cp && cp <= 0x17b5;
      case 0x18:
        return 0x180b <= cp && cp <= 0x180e;
      case 0x20:
        return (
          (0x200b <= cp && cp <= 0x200f) ||
          (0x202a <= cp && cp <= 0x202e) ||
          (0x2060 <= cp && cp <= 0x206f)
        );
      case 0xfe:
        return (0xfe00 <= cp && cp <= 0xfe0f) || cp === 0xfeff;
      case 0xff:
        return 0xfff0 <= cp && cp <= 0xfff8;
      default:
        return false;
    }
  }
  // Other planes: variation selectors + the HarfBuzz-excluded set
  return (
    (0xe0100 <= cp && cp <= 0xe01ef) ||
    cp === 0x2065 ||
    (0xfff0 <= (cp & 0xffff) && (cp & 0xffff) <= 0xfff8 && plane >= 0x2 && plane <= 0xe)
  );
}

/* ─── the Indic shaper (direct port of the fontkit algorithm) ───────────── */

function shapeIndic(font: ParsedTtfFont, engine: GsubEngine, glyphs: GlyphInfo[]): void {
  setupSyllables(glyphs);

  // The fontkit ShapingPlan stage order:
  //   [rvrn,ltra,ltrm,frac,numr,dnom] (already assigned: frac-family are
  //   local and only staged around U+2044 by the Default shaper — the Indic
  //   shaper stages them globally per the plan; applying here is harmless
  //   since the glyphs never carry them) → setupSyllables → [locl,ccmp] →
  //   initialReordering → [nukt] [akhn] [rphf] [rkrf] [pref] [blwf] [abvf]
  //   [half] [pstf] [vatu] [cjct] [cfar] → finalReordering → the final stage.
  engine.applyFeatures(INDIC_STAGE_FEATURES[0]!, glyphs);
  engine.applyFeatures(INDIC_STAGE_FEATURES[1]!, glyphs);
  initialReordering(font, engine, glyphs);
  for (let i = 2; i < INDIC_STAGE_FEATURES.length - 1; i++) {
    engine.applyFeatures(INDIC_STAGE_FEATURES[i]!, glyphs);
  }
  finalReordering(engine, glyphs);
  engine.applyFeatures(INDIC_STAGE_FEATURES[INDIC_STAGE_FEATURES.length - 1]!, glyphs);
}

function setupSyllables(glyphs: GlyphInfo[]): void {
  const cats = glyphs.map((g) => indicCatPos(g.codePoints[0] ?? 0).cat);

  let syllable = 0;
  let last = 0;
  const runs = matchRuns(cats);
  for (const [start, end, tag] of runs) {
    if (start > last) {
      syllable++;
      for (let i = last; i < start; i++) {
        glyphs[i]!.shaperInfo = {
          category: CAT.X,
          position: POS.End,
          syllableType: "non_indic_cluster",
          syllable,
        };
      }
    }
    syllable++;
    for (let i = start; i <= end; i++) {
      const { cat, pos } = indicCatPos(glyphs[i]!.codePoints[0] ?? 0);
      glyphs[i]!.shaperInfo = {
        category: CAT_INDEX[cat]!,
        position: 1 << pos,
        syllableType: tag,
        syllable,
      };
    }
    last = end + 1;
  }
  if (last < glyphs.length) {
    syllable++;
    for (let i = last; i < glyphs.length; i++) {
      glyphs[i]!.shaperInfo = {
        category: CAT.X,
        position: POS.End,
        syllableType: "non_indic_cluster",
        syllable,
      };
    }
  }
}

function consonantPosition(engine: GsubEngine, consonant: GlyphInfo, virama: GlyphInfo): number {
  if (
    engine.wouldSubstitute([virama, consonant], "blwf") ||
    engine.wouldSubstitute([consonant, virama], "blwf")
  ) {
    return POS.Below_C;
  }
  if (
    engine.wouldSubstitute([virama, consonant], "pstf") ||
    engine.wouldSubstitute([consonant, virama], "pstf")
  ) {
    return POS.Post_C;
  }
  if (
    engine.wouldSubstitute([virama, consonant], "pref") ||
    engine.wouldSubstitute([consonant, virama], "pref")
  ) {
    return POS.Post_C;
  }
  return POS.Base_C;
}

function initialReordering(font: ParsedTtfFont, engine: GsubEngine, glyphs: GlyphInfo[]): void {
  const dottedCircle = font.glyphForCodePoint(0x25cc);
  const viramaGid = font.glyphForCodePoint(INDIC_CONFIG.virama);

  if (viramaGid) {
    const info = engine.glyph(viramaGid, [INDIC_CONFIG.virama]);
    for (let i = 0; i < glyphs.length; i++) {
      if (glyphs[i]!.shaperInfo?.position === POS.Base_C) {
        const gi = glyphs[i]!;
        gi.shaperInfo!.position = consonantPosition(engine, gi, info);
      }
    }
  }

  for (let start = 0, end = nextSyllable(glyphs, 0); start < glyphs.length; start = end, end = nextSyllable(glyphs, start)) {
    const startInfo = glyphs[start]!.shaperInfo!;
    const syllableType = startInfo.syllableType;

    if (syllableType === "symbol_cluster" || syllableType === "non_indic_cluster") {
      continue;
    }

    if (syllableType === "broken_cluster" && dottedCircle) {
      const g = engine.glyph(dottedCircle, [0x25cc]);
      const dcInfo = indicCatPos(0x25cc);
      g.shaperInfo = {
        category: CAT_INDEX[dcInfo.cat]!,
        position: 1 << dcInfo.pos,
        syllableType: startInfo.syllableType,
        syllable: startInfo.syllable,
      };
      let i = start;
      while (i < end && glyphs[i]!.shaperInfo!.category === CAT.Repha) i++;
      glyphs.splice(i, 0, g);
      end++;
    }

    /* 1. Find base consonant */
    let base = end;
    let limit = start;
    let hasReph = false;

    if (
      INDIC_CONFIG.rephPos !== POS.Ra_To_Become_Reph &&
      engine.hasFeature("rphf") &&
      start + 3 <= end &&
      (INDIC_CONFIG.rephMode === "Implicit"
        ? !isJoiner(glyphs[start + 2]!)
        : glyphs[start + 2]!.shaperInfo!.category === CAT.ZWJ)
    ) {
      const first = glyphs[start]!.copy();
      const second = glyphs[start + 1]!.copy();
      const third = glyphs[start + 2]!.copy();
      if (
        engine.wouldSubstitute([first, second], "rphf") ||
        (INDIC_CONFIG.rephMode === "Explicit" && engine.wouldSubstitute([first, second, third], "rphf"))
      ) {
        limit += 2;
        while (limit < end && isJoiner(glyphs[limit]!)) limit++;
        base = start;
        hasReph = true;
      }
    }

    // basePos 'Last': scan backwards for the base consonant
    {
      let i = end;
      let seenBelow = false;
      do {
        const info = glyphs[--i]!.shaperInfo!;
        if (isConsonant(glyphs[i]!)) {
          if (info.position !== POS.Below_C && (info.position !== POS.Post_C || seenBelow)) {
            base = i;
            break;
          }
          if (info.position === POS.Below_C) seenBelow = true;
          base = i;
        } else if (
          start < i &&
          info.category === CAT.ZWJ &&
          glyphs[i - 1]!.shaperInfo!.category === CAT.H
        ) {
          break;
        }
      } while (i > limit);
    }

    if (hasReph && base === start && limit - base <= 2) {
      hasReph = false;
    }

    /* reposition before the base */
    for (let i = start; i < base; i++) {
      const info = glyphs[i]!.shaperInfo!;
      info.position = Math.min(POS.Pre_C, info.position);
    }
    if (base < end) glyphs[base]!.shaperInfo!.position = POS.Base_C;

    /* final consonants after a matra */
    for (let i = base + 1; i < end; i++) {
      if (glyphs[i]!.shaperInfo!.category === CAT.M) {
        for (let j = i + 1; j < end; j++) {
          if (isConsonant(glyphs[j]!)) {
            glyphs[j]!.shaperInfo!.position = POS.Final_C;
            break;
          }
        }
        break;
      }
    }

    if (hasReph) glyphs[start]!.shaperInfo!.position = POS.Ra_To_Become_Reph;

    /* attach misc marks to previous char */
    let lastPos = POS.Start;
    for (let i = start; i < end; i++) {
      const info = glyphs[i]!.shaperInfo!;
      if (
        (info.category & JOINER_FLAGS) !== 0 ||
        info.category === CAT.N ||
        info.category === CAT.RS ||
        info.category === CAT.CM ||
        (info.category & HALANT_OR_COENG_FLAGS) !== 0
      ) {
        info.position = lastPos;
        if (info.category === CAT.H && info.position === POS.Pre_M) {
          for (let j = i; j > start; j--) {
            if (glyphs[j - 1]!.shaperInfo!.position !== POS.Pre_M) {
              info.position = glyphs[j - 1]!.shaperInfo!.position;
              break;
            }
          }
        }
      } else if (info.position !== POS.SMVD) {
        lastPos = info.position;
      }
    }

    /* post-base consonants own anything before them since the last consonant/matra */
    let lastCm = base;
    for (let i = base + 1; i < end; i++) {
      if (isConsonant(glyphs[i]!)) {
        for (let j = lastCm + 1; j < i; j++) {
          if (glyphs[j]!.shaperInfo!.position < POS.SMVD) {
            glyphs[j]!.shaperInfo!.position = glyphs[i]!.shaperInfo!.position;
          }
        }
        lastCm = i;
      } else if (glyphs[i]!.shaperInfo!.category === CAT.M) {
        lastCm = i;
      }
    }

    /* sort by position (stable) */
    const arr = glyphs.slice(start, end);
    arr.sort((a, b) => a.shaperInfo!.position - b.shaperInfo!.position);
    glyphs.splice(start, arr.length, ...arr);

    /* find base again */
    for (let i = start; i < end; i++) {
      if (glyphs[i]!.shaperInfo!.position === POS.Base_C) {
        base = i;
        break;
      }
    }

    /* stage features */
    for (let i = start; i < end && glyphs[i]!.shaperInfo!.position === POS.Ra_To_Become_Reph; i++) {
      glyphs[i]!.features.rphf = true;
    }

    const blwf = INDIC_CONFIG.blwfMode === "Pre_And_Post";
    for (let i = start; i < base; i++) {
      glyphs[i]!.features.half = true;
      if (blwf) glyphs[i]!.features.blwf = true;
    }
    for (let i = base + 1; i < end; i++) {
      glyphs[i]!.features.abvf = true;
      glyphs[i]!.features.pstf = true;
      glyphs[i]!.features.blwf = true;
    }

    const prefLen = 2;
    if (engine.hasFeature("pref") && base + prefLen < end) {
      for (let i = base + 1; i + prefLen - 1 < end; i++) {
        const pair = [glyphs[i]!.copy(), glyphs[i + 1]!.copy()];
        if (engine.wouldSubstitute(pair, "pref")) {
          for (let j = 0; j < prefLen; j++) glyphs[i++]!.features.pref = true;
          if (engine.hasFeature("cfar")) {
            for (; i < end; i++) glyphs[i]!.features.cfar = true;
          }
          break;
        }
      }
    }

    /* ZWJ/ZWNJ effects */
    for (let i = start + 1; i < end; i++) {
      if (isJoiner(glyphs[i]!)) {
        const nonJoiner = glyphs[i]!.shaperInfo!.category === CAT.ZWNJ;
        let j = i;
        do {
          j--;
          if (nonJoiner) delete glyphs[j]!.features.half;
        } while (j > start && !isConsonant(glyphs[j]!));
      }
    }
  }
}

function finalReordering(engine: GsubEngine, glyphs: GlyphInfo[]): void {
  for (let start = 0, end = nextSyllable(glyphs, 0); start < glyphs.length; start = end, end = nextSyllable(glyphs, start)) {
    let tryPref = engine.hasFeature("pref");
    let base = start;

    /* find base again */
    for (; base < end; base++) {
      if (glyphs[base]!.shaperInfo!.position >= POS.Base_C) {
        if (tryPref && base + 1 < end) {
          for (let i = base + 1; i < end; i++) {
            if (glyphs[i]!.features.pref) {
              if (!(glyphs[i]!.substituted && glyphs[i]!.isLigated && !glyphs[i]!.isMultiplied)) {
                base = i;
                while (base < end && isHalantOrCoeng(glyphs[base]!)) base++;
                glyphs[base]!.shaperInfo!.position = POS.Base_C;
                tryPref = false;
              }
              break;
            }
          }
        }

        if (start < base && glyphs[base]!.shaperInfo!.position > POS.Base_C) {
          base--;
        }
        break;
      }
    }

    if (base === end && start < base && glyphs[base - 1]!.shaperInfo!.category === CAT.ZWJ) {
      base--;
    }

    if (base < end) {
      while (start < base && (glyphs[base]!.shaperInfo!.category & (CAT.N | HALANT_OR_COENG_FLAGS)) !== 0) {
        base--;
      }
    }

    /* reorder matras */
    if (start + 1 < end && start < base) {
      let newPos = base === end ? base - 2 : base - 1;

      while (newPos > start && (glyphs[newPos]!.shaperInfo!.category & (CAT.M | HALANT_OR_COENG_FLAGS)) === 0) {
        newPos--;
      }
      if (isHalantOrCoeng(glyphs[newPos]!) && glyphs[newPos]!.shaperInfo!.position !== POS.Pre_M) {
        if (newPos + 1 < end && isJoiner(glyphs[newPos + 1]!)) {
          newPos++;
        }
      } else {
        newPos = start;
      }

      if (start < newPos && glyphs[newPos]!.shaperInfo!.position !== POS.Pre_M) {
        for (let i = newPos; i > start; i--) {
          if (glyphs[i - 1]!.shaperInfo!.position === POS.Pre_M) {
            const oldPos = i - 1;
            if (oldPos < base && base <= newPos) base--;
            const tmp = glyphs[oldPos]!;
            glyphs.splice(oldPos, 0, ...glyphs.splice(oldPos + 1, newPos - oldPos));
            glyphs[newPos] = tmp;
            newPos--;
          }
        }
      }
    }

    /* reorder reph */
    if (
      start + 1 < end &&
      glyphs[start]!.shaperInfo!.position === POS.Ra_To_Become_Reph &&
      (glyphs[start]!.shaperInfo!.category === CAT.Repha) !==
        (glyphs[start]!.isLigated && !glyphs[start]!.isMultiplied)
    ) {
      let newRephPos = 0;
      let found = false;
      const rephPos = INDIC_CONFIG.rephPos;

      if (rephPos !== POS.After_Post) {
        newRephPos = start + 1;
        while (newRephPos < base && !isHalantOrCoeng(glyphs[newRephPos]!)) newRephPos++;
        if (newRephPos < base && isHalantOrCoeng(glyphs[newRephPos]!)) {
          if (newRephPos + 1 < base && isJoiner(glyphs[newRephPos + 1]!)) newRephPos++;
          found = true;
        }
        if (!found && rephPos === POS.After_Main) {
          newRephPos = base;
          while (newRephPos + 1 < end && glyphs[newRephPos + 1]!.shaperInfo!.position <= POS.After_Main) {
            newRephPos++;
          }
          found = newRephPos < end;
        }
        if (!found && rephPos === POS.After_Sub) {
          newRephPos = base;
          while (
            newRephPos + 1 < end &&
            (glyphs[newRephPos + 1]!.shaperInfo!.position & (POS.Post_C | POS.After_Post | POS.SMVD)) === 0
          ) {
            newRephPos++;
          }
          found = newRephPos < end;
        }
      }
      if (!found) {
        newRephPos = start + 1;
        while (newRephPos < base && !isHalantOrCoeng(glyphs[newRephPos]!)) newRephPos++;
        if (newRephPos < base && isHalantOrCoeng(glyphs[newRephPos]!)) {
          if (newRephPos + 1 < base && isJoiner(glyphs[newRephPos + 1]!)) newRephPos++;
          found = true;
        }
      }
      if (!found) {
        newRephPos = end - 1;
        while (newRephPos > start && glyphs[newRephPos]!.shaperInfo!.position === POS.SMVD) {
          newRephPos--;
        }
        if (isHalantOrCoeng(glyphs[newRephPos]!)) {
          for (let i = base + 1; i < newRephPos; i++) {
            if (glyphs[i]!.shaperInfo!.category === CAT.M) newRephPos--;
          }
        }
      }

      const reph = glyphs[start]!;
      glyphs.splice(start, 0, ...glyphs.splice(start + 1, newRephPos - start));
      glyphs[newRephPos] = reph;
      if (start < base && base <= newRephPos) base--;
    }

    /* reorder pre-base reordering consonants */
    if (tryPref && base + 1 < end) {
      for (let i = base + 1; i < end; i++) {
        if (glyphs[i]!.features.pref) {
          if (glyphs[i]!.isLigated && !glyphs[i]!.isMultiplied) {
            let newPos = base;
            while (newPos > start && (glyphs[newPos - 1]!.shaperInfo!.category & (CAT.M | HALANT_OR_COENG_FLAGS)) === 0) {
              newPos--;
            }
            if (newPos > start && glyphs[newPos - 1]!.shaperInfo!.category === CAT.M) {
              const oldPos = i;
              for (let j = base + 1; j < oldPos; j++) {
                if (glyphs[j]!.shaperInfo!.category === CAT.M) {
                  newPos--;
                  break;
                }
              }
            }
            if (newPos > start && isHalantOrCoeng(glyphs[newPos - 1]!)) {
              if (newPos < end && isJoiner(glyphs[newPos]!)) newPos++;
            }
            const oldPos = i;
            const tmp = glyphs[oldPos]!;
            glyphs.splice(newPos + 1, 0, ...glyphs.splice(newPos, oldPos - newPos));
            glyphs[newPos] = tmp;
            if (newPos <= base && base < oldPos) base++;
          }
          break;
        }
      }
    }

    /* init feature on word-start pre-matras */
    if (
      glyphs[start]!.shaperInfo?.position === POS.Pre_M &&
      (start === 0 || !isCfOrMn(glyphs[start - 1]!.codePoints[0] ?? 0))
    ) {
      glyphs[start]!.features.init = true;
    }
  }
}
