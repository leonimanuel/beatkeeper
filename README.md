# narration-clock

Resolves which unit of a scripted narration a TTS voice is currently speaking, from the voice's own word stream. Emits an index; renders nothing.

Intended for UIs that change state in step with an agent's speech (maps, charts, graphs, scenes). Not needed for chat-style UIs that render on tool results.

- Zero runtime dependencies
- Framework-agnostic core; optional React hook
- Adapters: Pipecat, LiveKit, ElevenLabs, AG-UI

## Install

```bash
npm install narration-clock
```

## Usage

```ts
import { createNarrationClock } from "narration-clock";

const clock = createNarrationClock({
  units: beats,                                              // { prose: string, ...anything }[]
  estimate: (unit) => unit.prose.split(/\s+/).length * 340,  // ms per unit; fallback only
  onAdvance: (index, source) => render(beats[index]),
});

client.on("botStartedSpeaking",  () => clock.start());
client.on("botTtsText",          (e) => clock.feed(e.text));
client.on("userStartedSpeaking", () => clock.interrupt());
```

`units` may be any objects with a `prose: string` field. Other fields are not read.

With an adapter:

```ts
import { fromPipecat } from "narration-clock/pipecat";

const unbind = fromPipecat(client).bind(clock);
```

### React

```tsx
import { useNarrationClock } from "narration-clock/react";
import { fromPipecat } from "narration-clock/pipecat";

const adapter = useMemo(() => fromPipecat(client), [client]);
const { index, source } = useNarrationClock(beats, { estimate, adapter });
```

The hook owns one clock for the component's lifetime. A `beats` array that extends the previous one (same elements, more on the end) is appended to; any other array resets the clock.

## API

### `createNarrationClock(options)`

```ts
createNarrationClock<T>(options: {
  units?: Unit<T>[];
  estimate?: (unit: Unit<T>, prev: Unit<T> | undefined, index: number) => number;
  onAdvance: (index: number, source: ClockSource) => void;
  onInterrupt?: "hold" | "reset" | ((index: number) => void);  // default "hold"
  leadMs?: number;                                               // default 0
  grace?: { baseMs?: number; perWordMs?: number };               // default 1500, 420
  timers?: { setTimeout; clearTimeout; now? };
  // walk options
  fireFirst?: boolean;                                           // default false
  lookahead?: number;                                            // default 8
  overshoot?: number;                                            // default 3
  openWords?: number;                                            // default 1
}): NarrationClock<T>
```

