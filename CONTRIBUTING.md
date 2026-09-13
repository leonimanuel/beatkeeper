# Contributing to beatkeeper

Thanks for taking an interest. beatkeeper is small and intends to stay that way, so the most useful contributions are usually adapters, real payload fixtures, and bug reports with a word stream attached.

## Getting set up

```bash
git clone https://github.com/leonimanuel/beatkeeper.git
cd beatkeeper
npm install
npm test
```

You need **Node 22.12 or newer** to work on beatkeeper, because `vitest@5` requires it. The published package itself supports **Node 18+** — CI enforces that split by smoke-testing the built tarball down to Node 18.

| Command | What it does |
| --- | --- |
| `npm test` | Runs the test suite once |
| `npm run typecheck` | Type-checks without emitting |
| `npm run build` | Compiles `src` to `dist` |
| `npm run clean` | Removes `dist` |

## What makes a good bug report

beatkeeper's job is to turn a stream of words into an index, so a report is only actionable if it includes the stream. Please give us:

1. **The beats** you passed as `units` (the `prose` strings are what matter; strip anything private).
2. **The words that arrived**, in order, as your stack delivered them — the raw payloads if you have them.
3. **The index you expected** at which point, and the index you got.

A failing test in `test/` is the ideal form of this. A JSON fixture under `test/fixtures/` plus a description is nearly as good.

Vague reports ("it desyncs sometimes") are very hard to act on, because desync has at least five distinct causes that the README enumerates — and they have different fixes.

## Adding an adapter

Adapters live in `src/adapters/` and are published as their own export subpath. If you add one:

- Keep it dependency-free. Every existing adapter imports only `import type` from the core, so none of them adds runtime weight. Take the vendor client as a structural type rather than importing its SDK.
- Add the subpath to `exports` in `package.json` **and** to the smoke list in `.github/workflows/ci.yml`. CI imports every subpath on four Node versions; an adapter missing from that list is untested.
- Include a fixture of real payloads under `test/fixtures/`. Synthetic payloads tend to be too well-behaved and miss the shape changes that motivate the adapter.

## Pull requests

- **Open an issue first for anything large.** For a typo, a fixture, or a focused bug fix, just send the PR.
- Keep commits atomic — one reviewable change each, with a message that says *why* rather than restating the diff.
- CI must be green. It runs typecheck, build, and tests on Node 22 and 24, then smoke-tests the packed tarball on Node 18, 20, 22 and 24.
- Public API changes need a `CHANGELOG.md` entry under `## Unreleased`.

## Scope

The README's [Non-goals](README.md#non-goals) section is enforced. beatkeeper resolves an index and renders nothing — it does not play audio, own a component tree, or talk to a synthesiser. Proposals that move it across that line are likely to be declined, however well implemented, so it is worth raising them as an issue before writing code.

## Releasing

Maintainers only:

1. Move `## Unreleased` entries in `CHANGELOG.md` under a new version heading.
2. `npm version <patch|minor|major>` — this updates `package.json`, the lockfile, and creates the tag.
3. `git push --follow-tags`.
4. The `release` workflow verifies the tagged commit, refuses a tag that disagrees with `package.json`, publishes, and opens a GitHub release.

Nothing is published from a laptop. Running the workflow manually from the Actions tab is always a rehearsal — every publishing step is gated on the ref being a tag — so it is a safe way to watch the pipeline before cutting a real version.

### Authentication

beatkeeper publishes with [trusted publishing](https://docs.npmjs.com/trusted-publishers): the runner authenticates to npm over OIDC and the registry issues a short-lived credential bound to that one workflow run. There is no long-lived token in repository secrets, and provenance attestations are generated automatically.

The one exception was the first release. A trusted publisher cannot be configured for a package that does not exist yet, so `0.1.0` was published with a temporary `NPM_TOKEN` secret, which was deleted once the trusted publisher was in place. The workflow still reads `NPM_TOKEN` if present, purely so that bootstrap path stays available; an absent secret is the normal state.
