import type { Adapter, NarrationClock, Timers } from "../clock.js";

/** One message from the ElevenLabs streaming TTS websocket. */
export type ElevenLabsMessage = {
  alignment?: {
    chars: string[];
    charStartTimesMs: number[];
    charDurationsMs?: number[];
  } | null;
  normalizedAlignment?: ElevenLabsMessage["alignment"];
  isFinal?: boolean | null;
};

export type ElevenLabsAdapter<T = unknown> = Adapter<T> & {
  /** Pass every parsed websocket message here. */
  message(msg: ElevenLabsMessage): void;
  /** Call when the first audio chunk becomes audible. Starts the clock. */
  playbackStarted(): void;
  /** Call on barge-in. */
  interrupted(): void;
};

/**
 * ElevenLabs alignment arrives with the audio chunk, at synthesis time —
 * ahead of playback by however much audio is buffered. Unlike a pipeline that
 * forwards words on the output clock, these must be scheduled: each word is
 * fed at its `charStartTimesMs` offset from the moment playback began.
 *
 * Words are assembled from characters and fed whole, on whitespace.
 *
 * Written against the websocket message shape; not yet run against a live
 * socket.
 */
export function fromElevenLabs<T = unknown>(opts: { timers?: Timers } = {}): ElevenLabsAdapter<T> {
  const timers = {
    setTimeout: opts.timers?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)),
    clearTimeout: opts.timers?.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)),
    now: opts.timers?.now ?? (() => Date.now()),
  };
  let clock: NarrationClock<T> | null = null;
  let origin: number | null = null;
  const pending: { text: string; atMs: number }[] = [];
  const scheduled = new Set<unknown>();
  let word = "";
  let wordStart = 0;

  const flush = () => {
    if (origin === null || !clock) return;
    const c = clock;
    for (const w of pending.splice(0)) {
      const delay = Math.max(0, origin + w.atMs - timers.now());
      const id = timers.setTimeout(() => {
        scheduled.delete(id);
        c.feed(w.text);
      }, delay);
      scheduled.add(id);
    }
  };

  const push = (text: string, atMs: number) => {
    if (!text) return;
    pending.push({ text, atMs });
    flush();
  };

  return {
    bind(c) {
      clock = c;
      return () => {
        clock = null;
        for (const id of scheduled) timers.clearTimeout(id);
        scheduled.clear();
      };
    },
    message(msg) {
      const a = msg.alignment ?? msg.normalizedAlignment;
      if (a) {
        for (let i = 0; i < a.chars.length; i++) {
          const ch = a.chars[i];
          if (/\s/.test(ch)) {
            push(word, wordStart);
            word = "";
          } else {
            if (!word) wordStart = a.charStartTimesMs[i] ?? 0;
            word += ch;
          }
        }
      }
      if (msg.isFinal) {
        push(word, wordStart);
        word = "";
      }
    },
    playbackStarted() {
      origin = timers.now();
      clock?.start();
      flush();
    },
    interrupted() {
      for (const id of scheduled) timers.clearTimeout(id);
      scheduled.clear();
      pending.length = 0;
      clock?.interrupt();
    },
  };
}
