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
      "We won", "so we left.", "Then we slept", "briefly", "not long.",
    ]);
  });
});

describe("the normal walk", () => {
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

  it("is indifferent to chunk size: words, phrases and whole sentences agree", () => {
    const sentence = "Good morning. On the 27th, a strike hit the Orlivka border crossing. Kharkiv";
    const a = new SpokenWalk(beats);
    const b = new SpokenWalk(beats);
    const c = new SpokenWalk(beats);
    expect(speak(a, sentence)).toEqual([1, 2]);
    expect(sentence.split(". ").flatMap((p) => b.feed(p))).toEqual([1, 2]);
    expect(c.feed(sentence)).toEqual([1, 2]);
  });

  it("is monotonic: words from an earlier unit never lower it", () => {
    const w = new SpokenWalk(beats);
    speak(w, "Good morning. On the 27th, a strike hit the Orlivka border crossing. Kharkiv");
    expect(speak(w, "Good morning On the")).toEqual([]);
    expect(w.reached).toBe(2);
  });
});

describe("the script is trusted", () => {
  it("keeps a repeated sentence and fires it each time", () => {
    const w = new SpokenWalk([{ prose: "Again." }, { prose: "And now the result." }, { prose: "Again." }]);
    expect(w.length).toBe(3);
    expect(speak(w, "Again. And now the result. Again.")).toEqual([1, 2]);
  });

  it("append adds exactly one unit, duplicate prose or not", () => {
    const w = new SpokenWalk([{ prose: "He said no." }]);
    w.append({ prose: "He said no." });
    expect(w.length).toBe(2);
  });
});

describe("fuzzy matching within a unit", () => {
  it("recovers when the TTS reads a number out differently", () => {
    const w = new SpokenWalk(beats);
    speak(w, "Good morning.");
    expect(speak(w, "On the twenty seventh a strike hit")).toEqual([1]);
    expect(w.remaining).toBe(4);
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
    expect(speak(w, "youre")).toEqual([1]);
  });

  it("holds position on a word it cannot place", () => {
    const w = new SpokenWalk([{ prose: "one two three four five six" }, { prose: "seven eight" }]);
    speak(w, "one two");
    speak(w, "um");
    expect(w.remaining).toBe(4);
    speak(w, "three");
    expect(w.remaining).toBe(3);
  });

  it("may skip to anywhere in the remainder of the current unit", () => {
    const w = new SpokenWalk([{ prose: "a b c d e f g h i j k l" }, { prose: "x y" }]);
    speak(w, "a k");
    expect(w.remaining).toBe(1);
    expect(w.reached).toBe(0);
  });

  it("normalize applies to script and speech alike", () => {
    const words: Record<string, string> = { twelfth: "12th" };
    const w = new SpokenWalk(
      [{ prose: "Saturday, September 12th." }, { prose: "Morning." }],
      { normalize: (t) => words[t] ?? t },
    );
    expect(speak(w, "Saturday September twelfth Morning")).toEqual([1]);
  });
});

