# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is pre-1.0 and follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the usual pre-1.0 caveat: **the minor version is where breaking changes
live**. Pin a minor range until 1.0.

## [Unreleased]

## [0.1.1] — 2026-09-14

Documentation only. No runtime code changed between 0.1.0 and 0.1.1; the
published `dist` is identical. This release exists because a package's README
and description on npm are fixed at publish time, so corrected documentation
only reaches the registry as a new version.

### Changed

- The npm `description` now matches the README's opening line and the GitHub
  repository description, which had drifted apart. No code change.

### Documentation

- README rewritten: the conceptual material is compressed from five "Problem"
  sections into one, the API and its timing edge cases are documented in one
  place rather than twice, and the adapters table states what each one has
  actually been verified against.
- The package is ESM-only. This was always true — `"type": "module"` with no
  `require` condition on any subpath — but nothing said so, and a CommonJS
  consumer on the supported Node 18 floor would have found out at runtime.

## [0.1.0] — 2026-09-13

First public release.

### Added

- **`createNarrationClock`** — resolves which unit of a scripted narration a TTS
  voice is currently speaking, from its word stream. Emits an index; renders
  nothing and touches no audio. `start()`, `feed()`, `stop()`, `interrupt()`
  and `sync()`; `onAdvance` runs synchronously inside `feed()`.
- **`SpokenWalk`** — the matcher underneath, usable on its own.
- **Adapters** for Pipecat, LiveKit, ElevenLabs and AG-UI, each on its own
  export subpath and each free of runtime dependencies.
  - `fromElevenLabs({ audioTime })` schedules words against the **audio** clock
    rather than the wall clock: given a playhead position in stream ms, a word
    is fed once the playhead reaches its offset. A buffering stall, a suspended
    `AudioContext`, or a backgrounded tab with throttled timers no longer lands
    words while different audio — or none — is audible. Opt-in; the wall-clock
    path is unchanged.
- **`useNarrationClock`** React hook, on `beatkeeper/react`. React is an
  optional peer dependency.
- **`compose()`** to join adapters, and `withHints()` / `clauses()` /
  `tokenize()` helpers.

### Packaging

- Zero runtime dependencies. Node 18+, verified in CI by installing the packed
  tarball and importing every export subpath on Node 18, 20, 22 and 24.
- Ships `src` alongside `dist` so the declaration and source maps resolve.
- Published from GitHub Actions with npm provenance.

---

## Pre-release history

Version numbers `0.1.0` through `0.3.0` appear in the git history but were
**never published to npm** — the release above reuses `0.1.0` as the first
public version. This section is provenance, not upgrade guidance; it is kept
because the measurements are the argument for the fixes.

### ElevenLabs per-message character offsets

ElevenLabs restarts `char_start_times_ms` at zero in every websocket message.
The adapter read them as offsets from playback start, so every message after
the first scheduled its words against the wrong origin. Because synthesis
outruns playback, those messages are all in hand within a second or two — the
walk raced to the last beat while the voice was still on the first. Beat 1
fired 36 ms into a 4.2-second narration.

Offsets are now accumulated: each message's span — its last character's start
plus that character's duration — is added as the message is consumed. The span
is added even when a message completes no word, because trailing punctuation
arrives in a message of its own, and skipping it pulls every later word early
by the shortfall.

| | beat 1 | beat 2 | total audio |
| --- | --- | --- | --- |
| `/stream-input`, before | 174 ms | 1637 ms | 3994 ms |
| `/stream-input`, after | 871 ms | 2566 ms | 3994 ms |
| `text-to-dialogue`, before | 36 ms | 840 ms | 4160 ms |
| `text-to-dialogue`, after | 1040 ms | 2600 ms | 4160 ms |

Assembly is keyed by context, so interleaved dialogue does not
cross-contaminate.

### `audioTime`

With a playhead that keeps pace, beats land on the same millisecond as the
wall-clock path (871/2566 ms and 1040/2600 ms against the live captures);
during a stall nothing is fed until the playhead moves again. A single poll is
armed only while a word is pending and sleeps the shorter of 20 ms and the time
to the next word. `interrupted()` cancels the poll and drops pending words.

### `start()` resumes the estimate clock

`start()` resumes where `stop()` or `interrupt()` paused it, instead of
rescheduling every unit from zero. Binding the pair to a pipeline's
per-utterance events (Pipecat `botStoppedSpeaking`, LiveKit agent state) was
unsafe before this: the second utterance waited out the whole narration again.

### Matching

The walk trusts the script — units given to the constructor are kept as given,
repeats included, and only `append()` de-duplicates. One re-anchor rather than
continuous re-anchoring. Timing moved into the adapters. Pipecat binds
`botStoppedSpeaking` → `stop()` and LiveKit stops on leaving the speaking
state; without a stop, `start()` was a no-op for every turn after the first.
`extendsNarrative` compares by prose, so a refetch yielding equal units as new
objects no longer resets the picture mid-sentence.

[Unreleased]: https://github.com/leonimanuel/beatkeeper/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/leonimanuel/beatkeeper/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/leonimanuel/beatkeeper/releases/tag/v0.1.0
