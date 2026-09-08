import { describe, expect, it } from "vitest";
import { SpokenWalk } from "../src/walk.js";
import { clauses, tokenize } from "../src/text.js";

const beats = [
  { prose: "Good morning." },
  { prose: "On the 27th, a strike hit the Orlivka border crossing." },
  { prose: "Kharkiv was hit the same night." },
  { prose: "Casualty figures for both remain unconfirmed." },
];

/** Feed one word at a time, as a TTS would, collecting every hit. */
function speak(walk: SpokenWalk, text: string): number[] {
  return text.split(/\s+/).flatMap((w) => walk.feed(w));
}

describe("tokenize", () => {
  it("lowercases and strips to letters and digits", () => {
    expect(tokenize("Kharkiv, was hit.")).toEqual(["kharkiv", "was", "hit"]);
  });
  it("keeps a number or a hyphenated word as one token", () => {
    expect(tokenize("$1.7B")).toEqual(["17b"]);
    expect(tokenize("one-point-seven")).toEqual(["onepointseven"]);
  });
  it("handles non-Latin scripts", () => {
    expect(tokenize("Харків, вночі")).toEqual(["харків", "вночі"]);
  });
  it("drops standalone punctuation", () => {
    expect(tokenize("— ... ,")).toEqual([]);
  });
});

describe("clauses", () => {
  it("splits at sentence ends, dashes, semicolons and ', so'", () => {
    expect(clauses("We won, so we left. Then we slept — briefly; not long.")).toEqual([
      "We won",
      "so we left.",
      "Then we slept",
      "briefly",
      "not long.",
    ]);
  });
});

describe("SpokenWalk", () => {
  it("fires each unit once, in order, on its first word", () => {
    const w = new SpokenWalk(beats);
    expect(speak(w, "Good morning.")).toEqual([]);
    expect(speak(w, "On")).toEqual([1]);
    expect(speak(w, "the 27th, a strike hit the Orlivka border crossing.")).toEqual([]);
    expect(speak(w, "Kharkiv was hit the same night.")).toEqual([2]);
    expect(speak(w, "Casualty")).toEqual([3]);
    expect(w.reached).toBe(3);
  });

  it("does not report unit 0 unless fireFirst is set", () => {
    expect(new SpokenWalk(beats).feed("Good")).toEqual([]);
    expect(new SpokenWalk(beats, { fireFirst: true }).feed("Good")).toEqual([0]);
  });

  it("accepts a whole sentence in one feed", () => {
    const w = new SpokenWalk(beats);
    expect(w.feed("Good morning. On the 27th, a strike hit the Orlivka border crossing. Kharkiv")).toEqual([1, 2]);
  });

  it("looks ahead past a number the TTS read out differently", () => {
    const w = new SpokenWalk(beats);
    speak(w, "Good morning.");
    expect(speak(w, "On the twenty seventh a strike hit")).toEqual([1]);
    // The walk resynced on "a strike hit"; the next unit fires on its first word.
    expect(speak(w, "the Orlivka border crossing. Kharkiv")).toEqual([2]);
  });

  it("matches a substantial prefix", () => {
    const w = new SpokenWalk([{ prose: "and then" }, { prose: "Kharkiv fell" }]);
    expect(speak(w, "and then khark")).toEqual([1]);
  });

  it("refuses a short prefix: 'you' must not claim 'youre'", () => {
    const w = new SpokenWalk([{ prose: "and then" }, { prose: "youre late" }]);
    speak(w, "and then");
    expect(speak(w, "you")).toEqual([]);
    expect(w.reached).toBe(0);
    expect(speak(w, "youre")).toEqual([1]);
  });

  it("holds position on a word that matches nothing nearby", () => {
    const w = new SpokenWalk([{ prose: "one two three four five six" }, { prose: "seven eight" }]);
    speak(w, "one two");
    expect(w.remaining).toBe(4);
    speak(w, "um");
    expect(w.remaining).toBe(4);
    speak(w, "three");
    expect(w.remaining).toBe(3);
    expect(w.reached).toBe(0);
  });

  it("assumes the next unit after `overshoot` unmatched words past the end", () => {
    const w = new SpokenWalk([{ prose: "a b c" }, { prose: "x y z" }]);
    speak(w, "a b c");
    expect(speak(w, "q q")).toEqual([]);
    expect(speak(w, "q")).toEqual([1]);
  });

  it("never overshoots when overshoot is 0", () => {
    const w = new SpokenWalk([{ prose: "a b c" }, { prose: "x y z" }], { overshoot: 0 });
    speak(w, "a b c q q q q q");
    expect(w.reached).toBe(0);
  });

  it("does not overshoot on the last unit", () => {
    const w = new SpokenWalk([{ prose: "a b c" }]);
    expect(speak(w, "a b c q q q q")).toEqual([]);
  });

  describe("openWords", () => {
    const units = [{ prose: "Kharkiv was hit overnight." }, { prose: "Three died." }];

    it("ignores a status line that names the same place", () => {
      const w = new SpokenWalk(units, { fireFirst: true, openWords: 2 });
      expect(speak(w, "Looking at Kharkiv now")).toEqual([]);
      expect(w.opened).toBe(false);
      expect(w.reached).toBe(-1);
    });

    it("opens on two script words in a row", () => {
      const w = new SpokenWalk(units, { fireFirst: true, openWords: 2 });
      speak(w, "Looking at Kharkiv now");
      expect(speak(w, "Kharkiv was")).toEqual([0]);
      expect(w.opened).toBe(true);
      expect(speak(w, "hit overnight. Three")).toEqual([1]);
    });

    it("re-arms when the miss is itself the first word", () => {
      const w = new SpokenWalk(units, { fireFirst: true, openWords: 2 });
      // "Kharkiv Kharkiv was": the second "Kharkiv" misses seq[1] but is seq[0], so the run restarts at 1.
      expect(speak(w, "Kharkiv Kharkiv was")).toEqual([0]);
    });

    it("opens a one-word unit on its one word", () => {
      const w = new SpokenWalk([{ prose: "Kharkiv." }, { prose: "Three died." }], { fireFirst: true, openWords: 2 });
      expect(speak(w, "Kharkiv")).toEqual([0]);
    });
  });

  it("drops an appended unit whose prose is already present", () => {
    const w = new SpokenWalk(beats);
    w.append({ prose: "Kharkiv was hit the same night." });
    expect(w.length).toBe(4);
    w.append({ prose: "New sentence." });
    expect(w.length).toBe(5);
  });

  it("appends units mid-stream and reaches them", () => {
    const w = new SpokenWalk([beats[0]]);
    speak(w, "Good morning.");
    w.append(beats[1]);
    expect(speak(w, "On")).toEqual([1]);
  });

  it("jump marks everything up to the target reached and is monotonic afterwards", () => {
    const w = new SpokenWalk(beats);
    expect(w.jump(2)).toEqual([1, 2]);
    expect(w.reached).toBe(2);
    expect(w.jump(1)).toEqual([]);
    // Words from an earlier unit cannot lower it.
    expect(speak(w, "On the 27th")).toEqual([]);
    expect(w.reached).toBe(2);
    expect(speak(w, "Kharkiv was hit the same night. Casualty")).toEqual([3]);
  });

  it("reports remaining as 0 before any unit is reached", () => {
    const w = new SpokenWalk(beats, { fireFirst: true });
    expect(w.remaining).toBe(0);
  });
});
