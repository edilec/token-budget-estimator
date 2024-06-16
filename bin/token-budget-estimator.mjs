#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_BUDGET_NAME,
  DEFAULT_REQUEST_NAME,
  estimateBudget,
  excerpt,
  exitCodeFor,
  formatReport,
  serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `token-budget-estimator

Count the tokens a request will cost against a declared tokenizer and model
mapping, with configurable message and tool overhead, and report exact counts
separately from estimates. Nothing is sent anywhere: no provider is contacted,
no vocabulary data is shipped and nothing is downloaded.

Usage:
  token-budget-estimator --root DIR [--budget FILE] [--request FILE] [--json]
                         [--max-file-bytes N] [--max-messages N]
                         [--max-tools N] [--max-text-chars N]
                         [--max-schema-depth N] [--max-findings N]

Options:
  --root DIR             Directory holding both inputs (required)
  --budget FILE          Budget and model profiles, relative to --root
                         (default ${DEFAULT_BUDGET_NAME})
  --request FILE         Messages and tool definitions, relative to --root
                         (default ${DEFAULT_REQUEST_NAME})
  --json                 Suppress the human summary on stderr
  --max-file-bytes N     Maximum bytes per input file (default 5242880)
  --max-messages N       Maximum messages counted (default 2000)
  --max-tools N          Maximum tool definitions counted (default 256)
  --max-text-chars N     Maximum characters per text field (default 200000)
  --max-schema-depth N   Maximum tool schema nesting depth (default 20)
  --max-findings N       Maximum findings in one report (default 1000)
  -h, --help             Show this help
  -v, --version          Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

Exact and estimated:
  Counted exactly: utf8-bytes, unicode-scalars, utf16-code-units -- units that
  are defined rather than modelled -- and any part carrying a "counted" block
  measured by the tokenizer the profile names. Any other tokenizer is estimated
  from a declared estimateCharsPerToken and estimateTolerance, and the report
  separates exactTokens from estimatedTokens. No ratio is ever invented.

What a pass means:
  The request fits the input allowance -- the context window less the output
  reservation -- even at the pessimistic end of every estimate. It is a
  statement about the numbers in --budget, and no provider was asked to
  confirm any of them.

Exit codes:
  0  the request was counted and fits the input allowance
  1  the request was counted and does not fit
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass"). An estimate
     whose band straddles the allowance lands here: the run cannot tell.
`

const LIMIT_FLAGS = new Map([
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-messages', 'maxMessages'],
  ['--max-schema-depth', 'maxSchemaDepth'],
  ['--max-text-chars', 'maxTextChars'],
  ['--max-tools', 'maxTools'],
])

const VALUE_FLAGS = new Map([
  ['--budget', 'budget'],
  ['--request', 'request'],
  ['--root', 'root'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, budget: null, request: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once. Letting it repeat discards
   * the earlier value with no diagnostic, so `--request a --request b` budgets
   * a file nobody named and `--max-messages 5 --max-messages 5000` enforces a
   * bound nobody asked for.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await estimateBudget({
      root: options.root,
      limits: options.limits,
      ...(options.budget === null ? {} : { budget: options.budget }),
      ...(options.request === null ? {} : { request: options.request }),
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty and a
    // consumer piping stdout gets nothing rather than a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) {
    process.stderr.write(formatReport(report, {
      budget: options.budget ?? DEFAULT_BUDGET_NAME,
      request: options.request ?? DEFAULT_REQUEST_NAME,
    }))
  }
  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} part(s) counted and ${report.summary.uncounted} not counted; this run is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
