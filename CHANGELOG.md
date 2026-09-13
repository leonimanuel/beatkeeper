# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is pre-1.0 and follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the usual pre-1.0 caveat: **the minor version is where breaking changes
live**. Pin a minor range until 1.0.

## [Unreleased]

### Added

- CI on every push and pull request: typecheck, build and tests on Node 22 and
  24, then the packed tarball installed and imported on Node 18, 20, 22 and 24.
  The smoke job makes `engines: node >=18` a tested claim rather than an
  assertion, and catches a broken `exports` map — otherwise invisible until
  someone installs the package.
- `repository`, `bugs` and `homepage` metadata, `engines: node >=18`, and a
  `typecheck` script.
- Contributing guide, code of conduct, security policy, and issue and pull
  request templates.

### Fixed

- `src` is now published. `declarationMap` and `sourceMap` were on while
  `files` listed only `dist`, so every `.d.ts.map` and `.js.map` pointed at
  `../src/*.ts` — a path absent from the tarball. Go-to-definition and stack
  traces dead-ended for consumers. Adds ~10 kB packed.
- The lockfile said `0.1.0` while `package.json` said `0.3.0`.

### Changed

- Removed the `prepare` script. `prepublishOnly` already covers publishing,
  while `prepare` additionally fired on consumer installs from a git URL, where
  devDependencies are not guaranteed. `prepublishOnly` now also runs the tests.

## [0.3.0] — unreleased publicly

The first version intended for npm. Everything below predates the initial
publish and is recorded for provenance rather than upgrade guidance.

### Added

- `fromElevenLabs({ audioTime })` schedules words against the **audio** clock
  instead of the wall clock. Given a playhead position in stream ms, a word is
  fed once the playhead reaches its offset. Previously each word was scheduled
  once at a wall-clock instant computed from `playbackStarted()`, so a
  buffering stall, a suspended `AudioContext`, or a backgrounded tab with
  throttled timers landed words while different audio — or none — was audible.

  A single poll is armed only while a word is pending and sleeps the shorter of
  20 ms and the time to the next word. With a playhead that keeps pace, beats
  land on the same millisecond as the wall-clock path (871/2566 ms and
  1040/2600 ms against live captures); during a stall nothing is fed until the
  playhead moves again. `interrupted()` cancels the poll and drops pending
  words.

  Opt-in. The wall-clock path and the existing API are unchanged.

### Changed

- `start()` now **resumes** the estimate clock where `stop()` or `interrupt()`
  paused it, instead of rescheduling every unit from zero. Binding the pair to
  a pipeline's per-utterance events (Pipecat `botStoppedSpeaking`, LiveKit
  agent state) was unsafe before this: the second utterance waited out the
  whole narration again.
- Pending ElevenLabs words are kept in stream order, so interleaved dialogue
  contexts are fed in order from the front.
- README rewritten around the five problems beatkeeper solves, with real
  payloads from Pipecat, the ElevenLabs websocket and HTTP APIs, and LiveKit.
  Documents that `onAdvance` runs synchronously inside `feed()`.

## [0.2.0] — unreleased publicly

### Fixed

- **ElevenLabs per-message character offsets.** ElevenLabs restarts
  `char_start_times_ms` at zero in every websocket message; the adapter read
  them as offsets from playback start, so every message after the first
  scheduled its words against the wrong origin. Because synthesis outruns
  playback, those messages are all in hand within a second or two — the walk
  raced to the last beat while the voice was still on the first. Beat 1 fired
  36 ms into a 4.2-second narration.

  Offsets are now accumulated: each message's span — its last character's start
  plus that character's duration — is added as the message is consumed. The
  span is added even when a message completes no word, because trailing
  punctuation arrives in a message of its own, and skipping it pulls every
  later word early by the shortfall.

  | | beat 1 | beat 2 | total audio |
  | --- | --- | --- | --- |
  | `/stream-input`, before | 174 ms | 1637 ms | 3994 ms |
  | `/stream-input`, after | 871 ms | 2566 ms | 3994 ms |
  | `text-to-dialogue`, before | 36 ms | 840 ms | 4160 ms |
  | `text-to-dialogue`, after | 1040 ms | 2600 ms | 4160 ms |

- Assembly is keyed by context, so interleaved dialogue does not cross-
  contaminate.

### Changed

- The walk trusts the script: units given to the constructor are kept as given,
  repeats included; only `append()` de-duplicates.
- One re-anchor instead of continuous re-anchoring.
- Timing moved into the adapters.
- Pipecat binds `botStoppedSpeaking` → `stop()`; LiveKit stops on leaving the
  speaking state. Without a stop, `start()` was a no-op for every turn after
  the first.
- `extendsNarrative` compares by prose, so a refetch yielding equal units as
  new objects no longer resets the picture mid-sentence.
- `onAdvance` receives the unit; `leadMs` may be a function read per cue.

### Added

- `compose()` joins adapters.

## [0.1.0] — unreleased publicly

### Added

- Initial implementation: resolve which unit of a scripted narration a TTS
  voice is speaking, from its word stream. Emits an index; renders nothing.
- Adapters for Pipecat, LiveKit, ElevenLabs and AG-UI.
- React hook, `useNarrationClock`.

[Unreleased]: https://github.com/leonimanuel/beatkeeper/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/leonimanuel/beatkeeper/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/leonimanuel/beatkeeper/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/leonimanuel/beatkeeper/releases/tag/v0.1.0
