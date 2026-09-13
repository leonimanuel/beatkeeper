import { SpokenWalk, stripUndefined, type Unit, type WalkOptions } from "./walk.js";

/** Which clock advanced the index. */
export type ClockSource = "spoken" | "estimate" | "sync";

/** Timer functions. Inject fakes for synchronous tests. */
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
 * them all. For a transport's word stream plus a server channel carrying
 * units.
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
  timers?: Timers;
};

export type NarrationClock<T = unknown> = {
  /** Begin the estimate clock. Call when the bot starts speaking. */
  start(): void;
  /** Spoken text, as it becomes audible. */
  feed(text: string): void;
  /** Add a unit to the end. Schedules its estimate if that clock is running. */
  append(unit: Unit<T>): void;
  /**
   * The caller asserts that unit `index` is the one being heard. Re-anchors
   * the walk there. Not a guess: for a source that knows.
   */
  sync(index: number): void;
  /** Barge-in. Stops the clocks and holds the index. */
  interrupt(): void;
  /** Stop both clocks. Call when the bot stops speaking. */
  stop(): void;
  /** Replace the units and return to the resting state. */
  reset(units?: Unit<T>[]): void;
  readonly index: number;
  readonly source: ClockSource | "idle";
  readonly running: boolean;
  /** Tokens of the current unit not yet heard. */
  readonly remaining: number;
  /** How far through the current unit the voice is, 0..1. */
  readonly progress: number;
  readonly length: number;
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
 * resume for the rest of the run. Text fed here is taken to be audible NOW:
 * whatever holds or schedules it to the listener's ear is the adapter's job.
 */
export function createNarrationClock<T = unknown>(o: ClockOptions<T>): NarrationClock<T> {
  const timers: Required<Timers> = { ...defaultTimers, ...stripUndefined(o.timers ?? {}) };
  const walkOpts: WalkOptions = {
    fireFirst: o.fireFirst,
    openWords: o.openWords,
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

  const clearEstimates = () => {
    for (const id of estimateTimers) timers.clearTimeout(id);
    estimateTimers.clear();
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
      if (hits.length === 0) return;
      if (!cued) {
        cued = true;
        clearEstimates();
      }
      for (const k of hits) advance(k, "spoken");
    },

    append(unit) {
      walk.append(unit);
      scheduleEstimates();
    },

    sync(i) {
      if (i <= index || i >= walk.length) return;
      if (!cued) {
        cued = true;
        clearEstimates();
      }
      walk.jump(i);
      advance(i, "sync");
    },

    interrupt() {
      clearEstimates();
      running = false;
    },

    stop() {
      clearEstimates();
      running = false;
    },

    reset(units = []) {
      clearEstimates();
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
    get remaining() {
      return walk.remaining;
    },
    get progress() {
      return walk.progress;
    },
    get length() {
      return walk.length;
    },
  };
}
