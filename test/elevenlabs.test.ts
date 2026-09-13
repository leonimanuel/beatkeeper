import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNarrationClock } from "../src/clock.js";
import { fromElevenLabs, type ElevenLabsMessage } from "../src/adapters/elevenlabs.js";
import { fakeTimers } from "./timers.js";

/**
 * Captured live from both sockets. See the fixtures' own `_comment`: the
 * point of each is that `char_start_times_ms` restarts at 0 in every message,
 * so an adapter that reads those as offsets from playback start collapses the
 * whole narration into the span of its first message.
 */
type Fixture = {
  text: string;
  _total_audio_ms: number;
  messages: (ElevenLabsMessage & { _audio_ms: number })[];
};

const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8"));

const streamInput = fixture("elevenlabs-stream-input");
const dialogue = fixture("elevenlabs-dialogue");

const align = (m: ElevenLabsMessage) => m.alignment ?? m.normalizedAlignment ?? m.normalized_alignment;

/** Feed a whole fixture and record the ms at which each advance lands. */
function run(f: Fixture, units: { prose: string }[]) {
  const timers = fakeTimers();
  const at: { index: number; ms: number }[] = [];
  const clock = createNarrationClock({
    units,
    timers,
    onAdvance: (index) => at.push({ index, ms: timers.now() }),
  });
  const el = fromElevenLabs({ timers });
  el.bind(clock);
  // Synthesis outruns playback: every message is in hand before the audio it
  // describes has played, which is exactly what makes the offsets matter.
  for (const m of f.messages) el.message(m);
  el.playbackStarted();
  timers.advance(f._total_audio_ms + 1000);
  return at;
}

describe("elevenlabs adapter, live /stream-input capture", () => {
  const units = [
    { prose: "Good morning, Leon." },
    { prose: "Here is today's briefing, and it runs" },
    { prose: "a little longer than usual." },
  ];

  it("every message restarts its char offsets at zero", () => {
    const withAlignment = streamInput.messages.filter((m) => align(m));
    expect(withAlignment.length).toBeGreaterThan(1);
    for (const m of withAlignment) {
      const starts = align(m)!.charStartTimesMs ?? align(m)!.char_start_times_ms ?? [];
      expect(starts[0]).toBe(0);
    }
  });

  it("summed message spans equal the total audio duration", () => {
    let cumulative = 0;
    for (const m of streamInput.messages) {
      const a = align(m);
      if (!a) continue;
      const starts = a.charStartTimesMs ?? a.char_start_times_ms ?? [];
      const durations = a.charDurationsMs ?? a.char_durations_ms ?? [];
      cumulative += starts[starts.length - 1] + durations[durations.length - 1];
    }
    expect(Math.abs(cumulative - streamInput._total_audio_ms)).toBeLessThan(1);
  });

  it("advances each beat at the ms the words are audible", () => {
    // Golden values, fake timers, frozen fixture. Reading the per-message
    // offsets as absolute gave 174ms and 1637ms: both beats land while the
    // first sentence is still being spoken.
    expect(run(streamInput, units)).toEqual([
      { index: 1, ms: 871 },
      { index: 2, ms: 2566 },
    ]);
  });

  it("ends its last message with whitespace, unlike the dialogue socket", () => {
    const last = [...streamInput.messages].reverse().find((m) => align(m))!;
    const chars = align(last)!.chars;
    expect(chars[chars.length - 1]).toBe(" ");
  });
});

