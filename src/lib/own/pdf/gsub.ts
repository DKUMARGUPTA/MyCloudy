/**
 * DocoPDF own PDF engine — GSUB substitution engine (P6-g).
 *
 * A faithful reimplementation of the @pdf-lib/fontkit OTProcessor/GSUBProcessor
 * pipeline (itself the HarfBuzz algorithm), specialized to the lookup set the
 * shipped Devanagari font uses: lookup types 1 (single, formats 1+2), 2
 * (multiple), 4 (ligature), 5 (context, formats 1+2+3) and 6 (chaining
 * context, formats 1+2+3), classic coverage/classdef structures.
 *
 * Semantics mirrored exactly (dev-time oracle parity, zero-mistake rule):
 *   - lookupsForFeatures: per-feature lookup lists, then a stable sort by
 *     lookup index.
 *   - applyLookups: per lookup, the glyph iterator resets to the lookup's
 *     flag (ignoreMarks/ignoreBaseGlyphs/ignoreLigatures/markAttachmentType
 *     via GDEF), walks all glyphs, only glyphs carrying the CURRENT feature
 *     are substituted; subtables tried until one matches.
 *   - ligature codePoints concatenate the consumed glyphs' codePoints (the
 *     ToUnicode lineage), isLigated/isMultiplied/substituted flags track what
 *     the shaper's final reordering reads.
 *   - sequenceMatchIndices gates each component on the current feature too.
 *   - wouldSubstitute: fresh copies carrying ONLY the tested feature, one
 *     applyFeatures pass, "did it collapse to a single glyph".
 */

import {
  classID,
  coverageIndex,
  type ClassDef,
  type Coverage,
  type GsubLookup,
  type LookupSubtable,
  type ParsedTtfFont,
} from "./font-ttf";

/* ─── glyph info + shaper state ─────────────────────────────────────────── */

/** The Indic shaper's per-glyph state (category/position bits + syllable). */
export interface ShaperInfo {
  /** CATEGORIES bit (1 << catIdx from indic-data). */
  category: number;
  /** POSITIONS bit (1 << posIdx from indic-data). */
  position: number;
  syllableType: string;
  syllable: number;
}

export class GlyphInfo {
  codePoints: number[];
  features: Record<string, boolean>;
  shaperInfo: ShaperInfo | null = null;
  ligatureComponent: number | null = null;
  isLigated = false;
  substituted = false;
  isMultiplied = false;
  isMark: boolean;
  isBase: boolean;
  isLigature: boolean;
  markAttachmentType: number;

  constructor(
    private readonly cls: { classOf(gid: number): { mark: boolean; base: boolean; ligature: boolean; markAttach: number } },
    public id: number,
    codePoints?: number[],
    features?: Record<string, boolean> | string[],
  ) {
    this.codePoints = codePoints ?? [];
    this.features = {};
    if (Array.isArray(features)) {
      for (const f of features) this.features[f] = true;
    } else if (features) {
      Object.assign(this.features, features);
    }
    const c = cls.classOf(id);
    this.isMark = c.mark;
    this.isBase = c.base;
    this.isLigature = c.ligature;
    this.markAttachmentType = c.markAttach;
  }

  copy(): GlyphInfo {
    const g = new GlyphInfo(this.cls, this.id, this.codePoints, this.features);
    g.shaperInfo = this.shaperInfo;
    g.isLigated = this.isLigated;
    g.substituted = this.substituted;
    g.isMultiplied = this.isMultiplied;
    return g;
  }

  /** fontkit's GlyphInfo id setter side effects (substituted + GDEF class). */
  setGlyphId(id: number): void {
    this.id = id;
    this.substituted = true;
    const c = this.cls.classOf(id);
    this.isMark = c.mark;
    this.isBase = c.base;
    this.isLigature = c.ligature;
    this.markAttachmentType = c.markAttach;
  }
}

/* ─── the engine ────────────────────────────────────────────────────────── */

interface IteratorOptions {
  ignoreBaseGlyphs: boolean;
  ignoreLigatures: boolean;
  ignoreMarks: boolean;
  markAttachmentType: number;
}

class GlyphIterator {
  glyphs: GlyphInfo[];
  options: IteratorOptions = {
    ignoreBaseGlyphs: false,
    ignoreLigatures: false,
    ignoreMarks: false,
    markAttachmentType: 0,
  };
  index = 0;

  constructor(glyphs: GlyphInfo[]) {
    this.glyphs = glyphs;
  }

  reset(options: IteratorOptions, index = 0): void {
    this.options = options;
    this.index = index;
  }

