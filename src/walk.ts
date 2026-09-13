import { tokenize } from "./text.js";

/** Anything with prose. Other fields are carried, never read. */
export type Unit<T = unknown> = { prose: string } & T;

export type WalkOptions = {
  /**
   * Report unit 0 when its first word is heard. Leave off when unit 0 is
   * already on screen before speech starts; set for captions, where nothing
   * is shown until the first word.
   */
  fireFirst?: boolean;
  /**
   * Consecutive matching words required before the walk opens. Set above 1
   * when speech that is not in the script shares the stream before unit 0
   * and may contain its words — a status line, an acknowledgement.
   */
  openWords?: number;
  /**
   * Applied to every token, script and spoken alike, after `tokenize`. For
   * number words, stemming, or a language whose inflections defeat the
   * prefix rule. Identity by default.
   */
  normalize?: (token: string) => string;
};

const DEFAULTS: Required<WalkOptions> = {
  fireFirst: false,
  openWords: 1,
  normalize: (t) => t,
};

/**
 * How the cursor may move to the NEXT unit on a word that does not match at
 * the cursor. These are not tuning knobs: they encode what counts as
 * evidence that a unit has ended.
 *
 * Within the current unit a single word may re-anchor the cursor anywhere
 * ahead — the voice skipped or merged something, and the unit is the same
 * either way. Crossing into the next unit changes what is on screen, so it
 * takes more: the cursor already within CROSS_SLACK tokens of the end (the
 * unit was nearly done), or CROSS_WORDS consecutive words that match the
 * next unit in order (one stray "the" cannot do it; "the EU" can).
 *
 * If the voice says OVERSHOOT words we cannot place at all once the cursor
 * is at the end of a unit, the next unit has started however it was read.
 */
const CROSS_SLACK = 2;
const CROSS_WORDS = 2;
const OVERSHOOT = 3;

export function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in o) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/**
 * Walks a TTS's spoken-word stream against the tokenized prose of an ordered
 * list of units, reporting each unit's index once its first word has been
 * heard. Pure and synchronous: no timers, no audio.
 */
export class SpokenWalk<T = unknown> {
  private readonly expected: string[] = [];
  /** Index into `expected` where each unit's tokens begin. */
  private readonly unitStart: number[] = [];
  private readonly units: Unit<T>[] = [];
  private readonly opts: Required<WalkOptions>;
  /** The next expected token. */
  private cursor = 0;
  /** Highest unit index reported. */
  private reachedIndex: number;
  /** Spoken tokens since the last match that matched nothing. */
  private unplaced = 0;
  /** A match seen in the next unit, awaiting a second word to confirm it. */
  private crossing: number | null = null;
  private isOpen: boolean;
  /** Tentative run length while not yet open. */
  private tentative = 0;

  constructor(units: Unit<T>[] = [], options: WalkOptions = {}) {
    this.opts = { ...DEFAULTS, ...stripUndefined(options) };
    this.reachedIndex = this.opts.fireFirst ? -1 : 0;
    this.isOpen = this.opts.openWords <= 1;
    for (const u of units) this.append(u);
  }

  /** `tokenize`, then the caller's normaliser. */
  tokens(text: string): string[] {
    return tokenize(text).map(this.opts.normalize);
  }

  /** Add a unit to the end. The sequence is trusted as given, repeats included. */
  append(unit: Unit<T>): void {
    this.units.push(unit);
    this.unitStart.push(this.expected.length);
    this.expected.push(...this.tokens(unit.prose));
  }

  /** Highest index reached. -1 before the first hit when `fireFirst` is set. */
  get reached(): number {
    return this.reachedIndex;
  }

  get length(): number {
    return this.units.length;
  }

  unit(i: number): Unit<T> | undefined {
    return this.units[i];
  }

  /** Whether the opening gate has passed. Always true when `openWords` <= 1. */
  get opened(): boolean {
    return this.isOpen;
  }

  /** Tokens of the current unit not yet heard. 0 before any unit is reached. */
  get remaining(): number {
    if (this.reachedIndex < 0) return 0;
    return Math.max(0, this.endOf(this.reachedIndex) - this.cursor);
  }

