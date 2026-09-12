import { describe, expect, it } from "vitest";
import { createNarrationClock } from "../src/clock.js";
import { fromPipecat } from "../src/adapters/pipecat.js";
import { fromLiveKit } from "../src/adapters/livekit.js";

/** A minimal on/off emitter in the shape both adapters duck-type. */
function emitter() {
  const ls = new Map<string, Set<(...a: any[]) => void>>();
  return {
    on(e: string, l: (...a: any[]) => void) { (ls.get(e) ?? ls.set(e, new Set()).get(e)!).add(l); },
    off(e: string, l: (...a: any[]) => void) { ls.get(e)?.delete(l); },
    emit(e: string, ...a: any[]) { for (const l of ls.get(e) ?? []) l(...a); },
    count() { let n = 0; for (const s of ls.values()) n += s.size; return n; },
  };
}

const U = [{ prose: "Good morning" }, { prose: "On the 27th" }];

describe("pipecat adapter", () => {
  it("starts, feeds, stops and interrupts the clock, and unbinds cleanly", () => {
    const c = emitter();
    const log: string[] = [];
    const clock = createNarrationClock({ units: U, onAdvance: (i, s) => log.push(`${i}:${s}`) });
    const unbind = fromPipecat(c).bind(clock);
    c.emit("botStartedSpeaking");
    expect(clock.running).toBe(true);
    c.emit("botTtsText", { text: "Good morning On" });
    expect(log).toEqual(["1:spoken"]);
    c.emit("botStoppedSpeaking");
    expect(clock.running).toBe(false);
    c.emit("botStartedSpeaking");
    expect(clock.running).toBe(true);
    c.emit("userStartedSpeaking");
    expect(clock.running).toBe(false);
    unbind();
    expect(c.count()).toBe(0);
  });
});

describe("livekit adapter", () => {
  it("stops the clock when the agent leaves the speaking state", () => {
    const room = { ...emitter(), localParticipant: { identity: "me" } };
    const clock = createNarrationClock({ units: U, onAdvance: () => {} });
    fromLiveKit(room).bind(clock);
    const agent = { identity: "agent" };
    room.emit("participantAttributesChanged", { "lk.agent.state": "speaking" }, agent);
    expect(clock.running).toBe(true);
    room.emit("participantAttributesChanged", { "lk.agent.state": "listening" }, agent);
    expect(clock.running).toBe(false);
    room.emit("participantAttributesChanged", { "lk.agent.state": "speaking" }, agent);
    expect(clock.running).toBe(true);
  });
});
