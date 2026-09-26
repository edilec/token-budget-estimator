import assert from 'node:assert/strict'
import test from 'node:test'

import { excerpt, hasForbiddenCharacter } from '../src/index.mjs'
import { FORBIDDEN, budgetOf, cliReport, everyString, fixture, message, profileOf, requestOf } from './support.mjs'

/**
 * Nothing untrusted carries a control, separator or bidi character into output.
 *
 * The report contract records four tools that stripped C0 and the line and
 * paragraph separators and let the C1 range through -- U+0085 is a line break
 * to a great many consumers and U+009B is the 8-bit CSI, which needs no ESC in
 * front of it -- and one tool that sanitised its evidence field carefully while
 * a page id containing a newline forged whole lines in the report.
 *
 * So each class is tested, and each is tested arriving through an identifier as
 * well as through text. Here the identifier route is an arbitrary JSON key: a
 * message, a budget document and an overhead block can all carry one, and each
 * is named in the message that refuses it.
 */

for (const [name, character] of Object.entries(FORBIDDEN)) {
  test(`${name} arriving through a message key never reaches the report`, async () => {
    const { report } = await cliReport({
      ...fixture(),
      'request.json': JSON.stringify(requestOf([{ ...message(), [`extra${character}Key`]: 1 }])),
    })
    assert.equal(report.status, 'incomplete')
    for (const value of everyString(report)) {
      assert.equal(hasForbiddenCharacter(value), false, `${name} survived in ${JSON.stringify(value)}`)
    }
    assert.ok(report.findings.some((finding) => finding.ruleId === 'message-invalid'))
  })

  test(`${name} arriving through an overhead key never reaches the report`, async () => {
    const profile = profileOf()
    profile.overhead = { ...profile.overhead, [`per${character}Thing`]: 1 }
    const { report } = await cliReport({ ...fixture(), 'budget.json': JSON.stringify(budgetOf(profile)) })
    assert.equal(report.status, 'incomplete')
    for (const value of everyString(report)) {
      assert.equal(hasForbiddenCharacter(value), false, `${name} survived in ${JSON.stringify(value)}`)
    }
    assert.ok(report.findings.some((finding) => finding.ruleId === 'overhead-invalid'))
  })
}

test('the human summary on stderr is sanitised too, not only the JSON on stdout', async () => {
  const NEL = FORBIDDEN['C1 NEL']
  const { stderr } = await cliReport({
    ...fixture(),
    'request.json': JSON.stringify(requestOf([{ ...message(), [`extra${NEL}Key`]: 1 }])),
  }, [])
  assert.equal(hasForbiddenCharacter(stderr.replaceAll('\n', '')), false)
})

test('a message id carrying a control character is refused without being echoed', async () => {
  const ESC = FORBIDDEN['C0 ESC']
  const { report } = await cliReport(fixture(budgetOf(), requestOf([message({ id: `turn${ESC}one` })])))
  assert.equal(report.status, 'incomplete')
  for (const value of everyString(report)) assert.equal(hasForbiddenCharacter(value), false)
  assert.match(
    report.findings.find((finding) => finding.ruleId === 'message-invalid').message,
    /A message id must be a printable identifier; entry 0 has a string of 8 character\(s\)\./,
    'the shape is reported, never the value',
  )
})

test('message text is never echoed into the report, sanitised or otherwise', async () => {
  // Text is counted, not quoted. A prompt is exactly the kind of document that
  // holds a customer's words or an internal system description, and a budget
  // report is pasted into pull requests.
  const SENTENCE = 'ZZQ-a-distinctive-sentence-from-inside-the-prompt'
  const { report } = await cliReport(fixture(budgetOf(), requestOf([
    message({ text: `${SENTENCE} and some more words after it` }),
  ])))
  assert.equal(report.status, 'pass')
  for (const value of everyString(report)) assert.equal(value.includes(SENTENCE), false)
  assert.ok(report.summary.tokens > 0, 'it was counted, which is the point')
})

test('a tool description is never echoed either', async () => {
  const SENTENCE = 'ZZQ-an-internal-tool-description-nobody-should-republish'
  const { report } = await cliReport(fixture(budgetOf(), requestOf([message()], {
    tools: [{ name: 'search', description: SENTENCE, parameters: { type: 'object' } }],
  })))
  assert.equal(report.status, 'pass')
  for (const value of everyString(report)) assert.equal(value.includes(SENTENCE), false)
})

test('excerpt collapses whitespace, strips every class and bounds the result', () => {
  assert.equal(excerpt('  a\t\tb\n\nc  '), 'a b c')
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(hasForbiddenCharacter(excerpt(`a${character}b`)), false, name)
  }
  assert.equal(excerpt('x'.repeat(200)).length, 163, '160 characters plus the ellipsis')
  assert.equal(excerpt('x'.repeat(200)).endsWith('...'), true)
  assert.equal(excerpt('short', 3), 'sho...')
})
