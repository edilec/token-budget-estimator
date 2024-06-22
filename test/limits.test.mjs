import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, estimateBudget, validateLimits } from '../src/index.mjs'
import {
  apiReport, budgetOf, cliReport, cliRun, findingsFor, fixture, message,
  raisedRules, requestOf, tool, withRoot,
} from './support.mjs'

/**
 * Every documented limit is enforced, reported by name, and reachable from the
 * command line.
 *
 * A configuration key that is accepted and silently ignored is a limit nobody
 * enforces -- one tool in this catalog documented a time budget the CLI never
 * wired through. So each limit is driven from argv, not only from the API, and
 * an unknown key is refused rather than dropped.
 */

test('every default limit has a hard cap and a command-line flag', async () => {
  const documented = Object.keys(DEFAULT_LIMITS).sort()
  assert.deepEqual(Object.keys(HARD_LIMITS).sort(), documented)
  for (const key of documented) assert.ok(HARD_LIMITS[key] >= DEFAULT_LIMITS[key], key)

  const help = (await cliRun(['--help'])).stdout
  const flags = {
    maxFileBytes: '--max-file-bytes',
    maxFindings: '--max-findings',
    maxMessages: '--max-messages',
    maxSchemaDepth: '--max-schema-depth',
    maxTextChars: '--max-text-chars',
    maxTools: '--max-tools',
  }
  assert.deepEqual(Object.keys(flags).sort(), documented)
  for (const [key, flag] of Object.entries(flags)) {
    assert.ok(help.includes(flag), `${flag} is not in --help`)
    assert.ok(help.includes(String(DEFAULT_LIMITS[key])), `the default for ${key} is not in --help`)
  }
})

test('an unknown limit key is refused rather than ignored', () => {
  assert.throws(() => validateLimits({ maxMessage: 5 }), /Unknown limit "maxMessage"/)
  assert.throws(() => validateLimits({ maxMessage: 5 }), /known limits are maxFileBytes, maxFindings/)
  assert.throws(() => validateLimits('nope'), /limits must be an object/)
})

test('a limit outside its range is refused', () => {
  assert.throws(() => validateLimits({ maxTools: 0 }), /between 1 and 4096/)
  assert.throws(() => validateLimits({ maxTools: 1.5 }), /between 1 and 4096/)
  assert.throws(() => validateLimits({ maxTools: HARD_LIMITS.maxTools + 1 }), /between 1 and 4096/)
  assert.equal(validateLimits({ maxTools: 7 }).maxTools, 7)
  assert.deepEqual(validateLimits(), DEFAULT_LIMITS)
})

test('an unknown option to the API is refused rather than ignored', async () => {
  await assert.rejects(() => estimateBudget({ root: '.', requests: 'typo.json' }), /Unknown option "requests"/)
  await assert.rejects(() => estimateBudget('nope'), /options must be an object/)
  await assert.rejects(() => estimateBudget({}), /root must be a non-empty string/)
})

test('maxFileBytes stops the read and names itself', async () => {
  const report = await apiReport(fixture(), { limits: { maxFileBytes: 8 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'input-too-large').length, 2, 'both inputs are bounded, not only the big one')
  assert.match(findingsFor(report, 'input-too-large')[0].message, /maxFileBytes limit of 8/)
})

test('maxMessages stops the walk and names itself', async () => {
  const { code, report } = await cliReport(
    fixture(budgetOf(), requestOf([message(), message({ id: 'b', role: 'user' }), message({ id: 'c', role: 'tool' })])),
    ['--max-messages', '2'],
  )
  assert.equal(code, 2)
  assert.equal(report.summary.messages, 2)
  assert.match(findingsFor(report, 'too-many-messages')[0].message, /maxMessages limit of 2/)
})

test('maxTools stops the walk and names itself', async () => {
  const { report } = await cliReport(
    fixture(budgetOf(), requestOf([message()], { tools: [tool(), tool({ name: 'escalate' })] })),
    ['--max-tools', '1'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.tools, 1)
  assert.match(findingsFor(report, 'too-many-tools')[0].message, /maxTools limit of 1/)
})

test('maxTextChars leaves the oversize field uncounted and names itself', async () => {
  const report = await apiReport(
    fixture(budgetOf(), requestOf([message({ text: 'x'.repeat(50) })])),
    { limits: { maxTextChars: 20 } },
  )
  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'too-many-text-chars')[0].message, /maxTextChars limit of 20/)
  assert.equal(report.summary.messages, 0, 'the message was not compiled, so it was not counted')
})

test('maxTextChars bounds a tool description too, not only a message', async () => {
  const report = await apiReport(
    fixture(budgetOf(), requestOf([message()], { tools: [tool({ description: 'd'.repeat(50) })] })),
    { limits: { maxTextChars: 20 } },
  )
  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'too-many-text-chars')[0].message, /Tool "search" has a description of 50 characters/)
})

test('maxSchemaDepth bounds the serialisation and names itself', async () => {
  const report = await apiReport(
    fixture(budgetOf(), requestOf([message()], { tools: [tool({ parameters: { a: { b: { c: { d: 1 } } } } })] })),
    { limits: { maxSchemaDepth: 2 } },
  )
  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'tool-schema-too-deep')[0].message, /maxSchemaDepth limit of 2/)
  assert.equal(findingsFor(report, 'tool-schema-too-deep')[0].location.pointer, '/tools/0/parameters/a/b')
})

test('maxFindings truncates deterministically and says how many were dropped', async () => {
  const files = fixture(budgetOf(), requestOf([
    message(), message({ id: 'b', role: 'user' }), message({ id: 'c', role: 'tool' }),
  ]))
  const report = await apiReport(files, { limits: { maxFindings: 2 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.length, 2)
  assert.match(findingsFor(report, 'too-many-findings')[0].message, /2 were not reported/)

  const again = await apiReport(files, { limits: { maxFindings: 2 } })
  assert.deepEqual(again.findings, report.findings, 'truncation is not order-dependent')
})

test('a repeated flag is a configuration error, not a silent last-wins', async () => {
  await withRoot(fixture(), async (root) => {
    const result = await cliRun(['--root', root, '--max-tools', '5', '--max-tools', '50'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--max-tools was given more than once/)
  })
})

test('a limit flag that is not a positive integer is refused', async () => {
  await withRoot(fixture(), async (root) => {
    for (const value of ['0', '-1', '1.5', 'many']) {
      const result = await cliRun(['--root', root, '--max-tools', value])
      assert.equal(result.code, 2, value)
      assert.match(result.stderr, /--max-tools requires a positive integer|--max-tools requires a value/)
    }
  })
})

test('several bounds hit at once are each reported by name, and none is silent', async () => {
  const report = await apiReport(
    fixture(budgetOf(), requestOf(
      [message({ text: 'x'.repeat(500) }), message({ id: 'b', role: 'user', text: 'y'.repeat(500) })],
      { tools: [tool(), tool({ name: 'escalate' })] },
    )),
    { limits: { maxTools: 1, maxTextChars: 100 } },
  )
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    raisedRules(report).filter((rule) => rule.startsWith('too-many')),
    ['too-many-text-chars', 'too-many-tools'],
  )
  // Both messages were over the character bound, so nothing was counted and the
  // run says that too rather than reporting a total made of overhead.
  assert.equal(report.summary.checked, 1, 'the one tool inside the bound was counted')
  assert.equal(report.summary.messages, 0)
})
