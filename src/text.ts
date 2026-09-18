/**
 * Lower-case, letters and digits only. "$1.7B" and "one-point-seven" each
 * survive as a single token; punctuation never counts. Unicode-aware so
 * Cyrillic and other non-Latin names match.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter(Boolean);
}

export type ClauseOptions = {
  /**
   * The longest piece a caption box can show, in characters. A clause over
   * it is cut at its last comma or colon inside the budget, else at its last
   * space, and the rest is cut the same way. Off by default: without it a
   * clause is whatever the seams below leave, however long.
   */
  maxChars?: number;
};

/**
 * Sentence to caption-sized pieces: split at sentence ends, em/en dashes,
 * semicolons, and ", so" turns.
 *
 * Those seams are where the SENSE turns, which is what a walk that moves a
 * picture wants. A subtitle box wants something else as well: a piece that
 * fits. A twenty-word sentence with one seam in it is two lines and a half
 * in an italic serif at 46ch, and a fixed two-line box shows the first two
 * and swallows the rest — every word after the cut is heard and never read.
 * `maxChars` adds the second kind of cut on top of the first, at commas
 * before anything else, so the pieces still read as phrases.
 */
export function clauses(text: string, options: ClauseOptions = {}): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+|\s+[—–]\s+|;\s+|,\s+(?=so\s)/)
    .map((c) => c.trim())
    .filter(Boolean);
  const max = options.maxChars;
  if (!max || max <= 0) return parts;
  return parts.flatMap((p) => fit(p, max));
}

/** A piece cut down to `max` characters at a time, phrase boundaries first. */
function fit(piece: string, max: number): string[] {
  if (piece.length <= max) return [piece];
  const head = piece.slice(0, max + 1);
  // Every comma or colon followed by a space, inside the budget: "196,000"
  // has a comma and is one word. The last one wins, unless what it leaves is
  // a stub — "September 18th." on its own line reads as a caption for
  // nothing — in which case the boundary before it is taken instead.
  const marks = [...head.matchAll(/[,:](?=\s)/g)].map((m) => m.index + 1);
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  let at = marks[marks.length - 1] ?? -1;
  for (let i = marks.length - 1; i >= 0; i--) {
    if (words(piece.slice(marks[i])) >= 3) { at = marks[i]; break; }
  }
  // No phrase boundary in reach: the last space, so no word is broken. A
  // single word longer than the budget goes through whole.
  if (at <= 0) at = head.lastIndexOf(" ");
  if (at <= 0) return [piece];
  const first = piece.slice(0, at).trim();
  const rest = piece.slice(at).trim();
  if (!first || !rest) return [piece];
  return [first, ...fit(rest, max)];
}
