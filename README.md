# beatkeeper

Keeps a voice agent's interface on the sentence the listener is hearing.

You give it your narration as an ordered list of beats, each with the words that will be spoken and whatever your UI needs. Your voice stack feeds it the words as they become audible. It tells you which beat the listener is on. It renders nothing and moves no audio.

```
npm install beatkeeper
```

> **[VISUAL 1 — hero]** One frame, two rows against a shared time axis. Top row: "LLM finished writing" at 2s. Bottom row: the voice still speaking at 20s, with the three beat boundaries marked at 4s, 9s and 15s. Caption: the interface should change at the marks on the bottom row, not at the one on top.

---

## The problem

A voice agent writes its answer faster than it can say it. For a chat interface that is fine: the text appears, the voice catches up, nobody minds. For an interface that *changes while the agent talks* — a map that flies to the place being described, a chart that highlights the series being discussed, a graph that lights the story being recalled — it is the whole problem.

Suppose the agent will say:

1. "Fighting increased near Pokrovsk."
2. "Further south, activity shifted toward Zaporizhzhia."
3. "Meanwhile, strikes were reported inside Russia."

Your map should fly to Pokrovsk when the listener *hears* "Pokrovsk", not when the model *wrote* it. If you render on the model's output, all three moves happen in the first two seconds and the map sits on Russia while the voice is still on Pokrovsk. If you render on the text-to-speech request, you are closer, but still ahead by however much audio is buffered between the synthesiser and the speaker, which is seconds, and varies.

The text goes through five states, and only the last one is the one you want to render on:

```
generated  →  sent to TTS  →  synthesised  →  received by the client  →  audible
```

Voice stacks expose "audible" in very different ways. Some pace one event per word to the playback clock. Some hand you a transcript that grows as the agent speaks. Some give you character timestamps that arrive *with* the audio, ahead of playback, and leave the scheduling to you. Some give you nothing usable at all. The signal you build against today is not the signal you get after switching model, endpoint, transport or SDK version.

beatkeeper turns all of those into one thing: an index into your beats that moves when the listener's ear does.

> **[PRODUCTION EXAMPLE A — Attaché]** Short clip or three stills of the landing demo at attache.news: the story graph, a sentence being spoken, the caption chip and the bridge line arriving on today's story as the voice names it. This is the "graph that lights the story being recalled" case. Ideally with the subtitle visible so the word-to-picture timing is legible in a still.

> **[PRODUCTION EXAMPLE B — sitrep]** The map flying to a place on the beat that names it, with the timeline sweep. Two stills, before and after, with the spoken sentence under each.

---

## The model

A beat is anything with `prose`:

```ts
const beats = [
  { prose: "Fighting increased near Pokrovsk.",                   map: pokrovsk },
  { prose: "Further south, activity shifted toward Zaporizhzhia.", map: zaporizhzhia },
  { prose: "Meanwhile, strikes were reported inside Russia.",      map: russia },
];
```

beatkeeper reads `prose`. Everything else is yours and is handed back to you untouched.

```
beats[]  ──expected words──▶  SpokenWalk  ◀──spoken words──  your voice stack
                                  │
                                  ▼
                            index: 0 → 1 → 2
                                  │
                                  ▼
                       onAdvance(index, source, beat)  →  you render beats[index]
```

The index only moves forward during a run. It may skip a beat when the voice does. It never goes back.

---

## Quick start

```ts
import { createNarrationClock } from "beatkeeper";

const clock = createNarrationClock({
  units: beats,
  onAdvance: (index, source, beat) => render(beat),
});

client.on("botStartedSpeaking",  () => clock.start());
client.on("botTtsText",          (e) => clock.feed(e.text));   // words, as they are heard
client.on("botStoppedSpeaking",  () => clock.stop());
client.on("userStartedSpeaking", () => clock.interrupt());
```

Or with an adapter that does the same binding for you:

```ts
import { fromPipecat } from "beatkeeper/pipecat";
const unbind = fromPipecat(client).bind(clock);
```

That is the whole integration. The rest of this document is about why it is shaped this way.

