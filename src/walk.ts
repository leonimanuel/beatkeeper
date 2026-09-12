import { tokenize } from "./text.js";

/** Anything with prose. Extra fields are carried, never read. */
export type Unit<T = unknown> = { prose: string } & T;

export type WalkOptions = {
  /**
   * Report unit 0 when its first word is heard. Leave off when unit 0 is
   * already on screen before speech starts; set for captions, where nothing
   * is shown until the first word.
   */
  fireFirst?: boolean;
  /** How far ahead to search for a token that does not match at the cursor. */
  lookahead?: number;
  /**
   * Unmatched words past the end of the current unit before the next one is
   * assumed to have started regardless. 0 disables.
   */
  overshoot?: number;
  /**
   * Consecutive matching words required before the walk opens. Set above 1
   * when speech that is not in the script shares the stream before unit 0
   * and may contain its words.
   */
  openWords?: number;
  /**
   * How close to the end of the current unit the cursor must be before a
   * lookahead match is allowed to land in the NEXT unit. Default unbounded,
   * so a match anywhere within `lookahead` counts. Set to 2 or 3 when units
   * begin with common words ("The", "And", "On"): a stray one spoken early
   * would otherwise jump the walk a unit ahead.
   */
  endSlack?: number;
  /**
   * Applied to every token, script and spoken alike, after `tokenize`. For
   * stemming, number words, or a language whose inflections defeat the
   * prefix rule. Identity by default.
   */
  normalize?: (token: string) => string;
};

const DEFAULTS: Required<WalkOptions> = {
  fireFirst: false,
  lookahead: 8,
  overshoot: 3,
  openWords: 1,
  endSlack: Infinity,
  normalize: (t) => t,
};

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
  private readonly seq: string[] = [];
  /** Index into `seq` where each unit's tokens begin. */
  private readonly starts: number[] = [];
  private readonly units: Unit<T>[] = [];
  private readonly opts: Required<WalkOptions>;
  private pos = 0;
  private fired: number;
  /** Unmatched tokens since the last match; counts toward overshoot. */
  private slack = 0;
  private open: boolean;
  /** Tentative run length while not yet open. */
  private tent = 0;

  /**
   * Units given here are the script and are taken as they are, repeats
   * included — a narration may say the same short sentence twice and mean
   * it twice. Only `append` de-duplicates.
   */
  constructor(units: Unit<T>[] = [], options: WalkOptions = {}) {
    this.opts = { ...DEFAULTS, ...stripUndefined(options) };
    this.fired = this.opts.fireFirst ? -1 : 0;
    this.open = this.opts.openWords <= 1;
    for (const u of units) this.push(u);
  }

  /** `tokenize`, then the caller's normaliser. */
  tokens(text: string): string[] {
    return tokenize(text).map(this.opts.normalize);
  }

  /**
   * Add a unit to the end. A unit whose prose is already present is dropped:
   * a streamed sentence can reach the client twice (once as the model's text,
   * once as the TTS's), and a copy would strand the walk on tokens the voice
   * never produces.
   */
  append(unit: Unit<T>): void {
    if (this.units.some((u) => u.prose === unit.prose)) return;
    this.push(unit);
  }

  private push(unit: Unit<T>): void {
    this.units.push(unit);
    this.starts.push(this.seq.length);
    this.seq.push(...this.tokens(unit.prose));
  }

  /** Highest index reached. -1 before the first hit when `fireFirst` is set. */
  get reached(): number {
    return this.fired;
  }

  get length(): number {
    return this.units.length;
  }

  unit(i: number): Unit<T> | undefined {
    return this.units[i];
  }

  /** Whether the opening gate has passed. Always true when `openWords` <= 1. */
  get opened(): boolean {
    return this.open;
  }

  /** Tokens of the current unit not yet heard. 0 before any unit is reached. */
  get remaining(): number {
    if (this.fired < 0) return 0;
    const end = this.starts[this.fired + 1] ?? this.seq.length;
    return Math.max(0, end - this.pos);
  }

  /**
   * How far through the current unit the voice is, 0..1 by token count. 0
   * before any unit is reached; 1 for an empty unit.
   */
  get progress(): number {
    if (this.fired < 0) return 0;
    const start = this.starts[this.fired];
    const end = this.starts[this.fired + 1] ?? this.seq.length;
    const total = end - start;
    if (total <= 0) return 1;
    return Math.min(1, Math.max(0, this.pos - start) / total);
  }

  /**
   * Move the cursor to the start of unit `i` and mark everything up to it
   * reached. Returns the indices newly fired. Used by external hints.
   */
  jump(i: number): number[] {
    const out: number[] = [];
    if (i >= this.units.length || i <= this.fired) return out;
    this.pos = this.starts[i];
    this.slack = 0;
    this.open = true;
    while (this.fired < i) {
      this.fired += 1;
      out.push(this.fired);
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
      if (this.open) this.advance(tok);
      else if (!this.opening(tok)) continue;
      while (
        this.fired + 1 < this.units.length &&
        this.pos > this.starts[this.fired + 1]
      ) {
        this.fired += 1;
        out.push(this.fired);
      }
    }
    return out;
  }

  /**
   * Before the walk is open, matches are tentative and must run `openWords`
   * in a row from the cursor. A miss resets the run (re-arming if the miss is
   * itself the first word). The cursor does not move until the gate passes.
   */
  private opening(tok: string): boolean {
    const base = this.pos;
    const unitAt = Math.max(this.fired, 0);
    const end = this.starts[unitAt + 1] ?? this.seq.length;
    if (this.seq[base + this.tent] === tok) {
      this.tent += 1;
      if (this.tent >= this.opts.openWords || base + this.tent >= end) {
        this.pos = base + this.tent;
        this.tent = 0;
        this.open = true;
        return true;
      }
      return false;
    }
    this.tent = this.seq[base] === tok ? 1 : 0;
    return false;
  }

  private advance(tok: string): void {
    const { lookahead, overshoot, endSlack } = this.opts;
    if (this.seq[this.pos] === tok) {
      this.pos += 1;
      this.slack = 0;
      return;
    }
    // Look a little further on: the TTS skipped or merged something. A
    // partial token ("onepointseven" arriving as "one") matches by prefix,
    // but only a substantial one: "you" must not claim "youre", or a stray
    // short word jumps the walk into the wrong sentence.
    //
    // A match that lies in the NEXT unit is a claim that this unit is over.
    // With `endSlack` set, that claim is only believed near the end of it.
    const end = this.starts[Math.max(this.fired, 0) + 1] ?? this.seq.length;
    const nearEnd = end - this.pos <= endSlack;
    const limit = Math.min(this.seq.length, this.pos + lookahead);
    for (let i = this.pos; i < limit; i++) {
      if (i >= end && !nearEnd) break;
      const want = this.seq[i];
      if (
        want === tok ||
        (tok.length >= 4 && want.length <= tok.length + 4 && want.startsWith(tok))
      ) {
        this.pos = i + 1;
        this.slack = 0;
        return;
      }
    }
    // Nothing nearby: hold position rather than guess. But count it: enough
    // unmatched words past the end of the current unit means the next one has
    // started however it was read out.
    this.slack += 1;
    if (overshoot <= 0) return;
    const nextStart = this.starts[this.fired + 1];
    if (nextStart !== undefined && this.pos + this.slack >= nextStart + overshoot) {
      this.pos = nextStart + 1;
      this.slack = 0;
    }
  }
}
