import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { countExact } from '../src/index.mjs'
import { cliRun, projectDirectory } from './support.mjs'

/**
 * The shipped examples, run as a user would run them.
 *
 * An example in a README that nobody executes is a claim, not a demonstration.
 * The three here differ only in the budget file, and between them they produce
 * all three exit codes.
 */

const example = (name) => join(projectDirectory, 'examples', name)

async function run(name) {
  const result = await cliRun(['--root', example(name), '--json'])
  return { code: result.code, report: JSON.parse(result.stdout) }
}

test('the fits example exits 0 and counts everything exactly', async () => {
  const { code, report } = await run('fits')
  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.messages, 3)
  assert.equal(report.summary.tools, 2)
  assert.equal(report.summary.checked, 5)
  assert.equal(report.summary.uncounted, 0)
  assert.equal(report.summary.estimatedParts, 0)
  assert.equal(report.summary.estimatedTokens, 0)
  assert.equal(report.summary.tokensLower, report.summary.tokens)
  assert.equal(report.summary.tokensUpper, report.summary.tokens)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
})

test('the fits example really is Unicode-heavy, which is what makes it an example', async () => {
  const request = JSON.parse(await readFile(example('fits/request.json'), 'utf8'))
  const text = request.messages.map((one) => one.text).join('')
  assert.notEqual(countExact('utf8-bytes', text), countExact('unicode-scalars', text), 'multi-byte characters are present')
  assert.notEqual(countExact('utf16-code-units', text), countExact('unicode-scalars', text), 'astral characters are present')
  assert.ok(/[؀-ۿ]/.test(text), 'Arabic')
  assert.ok(/[぀-ヿ一-鿿]/.test(text), 'Japanese')
  assert.ok(/[ऀ-ॿ]/.test(text), 'Devanagari')
  assert.ok(text.includes(String.fromCodePoint(0x200d)), 'a zero-width joiner')
  assert.ok(text.includes(String.fromCodePoint(0x301)), 'a combining acute')
})

test('the fits example counts real tool schemas, not just prose', async () => {
  const request = JSON.parse(await readFile(example('fits/request.json'), 'utf8'))
  assert.equal(request.tools.length, 2)
  for (const declared of request.tools) {
    assert.equal(typeof declared.parameters, 'object')
    assert.ok(Object.keys(declared.parameters.properties).length >= 2, 'a schema with real fields')
  }
})

test('the over-budget example exits 1 and names the window and the reservation', async () => {
  const { code, report } = await run('over-budget')
  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  const exceeded = report.findings.filter((finding) => finding.ruleId === 'budget-exceeded')
  assert.equal(exceeded.length, 1)
  assert.match(exceeded[0].message, /a 768 token window less 256 reserved for output/)
})

test('the undetermined example exits 2 because the band straddles the allowance', async () => {
  const { code, report } = await run('undetermined')
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'budget-undetermined'))
  assert.ok(report.summary.tokensLower <= report.summary.inputAllowance)
  assert.ok(report.summary.tokensUpper > report.summary.inputAllowance)
  assert.ok(report.summary.estimatedParts > 0, 'the parts were estimated')
  assert.ok(report.summary.declaredTokens > 0, 'and one part carries a measured count beside them')
})

test('the three examples share one request, so only the budget differs', async () => {
  const fits = JSON.parse(await readFile(example('fits/request.json'), 'utf8'))
  const over = JSON.parse(await readFile(example('over-budget/request.json'), 'utf8'))
  assert.deepEqual(over, fits, 'over-budget is the same request against a smaller window')

  const undetermined = JSON.parse(await readFile(example('undetermined/request.json'), 'utf8'))
  const withoutCounts = {
    ...undetermined,
    messages: undetermined.messages.map(({ counted, ...rest }) => rest),
  }
  assert.deepEqual(withoutCounts, fits, 'undetermined adds only a counted block')
})

test('the README quick start commands are the ones that exist', async () => {
  const readme = await readFile(join(projectDirectory, 'README.md'), 'utf8')
  for (const command of [
    'node bin/token-budget-estimator.mjs --root examples/fits',
    'node bin/token-budget-estimator.mjs --root examples/over-budget',
    'node bin/token-budget-estimator.mjs --root examples/undetermined',
  ]) {
    assert.ok(readme.includes(command), `the README no longer shows: ${command}`)
  }
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  assert.match(manifest.scripts.example, /--root examples\/fits/)
  assert.match(manifest.scripts['example:over'], /--root examples\/over-budget/)
  assert.match(manifest.scripts['example:undetermined'], /--root examples\/undetermined/)
  assert.match(manifest.scripts.check, /example:over/)
  assert.match(manifest.scripts.check, /example:undetermined/)
})
