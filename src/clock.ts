import { SpokenWalk, stripUndefined, type Unit, type WalkOptions } from "./walk.js";

/** Which clock advanced the index. */
export type ClockSource = "spoken" | "estimate" | "hint" | "interrupt";

export type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  now?: () => number;
};

/** Binds one voice stack's events to a clock. Returns an unbind function. */
export type Adapter<T = unknown> = {
  bind(clock: NarrationClock<T>): () => void;
};

/**
 * One adapter from several: each is bound in order, and unbinding unbinds
 * them all. For the common pair — a transport's word stream plus a server
 * channel carrying units and hints.
 */
export function compose<T = unknown>(...adapters: Adapter<T>[]): Adapter<T> {
  return {
    bind(clock) {
      const unbinds = adapters.map((a) => a.bind(clock));
      return () => {
        for (const u of unbinds.reverse()) u();
      };
    },
  };
}

export type ClockOptions<T = unknown> = WalkOptions & {
  units?: Unit<T>[];
  /**
   * Expected spoken duration of a unit in ms. Drives the fallback timer
   * clock; ignored once spoken text arrives. Omit to run without a fallback.
   */
  estimate?: (unit: Unit<T>, prev: Unit<T> | undefined, index: number) => number;
  /** Called when the index advances. Increasing; indices may be skipped. */
  onAdvance: (index: number, source: ClockSource, unit: Unit<T>) => void;
  /**
   * Behaviour on `interrupt()`. "hold" keeps the current index. "reset"
   * returns to the resting index. A function receives the current index.
   */
  onInterrupt?: "hold" | "reset" | ((index: number) => void);
  /**
   * Delay applied to spoken cues before they take effect. Default 0. A
   * function is read per cue, for a delay that changes during the run — the
   * audio the client still holds unplayed, say.
   */
  leadMs?: number | (() => number);
  /** Grace period for `hint()`: base plus per-remaining-word of the current unit. */
  grace?: { baseMs?: number; perWordMs?: number };
  timers?: Timers;
};

export type NarrationClock<T = unknown> = {
  /** Begin the estimate clock. Call when the bot starts speaking. */
  start(): void;
  /** Spoken text in. Returns indices newly reached. */
  feed(text: string): number[];
  /** Add a unit to the end. Schedules its estimate if that clock is running. */
  append(unit: Unit<T>): void;
  /**
   * An external source believes unit `index` has started (e.g. the server
   * began synthesising it). Trusted only after the spoken clock has had a
   * grace period to see the words itself.
   */
  hint(index: number): void;
  /** Stop both clocks and apply `onInterrupt`. */
  interrupt(): void;
  /** Stop both clocks. */
  stop(): void;
  /** Replace the units and return to the resting state. */
  reset(units?: Unit<T>[]): void;
  readonly index: number;
  readonly source: ClockSource | "idle";
  readonly running: boolean;
  readonly walk: SpokenWalk<T>;
};

const defaultTimers: Required<Timers> = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Two clocks advance the index; only one is active at a time.
 *
 * The ESTIMATE starts on `start()` and schedules each unit at the cumulative
 * `estimate()` of the units before it. It is wrong by however much the
 * voice's real pace differs, and the error accumulates.
 *
 * The SPOKEN clock is the word stream through `feed()`. On the first unit it
 * reaches, every pending estimate timer is cancelled and the estimate does not
 * resume for the rest of the run. Cues are applied on arrival: pipelines that
 * forward TTS alignment already hold each word event until that word's own
 * timestamp on the output clock, so delaying by the client-side audio buffer
 * makes the visual trail the audio by exactly that buffer. `leadMs` exists
 * for pipelines that behave otherwise; measure before setting it.
 */
