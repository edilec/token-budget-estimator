import assert from 'node:assert/strict'
import test from 'node:test'

import { countExact } from '../src/index.mjs'
import {
  UNICODE, apiReport, budgetOf, cliReport, estimatingProfile, findingsFor, fixture,
  message, profileOf, raisedRules, requestOf, tool,
} from './support.mjs'

/**
 * The three acceptance criteria for this tool, each held by something that
 * fails when it stops being true:
 *
 *   1. Unicode and tool-schema examples are covered;
 *   2. an unsupported tokenizer produces an estimate label;
 *   3. the output reservation is budgeted.
 *
 * Each is asserted on what the tool emits -- the numbers in the report and the
 * process exit code -- not on a table or a sentence in the README.
 */

test('a Unicode request is counted in the declared unit, and the units disagree', async () => {
  const text = `${UNICODE.astral} ${UNICODE.zwjSequence} ${UNICODE.combining} ${UNICODE.japanese} ${UNICODE.arabic}`
  const request = requestOf([message({ id: 'unicode-turn', role: 'user', text })])

  const byUnit = {}
  for (const tokenizer of ['unicode-scalars', 'utf16-code-units', 'utf8-bytes']) {
    const report = await apiReport(fixture(budgetOf(profileOf({ tokenizer })), request))
    assert.equal(report.status, 'pass', tokenizer)
    byUnit[tokenizer] = report.summary.tokens
  }

  // role "user" is 4 characters in every unit, the text is not, and the
  // overhead is a declared constant. The three totals must differ, or the unit
  // is not being used.
  const overhead = 4 + 3
  assert.equal(byUnit['unicode-scalars'], countExact('unicode-scalars', text) + 4 + overhead)
  assert.equal(byUnit['utf16-code-units'], countExact('utf16-code-units', text) + 4 + overhead)
  assert.equal(byUnit['utf8-bytes'], countExact('utf8-bytes', text) + 4 + overhead)
  assert.equal(new Set(Object.values(byUnit)).size, 3, 'a counter that ignores the unit passes nothing here')
})

test('text with an unpaired surrogate is refused rather than counted wrongly', async () => {
  const { code, report } = await cliReport(fixture(
    budgetOf(),
    requestOf([message({ text: `truncated here: ${UNICODE.loneHighSurrogate}` })]),
  ))
  assert.equal(code, 2, 'a part nobody could count leaves the total unknown')
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(raisedRules(report), ['no-parts-counted', 'text-lone-surrogate'])
  assert.equal(report.summary.uncounted, 1)
  assert.equal(report.summary.checked, 0)
})

test('an unpaired surrogate in a tool is refused too, wherever in the tool it sits', async () => {
  /**
   * The guarantee held for message text and was silently absent for everything
   * that reaches the wire through a serialised tool. `canonicalJson` ran first,
   * `JSON.stringify` escaped the lone surrogate into six well-formed
   * characters, `hasLoneSurrogate` then found nothing, and 47 characters of
   * escape text were counted as an exact measurement: status pass, uncounted 0,
   * exit 0. A description, a schema value and a schema key are three different
   * roads to the same escape.
   */
  const broken = `broken ${UNICODE.loneHighSurrogate} here`
  const places = {
    description: tool({ description: broken }),
    'schema value': tool({ parameters: { type: 'object', title: broken } }),
    'schema key': tool({ parameters: { [broken]: 1 } }),
  }

  for (const [place, declared] of Object.entries(places)) {
    const { code, report } = await cliReport(fixture(budgetOf(), requestOf([message()], { tools: [declared] })))
    assert.equal(code, 2, place)
    assert.equal(report.status, 'incomplete', place)
    assert.equal(report.summary.uncounted, 1, place)
    const refused = findingsFor(report, 'text-lone-surrogate')
    assert.equal(refused.length, 1, place)
    assert.equal(refused[0].severity, 'error', place)
    assert.match(refused[0].message, /unpaired surrogate/, place)
  }

  // And the well-formed twin still counts, so the guard is not refusing tools
  // in general.
  const intact = await cliReport(fixture(budgetOf(), requestOf([message()], {
    tools: [tool({ description: `intact ${UNICODE.astral} here` })],
  })))
  assert.equal(intact.code, 0)
  assert.equal(intact.report.summary.uncounted, 0)
})

