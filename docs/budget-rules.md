# Rule catalog, configuration and limits

This document is the reference for `token-budget-estimator`. The severity
column is asserted against `RULE_SEVERITY` in `src/index.mjs` in both
directions by `test/severity-table.test.mjs`, and every rule is additionally
driven through the real binary by `test/severity-behaviour.test.mjs`, which
pins the status and the process exit code rather than the table.

## Exact, estimated, and neither

| Kind | When | What the report says |
| --- | --- | --- |
| **Exact by unit** | The profile names `utf8-bytes`, `unicode-scalars` or `utf16-code-units`. | counted in `exactTokens`; `tokensLower == tokens == tokensUpper` for that part |
| **Exact by declaration** | The part carries a `counted` block naming the profile's tokenizer. | counted in `exactTokens` and in `declaredTokens` |
| **Estimated** | Any other tokenizer, with `estimateCharsPerToken` and `estimateTolerance` declared. | counted in `estimatedTokens`, one `estimate-used` finding, and a band |
| **Neither** | No ratio, a `counted` block from a different tokenizer, an unpaired surrogate, or a limit reached. | counted in `uncounted`; the run is `incomplete` and exits 2 |

The fourth row is the one that makes the other three trustworthy. A part that
could not be counted contributes **nothing to the total and one to `uncounted`**
— it is never silently treated as zero tokens.

No ratio is ever invented, and no vocabulary data is shipped. A wrong merge
table labelled "exact" is worse than an estimate labelled "estimate".

### The three-way verdict

`decideBudget` compares the band against the input allowance:

| Condition | Verdict | Status | Exit |
| --- | --- | --- | ---: |
| `tokensUpper <= inputAllowance` | fits | `pass` (or `fail` if another rule fired) | 0 |
| `tokensLower > inputAllowance` | exceeds | `fail` | 1 |
| otherwise | undetermined | `incomplete` | 2 |

An estimate can still be decisive — a band entirely under or entirely over the
allowance settles the question. What is refused is picking the optimistic end
of a band that straddles the line, which would be wrong exactly when it
mattered.

## What is counted

```
total = replyPrimer
      + sum over messages of ( perMessage
                             + count(role)
                             + (name ? perMessageName + count(name) : 0)
                             + count(text) or the declared count )
      + (tools present ? toolsPreamble : 0)
      + sum over tools of ( perToolDefinition
                          + count(canonical JSON of {name, description, parameters})
                            or the declared count )
```

- `role` and `name` are strings that go on the wire, so they are counted as
  text in the declared unit.
- A `counted` block replaces the count of the message **text** (or of the tool
  **schema**). The surrounding constants still apply.
- A string carrying an unpaired surrogate is refused where it is found, before
  anything is serialised. `JSON.stringify` escapes a lone surrogate into the six
  characters `\uD83D`, which are well-formed and contain no surrogate at all, so
  a serialise-then-check order counts escape text the provider never receives
  and finds nothing wrong with the result. This applies to a tool description, a
  schema value and a schema key alike.
- The tool schema is serialised canonically: object keys in code-unit order, no
  whitespace. That makes the count identical on every machine. It is **not** a
  claim about what a provider sends on the wire — a provider may pretty-print,
  order keys differently, or add fields. `perToolDefinition` exists to absorb
  that difference, and you should measure it once against a real request.

## Rule catalog

