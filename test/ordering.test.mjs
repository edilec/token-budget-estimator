import assert from 'node:assert/strict'
import test from 'node:test'

import { byCodeUnit, canonicalJson, compareFindings } from '../src/index.mjs'
import { budgetOf, cliReport, findingsFor, fixture, message, profileOf, requestOf } from './support.mjs'

/**
 * Ordering, pinned by what the tool emits.
 *
 * A source scan for `.localeCompare(` is not a determinism test. `Intl.Collator`
 * collates identically and spells differently, so the scan passes while the
 * output silently starts depending on the ICU data of whichever Node build is
 * running -- and that has produced a real ordering difference in this catalog.
 *
 * Every case below uses inputs an English collator orders the other way round,
 * pushes them through the real path, and asserts the exact emitted order. The
 * collator is constructed in each test and asserted to disagree, which is what
 * makes these cases cases at all.
 */

const collator = new Intl.Collator('en')

test('findings from two files are ordered by code unit, not by collation', async () => {
  assert.equal(collator.compare('Z-budget.json', 'a-request.json') > 0, true, 'the disagreement being pinned')

  const { report } = await cliReport(
    { 'Z-budget.json': 'not json', 'a-other.json': 'unused' },
    ['--budget', 'Z-budget.json', '--request', 'a-request.json'],
  )

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file),
    ['Z-budget.json', 'a-request.json'],
    'Z (0x5A) precedes a (0x61) by code unit; an English collator puts a first',
  )
})

test('a list of profile names inside a message is ordered by code unit', async () => {
  assert.equal(collator.compare('README', 'assets') > 0, true, 'the disagreement being pinned')

  const budget = { schemaVersion: '1', model: 'nowhere', profiles: { assets: profileOf(), README: profileOf() } }
  const { report } = await cliReport(fixture(budget))
  assert.match(findingsFor(report, 'profile-missing')[0].message, /declared profiles \(README, assets\)/)
})

test('a list of unknown keys inside a message is ordered by code unit', async () => {
  assert.equal(collator.compare('a-b', 'a_b') > 0, true, 'collation treats the underscore as ignorable')
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)

  const { report } = await cliReport(fixture(budgetOf(), requestOf([
    { ...message(), a_b: 1, 'a-b': 2, README: 3, assets: 4 },
  ])))
  assert.match(findingsFor(report, 'message-invalid')[0].message, /also declares README, a-b, a_b, assets/)
})

test('canonical schema serialisation orders keys by code unit', () => {
  // The count is the same either way -- the same characters in a different
  // order -- so only the emitted text catches a collator here. It is asserted
  // because the serialisation is what makes two machines agree byte for byte.
  assert.equal(collator.compare('Z', 'a') > 0, true)
  assert.equal(collator.compare('a-b', 'a_b') > 0, true)
  const written = canonicalJson({ a_b: 1, a: 2, Z: 3, 'a-b': 4 }, 10)
  assert.equal(written.text, '{"Z":3,"a":2,"a-b":4,"a_b":1}')
})

test('the report is emitted in the documented order, not in the order it was produced', async () => {
  /**
   * `compareFindings` had a unit test; the report had none. Deleting
   * `.sort(compareFindings)` -- its only call site -- changed stdout byte for
   * byte and left all 207 tests green, because every ordering fixture happened
   * to be produced in sorted order already. That is report-contract defect
   * class 7: an assertion that cannot fail is not a test.
   *
   * This fixture is produced in an order the sort has to change. The output
   * reservation is judged before a single message is counted, so
   * `output-reservation-below-minimum` at `/reserveOutputTokens` is produced
   * first and has to be emitted last: `/messages` precedes it by code unit.
   */
  const budget = budgetOf(profileOf({ contextTokens: 200, reserveOutputTokens: 32, minOutputTokens: 128 }))
  const request = requestOf([
    message({ id: 'system-turn', text: 'x'.repeat(400) }),
    message({ id: 'user-turn', role: 'user', text: 'y'.repeat(50) }),
  ])

  const { report, code } = await cliReport(fixture(budget, request))
  assert.equal(code, 1)
  assert.deepEqual(
    report.findings.map((finding) => [finding.location.pointer, finding.ruleId]),
    [
      ['/messages', 'budget-exceeded'],
      ['/messages/0', 'budget-contributor'],
      ['/messages/1', 'budget-contributor'],
      ['/reserveOutputTokens', 'output-reservation-below-minimum'],
    ],
    'the reservation finding is produced first and must be emitted last',
  )
  assert.ok(byCodeUnit('/messages', '/reserveOutputTokens') < 0, 'the pair the case turns on')
})

test('two runs over identical inputs produce byte-identical stdout', async () => {
  const files = fixture(budgetOf(), requestOf([
    message({ id: 'Zebra' }),
    message({ id: 'apple', role: 'user' }),
    message({ id: 'a-b', role: 'tool' }),
    message({ id: 'a_b', role: 'assistant' }),
  ]))
  const first = await cliReport(files)
  const second = await cliReport(files)
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
})

test('compareFindings is a total order over the documented key', () => {
  const finding = (file, pointer, ruleId, message_, evidence) => ({
    location: { file, pointer }, ruleId, message: message_, evidence,
  })
  assert.equal(compareFindings(finding('a', '', 'r', 'm', 'e'), finding('a', '', 'r', 'm', 'e')), 0)
  assert.ok(compareFindings(finding('Z', '', 'r', 'm'), finding('a', '', 'r', 'm')) < 0)
  assert.ok(compareFindings(finding('a', '/Z', 'r', 'm'), finding('a', '/a', 'r', 'm')) < 0)
  assert.ok(compareFindings(finding('a', '', 'A', 'm'), finding('a', '', 'a', 'm')) < 0)
  assert.ok(compareFindings(finding('a', '', 'r', 'Z'), finding('a', '', 'r', 'a')) < 0)
  assert.ok(compareFindings(finding('a', '', 'r', 'm', 'Z'), finding('a', '', 'r', 'm', 'a')) < 0)
  assert.ok(compareFindings(finding('a', '', 'r', 'm'), finding('a', '', 'r', 'm', 'a')) < 0)
})
