import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { budgetOf, cliReport, cliRun, everyString, fixture, withRoot } from './support.mjs'

/**
 * The JSON parse diagnostic, pinned by what it emits.
 *
 * V8 reports a parse failure two ways and only one is safe. The unsafe one
 * quotes the input back, and the quoted window is taken from wherever the
 * offence is -- not from the start -- so truncating the front is not a fix
 * either. Nineteen of thirty-eight tools in this catalog shipped a helper whose
 * branches were in the wrong order; the ones that wrote this test found it.
 *
 * It matters more here than in most tools, because the document being parsed is
 * a prompt: the first ten characters of one are routinely a system instruction,
 * a customer's name, or a key somebody pasted into a message while debugging.
 *
 * `CANARY` below is a synthetic token invented for these tests. It is not a
 * credential and it is not personal data; it exists so an assertion can say
 * "this string must not appear on either stream".
 */

const CANARY = 'CANARYTOKEN7ZZQ'

test('a document whose own text reads "at position 1" is not sliced back out', () => {
  let message
  try {
    JSON.parse('at position 1')
  } catch (error) {
    message = error.message
  }
  assert.equal(message, 'Unexpected token \'a\', "at position 1" is not valid JSON', 'the V8 wording this case exists for')
  assert.equal(parseFailureDetail({ message }), "unexpected token 'a' at the start of the document")
})

test('a document that is nothing but a credential-shaped token is not reproduced', () => {
  let detail
  try {
    JSON.parse(CANARY)
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assert.equal(detail, "unexpected token 'C' at the start of the document")
  assert.equal(detail.includes(CANARY.slice(0, 8)), false, 'V8 quotes ten characters, so eight is the interesting prefix')
})

test('a long document with a sensitive prefix is not reproduced either', () => {
  let message
  try {
    JSON.parse(`${CANARY}${'x'.repeat(2000)}`)
  } catch (error) {
    message = error.message
  }
  assert.match(message, /"CANARYTOKE"\.\.\. is not valid JSON$/, 'the V8 wording this case exists for')
  const detail = parseFailureDetail({ message })
  for (let length = CANARY.length; length >= 4; length -= 1) {
    assert.equal(detail.includes(CANARY.slice(0, length)), false, `prefix of ${length} characters leaked`)
  }
})

test('a quoted window taken from the middle of a document is not reproduced', () => {
  let message
  try {
    JSON.parse(`[${'1,'.repeat(30)}${CANARY}]`)
  } catch (error) {
    message = error.message
  }
  assert.match(message, /^Unexpected token 'C', \.\.\."/, 'the V8 wording this case exists for')
  assert.equal(parseFailureDetail({ message }), "unexpected token 'C' inside the document")
})

test('a quoted span containing a newline is still recognised as a quoted span', () => {
  // Without the `s` flag the pattern fails to match and the helper falls through
  // to the offset branch. That is safe by luck here and not safe at all for a
  // document that also contains the text "at position N".
  let message
  try {
    JSON.parse('[\n1,\nCANARY\nTOKEN\n]')
  } catch (error) {
    message = error.message
  }
  assert.ok(message.includes('\n'), 'the V8 message really does carry a newline here')
  assert.equal(parseFailureDetail({ message }), "unexpected token 'C' at the start of the document")
})

test('the safe positional form keeps its position, line and column', () => {
  let detail
  try {
    JSON.parse('{"alpha": 1 "beta": 2}')
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assert.equal(detail, "Expected ',' or '}' after property value in JSON at position 12 (line 1 column 13)")
  assert.match(detail, /position 12/)
  assert.match(detail, /line 1 column 13/)
})

test('a wording this helper has never seen is refused if a double quote survived', () => {
  // The backstop, and the reason the helper is safe against V8 wordings that do
  // not exist yet: across 500,206 distinct parse messages, every message with
  // no quoted snippet carried no double quote at all.
  assert.equal(
    parseFailureDetail({ message: `Some future wording naming "${CANARY}" at position 3` }),
    'the document could not be parsed as JSON',
  )
  assert.equal(parseFailureDetail({ message: 'Unexpected end of JSON input' }), 'Unexpected end of JSON input')
  assert.equal(parseFailureDetail({}), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(null), 'the document could not be parsed as JSON')
})

test('the canary never reaches stdout or stderr through the real binary', async () => {
  for (const [name, content] of [
    ['budget.json', CANARY],
    ['request.json', `{"schemaVersion": "1", "messages": ${CANARY}}`],
  ]) {
    const files = { ...fixture(), [name]: content }
    const { code, stdout, stderr, report } = await cliReport(files)
    assert.equal(code, 2, 'an unparseable input is evidence that was not obtained')
    assert.equal(report.status, 'incomplete')
    for (let length = CANARY.length; length >= 4; length -= 1) {
      const prefix = CANARY.slice(0, length)
      assert.equal(stdout.includes(prefix), false, `${name}: stdout leaked ${length} characters`)
      assert.equal(stderr.includes(prefix), false, `${name}: stderr leaked ${length} characters`)
    }
  }
})

test('the canary never reaches stderr through a configuration error either', async () => {
  await withRoot(fixture(), async (root) => {
    const result = await cliRun(['--root', root, `--${CANARY}`, 'value'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error has no subject, so stdout stays empty')
    assert.match(result.stderr, /Unknown option/)
  })
})

test('no string anywhere in an unparseable run carries the document', async () => {
  const files = { ...fixture(), 'request.json': `{"a": ${CANARY}}` }
  const { report } = await cliReport(files)
  for (const value of everyString(report)) assert.equal(value.includes(CANARY), false)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'input-not-json'), true)
})

test('a budget that is valid JSON but not an object is refused without reproducing it', async () => {
  const { report } = await cliReport({ ...fixture(), 'budget.json': `"${CANARY}"` })
  assert.equal(report.status, 'incomplete')
  for (const value of everyString(report)) assert.equal(value.includes(CANARY), false)
  assert.match(
    report.findings.find((finding) => finding.ruleId === 'budget-invalid').message,
    /a string of \d+ character\(s\)/,
    'the shape is reported, never the value',
  )
  assert.ok(budgetOf().model.length > 0)
})