export function createNarrationClock<T = unknown>(o: ClockOptions<T>): NarrationClock<T> {
  const timers: Required<Timers> = { ...defaultTimers, ...stripUndefined(o.timers ?? {}) };
  const rawLead = o.leadMs;
  const fixedLead = typeof rawLead === "number" ? rawLead : 0;
  const leadMs: () => number = typeof rawLead === "function" ? rawLead : () => fixedLead;
  const grace = { baseMs: 1500, perWordMs: 420, ...stripUndefined(o.grace ?? {}) };
  const walkOpts: WalkOptions = {
    fireFirst: o.fireFirst,
    lookahead: o.lookahead,
    overshoot: o.overshoot,
    openWords: o.openWords,
    endSlack: o.endSlack,
    normalize: o.normalize,
  };
  /** The first index the clock will ever report. */
  const first = o.fireFirst ? 0 : 1;

  let walk = new SpokenWalk<T>(o.units ?? [], walkOpts);
  let index = first - 1;
  let source: ClockSource | "idle" = "idle";
  let running = false;
  let cued = false;
  let startedAt = 0;
  let cumulative = 0;
  let scheduledThrough = -1;
  const estimateTimers = new Set<unknown>();
  const leadTimers = new Set<unknown>();
  let graceTimer: unknown = null;

  const clearSet = (s: Set<unknown>) => {
    for (const id of s) timers.clearTimeout(id);
    s.clear();
  };
  const clearGrace = () => {
    if (graceTimer !== null) {
      timers.clearTimeout(graceTimer);
      graceTimer = null;
    }
  };
  const clearAll = () => {
    clearSet(estimateTimers);
    clearSet(leadTimers);
    clearGrace();
  };

  /** Monotonic: a resync never lowers the index. */
  const advance = (i: number, from: ClockSource) => {
    if (i <= index || i >= walk.length) return;
    index = i;
    source = from;
    o.onAdvance(i, from, walk.unit(i)!);
  };

  const scheduleEstimates = () => {
    if (!o.estimate || !running || cued) return;
    for (let k = scheduledThrough + 1; k < walk.length; k++) {
      if (k > 0) cumulative += o.estimate(walk.unit(k - 1)!, walk.unit(k - 2), k - 1);
      scheduledThrough = k;
      if (k < first) continue;
      const delay = Math.max(0, startedAt + cumulative - timers.now());
      const id = timers.setTimeout(() => {
        estimateTimers.delete(id);
        advance(k, "estimate");
      }, delay);
      estimateTimers.add(id);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      startedAt = timers.now();
      cumulative = 0;
      scheduledThrough = -1;
      scheduleEstimates();
    },

    feed(text) {
      const hits = walk.feed(text);
      if (hits.length === 0) return hits;
      if (!cued) {
        cued = true;
        clearSet(estimateTimers);
      }
      clearGrace();
      for (const k of hits) {
        const lead = leadMs();
        if (lead > 0) {
          const id = timers.setTimeout(() => {
            leadTimers.delete(id);
            advance(k, "spoken");
          }, lead);
          leadTimers.add(id);
        } else {
          advance(k, "spoken");
        }
      }
      return hits;
    },

    append(unit) {
      const before = walk.length;
      walk.append(unit);
      if (walk.length > before) scheduleEstimates();
    },

    hint(i) {
      if (i <= index || i >= walk.length) return;
      clearGrace();
      const wait = grace.baseMs + walk.remaining * grace.perWordMs;
      graceTimer = timers.setTimeout(() => {
        graceTimer = null;
        if (i <= index) return;
        walk.jump(i);
        advance(i, "hint");
      }, wait);
    },

    interrupt() {
      clearAll();
      running = false;
      const policy = o.onInterrupt ?? "hold";
      if (policy === "hold") return;
      if (policy === "reset") {
        index = first - 1;
        source = "interrupt";
        // When unit 0 is the resting state, say so; when nothing is shown
        // before the first word, there is nothing to show.
        if (first === 1 && walk.length > 0) o.onAdvance(0, "interrupt", walk.unit(0)!);
        return;
      }
      policy(index);
    },

    stop() {
      clearAll();
      running = false;
    },

    reset(units = []) {
      clearAll();
      walk = new SpokenWalk<T>(units, walkOpts);
      index = first - 1;
      source = "idle";
      running = false;
      cued = false;
      cumulative = 0;
      scheduledThrough = -1;
    },

    get index() {
      return index;
    },
    get source() {
      return source;
    },
    get running() {
      return running;
    },
    get walk() {
      return walk;
    },
  };
}
