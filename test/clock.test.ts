import { describe, expect, it } from "vitest";
import { createNarrationClock, type ClockOptions, type Timers } from "../src/clock.js";

/** A deterministic timer queue, so every test is synchronous. */
function fakeTimers() {
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

const U = [
  { prose: "Good morning" },
  { prose: "On the 27th a strike hit Orlivka" },
  { prose: "Kharkiv was hit the same night" },
  { prose: "Casualty figures remain unconfirmed" },
];

function make(overrides: Partial<ClockOptions> = {}) {
  const timers = fakeTimers();
  const log: string[] = [];
  const clock = createNarrationClock({
    units: U,
    timers,
    onAdvance: (i, s) => log.push(`${i}:${s}`),
    ...overrides,
  });
  return { clock, timers, log };
}

const perUnit = () => 1000;

describe("estimate clock", () => {
  it("schedules each unit at the cumulative estimate of the units before it", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(999);
    expect(log).toEqual([]);
    timers.advance(1);
    expect(log).toEqual(["1:estimate"]);
    timers.advance(1000);
    expect(log).toEqual(["1:estimate", "2:estimate"]);
    timers.advance(1000);
    expect(log).toEqual(["1:estimate", "2:estimate", "3:estimate"]);
    expect(timers.pending()).toBe(0);
  });

  it("does not run without an estimate", () => {
    const { clock, timers, log } = make();
    clock.start();
    timers.advance(60_000);
    expect(log).toEqual([]);
    expect(clock.running).toBe(true);
  });

  it("does not start twice", () => {
    const { clock, timers } = make({ estimate: perUnit });
    clock.start();
    clock.start();
    expect(timers.pending()).toBe(3);
  });

  it("fires unit 0 immediately when fireFirst is set", () => {
    const { clock, timers, log } = make({ estimate: perUnit, fireFirst: true });
    clock.start();
    timers.advance(0);
    expect(log).toEqual(["0:estimate"]);
  });

  it("schedules a unit appended while running", () => {
    const { clock, timers, log } = make({ units: [U[0]], estimate: perUnit });
    clock.start();
    timers.advance(500);
    clock.append(U[1]);
    timers.advance(500);
    expect(log).toEqual(["1:estimate"]);
  });
});

describe("handover", () => {
  it("the first spoken hit cancels every pending estimate", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(500);
    expect(clock.feed("Good morning On")).toEqual([1]);
    expect(log).toEqual(["1:spoken"]);
    expect(timers.pending()).toBe(0);
    timers.advance(60_000);
    expect(log).toEqual(["1:spoken"]);
    expect(clock.source).toBe("spoken");
  });

  it("does not resume the estimate for units appended after the handover", () => {
    const { clock, timers, log } = make({ units: U.slice(0, 2), estimate: perUnit });
    clock.start();
    clock.feed("Good morning On");
    clock.append(U[2]);
    timers.advance(60_000);
    expect(log).toEqual(["1:spoken"]);
  });

  it("is monotonic: words for a unit the estimate already passed are ignored", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(2000);
    expect(log).toEqual(["1:estimate", "2:estimate"]);
    clock.feed("Good morning On the 27th");
    expect(log).toEqual(["1:estimate", "2:estimate"]);
    clock.feed("a strike hit Orlivka Kharkiv was hit the same night Casualty");
    expect(log).toEqual(["1:estimate", "2:estimate", "3:spoken"]);
    expect(clock.index).toBe(3);
  });
});

describe("leadMs", () => {
  it("delays a spoken cue by leadMs", () => {
    const { clock, timers, log } = make({ leadMs: 200 });
    clock.feed("Good morning On");
    expect(log).toEqual([]);
    timers.advance(199);
    expect(log).toEqual([]);
    timers.advance(1);
    expect(log).toEqual(["1:spoken"]);
  });
});