  private shouldIgnore(glyph: GlyphInfo | null): boolean {
    if (!glyph) return false;
    return (
      (this.options.ignoreMarks && glyph.isMark) ||
      (this.options.ignoreBaseGlyphs && glyph.isBase) ||
      (this.options.ignoreLigatures && glyph.isLigature) ||
      (this.options.markAttachmentType !== 0 &&
        glyph.isMark &&
        glyph.markAttachmentType !== this.options.markAttachmentType)
    );
  }

  private move(dir: number): GlyphInfo | null {
    this.index += dir;
    while (this.index >= 0 && this.index < this.glyphs.length && this.shouldIgnore(this.glyphs[this.index])) {
      this.index += dir;
    }
    if (this.index < 0 || this.index >= this.glyphs.length) return null;
    return this.glyphs[this.index]!;
  }

  next(): GlyphInfo | null {
    return this.move(1);
  }

  increment(count: number): GlyphInfo | null {
    const dir = count < 0 ? -1 : 1;
    count = Math.abs(count);
    while (count-- > 0) this.move(dir);
    return this.glyphs[this.index] ?? null;
  }

  get cur(): GlyphInfo | null {
    return this.glyphs[this.index] ?? null;
  }
}

interface LookupUse {
  feature: string;
  index: number;
  lookup: GsubLookup;
}

const DEFAULT_SCRIPTS = ["DFLT", "dflt", "latn"];

export class GsubEngine {
  /** Feature tag → feature (last record wins, per fontkit selectScript). */
  features: Record<string, { tag: string; lookupIndexes: number[] }> = {};
  scriptTag: string | null = null;

  private glyphs: GlyphInfo[] = [];
  private readonly iterator: GlyphIterator;
  private currentFeature = "";
  private readonly cls: { classOf(gid: number): { mark: boolean; base: boolean; ligature: boolean; markAttach: number } };

  constructor(private readonly font: ParsedTtfFont) {
    this.iterator = new GlyphIterator([]);
    const gdef = font.gdef;
    const glyphClassDef = gdef?.glyphClassDef;
    const markAttach = gdef?.markAttachClassDef;
    this.cls = {
      classOf(gid: number) {
        if (glyphClassDef) {
          const classIDValue = classID(glyphClassDef, gid);
          return {
            mark: classIDValue === 3,
            base: classIDValue === 1,
            ligature: classIDValue === 2,
            markAttach: markAttach ? classID(markAttach, gid) : 0,
          };
        }
        return { mark: false, base: true, ligature: false, markAttach: 0 };
      },
    };
  }

  /** GlyphInfo factory bound to this engine's GDEF classes. */
  glyph(id: number, codePoints?: number[]): GlyphInfo {
    return new GlyphInfo(this.cls, id, codePoints);
  }

  /**
   * Resolve the script tag (fontkit selectScript with no language): exact tag
   * match first, then the DFLT/dflt/latn fallback chain; features come from
   * the default langsys. Returns the resolved tag.
   */
  selectScript(input: string): string {
    const gsub = this.font.gsub;
    if (!gsub) return input;
    let tag = input;
    if (!gsub.scripts.has(tag)) {
      tag = DEFAULT_SCRIPTS.find((t) => gsub.scripts.has(t)) ?? input;
    }
    if (this.scriptTag === tag && this.features) {
      // fontkit reuses state when the script did not change
      return this.scriptTag ?? tag;
    }
    this.scriptTag = tag;
    const featureIndexes = gsub.scripts.get(tag) ?? [];
    const features: typeof this.features = {};
    for (const fi of featureIndexes) {
      const feature = gsub.features[fi];
      if (feature) features[feature.tag] = feature;
    }
    this.features = features;
    return tag;
  }

  /** The feature tags the resolved script offers (shaper feature checks). */
  hasFeature(tag: string): boolean {
    return this.features[tag] !== undefined;
  }

  applyFeatures(userFeatures: string[], glyphs: GlyphInfo[]): void {
    const lookups = this.lookupsForFeatures(userFeatures);
    this.applyLookups(lookups, glyphs);
  }

  private lookupsForFeatures(userFeatures: string[]): LookupUse[] {
    const gsub = this.font.gsub;
    if (!gsub) return [];
    const lookups: LookupUse[] = [];
    for (const tag of userFeatures) {
      const feature = this.features[tag];
      if (!feature) continue;
      for (const lookupIndex of feature.lookupIndexes) {
        const lookup = gsub.lookups[lookupIndex];
        if (lookup) lookups.push({ feature: tag, index: lookupIndex, lookup });
      }
    }
    lookups.sort((a, b) => a.index - b.index);
    return lookups;
  }

  private applyLookups(lookups: LookupUse[], glyphs: GlyphInfo[]): void {
    this.glyphs = glyphs;
    this.iterator.glyphs = glyphs;
    for (const { feature, lookup } of lookups) {
      this.currentFeature = feature;
      this.iterator.reset(flagOptions(lookup.flag));
      while (this.iterator.index < glyphs.length) {
        const cur = this.iterator.cur;
        if (!cur || !(feature in cur.features)) {
          this.iterator.next();
          continue;
        }
        for (const table of lookup.subtables) {
          if (this.applyLookup(lookup.type, table)) break;
        }
        this.iterator.next();
      }
    }
  }

