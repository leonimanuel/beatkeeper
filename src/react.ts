import { useEffect, useMemo, useRef, useState } from "react";
import {
  createNarrationClock,
  type Adapter,
  type ClockOptions,
  type ClockSource,
  type NarrationClock,
} from "./clock.js";
import type { Unit } from "./walk.js";

export type HookOptions<T = unknown> = Omit<ClockOptions<T>, "units" | "onAdvance"> & {
  onAdvance?: ClockOptions<T>["onAdvance"];
  /** Memoize this; a new adapter identity rebinds. */
  adapter?: Adapter<T>;
};

/**
 * Whether `next` is `prev` with more units on the end — the same narration,
 * grown — rather than a different one. Compared by element reference.
 */
export function extendsNarrative<T>(prev: Unit<T>[], next: Unit<T>[]): boolean {
  return next.length >= prev.length && prev.every((u, i) => next[i] === u);
}

/**
 * One clock for the component's lifetime. A `units` array that extends the
 * previous one is appended; any other array resets the clock. Options other
 * than `onAdvance` and `estimate` are read once, at creation.
 */
export function useNarrationClock<T = unknown>(
  units: Unit<T>[],
  options: HookOptions<T> = {},
): { index: number; source: ClockSource | "idle"; clock: NarrationClock<T> } {
  const optsRef = useRef(options);
  optsRef.current = options;
  const first = options.fireFirst ? 0 : 1;
  const [state, setState] = useState<{ index: number; source: ClockSource | "idle" }>({
    index: first - 1,
    source: "idle",
  });

  const clock = useMemo<NarrationClock<T>>(() => {
    const { adapter: _adapter, onAdvance: _onAdvance, estimate, ...rest } = optsRef.current;
    return createNarrationClock<T>({
      ...rest,
      units: [],
      estimate: estimate ? (u, p, i) => optsRef.current.estimate!(u, p, i) : undefined,
      onAdvance: (i, s) => {
        setState({ index: i, source: s });
        optsRef.current.onAdvance?.(i, s);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prevUnits = useRef<Unit<T>[]>([]);
  useEffect(() => {
    const prev = prevUnits.current;
    if (units === prev) return;
    if (extendsNarrative(prev, units)) {
      for (let i = prev.length; i < units.length; i++) clock.append(units[i]);
    } else {
      clock.reset(units);
      setState({ index: first - 1, source: "idle" });
    }
    prevUnits.current = units;
  }, [units, clock, first]);

  useEffect(() => options.adapter?.bind(clock), [options.adapter, clock]);
  useEffect(() => () => clock.stop(), [clock]);

  return { ...state, clock };
}
