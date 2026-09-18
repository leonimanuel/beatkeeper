import { describe, expect, it } from "vitest";
import { clauses } from "../src/text.js";

describe("clauses with a character budget", () => {
  const long =
    "And where gold surprised you by falling on rising yields, now those same yields have pushed mortgage rates above 7%.";

  it("leaves a clause alone without a budget", () => {
    expect(clauses(long)).toEqual([long]);
  });

  it("cuts an over-long clause at the last comma inside the budget", () => {
    expect(clauses(long, { maxChars: 64 })).toEqual([
      "And where gold surprised you by falling on rising yields,",
      "now those same yields have pushed mortgage rates above 7%.",
    ]);
  });

  it("keeps cutting until every piece fits", () => {
    const opener =
      "Since Attaché gets better with time, you're hearing the founder's real briefing for today, Friday, September 18th.";
    expect(clauses(opener, { maxChars: 64 })).toEqual([
      "Since Attaché gets better with time,",
      "you're hearing the founder's real briefing for today,",
      "Friday, September 18th.",
    ]);
  });

  it("does not mistake a thousands separator for a phrase boundary", () => {
    const s = "On the jobs data you were tracking for Fed relevance, claims fell to 196,000, lowest since July";
    expect(clauses(s, { maxChars: 64 })).toEqual([
      "On the jobs data you were tracking for Fed relevance,",
      "claims fell to 196,000, lowest since July",
    ]);
  });

  it("falls back to the last space when there is no comma in reach", () => {
    const s = "The council voted late on Tuesday to approve the second reading of the housing bill";
    const out = clauses(s, { maxChars: 40 });
    expect(out.every((p) => p.length <= 40)).toBe(true);
    expect(out.join(" ")).toBe(s);
  });

  it("still splits at the sense seams first", () => {
    expect(clauses("That's turned — Trump's now weighing renewed attacks, with a meeting set for the 22nd.", { maxChars: 64 })).toEqual([
      "That's turned",
      "Trump's now weighing renewed attacks,",
      "with a meeting set for the 22nd.",
    ]);
  });

  it("passes a single word longer than the budget through whole", () => {
    expect(clauses("Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz", { maxChars: 10 })).toEqual([
      "Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz",
    ]);
  });
});