---

## Where the timing comes from

Two lanes leave the voice stack. The audio lane is not beatkeeper's business — WebRTC or WebSocket, Opus or PCM, it does not care. The second lane is the one it reads: *evidence about which words are audible right now.*

```
AUDIO      [chunk][chunk][chunk][chunk][chunk] ───────────────▶ speaker

TEXT             "Fighting"   "increased"   "near"   "Pokrovsk" ───▶ clock.feed()
```

> **[VISUAL 2 — the two lanes]** The diagram above drawn properly, with the audio lane opaque and the text lane's words sitting under the audio chunks they belong to. A small bracket showing "buffer" between where a chunk is received and where it is heard.

Providers expose that second lane in four ways, and an adapter's whole job is to turn each into `clock.feed(text)` at the moment the text is audible:

| Paradigm | Example | What the adapter does |
|---|---|---|
| Paced word events | Pipecat `botTtsText`, LiveKit aligned transcripts | Feed on arrival. The pipeline already held each word to its timestamp. |
| Growing transcript | LiveKit `transcriptionReceived` segments | Feed only the newly appended suffix of each segment. |
| Timestamps ahead of playback | ElevenLabs `alignment.char_start_times_ms` | Assemble words, schedule each at its offset from the moment playback started, then feed. |
| Nothing | A protocol with no audio timing (AG-UI); a TTS without alignment | Run the estimate clock (below), or have the agent side emit its own spoken events. |

The point of putting this in adapters rather than in your application: timing behaviour differs not only between vendors but between models, endpoints, transports and SDK generations of the *same* vendor. The adapter is where that churn lives. Your application keeps reasoning in beats.

