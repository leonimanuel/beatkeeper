import type { Adapter } from "../clock.js";

type ParticipantLike = { identity: string };
type SegmentLike = { id: string; text: string };

/** The subset of `Room` this adapter uses. */
export type RoomLike = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  localParticipant?: ParticipantLike;
};

export type LiveKitOptions = {
  /** Only accept transcription and state from this participant. Default: any remote participant. */
  agentIdentity?: string;
};

/**
 * Binds `participantAttributesChanged` (agent state → `speaking` starts the
 * clock), `transcriptionReceived` (agent segments are fed) and
 * `activeSpeakersChanged` (the local participant speaking interrupts).
 *
 * Requires `use_tts_aligned_transcript=True` on the `AgentSession`. Without
 * it, segments arrive at generation time rather than speech time.
 *
 * Segments update in place as they grow. Only the appended suffix is fed; a
 * segment that is rewritten rather than extended is ignored.
 *
 * Written against livekit-client typings; not yet run against a live room.
 */
export function fromLiveKit<T = unknown>(room: RoomLike, opts: LiveKitOptions = {}): Adapter<T> {
  return {
    bind(clock) {
      const seen = new Map<string, string>();
      const isAgent = (p?: ParticipantLike) => {
        if (!p) return false;
        if (room.localParticipant && p.identity === room.localParticipant.identity) return false;
        return !opts.agentIdentity || p.identity === opts.agentIdentity;
      };

      let speaking = false;
      const attrs = (changed: Record<string, string>, participant: ParticipantLike) => {
        if (!isAgent(participant)) return;
        const state = changed["lk.agent.state"];
        if (state === undefined) return;
        if (state === "speaking") {
          speaking = true;
          clock.start();
        } else if (speaking) {
          // The turn ended; let the next `speaking` start a fresh estimate.
          speaking = false;
          clock.stop();
        }
      };
      const transcription = (segments: SegmentLike[], participant?: ParticipantLike) => {
        if (!isAgent(participant)) return;
        for (const s of segments) {
          const prev = seen.get(s.id) ?? "";
          if (s.text.length > prev.length && s.text.startsWith(prev)) {
            clock.feed(s.text.slice(prev.length));
          }
          seen.set(s.id, s.text);
        }
      };
      const speakers = (list: ParticipantLike[]) => {
        const me = room.localParticipant;
        if (me && list.some((p) => p.identity === me.identity)) clock.interrupt();
      };

      room.on("participantAttributesChanged", attrs);
      room.on("transcriptionReceived", transcription);
      room.on("activeSpeakersChanged", speakers);
      return () => {
        room.off("participantAttributesChanged", attrs);
        room.off("transcriptionReceived", transcription);
        room.off("activeSpeakersChanged", speakers);
      };
    },
  };
}