test('a message name costs its declared overhead, and an unnamed message does not', async () => {
  /**
   * `perMessageName` is a documented component of the formula
   * `perMessage + (name ? perMessageName + count(name) : 0)`, and removing it
   * from `countMessage` left all 207 tests green while every named message got
   * one token cheaper. The difference between the two runs below is the name
   * alone, so it is exactly the name's cost: its own characters plus the
   * declared constant.
   */
  const profile = profileOf({ overhead: { perMessage: 4, perMessageName: 7, perToolDefinition: 8, toolsPreamble: 16, replyPrimer: 3 } })
  const named = await apiReport(fixture(budgetOf(profile), requestOf([message({ name: 'customer-4821' })])))
  const anonymous = await apiReport(fixture(budgetOf(profile), requestOf([message()])))

  assert.equal(named.status, 'pass')
  assert.equal(anonymous.status, 'pass')
  assert.equal(named.summary.overheadTokens - anonymous.summary.overheadTokens, 7, 'the declared constant, not zero')
  assert.equal(
    named.summary.tokens - anonymous.summary.tokens,
    7 + countExact('utf8-bytes', 'customer-4821'),
    'the constant plus the name itself',
  )
})

test('a tool schema is counted from a canonical serialisation, whatever order its keys arrive in', async () => {
  const forward = tool({
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
  })
  const shuffled = tool({
    parameters: { required: ['query'], properties: { limit: { type: 'integer' }, query: { type: 'string' } }, type: 'object' },
  })

  const first = await apiReport(fixture(budgetOf(), requestOf([message()], { tools: [forward] })))
  const second = await apiReport(fixture(budgetOf(), requestOf([message()], { tools: [shuffled] })))

  assert.equal(first.status, 'pass')
  assert.equal(first.summary.tools, 1)
  assert.equal(first.summary.tokens, second.summary.tokens, 'key order must not change the count')
  assert.equal(
    first.summary.overheadTokens,
    3 + 4 + 16 + 8,
    'replyPrimer, perMessage, toolsPreamble and perToolDefinition, all declared',
  )
})

test('a tool schema deeper than the declared limit is not counted, and the run says so', async () => {
  const nested = tool({ parameters: { type: 'object', properties: { a: { properties: { b: { properties: { c: { type: 'string' } } } } } } } })
  const { code, report } = await cliReport(
    fixture(budgetOf(), requestOf([message()], { tools: [nested] })),
    ['--max-schema-depth', '3'],
  )
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.ok(raisedRules(report).includes('tool-schema-too-deep'))
  assert.equal(report.summary.uncounted, 1)
})

test('an unsupported tokenizer produces an estimate, labelled as one and kept separate', async () => {
  const report = await apiReport(fixture(budgetOf(estimatingProfile()), requestOf([
    message({ id: 'system-turn', text: 'Answer briefly and cite the source article.' }),
  ])))

  assert.equal(report.status, 'pass')
  assert.ok(report.summary.estimatedParts > 0, 'the parts were estimated')
  assert.ok(report.summary.estimatedTokens > 0)
  assert.equal(report.summary.exactTokens, 0, 'nothing here was counted exactly')
  assert.ok(report.summary.tokensLower < report.summary.tokens, 'an estimate carries a band')
  assert.ok(report.summary.tokensUpper > report.summary.tokens)

  const labelled = findingsFor(report, 'estimate-used')
  assert.equal(labelled.length, 1)
  assert.match(labelled[0].message, /part\(s\) were estimated for tokenizer "o200k_base" at 4 characters per token with a tolerance of 0\.25/)
  assert.equal(labelled[0].severity, 'info', 'an estimate is a labelled result, not a failure')
})

test('an unsupported tokenizer with no declared ratio counts nothing and never guesses one', async () => {
  const profile = estimatingProfile()
  delete profile.estimateCharsPerToken
  const { code, report } = await cliReport(fixture(budgetOf(profile)))

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.ok(raisedRules(report).includes('estimate-ratio-undeclared'))
  assert.equal(report.summary.tokens, 3, 'only the declared replyPrimer, which was never in doubt')
  assert.equal(report.summary.checked, 0)
})

test('a count measured elsewhere is exact, and only for the tokenizer it names', async () => {
  const counted = { tokens: 41, tokenizer: 'o200k_base' }
  const good = await apiReport(fixture(budgetOf(estimatingProfile()), requestOf([
    message({ text: 'a message whose real token count was measured by the real tokenizer', counted }),
  ])))
  assert.equal(good.status, 'pass')
  assert.equal(good.summary.declaredTokens, 41)
  assert.ok(good.summary.exactTokens >= 41)

  const mismatched = await cliReport(fixture(budgetOf(estimatingProfile()), requestOf([
    message({ text: 'the same message', counted: { tokens: 41, tokenizer: 'cl100k_base' } }),
  ])))
  assert.equal(mismatched.code, 2, 'a count of something else is not a count of this')
  assert.ok(raisedRules(mismatched.report).includes('declared-count-tokenizer-mismatch'))
  assert.equal(mismatched.report.summary.declaredTokens, 0)
})

