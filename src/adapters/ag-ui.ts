import type { Adapter } from "../clock.js";
import type { Unit } from "../walk.js";

type CustomEventLike = { name: string; value: unknown };

/** The subset of an AG-UI `AbstractAgent` this adapter uses. */
export type AgentLike = {
  subscribe(subscriber: {
    onCustomEvent?(params: { event: CustomEventLike }): void | Promise<void>;
  }): { unsubscribe(): void };
};

export type AgUiEventNames = {
  /** Value: a unit. Appended. */
  beat?: string;
  /** Value: `{ text: string }`. Fed. */
  spoken?: string;
  /** No value. Starts the clock. */
  started?: string;
  /** No value. Interrupts. */
  interrupted?: string;
};

const NAMES: Required<AgUiEventNames> = {
  beat: "beat",
  spoken: "beat.spoken",
  started: "beat.started",
  interrupted: "beat.interrupted",
};

/**
 * AG-UI carries no audio timing. Units and spoken text travel as `Custom`
 * events, the protocol's extension point:
 *
 *   { type: "CUSTOM", name: "beat",        value: unit }
 *   { type: "CUSTOM", name: "beat.spoken", value: { text } }
 *   { type: "CUSTOM", name: "beat.started" }
 *   { type: "CUSTOM", name: "beat.interrupted" }
 *
 * The agent side must emit `beat.spoken` from its own TTS word stream; no
 * AG-UI integration does this for you.
 *
 * Written against @ag-ui/client typings; not yet run against a live agent.
 */
export function fromAgUi<T = unknown>(agent: AgentLike, names: AgUiEventNames = {}): Adapter<T> {
  const n = { ...NAMES, ...names };
  return {
    bind(clock) {
      const sub = agent.subscribe({
        onCustomEvent({ event }) {
          switch (event.name) {
            case n.beat:
              clock.append(event.value as Unit<T>);
              break;
            case n.spoken: {
              const v = event.value as { text?: string } | undefined;
              if (v?.text) clock.feed(v.text);
              break;
            }
            case n.started:
              clock.start();
              break;
            case n.interrupted:
              clock.interrupt();
              break;
          }
        },
      });
      return () => sub.unsubscribe();
    },
  };
}
