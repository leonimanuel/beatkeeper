# Security Policy

## Supported versions

beatkeeper is pre-1.0. Fixes land on the latest released minor; there are no
backports to earlier ones.

| Version | Supported |
| --- | --- |
| 0.3.x | ✅ |
| < 0.3 | ❌ |

## Reporting a vulnerability

Please report privately rather than opening a public issue:

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/leonimanuel/beatkeeper/security/advisories/new)
- **Email:** leonmalisov@gmail.com

Expect an acknowledgement within a week.

## Threat model, briefly

beatkeeper has no runtime dependencies, performs no I/O, and reads only the
`prose` field of the units you hand it. It does not fetch, spawn, evaluate, or
write anything.

What it *does* do is consume strings that arrive from a remote synthesiser over
your transport. So the realistic concerns are:

- **Unbounded input.** A stream that never stops, or units built from untrusted
  text, is memory your process holds. Beats come from your script, but the word
  stream comes from the network.
- **Pathological matching cost.** Malformed or adversarial word streams
  exercising the matcher in unexpected ways.
- **Downstream trust.** `onAdvance` hands your own beat object back untouched —
  beatkeeper neither sanitises nor escapes anything. If a beat carries markup
  you render, that is yours to handle.

Reports in any of these areas are in scope and welcome.
