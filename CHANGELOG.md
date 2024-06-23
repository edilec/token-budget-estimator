# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a budget document mapping a model to a profile: the tokenizer, the context
  window, the output reservation, an optional minimum reply size and the five
  declared overhead components, each of them required;
- a request document of channel-labelled messages and tool definitions, with an
  optional `counted` block per part carrying a number measured elsewhere and
  naming the tokenizer it came from;
- exact counting for three units whose definitions are facts about the text --
  `utf8-bytes`, `unicode-scalars` and `utf16-code-units` -- and a labelled
  estimate with a band for any other tokenizer, from a ratio and tolerance the
  profile declares;
- a three-way verdict: fits, exceeds, or undetermined when the band straddles
  the input allowance;
- canonical serialisation of tool schemas -- object keys in code-unit order, no
  whitespace -- so the count is identical on every machine, with the difference
  from a provider's own serialisation absorbed by the declared
  `perToolDefinition` rather than papered over;
- `budget-contributor`, naming any message or tool that is at least a tenth of
  the counted total, and `budget-headroom-low` for a request that fits at over
  900 permille of the allowance;
- explicit limits on file bytes, messages, tools, text characters, schema depth
  and findings, each enforced, each reported by name, and each reachable from
  the command line;
- three runnable examples, one per exit code, differing only in the budget
  file;
- the rule catalog, both document formats, the counting formula and the limits
  in `docs/budget-rules.md`.

### Guarded

These are the defects this package was built against rather than audited for,
each with a test that fails when the guard is removed.

- **An uncounted part is never zero.** This is the defect class a counting tool
  is most exposed to: a part that could not be counted contributes nothing, and
  nothing looks exactly like a small number. Every route to an uncounted part
  -- no ratio, a count from another tokenizer, an unpaired surrogate, a limit
  reached -- increments `uncounted`, marks the run `incomplete` and exits 2.
- **An unpaired surrogate is refused rather than encoded.** Every conforming
  UTF-8 encoder substitutes U+FFFD, which is three bytes, so counting a lone
  surrogate returns a silently different number. `test/count.test.mjs` asserts
  that `TextEncoder` really does return 3 for a one-code-unit string, so the
  guard is visibly protecting against a real behaviour.
- **The unit is the unit.** `test/acceptance.test.mjs` counts the same
  Unicode-heavy text under all three profiles and asserts the totals differ. A
  counter that returns `text.length` for everything passes any test that checks
  one unit.
- **No vacuous pass.** An empty message list, and a request whose parts all
  failed to count, are errors that mark the run incomplete rather than
  reporting a total made of overhead alone.
- **Severity pinned behaviourally.** Every rule has a runnable case in
  `test/rule-cases.mjs` driven through the real binary; an error rule demoted to
  `warning` makes its run exit 0 and fails the case, whatever the source table
  and the documentation say. The table-versus-documentation assertion is kept
  but labelled secondary.
- **Ordering pinned behaviourally.** `test/ordering.test.mjs` uses inputs an
  English collator orders the other way round -- `Z` before `a`, `README`
  before `assets`, `a-b` before `a_b` -- and asserts the emitted order,
  including the key order of the canonical tool serialisation.
- **Sanitisation covers identifiers, not just excerpts.** The four character
  classes are each driven in through a JSON *key* as well as through text. And
  message text is not sanitised on the way out because it never goes out:
  sanitising it would change the count, so it is counted and never echoed.
- **The parse diagnostic never reproduces the document.** The quoting shape is
  recognised before the offset, with the `s` flag, and a surviving double quote
  falls back to a generic sentence. It matters more here than in most tools:
  the document being parsed is a prompt.
- **Confinement is by real path.** A symbolic link planted inside the root is
  refused unread, including one whose target does not exist; a root that is
  itself reached through a link is not falsely refused.

No release has been published.
