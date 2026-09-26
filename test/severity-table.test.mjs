import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, RULE_SEVERITY, byCodeUnit, createFinding } from '../src/index.mjs'
import { projectDirectory } from './support.mjs'

/**
 * The severity table against the documented catalog, in both directions.
 *
 * This is a secondary guard and is labelled as such. The report contract is
 * explicit that a table asserted against the documentation is *not* the
 * severity test: a coordinated edit of the table and the document passes it.
 * `test/severity-behaviour.test.mjs` is the real one -- it drives every rule
 * through the real binary and pins the exit code.
 *
 * What this file is good for is the drift a behavioural test cannot see: a rule
 * that exists in code and is documented nowhere, or documented and never
 * emitted.
 */

async function documentedRules(file) {
  const text = await readFile(join(projectDirectory, file), 'utf8')
  const rows = new Map()
  for (const line of text.split('\n')) {
    const match = /^\| `([a-z0-9-]+)` \| (error|warning|info) \|/.exec(line)
    if (match !== null) rows.set(match[1], match[2])
  }
  return rows
}

test('docs/budget-rules.md documents every rule, and only rules that exist', async () => {
  const documented = await documentedRules('docs/budget-rules.md')
  assert.deepEqual([...documented.keys()].sort(byCodeUnit), Object.keys(RULE_SEVERITY).sort(byCodeUnit))
  for (const [ruleId, severity] of documented) {
    assert.equal(RULE_SEVERITY[ruleId], severity, `docs and code disagree about ${ruleId}`)
  }
})

test('the README rule table is a subset of the catalog with matching severities', async () => {
  const readme = await documentedRules('README.md')
  assert.ok(readme.size >= 8, 'the README summarises the rules that carry the product')
  for (const [ruleId, severity] of readme) {
    assert.equal(RULE_SEVERITY[ruleId], severity, `the README and code disagree about ${ruleId}`)
  }
})

test('rule ids are stable kebab-case and the table is frozen', () => {
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.match(ruleId, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, ruleId)
  }
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.throws(() => {
    RULE_SEVERITY['estimate-used'] = 'error'
  }, TypeError)
})

test('a finding takes its severity from the table and an unknown rule throws', () => {
  const finding = createFinding({ ruleId: 'budget-exceeded', file: 'request.json', message: 'm' })
  assert.equal(finding.severity, 'error')
  assert.deepEqual(Object.keys(finding), ['ruleId', 'severity', 'message', 'location'])
  assert.throws(
    () => createFinding({ ruleId: 'invented-rule', file: 'f', message: 'm' }),
    /is not in RULE_SEVERITY/,
    'a rule with no severity must not default to something harmless',
  )
})

test('every documented limit and its default appear in the README and the docs', async () => {
  for (const file of ['README.md', 'docs/budget-rules.md']) {
    const text = await readFile(join(projectDirectory, file), 'utf8')
    for (const [key, value] of Object.entries(DEFAULT_LIMITS)) {
      assert.ok(text.includes(`\`${key}\``), `${key} is not documented in ${file}`)
      assert.ok(text.includes(String(value)), `the default for ${key} is not documented in ${file}`)
    }
  }
})
