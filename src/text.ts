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

/**
 * Sentence to caption-sized pieces: split at sentence ends, em/en dashes,
 * semicolons, and ", so" turns.
 */
export function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\s+[—–]\s+|;\s+|,\s+(?=so\s)/)
    .map((c) => c.trim())
    .filter(Boolean);
}
