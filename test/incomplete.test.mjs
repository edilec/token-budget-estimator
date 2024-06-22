import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UNICODE, budgetOf, cliReport, estimatingProfile, findingsFor, fixture,
  message, profileOf, raisedRules, requestOf, tool,
} from './support.mjs'

/**
 * Evidence the tool did not obtain never satisfies a check.
 *
 * In a counting tool the failure mode is specific and seductive: a part that
 * could not be counted contributes zero, and zero is a number, so the total
 * still looks like a total and still compares against the allowance. Every
 * case here asserts that the run says `incomplete`, exits 2, and counts the
 * part as uncounted rather than as nothing.
 */

async function expectIncomplete(files, args = []) {
  const { code, report, stdout } = await cliReport(files, args)
  assert.notEqual(stdout, '', 'a run with a subject always writes a report, so the consumer learns which input failed')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  return report
}

test('an input that could not be read reports incomplete on stdout and exits 2', async () => {
  const report = await expectIncomplete({ 'budget.json': budgetOf() })
  assert.deepEqual(raisedRules(report), ['input-unreadable'])
  assert.match(findingsFor(report, 'input-unreadable')[0].message, /ENOENT/)
})

test('an input that is not UTF-8 is decided by the decoder, not by the decoded text', async () => {
  // A lenient decode would not merely mislabel the file: a replacement
  // character is one scalar and three UTF-8 bytes, so it would return a
  // different number from the one the request actually costs.
  const report = await expectIncomplete({
    ...fixture(),
    'request.json': new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]),
  })
  assert.ok(raisedRules(report).includes('input-not-utf8'))
})

test('a file that legitimately contains a replacement character is still counted', async () => {
  const { code, report } = await cliReport(fixture(budgetOf(), requestOf([
    message({ text: `a replacement character: ${String.fromCodePoint(0xfffd)}` }),
  ])))
  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
})

test('an uncounted part is counted as uncounted, never as zero', async () => {
  /**
   * The seduction this test exists for. The second message cannot be counted,
   * and the arithmetic would happily carry on without it -- producing a total
   * that is too small, compared against the allowance, and reported as a pass.
   */
  const report = await expectIncomplete(fixture(budgetOf(), requestOf([
    message({ id: 'countable', text: 'a hundred characters or so of perfectly ordinary text' }),
    message({ id: 'truncated', role: 'user', text: `cut mid-character ${UNICODE.loneHighSurrogate}` }),
  ])))

  assert.ok(raisedRules(report).includes('text-lone-surrogate'))
  assert.equal(report.summary.uncounted, 1)
  assert.equal(report.summary.checked, 1, 'one of the two messages was counted')
  assert.equal(report.summary.messages, 2)
})

test('an empty message list is refused rather than passing on no evidence', async () => {
  const report = await expectIncomplete(fixture(budgetOf(), requestOf([])))
  assert.deepEqual(raisedRules(report), ['no-messages'])
  assert.equal(report.summary.tokens, 0)
})

test('a request whose parts all failed to count is refused, not reported as overhead', async () => {
  const report = await expectIncomplete(fixture(budgetOf(), requestOf([
    message({ text: UNICODE.loneHighSurrogate }),
  ])))
  assert.ok(raisedRules(report).includes('no-parts-counted'))
  assert.equal(report.summary.checked, 0)
  assert.match(findingsFor(report, 'no-parts-counted')[0].message, /the total is overhead alone/)
})

test('an unsupported tokenizer with no ratio reports once, not once per part', async () => {
  const report = await expectIncomplete(fixture(
    budgetOf(estimatingProfile({ estimateCharsPerToken: undefined })),
    requestOf([message(), message({ id: 'second', role: 'user' }), message({ id: 'third', role: 'tool' })]),
  ))
  assert.equal(findingsFor(report, 'estimate-ratio-undeclared').length, 1, 'one diagnostic, not one per part')
  assert.equal(report.summary.uncounted > 0, true)
})

test('a tool whose schema could not be serialised leaves the run incomplete', async () => {
  const report = await expectIncomplete(
    fixture(budgetOf(), requestOf([message()], {
      tools: [tool({ parameters: { a: { b: { c: { d: { e: 1 } } } } } })],
    })),
    ['--max-schema-depth', '2'],
  )
  assert.ok(raisedRules(report).includes('tool-schema-too-deep'))
  assert.equal(report.summary.uncounted, 1)
  assert.equal(report.summary.checked, 1, 'the message was counted; the tool was not')
})

test('a message list stopped by a limit leaves the run incomplete even though it fits', async () => {
  // The counted prefix fits the allowance easily. What is unknown is the rest,
  // and a total that omits an unknown tail is not a total.
  const report = await expectIncomplete(
    fixture(budgetOf(), requestOf([message(), message({ id: 'second', role: 'user' })])),
    ['--max-messages', '1'],
  )
  assert.ok(raisedRules(report).includes('too-many-messages'))
  assert.equal(report.summary.messages, 1)
  assert.ok(report.summary.tokens < report.summary.inputAllowance, 'what was counted fits, and that is not the question')
})

test('a budget that did not compile means nothing was counted', async () => {
  const report = await expectIncomplete(fixture(budgetOf(profileOf({ tokenizer: 9 }))))
  assert.deepEqual(raisedRules(report), ['profile-invalid'])
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.contextTokens, 0)
})

test('truncating the findings list makes the report incomplete rather than quietly partial', async () => {
  const report = await expectIncomplete(
    fixture(budgetOf(), requestOf([message(), message({ id: 'second', role: 'user' })])),
    ['--max-findings', '1'],
  )
  assert.ok(raisedRules(report).includes('too-many-findings'))
  assert.equal(report.findings.length, 1)
})

test('an estimate that cannot decide is incomplete, and the same request with a real count is not', async () => {
  const straddling = fixture(
    budgetOf(estimatingProfile({ contextTokens: 2100, reserveOutputTokens: 1024 })),
    requestOf([message({ text: 'y'.repeat(4000) })]),
  )
  const undecided = await expectIncomplete(straddling)
  assert.ok(raisedRules(undecided).includes('budget-undetermined'))

  // The same request, with the count measured by the real tokenizer, decides.
  const measured = fixture(
    budgetOf(estimatingProfile({ contextTokens: 2100, reserveOutputTokens: 1024 })),
    requestOf([message({
      text: 'y'.repeat(4000),
      counted: { tokens: 1000, tokenizer: 'o200k_base' },
    })]),
  )
  const { code, report } = await cliReport(measured)
  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.declaredTokens, 1000)

  // The band does not vanish: a `counted` block covers the message text, and
  // the role beside it is still estimated. What it does is collapse from
  // hundreds of tokens to a couple, which is the difference between a verdict
  // and a shrug.
  const measuredBand = report.summary.tokensUpper - report.summary.tokensLower
  const estimatedBand = undecided.summary.tokensUpper - undecided.summary.tokensLower
  assert.ok(measuredBand <= 5, `the residual band is ${measuredBand}`)
  assert.ok(estimatedBand > 100, `the estimated band was ${estimatedBand}`)
})