| Option        | Description |
| ------------- | ----------- |
| `units`       | Ordered narration units. May be empty and filled with `append()`. |
| `estimate`    | Expected spoken duration of a unit in ms. Drives the fallback timer clock. Omit to run without one. |
| `onAdvance`   | Called when the index advances. Indices increase; some may be skipped. `source` is which clock advanced it. |
| `onInterrupt` | Behaviour on `interrupt()`. `"hold"` keeps the index. `"reset"` returns to the resting index. A function receives the current index. |
| `leadMs`      | Delay applied to spoken cues. See [Latency](#latency). |
| `grace`       | Wait applied to `hint()` before it is trusted: `baseMs + remaining words in current unit × perWordMs`. |
| `timers`      | Timer implementation. Inject fakes for synchronous tests. |
| `fireFirst`   | Report unit 0 when its first word is heard. Off when unit 0 is already on screen before speech. |
| `lookahead`   | Tokens searched ahead when the next spoken word does not match at the cursor. |
| `overshoot`   | Unmatched words past the end of the current unit before the next is assumed started. `0` disables. |
| `openWords`   | Consecutive matching words required before the walk opens. Set above 1 when non-script speech precedes unit 0 in the same stream. |

### `NarrationClock<T>`

| Member         | Description |
| -------------- | ----------- |
| `start()`      | Begins the estimate clock. Call when the bot starts speaking, not when the turn is requested. No-op if no `estimate`. |
| `feed(text)`   | Consumes spoken text — a word, several, or a sentence. Returns indices newly reached. |
| `append(unit)` | Adds a unit to the end. Units whose `prose` is already present are dropped. Schedules its estimate if that clock is running. |
| `hint(i)`      | An external source (e.g. the server began synthesising unit `i`) believes `i` has started. Applied after the grace period unless the words arrive first. |
| `interrupt()`  | Stops both clocks and applies `onInterrupt`. |
| `stop()`       | Stops both clocks. |
| `reset(units)` | Replaces the units and returns to the resting state. Bindings survive. |
| `index`        | Current index. `-1` before the first unit when `fireFirst` is set. |
| `source`       | `"spoken"`, `"estimate"`, `"hint"`, `"interrupt"`, or `"idle"`. |
| `running`      | Whether `start()` has been called and not yet stopped. |
| `walk`         | The underlying `SpokenWalk`. |

### `SpokenWalk<T>`

The matcher, exported for use without timers (e.g. captions).

```ts
new SpokenWalk<T>(units?: Unit<T>[], options?: { fireFirst?, lookahead?, overshoot?, openWords? })
```

| Member         | Description |
| -------------- | ----------- |
| `feed(text)`   | Returns indices whose first word has now been heard, in order, each once. |
| `append(unit)` | As above. |
| `jump(i)`      | Moves the cursor to the start of unit `i` and marks it reached. |
| `unit(i)`      | The unit at `i`. |
| `reached`      | Highest index reached. |
| `remaining`    | Tokens of the current unit not yet heard. |
| `length`       | Number of units. |

### Adapters

```ts
type Adapter<T> = { bind(clock: NarrationClock<T>): () => void };
```

### Helpers

```ts
clauses(text: string): string[]    // splits at . ! ? — – ; and ", so"
tokenize(text: string): string[]   // lowercase, letters and digits only
```

### Types

```ts
type Unit<T = unknown> = { prose: string } & T;
type ClockSource = "spoken" | "estimate" | "hint" | "interrupt";
```

## Behaviour

### Clocks

Two clocks advance the index. Only one is active at a time.

- **Estimate.** Started by `start()`. Schedules each unit at the cumulative `estimate()` of the units before it. Drift accumulates with the difference between the estimate and the voice's actual pace.
- **Spoken.** Driven by `feed()`. On the first index it reaches, all pending estimate timers are cancelled and the estimate clock does not resume for the remainder of the run.

If no spoken text ever arrives (mock transport, TTS without alignment), the estimate clock runs to completion. If no `estimate` is given, only the spoken clock and hints advance the index.

### Matching

`feed()` tokenizes input and walks it against the concatenated tokens of all units.

- **Exact match** advances one position.
- **Mismatch** searches ahead up to `lookahead` positions for the incoming token. Handles the TTS merging, splitting or skipping tokens.
- **Prefix match** is accepted within the lookahead only when the incoming token is at least 4 characters and the candidate is at most 4 characters longer. Prevents `"you"` claiming `"youre"`.
- **No match** holds position and counts the token toward `overshoot`. Once `overshoot` more words have been heard than the current unit contains, the next unit is assumed started.
- The reached index is monotonic. A resync never lowers it.

Tokens are lowercased and stripped to `\p{L}` and `\p{N}`. `"$1.7B"` and `"one-point-seven"` each become a single token.

### Opening

With `openWords > 1`, matches before the walk opens are tentative: the cursor does not move until that many consecutive tokens match from the start of the first unit. A miss resets the run. This is for streams where the agent says something not in the script before unit 0 — a status line, an acknowledgement — that may contain the same words.

### Hints

`hint(i)` is for a second, less precise source that knows a unit has started — typically the server reporting that TTS began synthesising it, which precedes playback by the pipeline's buffer. The hint is applied after `grace.baseMs + remaining × grace.perWordMs`, unless the spoken clock reaches `i` first, in which case it is discarded.

### Latency

`leadMs` defaults to `0`. Cues are applied on arrival.

Pipelines that forward TTS alignment (Pipecat via `botTtsText`, LiveKit with `use_tts_aligned_transcript`) hold each word event until that word's own timestamp on the output clock, then send it outside the paced audio queue. The event arrives within a network hop of the word being audible. It is not early by the client-side audio buffer, and delaying it by that buffer makes the visual trail the audio by that amount.

Measure before setting `leadMs` to anything other than `0`.

The ElevenLabs adapter is the exception: alignment arrives with the audio chunk at synthesis time, so the adapter schedules each word at its own offset from playback start. See [ElevenLabs](#elevenlabs).

### Interruption

`interrupt()` stops both clocks. With the default `"hold"`, the index stays where it was; the remaining units are never emitted. Use `"reset"` or a callback if the surface requires otherwise.

### Duplicate units

The same sentence can reach the client twice — once as model output, once as TTS text. `append()` drops a unit whose `prose` already exists, so the second copy cannot strand the walk on tokens the voice will not produce.

## Adapters

Each adapter binds one voice stack's events to `start` / `feed` / `interrupt` and is under 60 lines. Read one and you can write your own.

The Pipecat adapter is exercised in production. The LiveKit, ElevenLabs and AG-UI adapters are written against the current SDK typings and have not yet been run against live sessions.

### Pipecat

```ts
import { fromPipecat } from "narration-clock/pipecat";
fromPipecat(client).bind(clock);
```

Binds `botStartedSpeaking`, `botTtsText`, `userStartedSpeaking` on a `PipecatClient`. Requires TTS alignment forwarding on the server-side TTS service. If you use constructor `callbacks` rather than `client.on`, call the clock methods from `onBotStartedSpeaking`, `onBotTtsText` and `onUserStartedSpeaking` directly.

### LiveKit

```ts
import { fromLiveKit } from "narration-clock/livekit";
fromLiveKit(room, { agentIdentity? }).bind(clock);
```

Binds `participantAttributesChanged` (`lk.agent.state === "speaking"` starts), `transcriptionReceived` (agent segments fed; only the appended suffix of a growing segment), `activeSpeakersChanged` (local participant speaking interrupts). Requires `use_tts_aligned_transcript=True` on the `AgentSession`.

### ElevenLabs

```ts
import { fromElevenLabs } from "narration-clock/elevenlabs";

const el = fromElevenLabs();
el.bind(clock);
ws.onmessage = (e) => el.message(JSON.parse(e.data));
audio.onplay   = () => el.playbackStarted();
```

For the streaming TTS websocket. Words are assembled from `alignment.chars` and scheduled at `charStartTimesMs` relative to `playbackStarted()`. Call `el.interrupted()` on barge-in.

### AG-UI

AG-UI carries no audio timing. Units and spoken text travel as `Custom` events:

```ts
// agent
emit({ type: "CUSTOM", name: "beat",        value: unit });
emit({ type: "CUSTOM", name: "beat.spoken", value: { text } });
emit({ type: "CUSTOM", name: "beat.started" });
emit({ type: "CUSTOM", name: "beat.interrupted" });
```

```ts
// client
import { fromAgUi } from "narration-clock/ag-ui";
fromAgUi(agent).bind(clock);          // event names configurable via second argument
```

The agent side must emit `beat.spoken` from its own TTS word stream. No AG-UI integration does this.

### None

```ts
ws.on("audio_start", () => clock.start());
ws.on("alignment",   (a) => clock.feed(a.text));
```

## Porting an existing matcher

Two shapes this replaces, and the options that reproduce them:

**Client-side word walk with a timer fallback** (estimate runs from `start()`, first real word takes over):

```ts
createNarrationClock({ units, estimate, onAdvance })
```

**Per-beat cursor with overshoot and a server `beat-start` message** (no timers; the server hint fills in when the words are unrecognisable):

```ts
const clock = createNarrationClock({ units: [], fireFirst: true, openWords: 2, onAdvance });
onServerMessage((m) => {
  if (m.type === "beat")       clock.append(m.beat);
  if (m.type === "beat-start") clock.hint(m.index);
});
onTtsText((text) => clock.feed(text));
```

`fireFirst: true` because the first beat is withheld from the screen until its first word; `openWords: 2` because a status line precedes it in the same stream and may name the same place.

Captions at clause granularity run a second walk over the same stream:

```ts
import { SpokenWalk, clauses } from "narration-clock";
const captions = new SpokenWalk(beats.flatMap((b) => clauses(b.prose).map((prose) => ({ prose }))), { fireFirst: true });
onTtsText((text) => { for (const k of captions.feed(text)) show(captions.unit(k)!.prose); });
```

## Non-goals

- Defining a beat schema. Only `prose` is read.
- Transport. Units arrive however the application delivers them.
- Rendering or animation. The output is an index.
- Audio or TTS.

## License

MIT
