# beatkeeper

[![npm](https://img.shields.io/npm/v/beatkeeper.svg)](https://www.npmjs.com/package/beatkeeper)
[![CI](https://github.com/leonimanuel/beatkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/leonimanuel/beatkeeper/actions/workflows/ci.yml)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/npm/l/beatkeeper.svg)](LICENSE)

Keeps a voice agent's interface on the words the listener is hearing, not the words the model wrote.

A voice agent writes its answer in two seconds and takes twenty to say it. Move the map when the text is *generated* and it makes every move in the first two seconds, then sits on the last beat while the voice is still on the first.

Describe the narration as beats — the words that will be spoken, plus whatever the picture needs at that moment. Your voice stack reports what is audible as it becomes audible. beatkeeper tells you which beat the listener is on. It renders nothing and touches no audio.

ESM only, zero dependencies, browsers and Node 18+.

## Quick start

```
npm install beatkeeper
```

A beat is your own object with one reserved field. `prose` is what will be spoken; everything else is yours and comes back untouched.

```ts
const beats = [
  { prose: "Fighting increased near Pokrovsk.",                    map: pokrovsk },
  { prose: "Further south, activity shifted toward Zaporizhzhia.", map: zaporizhzhia },
];
```

Create a clock over them and bind it to your voice stack:

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

The map moves when the voice reaches the sentence that names the place, not when the model finished writing it seconds earlier.

Two things to know up front. The index starts at `0`, assuming beat 0 is already on screen when the voice begins, so the first `onAdvance` is the *crossing* into beat 1; pass `fireFirst: true` to have beat 0 announced on its own first word instead. And beats are not sentences — send the synthesiser whole sentences, because prosody needs the context, and cut beats wherever the picture should change:

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

Without an adapter, bind four calls to your own events: `start()` when the bot starts speaking, `stop()` when it stops, `interrupt()` on barge-in, and `feed(text)` when text becomes **audible** — not when it is generated, and not when it is sent to the synthesiser. `feed` takes any chunk size, and `onAdvance` runs synchronously inside it, so `clock.index` is current by the time your handler returns.

## Why this is harder than it looks

**Only one moment is the right one.**

```
generated  →  sent to TTS  →  synthesised  →  received by the client  →  audible
```

Everything before the last state is a guess with a timestamp attached, and the gap between "sent to TTS" and "audible" is seconds wide and varies with buffering.

**Every stack reports that moment differently.** There is no standard `spoken_at` field. Pipecat releases one message per word, held to the word's own time on the bot's output clock. ElevenLabs sends character timings *with* the audio, seconds ahead of playback, renumbered from zero in every message. LiveKit grows a transcript in place. AG-UI carries no timing at all, and neither does a TTS without alignment. Adapters absorb the difference so the application only ever calls `feed()`:

| Shape | Examples | What the adapter does |
|---|---|---|
| Paced word events | Pipecat `bot-tts-text`, LiveKit aligned transcripts | Feed on arrival; the pipeline already held the word to its time |
| A transcript that grows | Pipecat `bot-output`, LiveKit segments | Feed only the newly appended suffix |
| Timings ahead of playback | ElevenLabs websocket | Assemble words from characters, accumulate each message's span into a running offset, schedule each word from the start of playback |
| Nothing | AG-UI; a TTS without alignment | Run the estimate, or emit spoken events from the agent side |

<details>
<summary>Real payloads from each, for matching against a stream in hand</summary>

```json
// Pipecat bot-tts-text — one message per word
{ "label": "rtvi-ai", "type": "bot-tts-text", "data": { "text": "Pokrovsk." } }

// Pipecat bot-output — a sentence that fills in, keyed by segment
{ "label": "rtvi-ai", "type": "bot-output", "data": {
    "text": "Fighting increased near Pokrovsk.", "aggregated_by": "sentence", "segment_id": 42,
    "will_be_spoken": true, "spoken_status": "in-progress",
    "spoken_progress": { "accumulated_text": "Fighting increased near", "remaining_text": " Pokrovsk." } } }

// ElevenLabs websocket — character timings, renumbered from zero each message
{ "audio": "<base64>",
  "alignment": { "chars": ["G","o","o","d"," ","m"], "charStartTimesMs": [0,58,104,139,174,209], "charDurationsMs": [58,46,35,35,35,35] },
  "isFinal": null }

// ElevenLabs HTTP /stream/with-timestamps — seconds, counted from the start of the request
{ "audio_base64": "<base64>",
  "alignment": { "characters": ["G","o","o","d"], "character_start_times_seconds": [0.0,0.058,0.104,0.139], "character_end_times_seconds": [0.058,0.104,0.139,0.174] } }

// LiveKit — a segment whose text grows as the agent speaks
{ "id": "SG_7f3a", "text": "Fighting increased near", "final": false, "language": "en" }
```

The v3 ElevenLabs dialogue socket carries the same alignment shape in snake_case, with a `context_id` per interleaved context.

</details>

**The voice does not say what you wrote.** What comes back is the TTS's reading of your script, not your script:

```
script:  On the 27th a strike hit the Orlivka crossing — $1.7B in damage.
heard:   on the twenty seventh a strike hit the orlivka crossing one point seven billion dollars in damage
```

Numbers become words, symbols become phrases, punctuation vanishes, contractions split. String equality fails inside the first sentence of real content, and the drift is not the same on every model or every day.

So beatkeeper does not compare strings. It tokenizes both sides — lower-case, letters and digits only, any script — and walks a cursor through the expected tokens, re-anchoring on any later word in the current beat, since moving within a beat changes nothing on screen. Crossing into the next beat changes the picture, so it takes more evidence: either the current beat is nearly done, or two words match the next beat in order. One stray "the" cannot move the picture; "the EU" can. The index only ever moves forward. It may skip a beat when the voice does, but it never goes back, because a picture that rewinds reads as broken in a way that one running slightly behind does not.

## API

### `createNarrationClock(options)`

```ts
createNarrationClock<T>({
  units?: Unit<T>[];                          // Unit<T> = { prose: string } & T
  onAdvance: (index: number, source: ClockSource, unit: Unit<T>) => void;
  estimate?: (unit: Unit<T>, prev: Unit<T> | undefined, index: number) => number;
  fireFirst?: boolean;                        // report unit 0 on its first word (default: unit 0 is already on screen)
  openWords?: number;                         // words in a row before the walk opens (default 1)
  normalize?: (token: string) => string;      // applied to every token, script and speech alike
  timers?: Timers;                            // test seam
}): NarrationClock<T>
```

`ClockSource` is `"spoken" | "estimate" | "sync"` — the kinds of evidence that move the index.

| Member | |
|---|---|
| `start()` | Begin the estimate clock, or resume it after `stop()`. Call when the bot starts speaking. |
| `feed(text)` | Spoken text, as it becomes audible. Any chunk size. |
| `append(unit)` | Add a unit to the end, mid-narration — what a model streaming its script needs. |
| `sync(index)` | Assert that `index` is being heard, now. |
| `interrupt()` | Pause the clocks, hold the index. |
| `stop()` | Pause the clocks. Call when the bot stops speaking. |
| `reset(units?)` | Replace the units; back to rest. |
| `index` | Current index. `-1` before the first unit when `fireFirst` is set. |
| `source` | Which evidence moved the index last: a `ClockSource`, or `"idle"` before anything has. |
| `running` | Between `start()` and `stop()`/`interrupt()`. |
| `remaining` | Tokens of the current unit not yet heard. |
| `progress` | Fraction of the current unit heard, 0..1. |

`fireFirst` decides whether beat 0 is already on screen before the voice starts (a map at rest) or nothing shows until the first word (a caption). `openWords` is for a stream where unscripted speech precedes the script and may share its words: with `openWords: 2` the walk does not open until two script words arrive in a row.

### Timing edge cases

**A player that buffers.** Text fed to the clock is taken to be audible *now*. Pipecat's word events arrive within a network hop of being audible; a player that buffers on top of that shifts the whole stream later, and the feed has to be held by the same amount — measured, since the buffer varies.

**A source that knows.** `sync(index)` re-anchors the walk immediately. It is for a caller that knows: a server tracking playback, a caption track with its own timing.

**A source that runs early.** A server saying "synthesis started on beat 3" is true, and ahead of the ear by the whole pipeline buffer. `withHints` turns it into a late sync — it waits a grace period sized to what the current beat still has to say, and drops the hint if spoken words get there first.

```ts
const hinted = withHints(clock);              // { hint, feed, cancel }
onServerMessage((m) => { if (m.type === "beat-start") hinted.hint(m.index); });
onTtsText((text) => hinted.feed(text));       // through the wrapper, so words beat hints
```

**Barge-in.** `interrupt()` holds the index where it is; `reset(nextBeats)` takes the next turn's beats once they exist.

**No alignment at all.** Give the clock an `estimate(beat)` in milliseconds and it steps through the beats on that schedule from `start()`.

```ts
createNarrationClock({ units: beats, estimate: (b) => b.prose.split(/\s+/).length * 400, onAdvance });
```

It is wrong by however much the voice's real pace differs and the error accumulates, so it is a degraded mode rather than a default. The moment a spoken word reaches any beat, every pending estimate is cancelled and does not resume for the rest of the run — a clock that flips between evidence and guesswork produces a picture that stutters. When neither words nor an estimate apply, beatkeeper holds rather than inventing certainty.

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
clauses(text)                             // sentence → caption-sized pieces: at . ! ? — – ; and ", so"
tokenize(text)                            // lowercase, letters and digits only, any script
withHints(clock, { baseMs?, perWordMs? }) // late-sync wrapper for a source that runs early
compose(...adapters)                      // bind several adapters to one clock; returns a single unbind
```

## Adapters

```ts
type Adapter<T> = { bind(clock: NarrationClock<T>): () => void };
```

| Adapter | Import | Verified against |
|---|---|---|
| Pipecat | `beatkeeper/pipecat` | unit tests with a mock RTVI client |
| ElevenLabs | `beatkeeper/elevenlabs` | captured frames from both live sockets ([fixtures](test/fixtures)) |
| LiveKit | `beatkeeper/livekit` | unit tests; not yet run against a live room |
| AG-UI | `beatkeeper/ag-ui` | not yet exercised against a live agent |

**Pipecat** — `fromPipecat(client, { source? })`. Binds `botStartedSpeaking`, `botStoppedSpeaking`, `userStartedSpeaking`, and one of the two audible-text signals: `botTtsText` (default; one event per word, needs alignment forwarding on the server's TTS service) or `botOutput` with `spoken_progress` (segment-scoped; only the newly heard suffix is fed). Never both — they carry the same words.

**LiveKit** — `fromLiveKit(room, { agentIdentity? })`. Binds `participantAttributesChanged` (agent state `speaking` starts, leaving it stops), `transcriptionReceived` (the appended suffix of each growing segment), and `activeSpeakersChanged` (the local participant interrupts). Requires `use_tts_aligned_transcript=True` on the `AgentSession`. LiveKit has since moved transcripts to text streams on the `lk.transcription` topic; this adapter targets the event API.

**AG-UI** — `fromAgUi(agent, names?)`. AG-UI carries no audio timing, so units and spoken text travel as `Custom` events (`beat`, `beat.spoken`, `beat.started`, `beat.interrupted`) that the agent side emits from its own TTS word stream.

**ElevenLabs** — `fromElevenLabs({ audioTime? })`, for the `/stream-input` socket and the v3 `/text-to-dialogue/multi-stream-input` socket. Alignment arrives with the audio, ahead of playback, so the adapter assembles words from `alignment.chars` and schedules each at its offset from `playbackStarted()`.

```ts
const el = fromElevenLabs();
el.bind(clock);
ws.onmessage = (e) => el.message(JSON.parse(e.data));
audio.onplay = () => el.playbackStarted();

// Web Audio: follow the playhead rather than the wall.
const el = fromElevenLabs({ audioTime: () => (ctx.currentTime - firstSampleAt) * 1000 });
```

Three properties of that scheduling:

- **The offset is not the wire value.** `char_start_times_ms` restarts at zero in every message, so the adapter accumulates each message's span — the last character's start plus its duration — whether or not the message completed a word.
- **The dialogue socket multiplexes contexts**, so assembly is kept per `context_id`. Its alignment is opt-in (`sync_alignment=true`).
- **Wall clock versus audio clock.** By default words are scheduled with wall-clock timers from `playbackStarted()`, which drift whenever playback falls behind the wall: a buffering stall, a suspended `AudioContext`, a backgrounded tab whose timers are throttled. `audioTime` returns the playhead's position in stream ms and each word is fed as the playhead reaches it, so a stall holds the words with the audio. Use it when you own the playback pipeline; the default suits an `<audio>` element whose playhead you cannot read.

The HTTP `with-timestamps` endpoint is a different shape and is not covered.

## React

```tsx
import { useNarrationClock } from "beatkeeper/react";
import { fromPipecat } from "beatkeeper/pipecat";

const adapter = useMemo(() => fromPipecat(client), [client]);
const { index } = useNarrationClock(beats, { adapter });
return <Map focus={beats[index]?.map} />;
```

One clock for the component's lifetime. A `beats` array that extends the previous one (same prose, more on the end) is appended to; any other array resets the clock.

## Non-goals

- Audio: transport, buffering, playback, codecs.
- Your beat schema. Only `prose` is read.
- Rendering or animation. The output is an index.
- Repairing a broken provider stream, or de-duplicating your own messages.
- Guessing the audible position when no evidence exists. It holds.

## Contributing

Adapters, real payload fixtures, and bug reports with the word stream attached are the most useful things to send. beatkeeper resolves an index from a stream of words, so a report without the stream is hard to act on. See [CONTRIBUTING.md](https://github.com/leonimanuel/beatkeeper/blob/main/CONTRIBUTING.md) for setup and what makes a report actionable.

Working on beatkeeper needs Node 22.12+ because `vitest@5` requires it, while the published package supports Node 18+. CI enforces both halves.

Release notes: [CHANGELOG.md](https://github.com/leonimanuel/beatkeeper/blob/main/CHANGELOG.md). Security policy and threat model: [SECURITY.md](https://github.com/leonimanuel/beatkeeper/blob/main/SECURITY.md).

## License

MIT
