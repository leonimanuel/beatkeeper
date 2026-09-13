import type { Adapter, NarrationClock, Timers } from "../clock.js";

/**
 * One message from an ElevenLabs streaming TTS websocket. The raw wire is
 * snake_case (`char_start_times_ms`, `is_final`); the official SDK renames
 * to camelCase. Both are accepted. The text-to-speech socket emits camelCase
 * on the wire and the text-to-dialogue socket snake_case, so either casing
 * may legitimately turn up.
 */
export type ElevenLabsAlignment = {
  chars: string[];
  charStartTimesMs?: number[];
  char_start_times_ms?: number[];
  charDurationsMs?: number[];
  char_durations_ms?: number[];
};
export type ElevenLabsMessage = {
  alignment?: ElevenLabsAlignment | null;
  normalizedAlignment?: ElevenLabsAlignment | null;
  normalized_alignment?: ElevenLabsAlignment | null;
  isFinal?: boolean | null;
  is_final?: boolean | null;
  /** Text-to-dialogue only: which context this message belongs to. */
  contextId?: string | null;
  context_id?: string | null;
};

export type ElevenLabsAdapter<T = unknown> = Adapter<T> & {
  /** Pass every parsed websocket message here. */
  message(msg: ElevenLabsMessage): void;
  /** Call when the first audio chunk becomes audible. Starts the clock. */
  playbackStarted(): void;
  /** Call on barge-in. */
  interrupted(): void;
};

/** Per-context assembly state. The dialogue socket multiplexes contexts. */
type Context = {
  /** Characters of the word being assembled, carried across messages. */
  word: string;
  /** Stream offset of that word's first character, in ms. */
  wordStart: number;
  /** Stream ms consumed by this context's earlier messages. */
  cumulative: number;
};

/** The text-to-speech socket sends no context; a symbol cannot collide with one. */
const DEFAULT_CONTEXT = Symbol("default");

const contextKey = (msg: ElevenLabsMessage): string | symbol =>
  msg.contextId ?? msg.context_id ?? DEFAULT_CONTEXT;

/**
 * ElevenLabs alignment arrives with the audio chunk, at synthesis time --
 * ahead of playback by however much audio is buffered. Unlike a pipeline that
 * forwards words on the output clock, these must be scheduled: each word is
 * fed at its stream offset from the moment playback began.
 *
 * That offset is NOT the `charStartTimesMs` value on the wire. Those restart
 * at zero in every message: a message covering stream time 983ms-4180ms still
 * numbers its own first character 0. Offsets are therefore accumulated here,
 * by adding each message's span (its last character's start plus that
 * character's duration) as the message is consumed. Measured against both
 * live sockets, the accumulated total equals the total audio duration
 * exactly, while any single message's alignment can lead or lag its own audio
 * chunk by a few hundred ms -- so the running total is the only sound thing
 * to schedule against.
 *
 * The span is added even for a message that completes no word, since trailing
 * punctuation arrives in a message of its own and skipping it would make
 * every later word early by the shortfall.
 *
 * Words are assembled from characters and fed whole, on whitespace. The last
 * word of an utterance has no whitespace after it and is flushed on
 * `is_final`.
 *
 * Covers both the `/stream-input` (text-to-speech) socket and the v3
 * `/text-to-dialogue/multi-stream-input` socket. The dialogue socket
 * multiplexes several contexts over one connection and ends each with its own
 * `is_final`, so assembly state is kept per `context_id`; the text-to-speech
 * socket sends no context and uses a single implicit one.
 *
 * Alignment on the dialogue socket is opt-in: connect with
 * `sync_alignment=true` or no message will carry any.
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
  const contexts = new Map<string | symbol, Context>();

  const context = (key: string | symbol): Context => {
    let c = contexts.get(key);
    if (!c) {
      c = { word: "", wordStart: 0, cumulative: 0 };
      contexts.set(key, c);
    }
    return c;
  };

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
      const key = contextKey(msg);
      const ctx = context(key);
      const a = msg.alignment ?? msg.normalizedAlignment ?? msg.normalized_alignment;
      if (a) {
        const starts = a.charStartTimesMs ?? a.char_start_times_ms ?? [];
        const durations = a.charDurationsMs ?? a.char_durations_ms ?? [];
        for (let i = 0; i < a.chars.length; i++) {
          const ch = a.chars[i];
          if (/\s/.test(ch)) {
            push(ctx.word, ctx.wordStart);
            ctx.word = "";
          } else {
            if (!ctx.word) ctx.wordStart = ctx.cumulative + (starts[i] ?? 0);
            ctx.word += ch;
          }
        }
        // Advance past this message's span, whether or not it completed a
        // word. Without durations the last character's own length is unknown
        // and the clock falls one character short rather than a whole message.
        if (starts.length) {
          ctx.cumulative += starts[starts.length - 1] + (durations[durations.length - 1] ?? 0);
        }
      }
      if (msg.isFinal || msg.is_final) {
        push(ctx.word, ctx.wordStart);
        contexts.delete(key);
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
      contexts.clear();
      origin = null;
      clock?.interrupt();
    },
  };
}