Adapters ship for Pipecat, LiveKit, ElevenLabs and AG-UI. Each is under sixty lines; read one and you can write your own. See [Adapters](#adapters).

---

## Why the matching is fuzzy

The words the TTS reports are not the words you sent it. It reads "27th" as "twenty seventh", "$1.7B" as "one point seven billion", drops a filler, merges a hyphenation, splits a contraction. So the walk does not compare strings; it walks a cursor through the expected tokens and tolerates local damage.

```
expected:  on  the  27th  a  strike  hit  the  orlivka  border  crossing
heard:     on  the  twenty  seventh  a  strike  hit ...
                    ▲       ▲       ▲
                    hold    hold    "a" is ahead in this beat → re-anchor there
```

The rules, in the order they are tried:

1. **The word at the cursor.** Exact match, cursor moves one.
2. **Anywhere later in the current beat.** The voice skipped or merged something. A prefix counts if it is substantial: "khark" claims "kharkiv"; "you" does not claim "you're".
3. **The next beat.** This changes what is on screen, so it takes more evidence than one word. Either the current beat was nearly done, or two words in a row match the next beat in order. One stray "the" cannot move the picture; "the EU" can.
4. **Nothing matched.** Hold. But if three words in a row cannot be placed once the cursor is at the end of a beat, the next beat has started however it was read.

A beat two ahead is never reached on words alone. If the voice really is that far from the script, that is not a matching problem; see [Fallbacks](#fallbacks).

> **[VISUAL 3 — the walk]** The token diagram above, animated or as three stills: cursor at "27th", holding through "twenty" and "seventh", jumping to "a". Optional fourth still showing a stray "the" *not* crossing into the next beat.

Tokens are lowercased and stripped to letters and digits, in any script. A `normalize` option lets you map tokens further — number words, stems, a language's inflections — and it is applied to script and speech alike.

---

## TTS chunks are not beats

Four granularities are in play and only two of them are yours:

```
LLM generation      tokens, fragments           the model's
TTS input           sentences or clauses        the voice pipeline's — prosody needs context
TTS alignment       words or characters         the voice pipeline's
beats               wherever the UI should move yours
```

Send the TTS whole sentences; it sounds better that way. Cut your beats wherever the picture should change, including inside a sentence, as long as the alignment lane is at least word-grained:

```ts
// One sentence to the synthesiser:
"Near Pokrovsk, forces advanced overnight."

// Three beats to beatkeeper:
[
  { prose: "Near Pokrovsk,",   map: { center: "Pokrovsk" } },
  { prose: "forces advanced",  map: { arrows: true } },
  { prose: "overnight.",       timeline: { highlight: "overnight" } },
]
```

The Attaché demo does exactly this: each sentence of the opener goes to the synthesiser whole, and the beats are the sentence's clauses, so a callback like "you'd asked why OPEC+ was holding — now Saudi's had to shut its pipeline" turns the picture at the dash.

Chunk size on the way in does not matter either. These three are the same to the walk:

```ts
clock.feed("Further"); clock.feed("south");
clock.feed("Further south");
clock.feed("Further south, activity shifted toward Zaporizhzhia.");
```

---

## Fallbacks

Two, and both are explicit.

**Estimate.** For a voice stack with no usable alignment. Give the clock an `estimate(beat)` in milliseconds and call `start()` when the bot starts speaking; it steps through the beats on that schedule. It is wrong by however much the voice's real pace differs, and the error accumulates, so it is a degraded mode, not a default. The moment a spoken word reaches a beat, the estimate is cancelled for the rest of the run.

```ts
createNarrationClock({
  units: beats,
  estimate: (b) => b.prose.split(/\s+/).length * 400,
  onAdvance,
});
```

**Sync.** For a caller that knows. `clock.sync(index)` re-anchors the cursor at that beat, now. It is not a guess and not a second clock: it is you asserting the position.

A common early signal — the server saying "TTS began synthesising beat 3" — is *not* knowledge of what is audible; synthesis runs ahead of the ear by the pipeline's buffer. `withHints` turns that into a late `sync`: it waits a grace period sized to what the current beat still has to say, and drops the hint if the words arrive first.

```ts
import { withHints } from "beatkeeper";
const hinted = withHints(clock);              // { hint, feed, cancel }
onServerMessage((m) => { if (m.type === "beat-start") hinted.hint(m.index); });
onTtsText((text) => hinted.feed(text));      // through the wrapper, so a hint is dropped when words win
```

When neither applies, beatkeeper holds rather than inventing certainty.

---

## Interruption

`clock.interrupt()` on barge-in. It stops the clocks and holds the index where it is. If the interface should reset, that is your call: `clock.reset(nextBeats)` when the next turn's beats exist.

---

## React

```tsx
import { useNarrationClock } from "beatkeeper/react";
import { fromPipecat } from "beatkeeper/pipecat";

const adapter = useMemo(() => fromPipecat(client), [client]);
const { index, source } = useNarrationClock(beats, { adapter });
```

One clock for the component's lifetime. A `beats` array that extends the previous one — same prose, more on the end — is appended to; any other array resets the clock.

---

## API

### `createNarrationClock(options)`

```ts
createNarrationClock<T>({
  units?: Unit<T>[];
  onAdvance: (index: number, source: ClockSource, unit: Unit<T>) => void;
  estimate?: (unit: Unit<T>, prev: Unit<T> | undefined, index: number) => number;
  fireFirst?: boolean;                        // report unit 0 on its first word (default: unit 0 is already on screen)
  openWords?: number;                         // words in a row before the walk opens (default 1)
  normalize?: (token: string) => string;      // applied to every token
  timers?: Timers;                            // test seam
}): NarrationClock<T>
```

| Member          | |
|-----------------|---|
| `start()`       | Begin the estimate clock. Call when the bot starts speaking. No-op while running. |
| `feed(text)`    | Spoken text, as it becomes audible. Any chunk size. |
| `append(unit)`  | Add a unit to the end. |
| `sync(index)`   | Assert that `index` is being heard. |
| `interrupt()`   | Stop the clocks, hold the index. |
| `stop()`        | Stop the clocks. Call when the bot stops speaking. |
| `reset(units?)` | Replace the units; back to rest. |
| `index`         | Current index. `-1` before the first unit when `fireFirst` is set. |
| `source`        | `"spoken"`, `"estimate"`, `"sync"`, or `"idle"`. |
| `running`       | Between `start()` and `stop()`/`interrupt()`. |
| `remaining`     | Tokens of the current unit not yet heard. |
| `progress`      | Fraction of the current unit heard, 0..1. |

`fireFirst` is the one real product choice here: whether beat 0 is already on screen before the voice starts (a map at rest, a graph waiting) or nothing is shown until the first word (a caption).

`openWords` is for a stream where unscripted speech precedes the script and may share its words — an acknowledgement that names the place the first beat names. With `openWords: 2` the walk does not open until two script words arrive in a row.

### `SpokenWalk`

The matcher on its own, for uses that want no timers — captions at clause grain, for instance:

```ts
import { SpokenWalk, clauses } from "beatkeeper";
const captions = new SpokenWalk(beats.flatMap((b) => clauses(b.prose).map((prose) => ({ prose }))), { fireFirst: true });
onTtsText((text) => { for (const k of captions.feed(text)) show(captions.unit(k)!.prose); });
```

`feed(text)` returns the indices newly reached. `append`, `jump(i)`, `unit(i)`, `reached`, `remaining`, `progress`, `length` as above.

### Helpers

```ts
clauses(text)    // sentence → caption-sized pieces: at . ! ? — – ; and ", so"
tokenize(text)   // lowercase, letters and digits only, any script
withHints(clock, { baseMs?, perWordMs? })
compose(...adapters)
```

---

## Adapters

```ts
type Adapter<T> = { bind(clock: NarrationClock<T>): () => void };
```

**Pipecat** — `fromPipecat(client, { source? })`. Binds `botStartedSpeaking`, `botStoppedSpeaking`, `userStartedSpeaking`, and one of two audible-text signals: `botTtsText` (default; one event per word, needs alignment forwarding on the server's TTS service) or `botOutput` with `spoken_progress` (segment-scoped; only the newly heard suffix is fed). Never both — they carry the same words. Pipecat holds each word event to its own timestamp on the output clock and sends it outside the paced audio queue, so it arrives within a network hop of being audible. Feed it as is. If your player buffers on top, hold the feed by that buffer yourself; do not guess.

**LiveKit** — `fromLiveKit(room, { agentIdentity? })`. Binds `participantAttributesChanged` (agent state `speaking` starts; leaving it stops), `transcriptionReceived` (the appended suffix of each growing segment), `activeSpeakersChanged` (the local participant speaking interrupts). Requires `use_tts_aligned_transcript=True` on the `AgentSession`. Note: LiveKit has since moved transcripts to text streams on the `lk.transcription` topic; this adapter targets the event API and has not been run against a live room.

**ElevenLabs** — `fromElevenLabs()`, for the `/stream-input` text-to-speech socket. Alignment arrives *with* the audio, ahead of playback, so the adapter assembles words from `alignment.chars` and schedules each at its `char_start_times_ms` offset from `playbackStarted()`. Accepts the raw snake_case wire shape and the SDK's camelCase. The v3 text-to-dialogue socket is a different protocol and is not covered. Not yet run against a live socket.

```ts
const el = fromElevenLabs();
el.bind(clock);
ws.onmessage = (e) => el.message(JSON.parse(e.data));
audio.onplay = () => el.playbackStarted();
```

**AG-UI** — `fromAgUi(agent, names?)`. AG-UI carries no audio timing, so units and spoken text travel as `Custom` events (`beat`, `beat.spoken`, `beat.started`, `beat.interrupted`) that the agent side must emit from its own TTS word stream. Not yet run against a live agent.

**Your own.** Three calls: `clock.start()` when speech starts, `clock.feed(text)` when text is audible, `clock.stop()` when speech ends. `clock.interrupt()` on barge-in if the stack has one.

---

## Non-goals

- Audio: transport, buffering, playback, codecs.
- Defining your beat schema. Only `prose` is read.
- Rendering or animation. The output is an index.
- Repairing a broken provider stream, or de-duplicating your own messages.
- Guessing the audible position when no evidence exists. It holds.

## License

MIT
