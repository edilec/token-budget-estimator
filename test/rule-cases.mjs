/**
 * One runnable input per rule id, and the runner that drives it through the
 * real binary.
 *
 * This table exists so that severity can be pinned by behaviour rather than by
 * a declaration. Three declarations that agree with each other survive a
 * coordinated edit of all three; an exit code does not. Every rule in
 * `RULE_SEVERITY` must appear here, and `test/severity-behaviour.test.mjs`
 * fails if one does not.
 */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { UNICODE, budgetOf, cliRun, estimatingProfile, fixture, message, profileOf, requestOf, tool } from './support.mjs'

const without = (object, key) => {
  const copy = { ...object }
  delete copy[key]
  return copy
}

const deepSchema = tool({
  name: 'deep',
  parameters: { type: 'object', properties: { a: { properties: { b: { properties: { c: { type: 'string' } } } } } } },
})

/**
 * Each case names one rule and an input that raises it. A case may raise other
 * rules too; the assertions that use this table are about the named rule being
 * present and about what the exit code does, not about the case being minimal.
 */
export const RULE_CASES = Object.freeze([
  { ruleId: 'budget-contributor', files: fixture() },
  {
    ruleId: 'budget-exceeded',
    // Allowance 8 tokens; the one message and the reply primer need 28.
    files: fixture(budgetOf(profileOf({ contextTokens: 40, reserveOutputTokens: 32 }))),
  },
  {
    ruleId: 'budget-headroom-low',
    // Allowance 100; the message is 82 characters plus a 6-character role plus
    // the declared perMessage 4 and replyPrimer 3, so the total is 95 -- 950
    // permille of the allowance, above the 900 permille threshold.
    files: fixture(
      budgetOf(profileOf({ contextTokens: 1100, reserveOutputTokens: 1000 })),
      requestOf([message({ text: 'x'.repeat(82) })]),
    ),
  },
  { ruleId: 'budget-invalid', files: fixture(budgetOf(profileOf(), { schemaVersion: '2' })) },
  {
    ruleId: 'budget-undetermined',
    files: fixture(
      budgetOf(estimatingProfile({ contextTokens: 2100, reserveOutputTokens: 1024 })),
      requestOf([message({ text: 'y'.repeat(4000) })]),
    ),
  },
  { ruleId: 'context-tokens-undeclared', files: fixture(budgetOf(without(profileOf(), 'contextTokens'))) },
  {
    ruleId: 'declared-count-invalid',
    files: fixture(budgetOf(), requestOf([message({ counted: { tokens: -1, tokenizer: 'utf8-bytes' } })])),
  },
  {
    ruleId: 'declared-count-tokenizer-mismatch',
    files: fixture(budgetOf(), requestOf([message({ counted: { tokens: 12, tokenizer: 'o200k_base' } })])),
  },
  { ruleId: 'estimate-not-permitted', files: fixture(budgetOf(estimatingProfile({ requireExact: true }))) },
  { ruleId: 'estimate-ratio-undeclared', files: fixture(budgetOf(without(estimatingProfile(), 'estimateCharsPerToken'))) },
  { ruleId: 'estimate-tolerance-undeclared', files: fixture(budgetOf(without(estimatingProfile(), 'estimateTolerance'))) },
  { ruleId: 'estimate-used', files: fixture(budgetOf(estimatingProfile())) },
  { ruleId: 'input-not-json', files: { ...fixture(), 'request.json': 'not json at all' } },
  { ruleId: 'input-not-utf8', files: { ...fixture(), 'request.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) } },
  { ruleId: 'input-too-large', files: fixture(), args: ['--max-file-bytes', '8'] },
  { ruleId: 'input-unreadable', files: { 'budget.json': budgetOf() } },
  {
    ruleId: 'message-duplicate',
    files: fixture(budgetOf(), requestOf([message(), message({ role: 'user' })])),
  },
  { ruleId: 'message-invalid', files: fixture(budgetOf(), requestOf([message({ text: 12 })])) },
  { ruleId: 'no-messages', files: fixture(budgetOf(), requestOf([])) },
  {
    ruleId: 'no-parts-counted',
    files: fixture(budgetOf(), requestOf([message({ text: `cut here ${UNICODE.loneHighSurrogate}` })])),
  },
  { ruleId: 'output-reservation-below-minimum', files: fixture(budgetOf(profileOf({ minOutputTokens: 2000 }))) },
  {
    ruleId: 'output-reservation-exceeds-context',
    files: fixture(budgetOf(profileOf({ contextTokens: 1000 })), requestOf([message()], { reserveOutputTokens: 1000 })),
  },
  { ruleId: 'output-reservation-undeclared', files: fixture(budgetOf(without(profileOf(), 'reserveOutputTokens'))) },
  { ruleId: 'overhead-invalid', files: fixture(budgetOf(profileOf({ overhead: { perMessage: 'four' } }))) },
  { ruleId: 'overhead-undeclared', files: fixture(budgetOf(without(profileOf(), 'overhead'))) },
  {
    ruleId: 'path-escapes-root',
    files: { 'budget.json': budgetOf() },
    setup: async ({ root, elsewhere }) => {
      await writeFile(join(elsewhere, 'other.json'), JSON.stringify(requestOf()))
      await symlink(join(elsewhere, 'other.json'), join(root, 'request.json'))
    },
  },
  { ruleId: 'profile-invalid', files: fixture(budgetOf(profileOf({ contextTokens: 0 }))) },
  { ruleId: 'profile-missing', files: fixture(budgetOf(profileOf(), { model: 'nowhere' })) },
  { ruleId: 'request-invalid', files: fixture(budgetOf(), requestOf([message()], { schemaVersion: '2' })) },
  { ruleId: 'role-unknown', files: fixture(budgetOf(), requestOf([message({ role: 'narrator' })])) },
  {
    ruleId: 'text-lone-surrogate',
    files: fixture(budgetOf(), requestOf([message(), message({ id: 'second', role: 'user', text: UNICODE.loneLowSurrogate })])),
  },
  {
    ruleId: 'tool-duplicate',
    files: fixture(budgetOf(), requestOf([message()], { tools: [tool(), tool()] })),
  },
  {
    ruleId: 'tool-invalid',
    files: fixture(budgetOf(), requestOf([message()], { tools: [{ ...tool(), strict: true }] })),
  },
  {
    ruleId: 'tool-schema-invalid',
    files: fixture(budgetOf(), requestOf([message()], { tools: [tool({ parameters: 'a JSON Schema, allegedly' })] })),
  },
  {
    ruleId: 'tool-schema-too-deep',
    files: fixture(budgetOf(), requestOf([message()], { tools: [deepSchema] })),
    args: ['--max-schema-depth', '3'],
  },
  {
    ruleId: 'too-many-findings',
    files: fixture(budgetOf(), requestOf([message(), message({ id: 'second', role: 'user' })])),
    args: ['--max-findings', '1'],
  },
  {
    ruleId: 'too-many-messages',
    files: fixture(budgetOf(), requestOf([message(), message({ id: 'second', role: 'user' })])),
    args: ['--max-messages', '1'],
  },
  { ruleId: 'too-many-text-chars', files: fixture(), args: ['--max-text-chars', '5'] },
  {
    ruleId: 'too-many-tools',
    files: fixture(budgetOf(), requestOf([message()], { tools: [tool(), tool({ name: 'escalate' })] })),
    args: ['--max-tools', '1'],
  },
])

/** Run one case through the real binary, in a fresh root with a sibling directory outside it. */
export async function runCase(testCase) {
  const root = await mkdtemp(join(tmpdir(), 'token-budget-estimator-case-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'token-budget-estimator-outside-'))
  try {
    for (const [name, content] of Object.entries(testCase.files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    if (testCase.setup !== undefined) await testCase.setup({ root, elsewhere })
    const result = await cliRun(['--root', root, '--json', ...(testCase.args ?? [])])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  }
}
