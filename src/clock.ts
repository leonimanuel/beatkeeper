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
  /**
   * Begin the estimate clock, or resume it after `stop()`/`interrupt()` from
   * where it paused. Call when the bot starts speaking.
   */
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
  /** Barge-in. Pauses the estimate clock and holds the index. */
  interrupt(): void;
  /** Pause the estimate clock. Call when the bot stops speaking; `start()` resumes. */
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
 * voice's real pace differs, and the error accumulates. `stop()` pauses it
 * and the next `start()` resumes it where it was: a stop between two
 * utterances of one narration (pipecat's `botStoppedSpeaking`, LiveKit's
 * agent state) must not restart the schedule from the first unit.
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
  /** When the narration's spoken time began; shifted forward by every pause. */
  let startedAt: number | null = null;
  /** When `stop()`/`interrupt()` paused the estimate, until the next `start()`. */
  let pausedAt: number | null = null;
  /** Offset of each unit from `startedAt`, by the estimates of the units before it. */
  const offsets: number[] = [];
  /** Pending estimate timers, by unit index. */
  const estimateTimers = new Map<number, unknown>();

  const clearEstimates = () => {
    for (const id of estimateTimers.values()) timers.clearTimeout(id);
    estimateTimers.clear();
  };

  const offsetOf = (k: number): number => {
    while (offsets.length <= k) {
      const n = offsets.length;
      offsets.push(n === 0 ? 0 : offsets[n - 1] + o.estimate!(walk.unit(n - 1)!, walk.unit(n - 2), n - 1));
    }
    return offsets[k];
  };

  /** Monotonic: a resync never lowers the index. */
  const advance = (i: number, from: ClockSource) => {
    if (i <= index || i >= walk.length) return;
    index = i;
    source = from;
    o.onAdvance(i, from, walk.unit(i)!);
  };

  /** Arm a timer for every unit not yet reached and not yet armed. */
  const scheduleEstimates = () => {
    if (!o.estimate || !running || cued || startedAt === null) return;
    for (let k = Math.max(index + 1, first); k < walk.length; k++) {
      if (estimateTimers.has(k)) continue;
      const delay = Math.max(0, startedAt + offsetOf(k) - timers.now());
      const id = timers.setTimeout(() => {
        estimateTimers.delete(k);
        advance(k, "estimate");
      }, delay);
      estimateTimers.set(k, id);
    }
  };

  const pause = () => {
    clearEstimates();
    if (running) pausedAt = timers.now();
    running = false;
  };

  return {
    start() {
      if (running) return;
      running = true;
      const now = timers.now();
      if (startedAt === null) startedAt = now;
      else if (pausedAt !== null) startedAt += now - pausedAt;
      pausedAt = null;
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
      pause();
    },

    stop() {
      pause();
    },

    reset(units = []) {
      clearEstimates();
      walk = new SpokenWalk<T>(units, walkOpts);
      index = first - 1;
      source = "idle";
      running = false;
      cued = false;
      startedAt = null;
      pausedAt = null;
      offsets.length = 0;
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