describe("elevenlabs adapter, live text-to-dialogue capture", () => {
  const units = [
    { prose: "Good morning, Leon." },
    { prose: "Here is today's briefing, and it runs" },
    { prose: "a little longer than usual." },
  ];

  it("reads the snake_case wire shape and advances on the audible ms", () => {
    // Reading the per-message offsets as absolute gave 36ms and 840ms here:
    // this socket sends more, shorter messages, so the interface jumped to
    // the second beat before the first word had finished.
    expect(run(dialogue, units)).toEqual([
      { index: 1, ms: 1040 },
      { index: 2, ms: 2600 },
    ]);
  });

  it("speaks the last beat, whose final word has no whitespace after it", () => {
    const lastBeat = [
      { prose: "Good morning, Leon." },
      { prose: "Here is today's briefing, and it runs a little longer than" },
      { prose: "usual." },
    ];
    const chars = align([...dialogue.messages].reverse().find((m) => align(m))!)!.chars;
    expect(chars[chars.length - 1]).not.toBe(" ");

    expect(run(dialogue, lastBeat).map((a) => a.index)).toContain(2);

    // Without the is_final flush the word is still being assembled when the
    // stream ends, and the beat never fires.
    const unterminated: Fixture = {
      ...dialogue,
      messages: dialogue.messages.filter((m) => !(m.is_final || m.isFinal)),
    };
    expect(run(unterminated, lastBeat).map((a) => a.index)).not.toContain(2);
  });

  it("advances past a message that completes no word", () => {
    // Message 2 of this capture is the single character "," -- it finishes
    // nothing, and dropping its span would pull every later word early.
    const comma = dialogue.messages[1];
    const a = align(comma)!;
    expect(a.chars.join("")).toBe(",");

    const without: Fixture = { ...dialogue, messages: dialogue.messages.filter((m) => m !== comma) };
    const withComma = run(dialogue, units).find((x) => x.index === 2)!;
    const withoutComma = run(without, units).find((x) => x.index === 2)!;
    expect(withComma.ms).toBeGreaterThan(withoutComma.ms);
  });

  it("keeps assembly state per context", () => {
    const timers = fakeTimers();
    const fed: string[] = [];
    const clock = createNarrationClock({
      units: [{ prose: "alpha beta" }, { prose: "gamma delta" }],
      timers,
      onAdvance: () => {},
    });
    // Stand in for the clock's feed so the raw word stream is observable.
    const spy = { ...clock, feed: (t: string) => fed.push(t) };
    const el = fromElevenLabs({ timers });
    el.bind(spy as typeof clock);
    el.playbackStarted();

    // Two contexts interleaved on one socket, each mid-word.
    el.message({ context_id: "a", alignment: { chars: "al".split(""), char_start_times_ms: [0, 10], char_durations_ms: [10, 10] } });
    el.message({ context_id: "b", alignment: { chars: "ga".split(""), char_start_times_ms: [0, 10], char_durations_ms: [10, 10] } });
    el.message({ context_id: "a", alignment: { chars: "pha ".split(""), char_start_times_ms: [0, 10, 20, 30], char_durations_ms: [10, 10, 10, 10] } });
    el.message({ context_id: "b", alignment: { chars: "mma ".split(""), char_start_times_ms: [0, 10, 20, 30], char_durations_ms: [10, 10, 10, 10] } });
    timers.advance(500);

    // Without per-context state the two half-words cross into "alga" / "phamma".
    expect(fed).toEqual(["alpha", "gamma"]);
  });

  it("ends one context without disturbing another", () => {
    const timers = fakeTimers();
    const fed: string[] = [];
    const clock = createNarrationClock({ units: [{ prose: "one two" }], timers, onAdvance: () => {} });
    const el = fromElevenLabs({ timers });
    el.bind({ ...clock, feed: (t: string) => fed.push(t) } as typeof clock);
    el.playbackStarted();

    el.message({ context_id: "a", alignment: { chars: "one".split(""), char_start_times_ms: [0, 10, 20], char_durations_ms: [10, 10, 10] } });
    el.message({ context_id: "b", alignment: { chars: "two".split(""), char_start_times_ms: [0, 10, 20], char_durations_ms: [10, 10, 10] } });
    el.message({ context_id: "a", is_final: true });
    timers.advance(500);
    expect(fed).toEqual(["one"]);

    el.message({ context_id: "b", is_final: true });
    timers.advance(500);
    expect(fed).toEqual(["one", "two"]);
  });
});
