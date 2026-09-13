import type { Adapter } from "../clock.js";

/** The subset of `PipecatClient` (an RTVI event emitter) this adapter uses. */
export type RTVIClientLike = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
};

export type PipecatOptions = {
  /**
   * Which of pipecat's two audible-text signals to feed. Never both: they
   * carry the same words and would advance the cursor twice.
   *
   * `"tts-text"` (default): `botTtsText`, one event per word as it is played.
   * Needs alignment forwarding on the server-side TTS service.
   *
   * `"bot-output"`: `botOutput` with `spoken_status: "in-progress"`, one event
   * per word carrying the sentence's text heard so far. Only the newly heard
   * suffix is fed. Segment-scoped, so an interrupted sentence leaves nothing
   * behind for the next one to trip on.
   */
  source?: "tts-text" | "bot-output";
};

type BotOutput = {
  text?: string;
  segment_id?: number;
  spoken_status?: "new" | "in-progress" | "completed";
  spoken_progress?: { accumulated_text?: string };
};

/**
 * Binds `botStartedSpeaking` (start), the chosen text signal (feed),
 * `botStoppedSpeaking` (stop) and `userStartedSpeaking` (interrupt).
 *
 * Pipecat holds each word event on its output clock until that word's own
 * timestamp and sends it outside the paced audio queue, so it arrives within
 * a network hop of being audible: feed it as is. If your player buffers on
 * top of that, hold the feed by the buffered amount yourself.
 *
 * `botStoppedSpeaking` matters: `start()` is a no-op while the clock runs,
 * so without a stop at the end of a turn the estimate would not re-arm.
 *
 * With constructor `callbacks` rather than `client.on`, call the same clock
 * methods from `onBotStartedSpeaking`, `onBotTtsText` (or `onBotOutput`),
 * `onBotStoppedSpeaking` and `onUserStartedSpeaking` directly.
 */
export function fromPipecat<T = unknown>(client: RTVIClientLike, opts: PipecatOptions = {}): Adapter<T> {
  const source = opts.source ?? "tts-text";
  return {
    bind(clock) {
      const started = () => clock.start();
      const stopped = () => clock.stop();
      const user = () => clock.interrupt();
      const ttsText = (data: { text: string }) => clock.feed(data.text);
      const heard = new Map<number, number>();
      const botOutput = (data: BotOutput) => {
        if (data.spoken_status !== "in-progress" || data.segment_id === undefined) return;
        const text = data.spoken_progress?.accumulated_text ?? "";
        const before = heard.get(data.segment_id) ?? 0;
        if (text.length > before) clock.feed(text.slice(before));
        heard.set(data.segment_id, text.length);
      };
      client.on("botStartedSpeaking", started);
      client.on("botStoppedSpeaking", stopped);
      client.on("userStartedSpeaking", user);
      if (source === "tts-text") client.on("botTtsText", ttsText);
      else client.on("botOutput", botOutput);
      return () => {
        client.off("botStartedSpeaking", started);
        client.off("botStoppedSpeaking", stopped);
        client.off("userStartedSpeaking", user);
        client.off("botTtsText", ttsText);
        client.off("botOutput", botOutput);
      };
    },
  };
}