  /** How far through the current unit the voice is, 0..1 by token count. */
  get progress(): number {
    if (this.reachedIndex < 0) return 0;
    const start = this.unitStart[this.reachedIndex];
    const total = this.endOf(this.reachedIndex) - start;
    if (total <= 0) return 1;
    return Math.min(1, Math.max(0, this.cursor - start) / total);
  }

  /**
   * Move the cursor to the start of unit `i` and mark everything up to it
   * reached. Returns the indices newly reached. For a caller that knows.
   */
  jump(i: number): number[] {
    const out: number[] = [];
    if (i >= this.units.length || i <= this.reachedIndex) return out;
    this.cursor = this.unitStart[i];
    this.unplaced = 0;
    this.crossing = null;
    this.isOpen = true;
    while (this.reachedIndex < i) {
      this.reachedIndex += 1;
      out.push(this.reachedIndex);
    }
    return out;
  }

  /**
   * Feed spoken text: a word, several, or a sentence. Returns the indices of
   * any units whose first word has now gone by, in order. Each index is
   * returned once; the sequence is monotonic.
   */
  feed(text: string): number[] {
    const out: number[] = [];
    for (const tok of this.tokens(text)) {
      if (this.isOpen) this.advance(tok);
      else if (!this.opening(tok)) continue;
      while (
        this.reachedIndex + 1 < this.units.length &&
        this.cursor > this.unitStart[this.reachedIndex + 1]
      ) {
        this.reachedIndex += 1;
        out.push(this.reachedIndex);
      }
    }
    return out;
  }

  /** One past the last token of unit `i`. */
  private endOf(i: number): number {
    return this.unitStart[i + 1] ?? this.expected.length;
  }

  /**
   * Before the walk is open, matches are tentative and must run `openWords`
   * in a row from the cursor. A miss resets the run (re-arming if the miss is
   * itself the first word). The cursor does not move until the gate passes.
   */
  private opening(tok: string): boolean {
    const base = this.cursor;
    const end = this.endOf(Math.max(this.reachedIndex, 0));
    if (this.expected[base + this.tentative] === tok) {
      this.tentative += 1;
      if (this.tentative >= this.opts.openWords || base + this.tentative >= end) {
        this.cursor = base + this.tentative;
        this.tentative = 0;
        this.isOpen = true;
        return true;
      }
      return false;
    }
    this.tentative = this.expected[base] === tok ? 1 : 0;
    return false;
  }

  private matches(expected: string, heard: string): boolean {
    // A partial token ("onepointseven" arriving as "one") matches by prefix,
    // but only a substantial one: "you" must not claim "youre".
    return (
      expected === heard ||
      (heard.length >= 4 && expected.length <= heard.length + 4 && expected.startsWith(heard))
    );
  }

  private advance(tok: string): void {
    // A crossing awaiting confirmation: the next word in the next unit.
    if (this.crossing !== null) {
      if (this.expected[this.crossing] === tok) {
        this.cursor = this.crossing + 1;
        this.crossing = null;
        this.unplaced = 0;
        return;
      }
      this.crossing = null;
    }

    if (this.expected[this.cursor] === tok) {
      this.cursor += 1;
      this.unplaced = 0;
      return;
    }

    const current = Math.max(this.reachedIndex, 0);
    const end = this.endOf(current);
    const nextEnd = this.endOf(current + 1);

    // Within the current unit: the voice skipped or merged something.
    for (let i = this.cursor; i < end; i++) {
      if (this.matches(this.expected[i], tok)) {
        this.cursor = i + 1;
        this.unplaced = 0;
        return;
      }
    }

    // In the next unit: evidence the current one is over. Believed outright
    // when the current unit was nearly done; otherwise held for a second
    // word in a row.
    const nearEnd = end - this.cursor <= CROSS_SLACK;
    for (let i = end; i < nextEnd; i++) {
      if (!this.matches(this.expected[i], tok)) continue;
      if (nearEnd || CROSS_WORDS <= 1) {
        this.cursor = i + 1;
        this.unplaced = 0;
      } else {
        this.crossing = i + 1;
      }
      return;
    }

    // Nothing we can place. Hold — but count. Enough of these past the end
    // of the current unit means the next one has started however it was
    // read out.
    this.unplaced += 1;
    if (end < this.expected.length && this.cursor + this.unplaced >= end + OVERSHOOT) {
      this.cursor = end + 1;
      this.unplaced = 0;
    }
  }
}
