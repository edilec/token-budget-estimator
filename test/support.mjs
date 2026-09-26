/**
 * Fixtures and runners shared by the test suite.
 *
 * Two entry points are exercised throughout: `apiReport` calls the exported
 * function, and `cliRun` spawns the real binary and reads the real exit code.
 * Several guarantees here can only be pinned by the second -- three agreeing
 * declarations survive a coordinated edit, and an exit code cannot be edited
 * at all.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { estimateBudget } from '../src/index.mjs'

const execFileAsync = promisify(execFile)

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(projectDirectory, 'bin/token-budget-estimator.mjs')

export const OVERHEAD = Object.freeze({
  perMessage: 4,
  perMessageName: 1,
  perToolDefinition: 8,
  toolsPreamble: 16,
  replyPrimer: 3,
})

/** A complete, valid profile counting UTF-8 bytes exactly. */
export function profileOf(overrides = {}) {
  return {
    tokenizer: 'utf8-bytes',
    contextTokens: 8192,
    reserveOutputTokens: 1024,
    overhead: { ...OVERHEAD },
    ...overrides,
  }
}

/** A profile for a tokenizer this package does not count, with a declared ratio and band. */
export function estimatingProfile(overrides = {}) {
  return profileOf({
    tokenizer: 'o200k_base',
    estimateCharsPerToken: 4,
    estimateTolerance: 0.25,
    ...overrides,
  })
}

/** A complete, valid budget document selecting `house`. */
export function budgetOf(profile = profileOf(), overrides = {}) {
  return {
    schemaVersion: '1',
    model: 'house',
    profiles: { house: profile },
    ...overrides,
  }
}

export function message(overrides = {}) {
  return { id: 'system-turn', role: 'system', text: 'Answer briefly.', ...overrides }
}

export function tool(overrides = {}) {
  return {
    name: 'search',
    description: 'Search the knowledge base.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    ...overrides,
  }
}

export function requestOf(messages = [message()], overrides = {}) {
  return { schemaVersion: '1', messages, ...overrides }
}

/** The default pair of inputs, as objects. */
export const fixture = (budget, request) => ({
  'budget.json': budget ?? budgetOf(),
  'request.json': request ?? requestOf(),
})

/**
 * Create a temporary root, write the named files into it, run `body(root)` and
 * remove the tree afterwards whatever happened. A string is written verbatim
 * and a `Uint8Array` byte for byte, so a test can plant text that is not JSON,
 * or bytes that are not UTF-8 at all.
 */
export async function withRoot(files, body) {
  const root = await mkdtemp(join(tmpdir(), 'token-budget-estimator-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Run the exported API over a temporary root. */
export async function apiReport(files, options = {}) {
  return withRoot(files, (root) => estimateBudget({ root, ...options }))
}

/** Spawn the real binary. Returns the exit code and both streams; never throws on a non-zero exit. */
export async function cliRun(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Spawn the real binary over a temporary root, and parse whatever stdout carried. */
export async function cliReport(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--json', ...extraArgs])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

/** Every rule id a report raised, deduplicated and ordered by code unit. */
export const raisedRules = (report) =>
  [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

/** The findings for one rule id, in emitted order. */
export const findingsFor = (report, ruleId) => report.findings.filter((finding) => finding.ruleId === ruleId)

/**
 * One character from each class the report contract names, built from code
 * points so every test file that uses them stays plain ASCII and readable.
 */
export const FORBIDDEN = Object.freeze({
  'C0 NUL': String.fromCharCode(0x00),
  'C0 LF': String.fromCharCode(0x0a),
  'C0 ESC': String.fromCharCode(0x1b),
  DEL: String.fromCharCode(0x7f),
  'C1 NEL': String.fromCharCode(0x85),
  'C1 CSI': String.fromCharCode(0x9b),
  'line separator': String.fromCharCode(0x2028),
  'paragraph separator': String.fromCharCode(0x2029),
  'bidi LRM': String.fromCharCode(0x200e),
  'bidi RLO': String.fromCharCode(0x202e),
  'bidi isolate': String.fromCharCode(0x2066),
})

/**
 * Unicode that the three exact units genuinely disagree about, built from code
 * points so this file and every file that imports it stays plain ASCII.
 */
export const UNICODE = Object.freeze({
  /** U+1F512, one scalar, two code units, four bytes. */
  astral: String.fromCodePoint(0x1f512),
  /** Woman technologist: two emoji joined by U+200D. */
  zwjSequence: String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb),
  /** "e" plus U+0301 COMBINING ACUTE: two scalars that render as one letter. */
  combining: String.fromCodePoint(0x65, 0x301),
  /** The precomposed form of the same letter: one scalar. */
  precomposed: String.fromCodePoint(0xe9),
  /** Japanese, three bytes per scalar in UTF-8. */
  japanese: String.fromCodePoint(0x65e5, 0x672c, 0x8a9e),
  /** Arabic, two bytes per scalar in UTF-8. */
  arabic: String.fromCodePoint(0x645, 0x631, 0x62d, 0x628, 0x627),
  /** A lone high surrogate: no UTF-8 encoder can represent it. */
  loneHighSurrogate: String.fromCharCode(0xd83d),
  /** A lone low surrogate. */
  loneLowSurrogate: String.fromCharCode(0xdd12),
})

/** Walk every string in a report, so a test can assert about all of them at once. */
export function* everyString(value) {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const item of value) yield* everyString(item)
  else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      yield key
      yield* everyString(value[key])
    }
  }
}
