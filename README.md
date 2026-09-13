# beatkeeper

Keeps a voice agent's interface on the words the listener is *hearing*, not the words the model *wrote*.

You describe the narration as an ordered list of beats: the words that will be spoken, plus whatever your UI needs at that moment. Your voice stack tells beatkeeper what is audible as it becomes audible. beatkeeper tells you which beat the listener is on. It renders nothing and touches no audio.

```
npm install beatkeeper
```

> **[VIDEO A — Attaché, 15s]** The landing demo at attache.news. The bot reads the founder's briefing; as each sentence is spoken the story graph lights the story being told and draws the bridge to the one it connects to. Subtitle visible, so word-to-picture timing is legible.

> **[VIDEO B — sitrep, 10s]** The map flying to a place on the beat that names it, with the timeline sweep; the spoken sentence under the frame.

Both run on the same 40 lines of integration shown under [Quick start](#quick-start).

---

## Why "when the model wrote it" is the wrong moment

A voice agent writes its answer in two seconds and takes twenty to say it. If your map, chart or graph moves when text is *generated*, all of its moves happen in the first two seconds and the picture sits on the last beat while the voice is still on the first. If it moves when text is *sent to the synthesiser*, it is closer, but still ahead by however much audio is buffered between the synthesiser and the speaker, which is seconds and varies.

```
generated  →  sent to TTS  →  synthesised  →  received by the client  →  audible
```

Only the last state is the one to render on. Everything before it is a guess with a timestamp attached.

> **[VISUAL 1 — hero]** Two rows on one time axis. Top: "model finished writing" at 2s. Bottom: the voice reaching beats 1, 2, 3 at 4s, 9s, 15s. Caption: the picture should change at the bottom marks.

beatkeeper's job is to turn whatever your stack knows about "audible" into one thing: an index into your beats that moves when the listener's ear does.

```ts
const beats = [
  { prose: "Fighting increased near Pokrovsk.",                    map: pokrovsk },
  { prose: "Further south, activity shifted toward Zaporizhzhia.", map: zaporizhzhia },
  { prose: "Meanwhile, strikes were reported inside Russia.",      map: russia },
];
```

Only `prose` is read. Everything else is yours and comes back untouched in `onAdvance(index, source, beat)`.

---

## Problem 1: every stack reports "audible" differently

There is no standard `spoken_at` field. What exists is four different shapes, and one vendor can move between them when you change model, endpoint, transport or SDK version. These are real payloads.

**Pipecat, one RTVI message per word, released at the word's own time on the bot's output clock:**

```json
{ "label": "rtvi-ai", "type": "bot-tts-text", "data": { "text": "Pokrovsk." } }
```

**Pipecat, the same words as a sentence that fills in** (`bot-output`, one message per word boundary, keyed by segment):

```json
{ "label": "rtvi-ai", "type": "bot-output", "data": {
    "text": "Fighting increased near Pokrovsk.", "aggregated_by": "sentence", "segment_id": 42,
    "will_be_spoken": true, "spoken_status": "in-progress",
    "spoken_progress": { "accumulated_text": "Fighting increased near", "remaining_text": " Pokrovsk." } } }
```

**ElevenLabs websocket** (`/stream-input`, and the v3 dialogue socket in snake_case with a `context_id`). Character timings arrive *with* the audio, seconds ahead of playback, and **every message numbers its characters from zero** whatever stream time it covers:

```json
{ "audio": "<base64>",
  "alignment": { "chars": ["G","o","o","d"," ","m"], "charStartTimesMs": [0,58,104,139,174,209], "charDurationsMs": [58,46,35,35,35,35] },
  "isFinal": null }
```

**ElevenLabs HTTP** (`/stream/with-timestamps`), a different shape again, in seconds, counted from the start of the request's audio rather than per chunk:

```json
{ "audio_base64": "<base64>",
  "alignment": { "characters": ["G","o","o","d"], "character_start_times_seconds": [0.0,0.058,0.104,0.139], "character_end_times_seconds": [0.058,0.104,0.139,0.174] } }
```

**LiveKit**, a transcription segment whose `text` grows as the agent speaks (with `use_tts_aligned_transcript=True`; without it the text arrives at generation time):

```json
{ "id": "SG_7f3a", "text": "Fighting increased near", "final": false, "language": "en" }
```

**Nothing.** AG-UI carries no audio timing at all, and neither does a TTS without alignment.

### How beatkeeper handles it

One call: `clock.feed(text)`, made when `text` is audible. Everything vendor-specific lives in an adapter whose whole job is to turn one of those shapes into that call at the right moment:

| Shape | Examples | What the adapter does |
|---|---|---|
| Paced word events | Pipecat `bot-tts-text`, LiveKit aligned transcripts | Feed on arrival. The pipeline already held the word to its time. |
| A transcript that grows | Pipecat `bot-output`, LiveKit segments | Feed only the newly appended suffix. |
| Timings ahead of playback | ElevenLabs websocket | Assemble words from characters, accumulate each message's span into a running stream offset, schedule each word at that offset from the moment playback started. |
| Nothing | AG-UI; a TTS without alignment | Run the [estimate](#problem-5-no-alignment-at-all), or have the agent side emit its own spoken events. |

Adapters ship for Pipecat, LiveKit, ElevenLabs and AG-UI, each a single short file; read one and you can write your own. The application never sees a payload. It reasons in beats.

---

## Problem 2: the voice does not say what you wrote

The words your stack reports back are the TTS's reading of your text, not your text. Expect, for a script line and what comes back:

```
script:  On the 27th a strike hit the Orlivka crossing — $1.7B in damage.
heard:   on the twenty seventh a strike hit the orlivka crossing one point seven billion dollars in damage
```

Numbers become words, symbols become phrases, punctuation vanishes, a filler is dropped, a hyphenation merges, a contraction splits. String equality fails inside the first sentence of real content. And the drift is not the same on every model or every day.

### How beatkeeper handles it

It does not compare strings. It tokenizes both sides (lower-case, letters and digits only, any script, so `$1.7B` survives as one token and punctuation never counts) and walks a cursor through the expected tokens, tolerating local damage:

```
expected:  on  the  27th  a  strike  hit  the  orlivka  crossing
heard:     on  the  twenty  seventh  a  strike  hit ...
                    ▲       ▲       ▲
                    hold    hold    "a" is ahead in this beat → the cursor jumps there
```

The rules, in the order they are tried:

1. **The word at the cursor.** Exact match, cursor moves one.
2. **Anywhere later in the current beat.** The voice skipped or merged something; the beat is the same either way, so one word is enough to re-anchor. A prefix counts if it is substantial: "khark" claims "kharkiv"; "you" does not claim "you're".
3. **The next beat.** This changes what is on screen, so it takes more evidence: either the current beat was nearly done, or two words in a row match the next beat in order. One stray "the" cannot move the picture; "the EU" can.
4. **Nothing matched.** Hold. But after three words in a row that cannot be placed once the cursor is at the end of a beat, the next beat has started however it was read.

The bar is asymmetric because the cost is: moving inside a beat changes nothing on screen, crossing into the next one does. The index only ever moves forward. It may skip a beat when the voice does; it never goes back, because a picture that rewinds reads as broken in a way that one running slightly behind does not.

> **[VISUAL 2 — the walk]** Three stills of the diagram above: cursor at "27th", holding through "twenty" and "seventh", jumping to "a". A fourth: a stray "the" not crossing into the next beat.

A `normalize` option maps tokens further (number words, stems, a language's inflections) and is applied to script and speech alike.

---

## Problem 3: chunk sizes vary, and none of them is your beat

Four granularities are in play and only one is yours:

```
LLM generation     tokens, fragments              the model's
TTS input          sentences or clauses           the voice pipeline's; prosody needs context
TTS alignment      words or characters            the voice pipeline's
beats              wherever the picture moves     yours
```

Send the synthesiser whole sentences; it sounds better that way. Cut your beats wherever the picture should change, including inside a sentence, as long as the alignment lane is at least word-grained:

```ts
// One sentence to the synthesiser:
"Near Pokrovsk, forces advanced overnight."

// Three beats to beatkeeper:
[
  { prose: "Near Pokrovsk,",  map: { center: "Pokrovsk" } },
  { prose: "forces advanced", map: { arrows: true } },
  { prose: "overnight.",      timeline: { highlight: "overnight" } },
]
```

Attaché does exactly this: each sentence goes to the synthesiser whole, and the beats are its clauses (`clauses()` below), so a callback like "you'd asked why OPEC+ was holding — now Saudi's had to shut its pipeline" turns the picture at the dash.

Chunk size on the way in does not matter either. These are the same to the walk:

```ts
clock.feed("Further"); clock.feed("south");
clock.feed("Further south");
clock.feed("Further south, activity shifted toward Zaporizhzhia.");
```

Beats can also arrive while the voice is already speaking: `clock.append(beat)` adds to the end of a running narration, which is what a model streaming its script needs.

---

## Problem 4: the stream stalls, runs ahead, or gets cut off

**The player buffers.** Text fed to the clock is taken to be audible *now*. Pipecat's word events arrive within a network hop of being audible; if your player buffers on top of that, hold the feed by the buffered amount yourself (Attaché measures the player's lag and delays each word by it). Do not guess a constant.

**A source that knows.** `clock.sync(index)` re-anchors the walk at a beat, now. It is for a caller that knows, not a guess: a server that tracks playback, a caption track with its own timing.

**A source that runs early.** A server saying "synthesis started on beat 3" is true, and ahead of the ear by the whole pipeline buffer. `withHints` turns that into a late sync: it waits a grace period sized to what the current beat still has to say, then syncs; if spoken words reach the beat first, the hint is dropped.

```ts
const hinted = withHints(clock);               // { hint, feed, cancel }
onServerMessage((m) => { if (m.type === "beat-start") hinted.hint(m.index); });
onTtsText((text) => hinted.feed(text));       // through the wrapper, so words beat hints
```

**Barge-in.** `clock.interrupt()` holds the index where it is. When the next turn's beats exist, `clock.reset(nextBeats)`.

**Silence between utterances.** `stop()` when the bot stops speaking pauses the estimate clock; the next `start()` resumes it where it paused rather than from the first beat, so binding the pair to a pipeline's per-utterance events is safe.

---

## Problem 5: no alignment at all

Some stacks give you nothing usable. Give the clock an `estimate(beat)` in milliseconds and call `start()` when the bot starts speaking; it steps through the beats on that schedule.

```ts
createNarrationClock({
  units: beats,
  estimate: (b) => b.prose.split(/\s+/).length * 400,
  onAdvance,
});
```

It is wrong by however much the voice's real pace differs, and the error accumulates, so it is a degraded mode, not a default. The moment a spoken word reaches any beat, every pending estimate is cancelled and the estimate does not resume for the rest of the run: a clock that flips between evidence and guesswork produces a picture that stutters. When neither words nor an estimate apply, beatkeeper holds rather than inventing certainty.

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

Or let an adapter do the same binding:

```ts
import { fromPipecat } from "beatkeeper/pipecat";
const unbind = fromPipecat(client).bind(clock);
```

`onAdvance` runs synchronously inside `feed()`, so `clock.index` is already current when your handler returns.

### React

```tsx
import { useNarrationClock } from "beatkeeper/react";
import { fromPipecat } from "beatkeeper/pipecat";

const adapter = useMemo(() => fromPipecat(client), [client]);
const { index } = useNarrationClock(beats, { adapter });
return <Map focus={beats[index]?.map} />;
```

One clock for the component's lifetime. A `beats` array that extends the previous one (same prose, more on the end) is appended to; any other array resets the clock.

When the picture is driven by more than the index (Attaché keeps the clock inside a director object that also owns a spotlight and the graph), skip the hook and hold the clock in a ref:

```tsx
const clockRef = useRef<NarrationClock<Beat> | null>(null);
useEffect(() => {
  const clock = createNarrationClock({ units: beats, onAdvance: (i) => setIndex(i) });
  clockRef.current = clock;
  return () => clock.stop();
}, []);
// callbacks: clockRef.current?.feed(text)
```

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
| `start()`       | Begin the estimate clock, or resume it after `stop()`. Call when the bot starts speaking. |
| `feed(text)`    | Spoken text, as it becomes audible. Any chunk size. |
| `append(unit)`  | Add a unit to the end. |
| `sync(index)`   | Assert that `index` is being heard. |
| `interrupt()`   | Pause the clocks, hold the index. |
| `stop()`        | Pause the clocks. Call when the bot stops speaking. |
| `reset(units?)` | Replace the units; back to rest. |
| `index`         | Current index. `-1` before the first unit when `fireFirst` is set. |
| `source`        | `"spoken"`, `"estimate"`, `"sync"`, or `"idle"`. |
| `running`       | Between `start()` and `stop()`/`interrupt()`. |
| `remaining`     | Tokens of the current unit not yet heard. |
| `progress`      | Fraction of the current unit heard, 0..1. |

`fireFirst` is the one real product choice: whether beat 0 is already on screen before the voice starts (a map at rest, a graph waiting) or nothing is shown until the first word (a caption).

`openWords` is for a stream where unscripted speech precedes the script and may share its words. With `openWords: 2` the walk does not open until two script words arrive in a row.

### `SpokenWalk`

The matcher on its own, no timers, for uses like captions at clause grain:

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

**Pipecat**: `fromPipecat(client, { source? })`. Binds `botStartedSpeaking`, `botStoppedSpeaking`, `userStartedSpeaking`, and one of the two audible-text signals: `botTtsText` (default; one event per word, needs alignment forwarding on the server's TTS service) or `botOutput` with `spoken_progress` (segment-scoped; only the newly heard suffix is fed). Never both; they carry the same words.

**LiveKit**: `fromLiveKit(room, { agentIdentity? })`. Binds `participantAttributesChanged` (agent state `speaking` starts; leaving it stops), `transcriptionReceived` (the appended suffix of each growing segment), `activeSpeakersChanged` (the local participant speaking interrupts). Requires `use_tts_aligned_transcript=True` on the `AgentSession`. LiveKit has since moved transcripts to text streams on the `lk.transcription` topic; this adapter targets the event API and has not been run against a live room.

**ElevenLabs**: `fromElevenLabs()`, for the `/stream-input` text-to-speech socket and the v3 `/text-to-dialogue/multi-stream-input` socket. Alignment arrives with the audio, ahead of playback, so the adapter assembles words from `alignment.chars` and schedules each at its offset from `playbackStarted()`. That offset is not the wire value: `char_start_times_ms` restarts at zero in every message, so the adapter accumulates each message's span (last character's start plus its duration) as it goes, whether or not the message completed a word. The dialogue socket multiplexes contexts, so assembly is kept per `context_id`; its alignment is opt-in (`sync_alignment=true`). Tested against captures from both live sockets ([fixtures](test/fixtures)). The HTTP `with-timestamps` endpoint is a different shape and is not covered.

```ts
const el = fromElevenLabs();
el.bind(clock);
ws.onmessage = (e) => el.message(JSON.parse(e.data));
audio.onplay = () => el.playbackStarted();
```

**AG-UI**: `fromAgUi(agent, names?)`. AG-UI carries no audio timing, so units and spoken text travel as `Custom` events (`beat`, `beat.spoken`, `beat.started`, `beat.interrupted`) that the agent side must emit from its own TTS word stream. Not yet run against a live agent.

**Your own.** Three calls: `clock.start()` when speech starts, `clock.feed(text)` when text is audible, `clock.stop()` when speech ends. `clock.interrupt()` on barge-in if the stack has one.

---

## Non-goals

- Audio: transport, buffering, playback, codecs.
- Your beat schema. Only `prose` is read.
- Rendering or animation. The output is an index.
- Repairing a broken provider stream, or de-duplicating your own messages.
- Guessing the audible position when no evidence exists. It holds.

## License

MIT