describe("hint", () => {
  const grace = { baseMs: 1000, perWordMs: 100 };

  it("is applied after base plus the remaining words of the current unit", () => {
    const { clock, timers, log } = make({ grace });
    // Unit 0 has two words, none heard: wait 1000 + 2 * 100.
    clock.hint(2);
    timers.advance(1199);
    expect(log).toEqual([]);
    timers.advance(1);
    expect(log).toEqual(["2:hint"]);
    expect(clock.index).toBe(2);
    expect(clock.walk.reached).toBe(2);
  });

  it("is discarded when the words arrive first", () => {
    const { clock, timers, log } = make({ grace });
    clock.hint(1);
    clock.feed("Good morning On");
    expect(log).toEqual(["1:spoken"]);
    timers.advance(60_000);
    expect(log).toEqual(["1:spoken"]);
    expect(timers.pending()).toBe(0);
  });

  it("ignores a hint at or behind the current index", () => {
    const { clock, timers, log } = make({ grace });
    clock.feed("Good morning On the 27th a strike hit Orlivka Kharkiv");
    clock.hint(1);
    clock.hint(2);
    timers.advance(60_000);
    expect(log).toEqual(["1:spoken", "2:spoken"]);
  });

  it("a later hint replaces an earlier one", () => {
    const { clock, timers, log } = make({ grace });
    clock.hint(1);
    clock.hint(2);
    timers.advance(1200);
    expect(log).toEqual(["2:hint"]);
  });

  it("the walk resumes from the hinted unit", () => {
    const { clock, timers, log } = make({ grace });
    clock.hint(2);
    timers.advance(1200);
    expect(clock.feed("Kharkiv was hit the same night Casualty")).toEqual([3]);
    expect(log).toEqual(["2:hint", "3:spoken"]);
  });
});

describe("interrupt", () => {
  it("hold: stops the clocks and keeps the index", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(1000);
    clock.interrupt();
    timers.advance(60_000);
    expect(log).toEqual(["1:estimate"]);
    expect(clock.index).toBe(1);
    expect(clock.running).toBe(false);
  });

  it("reset: returns to unit 0 and says so", () => {
    const { clock, log } = make({ onInterrupt: "reset" });
    clock.feed("Good morning On the 27th a strike hit Orlivka Kharkiv");
    clock.interrupt();
    expect(log).toEqual(["1:spoken", "2:spoken", "0:interrupt"]);
    expect(clock.index).toBe(0);
  });

  it("reset with fireFirst: nothing to show, nothing reported", () => {
    const { clock, log } = make({ onInterrupt: "reset", fireFirst: true });
    clock.feed("Good morning On");
    clock.interrupt();
    expect(log).toEqual(["0:spoken", "1:spoken"]);
    expect(clock.index).toBe(-1);
  });

  it("callback: receives the current index", () => {
    let seen = -1;
    const { clock } = make({ onInterrupt: (i) => (seen = i) });
    clock.feed("Good morning On");
    clock.interrupt();
    expect(seen).toBe(1);
  });

  it("a stopped clock can be started again", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    clock.interrupt();
    clock.start();
    timers.advance(1000);
    expect(log).toEqual(["1:estimate"]);
  });
});

describe("reset", () => {
  it("replaces the units and returns to the resting state, keeping the estimate off until start", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(1000);
    clock.reset([{ prose: "Fresh start" }, { prose: "Second line" }]);
    expect(clock.index).toBe(0);
    expect(clock.source).toBe("idle");
    expect(clock.running).toBe(false);
    timers.advance(60_000);
    expect(log).toEqual(["1:estimate"]);
    expect(clock.feed("Fresh start Second")).toEqual([1]);
    expect(log).toEqual(["1:estimate", "1:spoken"]);
  });
});

describe("walk options pass through", () => {
  it("openWords and fireFirst reach the walk", () => {
    const { clock, log } = make({
      units: [{ prose: "Kharkiv was hit" }, { prose: "Three died" }],
      fireFirst: true,
      openWords: 2,
    });
    clock.feed("Looking at Kharkiv now");
    expect(log).toEqual([]);
    clock.feed("Kharkiv was");
    expect(log).toEqual(["0:spoken"]);
  });
});