  /**
   * fontkit's wouldSubstitute: copies carrying ONLY the tested feature, one
   * pass, "did the sequence collapse to a single glyph".
   */
  wouldSubstitute(glyphs: GlyphInfo[], feature: string): boolean {
    const copies = glyphs.map((g) => {
      const c = new GlyphInfo(this.cls, g.id, g.codePoints);
      c.shaperInfo = g.shaperInfo;
      c.features = { [feature]: true };
      return c;
    });
    this.applyFeatures([feature], copies);
    return copies.length === 1;
  }

  /* ─── lookup application (mirrors GSUBProcessor.applyLookup) ──────────── */

  private applyLookup(lookupType: number, table: LookupSubtable): boolean {
    switch (table.kind) {
      case "single1": {
        const index = coverageIndex(table.cov, this.iterator.cur?.id ?? -1);
        if (index === -1) return false;
        const glyph = this.iterator.cur!;
        glyph.setGlyphId((glyph.id + table.delta) & 0xffff);
        return true;
      }
      case "single2": {
        const index = coverageIndex(table.cov, this.iterator.cur?.id ?? -1);
        if (index === -1) return false;
        const glyph = this.iterator.cur!;
        glyph.setGlyphId(table.substitutes[index] ?? glyph.id);
        return true;
      }
      case "multiple1": {
        const index = coverageIndex(table.cov, this.iterator.cur?.id ?? -1);
        if (index === -1) return false;
        const sequence = table.sequences[index];
        if (!sequence || sequence.length === 0) return false;
        const cur = this.iterator.cur!;
        cur.setGlyphId(sequence[0]!);
        cur.ligatureComponent = 0;
        const replacement: GlyphInfo[] = [];
        for (let i = 1; i < sequence.length; i++) {
          const glyph = new GlyphInfo(this.cls, sequence[i]!, [], cur.features);
          glyph.shaperInfo = cur.shaperInfo;
          glyph.isLigated = cur.isLigated;
          glyph.ligatureComponent = i;
          glyph.substituted = true;
          glyph.isMultiplied = true;
          replacement.push(glyph);
        }
        this.glyphs.splice(this.iterator.index + 1, 0, ...replacement);
        return true;
      }
      case "ligature1": {
        const index = coverageIndex(table.cov, this.iterator.cur?.id ?? -1);
        if (index === -1) return false;
        for (const ligature of table.sets[index] ?? []) {
          const matched = this.sequenceMatchIndices(1, ligature.components);
          if (!matched) continue;
          const cur = this.iterator.cur!;
          const characters = cur.codePoints.slice();
          for (const m of matched) characters.push(...this.glyphs[m]!.codePoints);
          const ligatureGlyph = new GlyphInfo(this.cls, ligature.glyph, characters, cur.features);
          ligatureGlyph.shaperInfo = cur.shaperInfo;
          ligatureGlyph.isLigated = true;
          ligatureGlyph.substituted = true;
          for (let i = matched.length - 1; i >= 0; i--) this.glyphs.splice(matched[i]!, 1);
          this.glyphs[this.iterator.index] = ligatureGlyph;
          return true;
        }
        return false;
      }
      case "context1":
      case "context2":
      case "context3":
        return this.applyContext(table);
      case "chain1":
      case "chain2":
      case "chain3":
        return this.applyChainingContext(table);
      default:
        throw new Error(`GSUB lookup type ${lookupType} is not supported`);
    }
  }

  /* ─── matching helpers (mirror OTProcessor) ──────────────────────────── */

  private match<T>(
    sequenceIndex: number,
    sequence: readonly T[],
    fn: (component: T, glyph: GlyphInfo) => boolean,
    matched?: number[],
  ): number[] | true | false {
    const pos = this.iterator.index;
    let glyph = this.iterator.increment(sequenceIndex);
    let idx = 0;
    while (idx < sequence.length && glyph && fn(sequence[idx]!, glyph)) {
      if (matched) matched.push(this.iterator.index);
      idx++;
      glyph = this.iterator.next();
    }
    this.iterator.index = pos;
    if (idx < sequence.length) return false;
    return matched ?? true;
  }

  private sequenceMatches(sequenceIndex: number, sequence: number[]): boolean {
    return this.match(sequenceIndex, sequence, (component, glyph) => component === glyph.id) !== false;
  }

