import { describe, expect, it } from "vitest";
import { compose, createNarrationClock, type ClockOptions } from "../src/clock.js";
import { fakeTimers } from "./timers.js";
import { withHints } from "../src/hints.js";

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

describe("spoken clock", () => {
  it("advances on the words and reports the unit", () => {
    const seen: string[] = [];
    const clock = createNarrationClock({
      units: U, timers: fakeTimers(),
      onAdvance: (_i, _s, u) => seen.push(u.prose),
    });
    clock.feed("Good morning On");
    expect(clock.index).toBe(1);
    expect(clock.source).toBe("spoken");
    expect(seen).toEqual(["On the 27th a strike hit Orlivka"]);
  });

  it("exposes remaining and progress for the current unit", () => {
    const { clock } = make();
    clock.feed("Good morning On the 27th");
    expect(clock.remaining).toBe(4);
    expect(clock.progress).toBeCloseTo(3 / 7);
  });
});

describe("estimate clock", () => {
  it("schedules each unit at the cumulative estimate of the units before it", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(999);
    expect(log).toEqual([]);
    timers.advance(1);
    expect(log).toEqual(["1:estimate"]);
    timers.advance(2000);
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

  it("does not start twice, and re-arms after stop()", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    clock.start();
    expect(timers.pending()).toBe(3);
    timers.advance(3000);
    clock.stop();
    clock.reset(U);
    clock.start();
    timers.advance(1000);
    expect(log.at(-1)).toBe("1:estimate");
  });

  it("fires unit 0 immediately when fireFirst is set", () => {
    const { clock, timers, log } = make({ estimate: perUnit, fireFirst: true });
    clock.start();
    timers.advance(0);
    expect(log).toEqual(["0:estimate"]);
  });

  it("resumes after stop() where it paused, not from the first unit", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(400);
    clock.stop(); // the bot fell silent 400ms into unit 0
    timers.advance(5000);
    expect(log).toEqual([]);
    clock.start(); // it speaks again: 600ms of unit 0 remain
    timers.advance(599);
    expect(log).toEqual([]);
    timers.advance(1);
    expect(log).toEqual(["1:estimate"]);
    timers.advance(1000);
    expect(log).toEqual(["1:estimate", "2:estimate"]);
  });

  it("a stop between utterances does not re-run the units already passed", () => {
    // Before: start() after stop() rescheduled every unit from zero, so the
    // second utterance waited the whole narration again before moving.
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(1000);
    expect(log).toEqual(["1:estimate"]);
    clock.stop();
    clock.start();
    timers.advance(1000);
    expect(log).toEqual(["1:estimate", "2:estimate"]);
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
  it("the first spoken hit cancels every pending estimate, for good", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(500);
    clock.feed("Good morning On");
    expect(log).toEqual(["1:spoken"]);
    expect(timers.pending()).toBe(0);
    clock.append({ prose: "A fifth line" });
    timers.advance(60_000);
    expect(log).toEqual(["1:spoken"]);
  });

  it("is monotonic: words for a unit the estimate already passed are ignored", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(2000);
    clock.feed("Good morning On the 27th");
    expect(log).toEqual(["1:estimate", "2:estimate"]);
    clock.feed("a strike hit Orlivka Kharkiv was hit the same night Casualty");
    expect(log).toEqual(["1:estimate", "2:estimate", "3:spoken"]);
  });
});

describe("sync", () => {
  it("re-anchors the walk and the index at once", () => {
    const { clock, log } = make();
    clock.sync(2);
    expect(log).toEqual(["2:sync"]);
    expect(clock.feed("Kharkiv was hit the same night Casualty"));
    expect(log).toEqual(["2:sync", "3:spoken"]);
  });

  it("ignores a sync at or behind the index, or past the end", () => {
    const { clock, log } = make();
    clock.feed("Good morning On the 27th a strike hit Orlivka Kharkiv");
    clock.sync(1);
    clock.sync(2);
    clock.sync(99);
    expect(log).toEqual(["1:spoken", "2:spoken"]);
  });

  it("cancels the estimate like a spoken hit would", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    clock.sync(2);
    timers.advance(60_000);
    expect(log).toEqual(["2:sync"]);
  });
});

describe("interrupt", () => {
  it("stops the clocks and holds the index", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(1000);
    clock.interrupt();
    timers.advance(60_000);
    expect(log).toEqual(["1:estimate"]);
    expect(clock.index).toBe(1);
    expect(clock.running).toBe(false);
  });

  it("can be started again", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    clock.interrupt();
    clock.start();
    timers.advance(1000);
    expect(log).toEqual(["1:estimate"]);
  });
});

describe("reset", () => {
  it("replaces the units and returns to rest", () => {
    const { clock, timers, log } = make({ estimate: perUnit });
    clock.start();
    timers.advance(1000);
    clock.reset([{ prose: "Fresh start" }, { prose: "Second line" }]);
    expect(clock.index).toBe(0);
    expect(clock.source).toBe("idle");
    expect(clock.running).toBe(false);
    timers.advance(60_000);
    expect(log).toEqual(["1:estimate"]);
    clock.feed("Fresh start Second");
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

describe("withHints", () => {
  const grace = { baseMs: 1000, perWordMs: 100 };

  it("applies a hint after base plus the remaining words, as a sync", () => {
    const { clock, timers, log } = make();
    const h = withHints(clock, { ...grace, timers });
    // Unit 0 has two words, none heard: wait 1000 + 2 * 100.
    h.hint(2);
    timers.advance(1199);
    expect(log).toEqual([]);
    timers.advance(1);
    expect(log).toEqual(["2:sync"]);
  });

  it("drops the hint when the words arrive first", () => {
    const { clock, timers, log } = make();
    const h = withHints(clock, { ...grace, timers });
    h.hint(1);
    h.feed("Good morning On");
    timers.advance(60_000);
    expect(log).toEqual(["1:spoken"]);
  });

  it("a later hint replaces an earlier one", () => {
    const { clock, timers, log } = make();
    const h = withHints(clock, { ...grace, timers });
    h.hint(1);
    h.hint(2);
    timers.advance(1200);
    expect(log).toEqual(["2:sync"]);
  });
});

describe("compose", () => {
  it("binds every adapter and unbinds them all", () => {
    const calls: string[] = [];
    const a = { bind: () => { calls.push("bind a"); return () => calls.push("unbind a"); } };
    const b = { bind: () => { calls.push("bind b"); return () => calls.push("unbind b"); } };
    const { clock } = make();
    compose(a, b).bind(clock)();
    expect(calls).toEqual(["bind a", "bind b", "unbind b", "unbind a"]);
  });
});
