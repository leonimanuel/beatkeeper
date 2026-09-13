import type { NarrationClock, Timers } from "./clock.js";

export type HintOptions = {
  /** Waited before a hint is believed, plus `perWordMs` for each word of the current unit not yet heard. */
  baseMs?: number;
  perWordMs?: number;
  timers?: Pick<Timers, "setTimeout" | "clearTimeout">;
};

export type Hinted<T = unknown> = {
  /** A source that runs ahead of the voice believes unit `index` has started. */
  hint(index: number): void;
  /** Route spoken text through here instead of `clock.feed` so a hint is dropped when the words arrive first. */
  feed(text: string): void;
  /** Cancel a pending hint. */
  cancel(): void;
};

/**
 * Turns an EARLY signal into a late `sync()`.
 *
 * A server can say "TTS began synthesising unit 3" — a useful fallback for
 * words that arrive mangled or not at all — but synthesis runs ahead of the
 * listener's ear by the pipeline's buffer, so applying it at once would move
 * the picture before the voice gets there. This waits a grace period sized
 * to what the current unit still has to say, and only then re-anchors the
 * clock with `sync()`. If spoken words reach the unit first, the hint is
 * discarded. Not part of the clock: the clock has one authoritative
 * re-anchor, and this is one way of deciding when to use it.
 */
export function withHints<T = unknown>(clock: NarrationClock<T>, opts: HintOptions = {}): Hinted<T> {
  const baseMs = opts.baseMs ?? 1500;
  const perWordMs = opts.perWordMs ?? 420;
  const t = {
    setTimeout: opts.timers?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)),
    clearTimeout: opts.timers?.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)),
  };
  let pending: unknown = null;
  const cancel = () => {
    if (pending !== null) {
      t.clearTimeout(pending);
      pending = null;
    }
  };
  return {
    hint(index) {
      if (index <= clock.index || index >= clock.length) return;
      cancel();
      const wait = baseMs + clock.remaining * perWordMs;
      pending = t.setTimeout(() => {
        pending = null;
        clock.sync(index);
      }, wait);
    },
    feed(text) {
      const before = clock.index;
      clock.feed(text);
      if (clock.index !== before) cancel();
    },
    cancel,
  };
}
