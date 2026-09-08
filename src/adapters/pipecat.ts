import type { Adapter } from "../clock.js";

/** The subset of `PipecatClient` (an RTVI event emitter) this adapter uses. */
export type RTVIClientLike = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
};

/**
 * Binds `botStartedSpeaking`, `botTtsText` and `userStartedSpeaking`.
 *
 * `botTtsText` carries one message per word as it is played, provided the
 * server-side TTS service has alignment forwarding enabled. Events arrive
 * on the word's own timestamp; apply them with no added delay.
 *
 * If you construct the client with `callbacks` instead of subscribing, call
 * `clock.start()`, `clock.feed(data.text)` and `clock.interrupt()` from
 * `onBotStartedSpeaking`, `onBotTtsText` and `onUserStartedSpeaking` directly.
 */
export function fromPipecat<T = unknown>(client: RTVIClientLike): Adapter<T> {
  return {
    bind(clock) {
      const started = () => clock.start();
      const text = (data: { text: string }) => clock.feed(data.text);
      const user = () => clock.interrupt();
      client.on("botStartedSpeaking", started);
      client.on("botTtsText", text);
      client.on("userStartedSpeaking", user);
      return () => {
        client.off("botStartedSpeaking", started);
        client.off("botTtsText", text);
        client.off("userStartedSpeaking", user);
      };
    },
  };
}