test('the output reservation is what the input is budgeted against', async () => {
  // A request that fits the window and not the allowance is the whole reason
  // the reservation exists. 8192 - 8100 leaves 92 tokens for input.
  const request = requestOf([message({ text: 'x'.repeat(200) })])

  const generous = await cliReport(fixture(budgetOf(profileOf({ reserveOutputTokens: 1024 })), request))
  assert.equal(generous.code, 0)
  assert.equal(generous.report.summary.inputAllowance, 7168)

  const tight = await cliReport(fixture(budgetOf(profileOf({ reserveOutputTokens: 8100 })), request))
  assert.equal(tight.code, 1, 'the request fits the window and not the allowance')
  assert.equal(tight.report.summary.inputAllowance, 92)
  assert.match(findingsFor(tight.report, 'budget-exceeded')[0].message, /a 8192 token window less 8100 reserved for output/)
})

test('a profile that budgets no output at all is refused rather than assumed', async () => {
  const profile = profileOf()
  delete profile.reserveOutputTokens
  const { code, report } = await cliReport(fixture(budgetOf(profile)))
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(raisedRules(report), ['output-reservation-undeclared'])
})

test('a reservation that swallows the window is refused, not turned into a negative allowance', async () => {
  const { code, report } = await cliReport(fixture(budgetOf(profileOf({ contextTokens: 1000, reserveOutputTokens: 1000 }))))
  assert.equal(code, 2)
  assert.ok(raisedRules(report).includes('output-reservation-exceeds-context'))
  assert.equal(report.summary.tokens, 0)
})

test('a request-level reservation that swallows the window is refused by its own guard', async () => {
  /**
   * There are two guards, and only one of them had a case. The profile-level
   * one in `src/budget.mjs` fires while the budget is compiled; the
   * request-level one fires after the override is applied, and every existing
   * case reached the first before the second could matter. Removing the
   * request-level check left the suite green and published
   * `inputAllowance: -99991807` in the summary -- a negative allowance that
   * every later comparison then read as "nothing fits".
   *
   * The profile here is entirely reasonable: 8192 with 1024 reserved. Only the
   * request asks for more window than exists.
   */
  const { code, report } = await cliReport(fixture(
    budgetOf(profileOf({ contextTokens: 8192, reserveOutputTokens: 1024 })),
    requestOf([message()], { reserveOutputTokens: 99999999 }),
  ))

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.ok(raisedRules(report).includes('output-reservation-exceeds-context'))
  assert.equal(report.summary.inputAllowance, 0, 'never negative')
  assert.equal(report.summary.reserveOutputTokens, 99999999, 'the override is what was judged')
  assert.equal(raisedRules(report).includes('budget-exceeded'), false, 'the run stopped before it pretended to decide')
})

test('an estimate whose band straddles the allowance is incomplete, never an optimistic pass', async () => {
  /**
   * The decision this tool exists to get right. The point estimate is inside
   * the allowance and the upper bound is outside it, so a tool that reported
   * the point estimate would say "fits" and be wrong exactly when it mattered.
   */
  const text = 'y'.repeat(4000)
  const profile = estimatingProfile({ contextTokens: 2100, reserveOutputTokens: 1024 })
  const { code, report } = await cliReport(fixture(budgetOf(profile), requestOf([message({ text })])))

  assert.equal(report.summary.inputAllowance, 1076)
  assert.ok(report.summary.tokens <= report.summary.inputAllowance, 'the point estimate fits')
  assert.ok(report.summary.tokensUpper > report.summary.inputAllowance, 'the band does not')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.ok(raisedRules(report).includes('budget-undetermined'))
  assert.equal(raisedRules(report).includes('budget-exceeded'), false)
})

test('a band entirely inside the allowance is a pass, and one entirely outside is a failure', async () => {
  const short = await cliReport(fixture(
    budgetOf(estimatingProfile({ contextTokens: 8192, reserveOutputTokens: 1024 })),
    requestOf([message({ text: 'y'.repeat(400) })]),
  ))
  assert.equal(short.code, 0, 'an estimate can still be decisive when the band clears the allowance')
  assert.equal(short.report.status, 'pass')

  const long = await cliReport(fixture(
    budgetOf(estimatingProfile({ contextTokens: 1100, reserveOutputTokens: 1000 })),
    requestOf([message({ text: 'y'.repeat(4000) })]),
  ))
  assert.equal(long.code, 1)
  assert.ok(raisedRules(long.report).includes('budget-exceeded'))
})
