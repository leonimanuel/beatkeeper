# beatkeeper

[![npm](https://img.shields.io/npm/v/beatkeeper.svg)](https://www.npmjs.com/package/beatkeeper)
[![CI](https://github.com/leonimanuel/beatkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/leonimanuel/beatkeeper/actions/workflows/ci.yml)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/npm/l/beatkeeper.svg)](LICENSE)

Keeps a voice agent's interface on the words the listener is *hearing*, not the words the model *wrote*.

A narration is described as an ordered list of beats: the words that will be spoken, plus whatever the interface needs at that moment. The voice stack reports what is audible as it becomes audible. beatkeeper resolves which beat the listener is on. It renders nothing and touches no audio.

---

## Quick start

```
npm install beatkeeper
```

A beat is an application object with one reserved field. `prose` is the words that will be spoken; everything else is whatever the picture needs when they are.

```ts
const beats = [
  { prose: "Fighting increased near Pokrovsk.",                    map: pokrovsk },
  { prose: "Further south, activity shifted toward Zaporizhzhia.", map: zaporizhzhia },
];
```

A clock over those beats binds to the voice stack. Pipecat here; LiveKit, ElevenLabs and AG-UI take the same shape:

```ts
import { createNarrationClock } from "beatkeeper";
import { fromPipecat } from "beatkeeper/pipecat";

const clock = createNarrationClock({
  units: beats,
  onAdvance: (index, source, beat) => focusMap(beat.map),
});

const unbind = fromPipecat(client).bind(clock);
```

That is the whole integration. The adapter hands the clock each word as it becomes audible, and `onAdvance` fires on the word that crosses into a new beat — not on every word, and not on a timer:

| As the voice says | beatkeeper |
|---|---|
| *(nothing yet)* | `clock.index` is `0` — beat 0 is the picture already on screen |
| `"Fighting"` `"increased"` `"near"` `"Pokrovsk."` | walks through beat 0. Nothing fires: beat 0 is showing already |
| `"Further"` | **`onAdvance(1, "spoken", beats[1])`** → `focusMap(zaporizhzhia)` |
| `"south,"` `"activity"` … | walks through beat 1. `clock.index` is `1`, the map has already moved |

The map moves when the voice reaches the sentence that names the place — not when the model finished writing it, seconds earlier. Nothing polls, and no timers run unless an [estimate](#no-alignment-at-all) is configured: the words are the clock.

The index starts at `0`, on the assumption that beat 0 is the picture already on screen when the voice begins, so the first `onAdvance` reports the *crossing* into beat 1. With `fireFirst: true` the index starts at `-1` and beat 0 is announced on its own first word instead — right for a caption, wrong for a map at rest.

`clock.index`, `clock.progress` and `clock.remaining` are readable at any time, for a caller that would rather pull than be pushed.

### The four calls underneath

`fromPipecat` binds four listeners:

```ts
client.on("botStartedSpeaking",  () => clock.start());
client.on("botTtsText",          (e) => clock.feed(e.text));   // words, as they are heard
client.on("botStoppedSpeaking",  () => clock.stop());
client.on("userStartedSpeaking", () => clock.interrupt());
```

`fromPipecat` adds teardown and the [`bot-output` variant](#pipecat) on top of those four. The four are the entire contract, so a stack with no adapter binds the same calls to its own events: `start()` when the bot starts speaking, `stop()` when it stops, `interrupt()` on barge-in where the stack reports one, and `feed(text)` when text becomes **audible** — not when it is generated, and not when it is sent to the synthesiser.

`feed` carries the whole idea, and [Problem 1](#problem-1-every-stack-reports-audible-differently) is about how differently each stack signals that the moment has arrived. It accepts any chunk size — a word, a clause, a whole sentence — and `onAdvance` runs synchronously inside it, so `clock.index` is already current when the handler returns.

[Adapters](#adapters) covers the other three and writing a new one; [React](#react) has a hook.

---

The rest of this README is about *why* keeping a picture on the voice is harder than it looks, and what beatkeeper does about it. Reference material begins at [API](#api).

## Why "when the model wrote it" is the wrong moment

A voice agent writes its answer in two seconds and takes twenty to say it. A map, chart or graph that moves when text is *generated* makes all of its moves in the first two seconds, then sits on the last beat while the voice is still on the first. Moving when text is *sent to the synthesiser* is closer, but still ahead of the ear by however much audio is buffered between the synthesiser and the speaker, which is seconds and varies.

```
generated  →  sent to TTS  →  synthesised  →  received by the client  →  audible
```

Only the last state is the one to render on. Everything before it is a guess with a timestamp attached.

beatkeeper turns whatever a stack knows about "audible" into one thing: an index into the beats that moves when the listener's ear does.

---

## Problem 1: every stack reports "audible" differently

There is no standard `spoken_at` field. What exists is four different shapes, and one vendor can move between them across a change of model, endpoint, transport or SDK version. Two real payloads, at opposite ends of the range.

**A word, already paced.** Pipecat's `bot-tts-text`, one RTVI message per word, released at the word's own time on the bot's output clock — audible when it arrives:

```json
{ "label": "rtvi-ai", "type": "bot-tts-text", "data": { "text": "Pokrovsk." } }
```

**Characters, timed, ahead of the ear.** The ElevenLabs websocket, where alignment arrives *with* the audio, seconds before playback, and **every message numbers its characters from zero** whatever stream time it covers:

```json
{ "audio": "<base64>",
  "alignment": { "chars": ["G","o","o","d"," ","m"], "charStartTimesMs": [0,58,104,139,174,209], "charDurationsMs": [58,46,35,35,35,35] },
  "isFinal": null }
```

Between those sit a transcript that grows in place, and no timing at all.

<details>
<summary>The other four payloads, for matching against a stream in hand</summary>

**Pipecat `bot-output`**, the same words as a sentence that fills in: one message per word boundary, keyed by segment.

```json
{ "label": "rtvi-ai", "type": "bot-output", "data": {
    "text": "Fighting increased near Pokrovsk.", "aggregated_by": "sentence", "segment_id": 42,
    "will_be_spoken": true, "spoken_status": "in-progress",
    "spoken_progress": { "accumulated_text": "Fighting increased near", "remaining_text": " Pokrovsk." } } }
```

**ElevenLabs v3 dialogue socket**, the same alignment shape in snake_case with a `context_id` per interleaved context.

**ElevenLabs HTTP** (`/stream/with-timestamps`), a different shape again, in seconds, counted from the start of the request's audio rather than per chunk:

```json
{ "audio_base64": "<base64>",
  "alignment": { "characters": ["G","o","o","d"], "character_start_times_seconds": [0.0,0.058,0.104,0.139], "character_end_times_seconds": [0.058,0.104,0.139,0.174] } }
```

**LiveKit**, a transcription segment whose `text` grows as the agent speaks (with `use_tts_aligned_transcript=True`; without it the text arrives at generation time):

```json
{ "id": "SG_7f3a", "text": "Fighting increased near", "final": false, "language": "en" }
```

</details>

### How beatkeeper handles it

One call: `clock.feed(text)`, made when `text` is audible. Everything vendor-specific lives in an adapter whose whole job is to turn one of those shapes into that call at the right moment:

| Shape | Examples | What the adapter does |
|---|---|---|
| Paced word events | Pipecat `bot-tts-text`, LiveKit aligned transcripts | Feed on arrival. The pipeline already held the word to its time. |
| A transcript that grows | Pipecat `bot-output`, LiveKit segments | Feed only the newly appended suffix. |
| Timings ahead of playback | ElevenLabs websocket | Assemble words from characters, accumulate each message's span into a running stream offset, schedule each word at that offset from the moment playback started. |
| Nothing | AG-UI; a TTS without alignment | Run the [estimate](#no-alignment-at-all), or emit spoken events from the agent side. |

Adapters ship for Pipecat, LiveKit, ElevenLabs and AG-UI, each a single short file that a new one can be written from. The application never sees a payload. It reasons in beats.

---

## Problem 2: the voice does not say what the script says

The words a stack reports back are the TTS's reading of the script, not the script itself. For one line, and what returns:

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

A `normalize` option maps tokens further (number words, stems, a language's inflections) and is applied to script and speech alike.

---

## Problem 3: chunk sizes vary, and none of them is the beat

Four granularities are in play, and only the last belongs to the application:

```
LLM generation     tokens, fragments              the model's
TTS input          sentences or clauses           the voice pipeline's; prosody needs context
TTS alignment      words or characters            the voice pipeline's
beats              wherever the picture moves     the application's
```

Whole sentences to the synthesiser sound better, so beats are cut independently of them: wherever the picture should change, including inside a sentence, as long as the alignment lane is at least word-grained.

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

Chunk size on the way in does not matter either: `feed("Further")` then `feed("south")`, `feed("Further south")`, and `feed("Further south, activity shifted toward Zaporizhzhia.")` are all the same to the walk.

Beats can also arrive while the voice is already speaking: `clock.append(beat)` adds to the end of a running narration, which is what a model streaming its script needs.

---

## Modes and edge cases

### When the stream stalls, runs ahead, or gets cut off

**The player buffers.** Text fed to the clock is taken to be audible *now*. Pipecat's word events arrive within a network hop of being audible; a player that buffers on top of that shifts the whole stream later, and the feed has to be held by the same amount. Attaché measures the player's lag and delays each word by it — a measured lag rather than a constant, since the buffer varies.

**A source that knows.** `clock.sync(index)` re-anchors the walk at a beat, now. It is for a caller that knows, not a guess: a server that tracks playback, a caption track with its own timing.

**A source that runs early.** A server saying "synthesis started on beat 3" is true, and ahead of the ear by the whole pipeline buffer. `withHints` turns that into a late sync: it waits a grace period sized to what the current beat still has to say, then syncs; if spoken words reach the beat first, the hint is dropped.

```ts
const hinted = withHints(clock);               // { hint, feed, cancel }
onServerMessage((m) => { if (m.type === "beat-start") hinted.hint(m.index); });
onTtsText((text) => hinted.feed(text));       // through the wrapper, so words beat hints
```

**Barge-in.** `clock.interrupt()` holds the index where it is. Once the next turn's beats exist, `clock.reset(nextBeats)` takes them.

**Silence between utterances.** `stop()` at the end of a turn pauses the estimate clock; the next `start()` resumes it where it paused rather than from the first beat, so the pair binds safely to a pipeline's per-utterance events.

### No alignment at all

Some stacks report nothing usable. An `estimate(beat)` in milliseconds, with `start()` called when the bot starts speaking, steps the index through the beats on that schedule.

```ts
createNarrationClock({
  units: beats,
  estimate: (b) => b.prose.split(/\s+/).length * 400,
  onAdvance,
});
```

It is wrong by however much the voice's real pace differs, and the error accumulates, which makes it a degraded mode rather than a default. The moment a spoken word reaches any beat, every pending estimate is cancelled and the estimate does not resume for the rest of the run: a clock that flips between evidence and guesswork produces a picture that stutters. When neither words nor an estimate apply, beatkeeper holds rather than inventing certainty.

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
| `start()`       | Begin the estimate clock, or resume it after `stop()`. Called when the bot starts speaking. |
| `feed(text)`    | Spoken text, as it becomes audible. Any chunk size. |
| `append(unit)`  | Add a unit to the end. |
| `sync(index)`   | Assert that `index` is being heard. |
| `interrupt()`   | Pause the clocks, hold the index. |
| `stop()`        | Pause the clocks. Called when the bot stops speaking. |
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

Every adapter reduces to the [four calls](#the-four-calls-underneath); a stack without one binds them directly.

### Pipecat

`fromPipecat(client, { source? })`. Binds `botStartedSpeaking`, `botStoppedSpeaking`, `userStartedSpeaking`, and one of the two audible-text signals: `botTtsText` (default; one event per word, needs alignment forwarding on the server's TTS service) or `botOutput` with `spoken_progress` (segment-scoped; only the newly heard suffix is fed). Never both; they carry the same words.

### LiveKit

`fromLiveKit(room, { agentIdentity? })`. Binds `participantAttributesChanged` (agent state `speaking` starts; leaving it stops), `transcriptionReceived` (the appended suffix of each growing segment), `activeSpeakersChanged` (the local participant speaking interrupts). Requires `use_tts_aligned_transcript=True` on the `AgentSession`.

LiveKit has since moved transcripts to text streams on the `lk.transcription` topic; this adapter targets the event API and has not been run against a live room.

### ElevenLabs

`fromElevenLabs()`, for the `/stream-input` text-to-speech socket and the v3 `/text-to-dialogue/multi-stream-input` socket. Alignment arrives with the audio, ahead of playback, so the adapter assembles words from `alignment.chars` and schedules each at its offset from `playbackStarted()`.

```ts
const el = fromElevenLabs();
el.bind(clock);
ws.onmessage = (e) => el.message(JSON.parse(e.data));
audio.onplay = () => el.playbackStarted();

// Web Audio: follow the playhead rather than the wall.
const el = fromElevenLabs({ audioTime: () => (ctx.currentTime - firstSampleAt) * 1000 });
```

Three properties of that scheduling:

- **The offset is not the wire value.** `char_start_times_ms` restarts at zero in every message, so the adapter accumulates each message's span (last character's start plus its duration) as it goes, whether or not the message completed a word.
- **The dialogue socket multiplexes contexts**, so assembly is kept per `context_id`. Its alignment is opt-in (`sync_alignment=true`).
- **Wall clock versus audio clock.** By default words are scheduled with wall-clock timers from `playbackStarted()`, which drift from the audio whenever playback falls behind the wall: a buffering stall, a suspended `AudioContext`, a backgrounded tab whose timers are throttled. `audioTime` schedules against the audio clock instead — it returns the playhead's position in stream ms, and each word is fed as the playhead reaches it, so a stall holds the words with the audio. It applies wherever the playback pipeline is under the application's control; the default suits an `<audio>` element whose playhead cannot be read.

Tested against captures from both live sockets ([fixtures](test/fixtures)). The HTTP `with-timestamps` endpoint is a different shape and is not covered.

### AG-UI

`fromAgUi(agent, names?)`. AG-UI carries no audio timing, so units and spoken text travel as `Custom` events (`beat`, `beat.spoken`, `beat.started`, `beat.interrupted`) that the agent side must emit from its own TTS word stream. Not yet run against a live agent.

---

## React

```tsx
import { useNarrationClock } from "beatkeeper/react";
import { fromPipecat } from "beatkeeper/pipecat";

const adapter = useMemo(() => fromPipecat(client), [client]);
const { index } = useNarrationClock(beats, { adapter });
return <Map focus={beats[index]?.map} />;
```

One clock for the component's lifetime. A `beats` array that extends the previous one (same prose, more on the end) is appended to; any other array resets the clock.

When the picture is driven by more than the index — Attaché keeps the clock inside a director object that also owns a spotlight and the graph — a ref holds the clock instead of the hook:

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

## Non-goals

- Audio: transport, buffering, playback, codecs.
- The beat schema. Only `prose` is read.
- Rendering or animation. The output is an index.
- Repairing a broken provider stream, or de-duplicating a caller's own messages.
- Guessing the audible position when no evidence exists. It holds.

## Contributing

Adapters, real payload fixtures, and bug reports with the word stream attached are the most useful things to send. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and what makes a report actionable — beatkeeper resolves an index from a stream of words, so a report without the stream is hard to act on, and the problems above have different fixes.

Note the Node split: working on beatkeeper needs Node 22.12+ because `vitest@5` requires it, while the published package supports Node 18+. CI enforces both halves.

Release notes live in [CHANGELOG.md](CHANGELOG.md). Security policy and threat model: [SECURITY.md](SECURITY.md).

## License

MIT
