import assert from 'node:assert/strict'
import test from 'node:test'

import { OVERHEAD_KEYS, ROLES } from '../src/index.mjs'
import {
  apiReport, budgetOf, estimatingProfile, findingsFor, fixture, message,
  profileOf, raisedRules, requestOf, tool,
} from './support.mjs'

/**
 * What the two input documents must look like, and what happens when they do
 * not.
 *
 * The recurring principle: an unknown key is refused rather than ignored. A key
 * this tool silently drops is a cost somebody believes is being counted, and a
 * one-character typo in an overhead component would quietly remove it from the
 * budget.
 */

const only = (report, ...rules) => assert.deepEqual(raisedRules(report), rules.sort())

test('an unknown key in the budget document is refused, and named', async () => {
  const report = await apiReport(fixture(budgetOf(profileOf(), { profile: 'house' })))
  only(report, 'budget-invalid')
  assert.match(findingsFor(report, 'budget-invalid')[0].message, /it also declares profile/)
})

test('an unknown key in a profile is refused, and named', async () => {
  const report = await apiReport(fixture(budgetOf(profileOf({ maxTokens: 10 }))))
  only(report, 'profile-invalid')
  assert.match(findingsFor(report, 'profile-invalid')[0].message, /also declares maxTokens/)
})

test('an unknown overhead component is refused rather than ignored', async () => {
  const report = await apiReport(fixture(budgetOf(profileOf({ overhead: { ...Object.fromEntries(OVERHEAD_KEYS.map((k) => [k, 1])), perImage: 100 } }))))
  only(report, 'overhead-invalid')
  assert.match(findingsFor(report, 'overhead-invalid')[0].message, /also declares perImage/)
})

test('every overhead component is required, one at a time', async () => {
  for (const key of OVERHEAD_KEYS) {
    const overhead = Object.fromEntries(OVERHEAD_KEYS.filter((other) => other !== key).map((other) => [other, 1]))
    const report = await apiReport(fixture(budgetOf(profileOf({ overhead }))))
    only(report, 'overhead-invalid')
    assert.match(findingsFor(report, 'overhead-invalid')[0].message, new RegExp(`overhead\\.${key} must be an integer`), key)
  }
})

test('an overhead of zero is allowed, because zero is a choice somebody made', async () => {
  const overhead = Object.fromEntries(OVERHEAD_KEYS.map((key) => [key, 0]))
  const report = await apiReport(fixture(budgetOf(profileOf({ overhead }))))
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.overheadTokens, 0)
})

test('a model naming no profile is refused rather than falling back to any of them', async () => {
  const report = await apiReport(fixture(budgetOf(profileOf(), { model: 'somewhere-else' })))
  only(report, 'profile-missing')
  assert.match(findingsFor(report, 'profile-missing')[0].message, /not one of the declared profiles \(house\)/)
  assert.match(findingsFor(report, 'profile-missing')[0].suggestion, /has no window, no reservation and no overhead/)
})

test('an estimate ratio outside its range is refused, in both directions', async () => {
  for (const value of [0, 0.05, 1000, 'four', Number.POSITIVE_INFINITY]) {
    const report = await apiReport(fixture(budgetOf(estimatingProfile({ estimateCharsPerToken: value }))))
    assert.ok(raisedRules(report).includes('profile-invalid'), String(value))
  }
})

test('an estimate tolerance outside its range is refused', async () => {
  for (const value of [0, -0.1, 1.5, 'wide']) {
    const report = await apiReport(fixture(budgetOf(estimatingProfile({ estimateTolerance: value }))))
    assert.ok(raisedRules(report).includes('profile-invalid'), String(value))
  }
  const fine = await apiReport(fixture(budgetOf(estimatingProfile({ estimateTolerance: 1 }))))
  assert.equal(fine.status, 'pass')
})

test('a role outside the declared set is refused, because its overhead is unknown', async () => {
  const report = await apiReport(fixture(budgetOf(), requestOf([message({ role: 'narrator' })])))
  assert.ok(raisedRules(report).includes('role-unknown'))
  assert.match(findingsFor(report, 'role-unknown')[0].message, new RegExp(ROLES.join(', ')))

  for (const role of ROLES) {
    const fine = await apiReport(fixture(budgetOf(), requestOf([message({ role })])))
    assert.equal(fine.status, 'pass', role)
  }
})

test('a duplicate message id is refused because a contributor naming it would be ambiguous', async () => {
  const report = await apiReport(fixture(budgetOf(), requestOf([message(), message({ role: 'user' })])))
  assert.ok(raisedRules(report).includes('message-duplicate'))
})

test('a duplicate tool name is refused', async () => {
  const report = await apiReport(fixture(budgetOf(), requestOf([message()], { tools: [tool(), tool()] })))
  assert.ok(raisedRules(report).includes('tool-duplicate'))
})

test('a counted block must carry both a number and the tokenizer it came from', async () => {
  for (const counted of [
    { tokens: 10 },
    { tokenizer: 'utf8-bytes' },
    { tokens: 10, tokenizer: 'utf8-bytes', measuredAt: 'today' },
    { tokens: 1.5, tokenizer: 'utf8-bytes' },
    { tokens: 10, tokenizer: '9lives' },
    'ten',
  ]) {
    const report = await apiReport(fixture(budgetOf(), requestOf([message({ counted })])))
    assert.ok(raisedRules(report).includes('declared-count-invalid'), JSON.stringify(counted))
  }
  const fine = await apiReport(fixture(budgetOf(), requestOf([message({ counted: { tokens: 0, tokenizer: 'utf8-bytes' } })])))
  assert.equal(fine.status, 'pass', 'zero is a legitimate measured count')
})

test('a tool whose parameters are not an object is refused rather than serialised', async () => {
  const report = await apiReport(fixture(budgetOf(), requestOf([message()], { tools: [tool({ parameters: ['type', 'object'] })] })))
  assert.ok(raisedRules(report).includes('tool-schema-invalid'))
})

test('a tool with no parameters at all is counted, because a tool may take none', async () => {
  const report = await apiReport(fixture(budgetOf(), requestOf([message()], {
    tools: [{ name: 'ping', description: 'Check that the service answers.' }],
  })))
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.tools, 1)
})

test('a request-level output reservation overrides the profile and is validated the same way', async () => {
  const overridden = await apiReport(fixture(budgetOf(), requestOf([message()], { reserveOutputTokens: 2048 })))
  assert.equal(overridden.summary.reserveOutputTokens, 2048)
  assert.equal(overridden.summary.inputAllowance, 8192 - 2048)

  const nonsense = await apiReport(fixture(budgetOf(), requestOf([message()], { reserveOutputTokens: -1 })))
  assert.ok(raisedRules(nonsense).includes('request-invalid'))
})

test('the schema version of each document is checked', async () => {
  const badBudget = await apiReport(fixture(budgetOf(profileOf(), { schemaVersion: 1 })))
  only(badBudget, 'budget-invalid')
  const badRequest = await apiReport(fixture(budgetOf(), requestOf([message()], { schemaVersion: '2' })))
  only(badRequest, 'request-invalid')
})

test('a message with no text is refused rather than counted as empty', async () => {
  const report = await apiReport(fixture(budgetOf(), requestOf([{ id: 'm', role: 'user' }])))
  assert.ok(raisedRules(report).includes('message-invalid'))

  const empty = await apiReport(fixture(budgetOf(), requestOf([message({ text: '' })])))
  assert.equal(empty.status, 'pass', 'an explicitly empty message is a different thing and is counted')
})