| ruleId | severity | fires when |
| --- | --- | --- |
| `budget-contributor` | info | One message or tool is at least 100 permille of the counted total. |
| `budget-exceeded` | error | The request needs more than the input allowance even at the optimistic bound. |
| `budget-headroom-low` | warning | The request fits, but uses at least 900 permille of the input allowance. |
| `budget-invalid` | error | The budget document, its model name or its profiles map is malformed. |
| `budget-undetermined` | error | The band straddles the input allowance, so this run cannot tell whether the request fits. |
| `context-tokens-undeclared` | error | The profile declares no `contextTokens`. |
| `declared-count-invalid` | error | A `counted` block is malformed. |
| `declared-count-tokenizer-mismatch` | error | A `counted` block names a different tokenizer from the profile, so it counts something else. |
| `estimate-not-permitted` | error | The profile declares `requireExact` and a part was estimated. |
| `estimate-ratio-undeclared` | error | The tokenizer is not counted exactly and no `estimateCharsPerToken` was declared. |
| `estimate-tolerance-undeclared` | error | A ratio was declared without an `estimateTolerance`, so the estimate has no band. |
| `estimate-used` | info | At least one part was estimated; names the tokenizer, the ratio and the tolerance. |
| `input-not-json` | error | An input file is not valid JSON. |
| `input-not-utf8` | error | An input file is not valid UTF-8, as decided by a strict decoder. |
| `input-too-large` | error | An input file is above `maxFileBytes` and was not read. |
| `input-unreadable` | error | An input could not be resolved, inspected or read. |
| `message-duplicate` | error | Two messages share an id. |
| `message-invalid` | error | A message is malformed or carries an unknown key. |
| `no-messages` | error | The request declares no messages. |
| `no-parts-counted` | error | Messages were declared but none could be counted, so the total is overhead alone. |
| `output-reservation-below-minimum` | warning | The effective reservation is below the profile's `minOutputTokens`. |
| `output-reservation-exceeds-context` | error | The reservation leaves no room for input at all. |
| `output-reservation-undeclared` | error | The profile declares no `reserveOutputTokens`. |
| `overhead-invalid` | error | An overhead component is missing, not an integer, or unknown. |
| `overhead-undeclared` | error | The profile declares no `overhead` block. |
| `path-escapes-root` | error | An input's real path lies outside the real `--root`. |
| `profile-invalid` | error | The selected profile is malformed. |
| `profile-missing` | error | `model` names a profile the document does not declare. |
| `request-invalid` | error | The request document is malformed. |
| `role-unknown` | error | A message declares a role outside the documented set, so its overhead is unknown. |
| `text-lone-surrogate` | error | Text, a tool description, a schema value or a schema key contains an unpaired surrogate, which no UTF-8 encoder can represent. |
| `tool-duplicate` | error | Two tools share a name. |
| `tool-invalid` | error | A tool is malformed or carries an unknown key. |
| `tool-schema-invalid` | error | A tool's `parameters` is not an object, or holds a value that cannot be written deterministically. |
| `tool-schema-too-deep` | error | A tool's schema is deeper than `maxSchemaDepth`. |
| `too-many-findings` | error | The run produced more findings than `maxFindings`; the report is partial. |
| `too-many-messages` | error | The request declares more messages than `maxMessages`; the walk stopped. |
| `too-many-text-chars` | error | A text field is above `maxTextChars`; it was not counted. |
| `too-many-tools` | error | The request declares more tools than `maxTools`; the walk stopped. |

## Budget document

```json
{
  "schemaVersion": "1",
  "model": "house-bytes",
  "profiles": {
    "house-bytes": {
      "tokenizer": "utf8-bytes",
      "contextTokens": 8192,
      "reserveOutputTokens": 1024,
      "minOutputTokens": 512,
      "overhead": {
        "perMessage": 4,
        "perMessageName": 1,
        "perToolDefinition": 8,
        "toolsPreamble": 16,
        "replyPrimer": 3
      }
    },
    "vendor-large": {
      "tokenizer": "o200k_base",
      "contextTokens": 128000,
      "reserveOutputTokens": 8192,
      "estimateCharsPerToken": 3.8,
      "estimateTolerance": 0.25,
      "requireExact": false,
      "overhead": { "perMessage": 3, "perMessageName": 1, "perToolDefinition": 12, "toolsPreamble": 12, "replyPrimer": 3 }
    }
  }
}
```

- Only the profile named by `model` is compiled. Reporting findings about
  models this run is not budgeting would be noise on a report whose job is one
  number.
- Every `overhead` component is required. An omitted one is not zero; it is a
  number nobody supplied.
- `minOutputTokens` and `requireExact` are optional.
- An unknown key anywhere is refused, never ignored.

## Request document

```json
{
  "schemaVersion": "1",
  "reserveOutputTokens": 2048,
  "messages": [
    { "id": "system-turn", "role": "system", "text": "..." },
    { "id": "customer-turn", "role": "user", "name": "customer-4821", "text": "...",
      "counted": { "tokens": 412, "tokenizer": "o200k_base" } }
  ],
  "tools": [
    { "name": "search", "description": "...", "parameters": { "type": "object" } }
  ]
}
```

- `role` is one of `assistant`, `developer`, `system`, `tool`, `user`.
- `reserveOutputTokens` at the request level overrides the profile's.
- `tools` is optional; a tool with no `parameters` is counted normally.

## Limits

| Limit | Flag | Default | Hard cap |
| --- | --- | ---: | ---: |
| `maxFileBytes` | `--max-file-bytes` | 5242880 | 67108864 |
| `maxMessages` | `--max-messages` | 2000 | 100000 |
| `maxTools` | `--max-tools` | 256 | 4096 |
| `maxTextChars` | `--max-text-chars` | 200000 | 5000000 |
| `maxSchemaDepth` | `--max-schema-depth` | 20 | 100 |
| `maxFindings` | `--max-findings` | 1000 | 20000 |

Exceeding a limit is never a silent truncation. It produces a finding naming
the limit, marks the run `incomplete`, and exits 2 — even when the part that
*was* counted fits comfortably, because a total that omits an unknown tail is
not a total.

An unknown limit key is a configuration error, not a value to ignore.

## Determinism

- Findings sort by `(location.file, location.pointer, ruleId, message, evidence)`.
- Every comparison is by UTF-16 code unit, including the key order of the
  canonical tool serialisation. Neither `localeCompare` nor `Intl.Collator`
  appears in this package, and `test/ordering.test.mjs` pins the emitted order
  with inputs an English collator orders the other way round.
- No clock, no environment variable, no random source and no filesystem
  enumeration order affects output. Two runs over identical inputs produce
  byte-identical stdout.