describe("crossing into the next unit", () => {
  const units = [{ prose: "a b c d e f g h" }, { prose: "the x y z" }, { prose: "q r s" }];

  it("one stray word cannot move the cursor to the next unit", () => {
    const w = new SpokenWalk(units);
    expect(speak(w, "a b the")).toEqual([]);
    expect(speak(w, "c d")).toEqual([]);
    expect(w.reached).toBe(0);
  });

  it("two words in a row from the next unit can", () => {
    const w = new SpokenWalk(units);
    expect(speak(w, "a b the x")).toEqual([1]);
    expect(w.remaining).toBe(2);
  });

  it("a single word suffices when the current unit is nearly done", () => {
    const w = new SpokenWalk(units);
    expect(speak(w, "a b c d e f the")).toEqual([1]);
  });

  it("never reaches two units ahead directly: a unit is entered before the one after it", () => {
    const w = new SpokenWalk(units);
    // Unit 2's words, spoken at the end of unit 0, are unplaceable: unit 2 is out of reach.
    expect(speak(w, "a b c d e f g h q r")).toEqual([]);
    expect(w.reached).toBe(0);
    // The third unplaceable word is overshoot: unit 1 is assumed, not unit 2.
    expect(speak(w, "s")).toEqual([1]);
    // From unit 1, one word of unit 2 is not enough; two in a row are.
    expect(speak(w, "q")).toEqual([]);
    expect(speak(w, "r")).toEqual([2]);
  });

  it("after three unplaceable words past the end, the next unit is assumed", () => {
    const w = new SpokenWalk([{ prose: "a b c" }, { prose: "x y z" }]);
    speak(w, "a b c");
    expect(speak(w, "mm mm")).toEqual([]);
    expect(speak(w, "mm")).toEqual([1]);
  });

  it("does not overshoot on the last unit", () => {
    const w = new SpokenWalk([{ prose: "a b c" }]);
    expect(speak(w, "a b c q q q q")).toEqual([]);
  });

  it("a whole unit read unrecognisably is passed over once the one after it is heard", () => {
    const w = new SpokenWalk([{ prose: "a b c" }, { prose: "he said no" }, { prose: "pipeline or trump" }]);
    speak(w, "a b c");
    // Three unplaceable words push the cursor into beat 1; the cursor is then
    // near beat 1's end, so beat 2's first word crosses on its own.
    expect(speak(w, "hee sed know")).toEqual([1]);
    expect(speak(w, "pipeline")).toEqual([2]);
  });
});

describe("openWords", () => {
  const units = [{ prose: "Kharkiv was hit overnight." }, { prose: "Three died." }];

  it("ignores a status line that names the same place", () => {
    const w = new SpokenWalk(units, { fireFirst: true, openWords: 2 });
    expect(speak(w, "Looking at Kharkiv now")).toEqual([]);
    expect(w.opened).toBe(false);
  });

  it("opens on two script words in a row", () => {
    const w = new SpokenWalk(units, { fireFirst: true, openWords: 2 });
    speak(w, "Looking at Kharkiv now");
    expect(speak(w, "Kharkiv was")).toEqual([0]);
    expect(speak(w, "hit overnight. Three")).toEqual([1]);
  });

  it("re-arms when the miss is itself the first word", () => {
    const w = new SpokenWalk(units, { fireFirst: true, openWords: 2 });
    expect(speak(w, "Kharkiv Kharkiv was")).toEqual([0]);
  });

  it("opens a one-word unit on its one word", () => {
    const w = new SpokenWalk([{ prose: "Kharkiv." }, { prose: "Three died." }], { fireFirst: true, openWords: 2 });
    expect(speak(w, "Kharkiv")).toEqual([0]);
  });
});

describe("jump and progress", () => {
  it("jump marks everything up to the target reached and stays monotonic", () => {
    const w = new SpokenWalk(beats);
    expect(w.jump(2)).toEqual([1, 2]);
    expect(w.jump(1)).toEqual([]);
    expect(speak(w, "On the 27th")).toEqual([]);
    expect(speak(w, "Kharkiv was hit the same night. Casualty")).toEqual([3]);
  });

  it("progress is the fraction of the current unit heard", () => {
    const w = new SpokenWalk([{ prose: "one two three four" }, { prose: "five" }]);
    expect(w.progress).toBe(0);
    speak(w, "one two");
    expect(w.progress).toBe(0.5);
    speak(w, "three four five");
    expect(w.reached).toBe(1);
    expect(w.progress).toBe(1);
  });

  it("appends units mid-stream and reaches them", () => {
    const w = new SpokenWalk([beats[0]]);
    speak(w, "Good morning.");
    w.append(beats[1]);
    expect(speak(w, "On")).toEqual([1]);
  });
});