  private sequenceMatchIndices(sequenceIndex: number, sequence: number[]): number[] | false {
    const matched: number[] = [];
    const res = this.match(
      sequenceIndex,
      sequence,
      (component, glyph) => {
        if (!(this.currentFeature in glyph.features)) return false;
        return component === glyph.id;
      },
      matched,
    );
    return res === false ? false : matched;
  }

  private coverageSequenceMatches(sequenceIndex: number, sequence: Coverage[]): boolean {
    return (
      this.match(sequenceIndex, sequence, (coverage, glyph) =>
        coverageIndex(coverage, glyph.id) >= 0,
      ) !== false
    );
  }

  private classSequenceMatches(
    sequenceIndex: number,
    sequence: number[],
    classDef: ClassDef,
  ): boolean {
    return (
      this.match(sequenceIndex, sequence, (classId, glyph) => classId === classID(classDef, glyph.id)) !==
      false
    );
  }

  private applyLookupList(records: Array<{ sequenceIndex: number; lookupListIndex: number }>): boolean {
    const options = this.iterator.options;
    const glyphIndex = this.iterator.index;
    for (const record of records) {
      this.iterator.reset(options, glyphIndex);
      this.iterator.increment(record.sequenceIndex);
      const lookup = this.font.gsub?.lookups[record.lookupListIndex];
      if (!lookup) continue;
      this.iterator.reset(flagOptions(lookup.flag), this.iterator.index);
      for (const table of lookup.subtables) {
        if (this.applyLookup(lookup.type, table)) break;
      }
    }
    this.iterator.reset(options, glyphIndex);
    return true;
  }

  private applyContext(table: Extract<LookupSubtable, { kind: "context1" | "context2" | "context3" }>): boolean {
    switch (table.kind) {
      case "context1": {
        const index = coverageIndex(table.cov, this.iterator.cur?.id ?? -1);
        if (index === -1) return false;
        const set = table.ruleSets[index];
        if (!set) return false;
        for (const rule of set) {
          if (this.sequenceMatches(1, rule.input)) {
            return this.applyLookupList(rule.lookups);
          }
        }
        return false;
      }
      case "context2": {
        if (coverageIndex(table.cov, this.iterator.cur?.id ?? -1) === -1) return false;
        const index = classID(table.classDef, this.iterator.cur?.id ?? -1);
        const set = table.classSets[index];
        if (!set) return false;
        for (const rule of set) {
          if (this.classSequenceMatches(1, rule.classes, table.classDef)) {
            return this.applyLookupList(rule.lookups);
          }
        }
        return false;
      }
      case "context3": {
        if (this.coverageSequenceMatches(0, table.coverages)) {
          return this.applyLookupList(table.lookups);
        }
        return false;
      }
    }
  }

  private applyChainingContext(
    table: Extract<LookupSubtable, { kind: "chain1" | "chain2" | "chain3" }>,
  ): boolean {
    switch (table.kind) {
      case "chain1": {
        const index = coverageIndex(table.cov, this.iterator.cur?.id ?? -1);
        if (index === -1) return false;
        const set = table.ruleSets[index];
        if (!set) return false;
        for (const rule of set) {
          if (
            this.sequenceMatches(-rule.backtrack.length, rule.backtrack) &&
            this.sequenceMatches(1, rule.input) &&
            this.sequenceMatches(1 + rule.input.length, rule.lookahead)
          ) {
            return this.applyLookupList(rule.lookups);
          }
        }
        return false;
      }
      case "chain2": {
        if (coverageIndex(table.cov, this.iterator.cur?.id ?? -1) === -1) return false;
        const index = classID(table.inputClassDef, this.iterator.cur?.id ?? -1);
        const rules = table.classSets[index];
        if (!rules) return false;
        for (const rule of rules) {
          if (
            this.classSequenceMatches(-rule.backtrack.length, rule.backtrack, table.backtrackClassDef) &&
            this.classSequenceMatches(1, rule.input, table.inputClassDef) &&
            this.classSequenceMatches(1 + rule.input.length, rule.lookahead, table.lookaheadClassDef)
          ) {
            return this.applyLookupList(rule.lookups);
          }
        }
        return false;
      }
      case "chain3": {
        if (
          this.coverageSequenceMatches(-table.backtrack.length, table.backtrack) &&
          this.coverageSequenceMatches(0, table.input) &&
          this.coverageSequenceMatches(table.input.length, table.lookahead)
        ) {
          return this.applyLookupList(table.lookups);
        }
        return false;
      }
    }
  }
}

/** LookupFlag u16 → iterator options (fontkit's LookupFlags struct layout). */
function flagOptions(flag: number): IteratorOptions {
  return {
    ignoreBaseGlyphs: (flag & 0x0002) !== 0,
    ignoreLigatures: (flag & 0x0004) !== 0,
    ignoreMarks: (flag & 0x0008) !== 0,
    markAttachmentType: (flag >> 8) & 0xff,
  };
}
