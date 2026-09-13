import type { Timers } from "../src/clock.js";

/** A deterministic timer queue, so every test is synchronous. */
export function fakeTimers() {
  let t = 0;
  let seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  const timers: Required<Timers> & { advance(ms: number): void; pending(): number } = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      q.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      q.delete(id as number);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...q.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        t = due[1].at;
        q.delete(due[0]);
        due[1].fn();
      }
      t = end;
    },
    pending: () => q.size,
  };
  return timers;
}
