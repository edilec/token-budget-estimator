import assert from 'node:assert/strict'
import test from 'node:test'

import { RULE_SEVERITY } from '../src/index.mjs'
import { RULE_CASES, runCase } from './rule-cases.mjs'

/**
 * Severity, pinned by what the binary does.
 *
 * The report contract is explicit that a severity table asserted against the
 * documentation is not a severity test: a tool can hold the same claim in a
 * source table, a documentation table and a hand-written expected-value map,
 * and a coordinated edit of all three passes. One tool in this catalog had 40
 * of 52 error rules survive exactly that flip.
 *
 * So these cases drive real inputs through the real binary and assert the
 * observable outcome. Demoting any error rule to `warning` makes its run exit 0
 * and fails the corresponding case here, whatever the tables say.
 */

const byRule = new Map(RULE_CASES.map((testCase) => [testCase.ruleId, testCase]))

test('every rule in the severity table has a runnable case', () => {
  const documented = Object.keys(RULE_SEVERITY).sort()
  assert.deepEqual([...byRule.keys()].sort(), documented, 'a rule with no case is a rule nothing holds')
  assert.equal(RULE_CASES.length, documented.length, 'no duplicate cases')
})

for (const testCase of RULE_CASES) {
  const severity = RULE_SEVERITY[testCase.ruleId]

  test(`${testCase.ruleId} (${severity}) behaves as its severity says`, async () => {
    const { code, report } = await runCase(testCase)
    assert.notEqual(report, null, 'a run with a subject always writes a report to stdout')
    const raised = report.findings.filter((finding) => finding.ruleId === testCase.ruleId)
    assert.ok(raised.length > 0, `the case did not raise ${testCase.ruleId}; it raised ${report.findings.map((f) => f.ruleId).join(', ')}`)
    assert.equal(raised[0].severity, severity, 'the emitted severity, not the table')

    if (severity === 'error') {
      assert.notEqual(code, 0, `${testCase.ruleId} is an error rule, so this run must not exit 0`)
      assert.notEqual(report.status, 'pass', `${testCase.ruleId} is an error rule, so this run must not report a pass`)
      assert.ok(code === 1 || code === 2, `expected 1 or 2, got ${code}`)
      assert.ok(report.status === 'fail' || report.status === 'incomplete')
    } else {
      // An info or warning rule must be able to appear in a run that still
      // passes; otherwise the distinction between the classes is decorative.
      const errors = report.findings.filter((finding) => finding.severity === 'error')
      assert.deepEqual(errors, [], `${testCase.ruleId} should be reachable without an error`)
      assert.equal(report.status, 'pass')
      assert.equal(code, 0)
    }
  })
}

test('the counts in the summary are the counts in the findings', async () => {
  for (const testCase of RULE_CASES) {
    const { report } = await runCase(testCase)
    const errors = report.findings.filter((finding) => finding.severity === 'error').length
    const warnings = report.findings.filter((finding) => finding.severity === 'warning').length
    assert.equal(report.summary.errors, errors, testCase.ruleId)
    assert.equal(report.summary.warnings, warnings, testCase.ruleId)
  }
})

test('a status of pass is never reported alongside an error finding', async () => {
  for (const testCase of RULE_CASES) {
    const { report, code } = await runCase(testCase)
    if (report.findings.some((finding) => finding.severity === 'error')) {
      assert.notEqual(report.status, 'pass', testCase.ruleId)
      assert.notEqual(code, 0, testCase.ruleId)
    }
  }
})
