import type { Adapter } from "../clock.js";

/** The subset of `PipecatClient` (an RTVI event emitter) this adapter uses. */
export type RTVIClientLike = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
};

/**
 * Binds `botStartedSpeaking` (start), `botTtsText` (feed),
 * `botStoppedSpeaking` (stop) and `userStartedSpeaking` (interrupt).
 *
 * `botTtsText` carries one message per word as it is played, provided the
 * server-side TTS service has alignment forwarding enabled. Events arrive
 * on the word's own timestamp; apply them with no added delay.
 *
 * `botStoppedSpeaking` matters more than it looks: `start()` is a no-op
 * while the clock is running, so without a stop at the end of a turn the
 * estimate clock would never re-arm for the next one.
 *
 * If you construct the client with `callbacks` instead of subscribing, call
 * the same four clock methods from `onBotStartedSpeaking`, `onBotTtsText`,
 * `onBotStoppedSpeaking` and `onUserStartedSpeaking` directly.
 */
export function fromPipecat<T = unknown>(client: RTVIClientLike): Adapter<T> {
  return {
    bind(clock) {
      const started = () => clock.start();
      const text = (data: { text: string }) => clock.feed(data.text);
      const stopped = () => clock.stop();
      const user = () => clock.interrupt();
      client.on("botStartedSpeaking", started);
      client.on("botTtsText", text);
      client.on("botStoppedSpeaking", stopped);
      client.on("userStartedSpeaking", user);
      return () => {
        client.off("botStartedSpeaking", started);
        client.off("botTtsText", text);
        client.off("botStoppedSpeaking", stopped);
        client.off("userStartedSpeaking", user);
      };
    },
  };
}
