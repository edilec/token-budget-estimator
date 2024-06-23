# Token Budget Estimator

Count the tokens a request will cost against a declared tokenizer and model
mapping, with configurable message and tool overhead, and report exact counts
separately from estimates.

- **Repository:** [edilec/token-budget-estimator](https://github.com/edilec/token-budget-estimator)
- **Area:** Prompt & Agent Workflows
- **License:** MIT

## What it does

You have a request about to be sent: a few messages, a handful of tool
definitions, a model with a context window. Will it fit, and with room for the
reply?

This tool answers that from a file you control, and — more importantly — tells
you **how much of the answer it actually knows**:

- counts text exactly where the unit is defined (`utf8-bytes`,
  `unicode-scalars`, `utf16-code-units`);
- accepts a `counted` block for a part you measured with a real vendor
  tokenizer, and checks it names the tokenizer the profile uses;
- estimates from a ratio *you* declare for any other tokenizer, and carries a
  band around it;
- refuses to count anything it cannot count, and says so rather than treating
  it as zero;
- budgets the input against the window **less the output reservation**, and
  reports three outcomes — fits, exceeds, or cannot tell.

## Why it exists

Because the usual failure is not a slightly wrong number. It is a confident
number with no idea how confident it should be:

- a per-message overhead nobody wrote down, so the budget is short by a few
  tokens per turn and fails on the twentieth;
- a request budgeted against the whole window, so it fits and the reply is
  truncated;
- an emoji counted as one character when it is four bytes, or a message cut
  mid-character so the encoder silently substitutes three bytes for a
  half-character;
- an estimate quoted to the token, from a ratio somebody copied off a blog.

So this tool declines to invent any of the numbers it is not given, and when
an estimate cannot settle the question it says so instead of guessing.

## Quick start

```sh
# a multilingual request with two tool schemas, counted exactly: exits 0
node bin/token-budget-estimator.mjs --root examples/fits

# the same request against a 768-token window: exits 1
node bin/token-budget-estimator.mjs --root examples/over-budget

# the same request estimated for a tokenizer this tool does not count,
# where the band straddles the allowance: exits 2, "cannot tell"
node bin/token-budget-estimator.mjs --root examples/undetermined

# machine-readable report only
node bin/token-budget-estimator.mjs --root examples/fits --json | jq .summary
```

As a library:

```js
import { estimateBudget, exitCodeFor } from 'token-budget-estimator'

const report = await estimateBudget({ root: 'budgets/support-triage' })
process.exitCode = exitCodeFor(report)
```

## Exact, estimated, and neither

| Kind | When | Where it lands in the report |
| --- | --- | --- |
| Exact by unit | the profile names one of the three counted units | `exactTokens`, no band |
| Exact by declaration | the part carries `counted: {tokens, tokenizer}` matching the profile | `exactTokens` and `declaredTokens` |
| Estimated | any other tokenizer, with a declared ratio and tolerance | `estimatedTokens`, plus a band and an `estimate-used` finding |
| Neither | no ratio, a count from another tokenizer, an unpaired surrogate, a limit reached | `uncounted`; the run is `incomplete` and exits 2 |

**This package ships no vocabulary data and downloads nothing.** It does not
implement any vendor's byte-pair encoding, and it does not pretend to: a wrong
merge table labelled "exact" is worse than an estimate labelled "estimate". If
you need a vendor's exact numbers, run that vendor's tokenizer and put the
result in a `counted` block — the report will then show it as declared-exact
and name the tokenizer it came from.

## Rules

Full catalog, with both document formats and every limit, in
[`docs/budget-rules.md`](docs/budget-rules.md). The rules that carry the
product:

| ruleId | severity | fires when |
| --- | --- | --- |
| `budget-exceeded` | error | The request needs more than the input allowance even at the optimistic bound. |
| `budget-undetermined` | error | The band straddles the allowance, so this run cannot tell whether the request fits. |
| `budget-headroom-low` | warning | It fits, but uses at least 900 permille of the allowance. |
| `estimate-used` | info | At least one part was estimated; names the tokenizer, ratio and tolerance. |
| `estimate-ratio-undeclared` | error | An unsupported tokenizer with no declared ratio. Nothing is guessed. |
| `declared-count-tokenizer-mismatch` | error | A `counted` block measured with a different encoding is a count of something else. |
| `text-lone-surrogate` | error | Text no UTF-8 encoder can represent; counting it would return a silently different number. |
| `output-reservation-undeclared` | error | The profile says nothing about the reply, so the input allowance is unknown. |
| `overhead-undeclared` | error | The per-message and per-tool cost is unknown. It is not assumed to be zero. |
| `no-parts-counted` | error | Nothing could be counted, so the total is overhead alone. |

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | The request was counted and fits the input allowance. | the JSON report |
| `1` | The request was counted and does not fit. | the JSON report |
| `2` | Invalid configuration, or evidence that could not be obtained. | **empty** for a configuration error; an `incomplete` report otherwise |

A consumer piping stdout must handle the empty case. A configuration error
never had a subject, so there is nothing to report about.

`incomplete` is never interchangeable with `pass`. An estimate whose band
straddles the allowance lands here: the run genuinely cannot tell.

## Limits

| Limit | Flag | Default |
| --- | --- | ---: |
| `maxFileBytes` | `--max-file-bytes` | 5242880 |
| `maxMessages` | `--max-messages` | 2000 |
| `maxTools` | `--max-tools` | 256 |
| `maxTextChars` | `--max-text-chars` | 200000 |
| `maxSchemaDepth` | `--max-schema-depth` | 20 |
| `maxFindings` | `--max-findings` | 1000 |

Exceeding one is an `incomplete` result with a finding naming the limit — even
when the part that was counted fits, because a total that omits an unknown tail
is not a total. An unknown limit key is a configuration error.

## Guarantees

Each of these has a test that fails when the guarantee is removed.

- **An uncounted part is never counted as zero.** It increments `uncounted`,
  the run is `incomplete`, and it exits 2.
- **The unit is the unit.** An astral character is one scalar, two UTF-16 code
  units and four UTF-8 bytes, and the three profiles return three different
  totals for the same text.
- **An unpaired surrogate is refused, not encoded.** Every conforming UTF-8
  encoder substitutes U+FFFD, which is three bytes, so counting it would return
  a silently different number.
- **No ratio is invented.** An unsupported tokenizer with no declared
  `estimateCharsPerToken` counts nothing.
- **A declared count must name the profile's tokenizer.** A count from another
  encoding is a count of something else.
- **An estimate that cannot decide says so.** A band straddling the allowance
  is `incomplete`, never an optimistic pass.
- **The output reservation is required and is what the input is budgeted
  against.** A request that fits the window and not the allowance fails.
- **Every overhead component is required.** An omitted one is not zero.
- **The tool-schema serialisation is canonical**, so two machines agree byte
  for byte; key order in the input does not change the count.
- **Nothing untrusted reaches output raw.** Message text and tool descriptions
  are never echoed at all, and every identifier, path, pointer, message and
  piece of evidence is stripped of C0, DEL, C1, U+2028/U+2029 and the bidi
  controls.
- **A JSON parse failure never reproduces the document.** V8 embeds raw input
  in its message; this package keeps the offset and drops the quoted half.
- **Path confinement is by real path**, not by rejecting `..`.
- **Output is deterministic and byte-identical** across runs, machines and Node
  builds. Ordering is by UTF-16 code unit.

## Non-goals

- **It does not implement a vendor tokenizer.** No vocabulary, no merge table,
  no download. See the table above for the two honest routes to a vendor's
  numbers.
- **It does not contact a provider.** No network of any kind, no API key, no
  telemetry. The count is arithmetic over local files.
- **It does not know your provider's real overhead.** Those constants are
  declarations you supply and should measure once against a real request.
- **It does not count graphemes.** A family emoji is several scalars, and this
  package says so rather than guessing which unit you meant.
- **It does not normalise text.** The precomposed and combining forms of the
  same letter have different sizes, and normalising one into the other would
  change the number relative to the bytes you are actually going to send.
- **It does not modify anything.** Read-only, always.

## Verification

```sh
npm run check     # lint, tests, the three runnable examples, and a packaging dry run
```

Zero runtime dependencies and zero development dependencies. Node 22 or newer,
ESM, `node:test` and `node:assert/strict`.

## License

MIT. See [LICENSE](./LICENSE).
