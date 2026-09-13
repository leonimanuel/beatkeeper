<!--
Keep this short. The useful parts are "why" and "how you know it works".
For a typo or a fixture, one line is plenty — delete the rest.
-->

## What and why

<!-- What changes, and what problem it solves. The diff shows the what; the why is what reviewers can't reconstruct. -->

## How this was verified

<!--
Beyond CI. If it touches matching, a test with the word stream that used to
fail is far more convincing than a description.
-->

## Checklist

- [ ] `npm test` passes locally (Node 22.12+ required for the toolchain)
- [ ] Public API changes have a `CHANGELOG.md` entry under `## Unreleased`
- [ ] New adapter, if any, is added to `exports` in `package.json` *and* to the smoke list in `.github/workflows/ci.yml`
