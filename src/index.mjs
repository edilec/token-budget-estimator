/**
 * token-budget-estimator -- count the tokens a request will cost against a
 * declared tokenizer and model mapping, with configurable message and tool
 * overhead, reporting exact counts separately from estimates.
 *
 * The number this tool produces is only as good as what it was told, so it is
 * built to be honest about which half is which:
 *
 * - **Exact** means the unit is defined and the count is a fact about the text
 *   (UTF-8 bytes, Unicode scalar values, UTF-16 code units), or the count was
 *   measured by a tokenizer you named and declared in the file.
 * - **Estimate** means a ratio somebody supplied was applied to a character
 *   count, and it carries a band.
 * - **Neither** -- an unsupported tokenizer with no ratio, a declared count
 *   from a different encoding, text this tool cannot encode -- is not a small
 *   number. It is an unknown, and an unknown makes the run `incomplete`.
 *
 * The third outcome is the one that makes this useful rather than reassuring.
 * When an estimate's band straddles the allowance, this tool does not pick the
 * optimistic end: it reports that the run cannot tell, and exits 2.
 *
 * This package issues no request of any kind, contacts no provider, ships no
 * vocabulary data and downloads nothing.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'

import { compileBudget, decideBudget } from './budget.mjs'
import {
  EXACT_TOKENIZERS, ZERO_BOUNDS, addBounds, boundsFor, canonicalJson, countExact,
  estimateTokens, exactBounds, hasLoneSurrogate, scalarsOf,
} from './count.mjs'
import { compileRequest } from './request.mjs'
import { byCodeUnit, decodeUtf8, excerpt, hasForbiddenCharacter, isPlainObject, parseFailureDetail } from './text.mjs'

export const TOOL_ID = 'token-budget-estimator'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_BUDGET_NAME = 'budget.json'
export const DEFAULT_REQUEST_NAME = 'request.json'

/**
 * Limits, each enforced and each reported by name when it is hit.
 *
 * Exceeding one is never a silent truncation. A request whose tail was not
 * counted has an unknown size, and an unknown size is not a size that fits.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 5242880,
  maxMessages: 2000,
  maxTools: 256,
  maxTextChars: 200000,
  maxSchemaDepth: 20,
  maxFindings: 1000,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxFileBytes: 67108864,
  maxMessages: 100000,
  maxTools: 4096,
  maxTextChars: 5000000,
  maxSchemaDepth: 100,
  maxFindings: 20000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity decides whether a run fails, so it lives in one frozen place and
 * every finding takes its severity from here; an unknown rule id throws rather
 * than defaulting to something harmless.
 *
 * `test/severity-table.test.mjs` asserts this table against
 * `docs/budget-rules.md` in both directions. That is worth having and it is not
 * the guarantee: three declarations agreeing with each other survive a
 * coordinated edit of all three. `test/severity-behaviour.test.mjs` drives
 * every rule through the real binary and pins `status` and the process exit
 * code, which no edit to a table can satisfy.
 */
export const RULE_SEVERITY = Object.freeze({
  'budget-contributor': 'info',
  'budget-exceeded': 'error',
  'budget-headroom-low': 'warning',
  'budget-invalid': 'error',
  'budget-undetermined': 'error',
  'context-tokens-undeclared': 'error',
  'declared-count-invalid': 'error',
  'declared-count-tokenizer-mismatch': 'error',
  'estimate-not-permitted': 'error',
  'estimate-ratio-undeclared': 'error',
  'estimate-tolerance-undeclared': 'error',
  'estimate-used': 'info',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'message-duplicate': 'error',
  'message-invalid': 'error',
  'no-messages': 'error',
  'no-parts-counted': 'error',
  'output-reservation-below-minimum': 'warning',
  'output-reservation-exceeds-context': 'error',
  'output-reservation-undeclared': 'error',
  'overhead-invalid': 'error',
  'overhead-undeclared': 'error',
  'path-escapes-root': 'error',
  'profile-invalid': 'error',
  'profile-missing': 'error',
  'request-invalid': 'error',
  'role-unknown': 'error',
  'text-lone-surrogate': 'error',
  'tool-duplicate': 'error',
  'tool-invalid': 'error',
  'tool-schema-invalid': 'error',
  'tool-schema-too-deep': 'error',
  'too-many-findings': 'error',
  'too-many-messages': 'error',
  'too-many-text-chars': 'error',
  'too-many-tools': 'error',
})

/** A part is reported as a contributor when it is at least this share of the total. */
export const CONTRIBUTOR_PERMILLE = 100

/** A run that fits is still warned about at this share of the input allowance. */
export const HEADROOM_WARN_PERMILLE = 900

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const MAX_NAME_LENGTH = 200

const ALLOWED_OPTIONS = Object.freeze(['budget', 'limits', 'request', 'root'])

/**
 * Validate limit overrides.
 *
 * An unknown key throws instead of being ignored. A documented limit that a
 * one-character typo silently disables is a limit nobody is enforcing, and the
 * CLI turns this throw into a configuration error with an empty stdout.
 */
export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(`Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`)
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against an
 * unresolved candidate refuses legitimate files whenever the root is reached
 * through a symbolic link -- a `/var` that is really `/private/var` is enough
 * -- and a false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * This is not the confinement. A symbolic link planted inside the root contains
 * no `..` at all and passes every check here; `resolveInput` catches that by
 * resolving the real path of both sides and comparing those.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  if (normalize(name).split(/[\\/]/).includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

class FindingSink {
  constructor() {
    this.rows = []
  }

  add(row) {
    this.rows.push({ pointer: '', ...row })
  }
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike, not only an excerpt field. Untrusted values
 * reach this tool through identifiers as well: a profile name, a tool name and
 * an overhead key are all arbitrary JSON keys, and each is named in the message
 * that refuses it.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/budget-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, LOCATION_LIMIT), pointer: excerpt(row.pointer, LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/** Documented sort key: location.file, location.pointer, ruleId, message, evidence. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file, b.location.file) ||
    byCodeUnit(a.location.pointer, b.location.pointer) ||
    byCodeUnit(a.ruleId, b.ruleId) ||
    byCodeUnit(a.message, b.message) ||
    byCodeUnit(a.evidence ?? '', b.evidence ?? '')
  )
}

function emptyState() {
  return {
    checked: 0,
    uncounted: 0,
    exactTokens: 0,
    declaredTokens: 0,
    estimatedTokens: 0,
    estimatedParts: 0,
    overheadTokens: 0,
    total: ZERO_BOUNDS,
    ratioReported: false,
    toleranceReported: false,
    incomplete: false,
  }
}

function buildReport(sink, state, counts, limits) {
  let findings = sink.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: counts.requestName,
      ruleId: 'too-many-findings',
      pointer: '',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or narrow the request.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const status = state.incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      messages: counts.messages,
      tools: counts.tools,
      uncounted: state.uncounted,
      tokens: state.total.point,
      tokensLower: state.total.lower,
      tokensUpper: state.total.upper,
      exactTokens: state.exactTokens,
      declaredTokens: state.declaredTokens,
      estimatedTokens: state.estimatedTokens,
      estimatedParts: state.estimatedParts,
      overheadTokens: state.overheadTokens,
      contextTokens: counts.contextTokens,
      reserveOutputTokens: counts.reserveOutputTokens,
      inputAllowance: counts.inputAllowance,
      utilisationPermille: counts.utilisationPermille,
    },
    findings,
  }
}

/**
 * Resolve one declared input inside the declared root.
 *
 * Both sides are resolved to their real paths before they are compared.
 * Rejecting `..` lexically is not confinement: a symbolic link planted inside
 * the root points anywhere and contains no `..` at all.
 */
async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') return { ok: false, reason: 'unreadable', code: error.code }
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

/** Read one confined input and turn it into parsed JSON, or into the finding that says why not. */
async function loadJson(sink, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} is not a regular file, so nothing was read from it.` })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    sink.add({
      file,
      ruleId: 'input-too-large',
      message: `${file} is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the input.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    sink.add({
      file,
      ruleId: 'input-not-utf8',
      message: `${file} is not valid UTF-8, so it was not parsed. Whether a file decodes is the decoder's decision, never an inference drawn from the decoded text -- and a lenient decode would return a different number, not merely a different label.`,
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  try {
    return { value: JSON.parse(decoded.text) }
  } catch (error) {
    sink.add({
      file,
      ruleId: 'input-not-json',
      message: `${file} is not valid JSON: ${parseFailureDetail(error)}.`,
      suggestion: 'Validate the file with a JSON parser before re-running.',
    })
    return null
  }
}

/**
 * Count one string, or say why it could not be counted.
 *
 * Returning null is never zero. The caller adds nothing to the total, counts
 * the part as uncounted, and the run becomes incomplete -- because a request
 * whose size is partly unknown has an unknown size, and an unknown size is not
 * a size that fits.
 */
function countText(sink, file, pointer, profile, text, state) {
  if (hasLoneSurrogate(text)) {
    /**
     * Not a pedantic refusal. Every conforming UTF-8 encoder substitutes
     * U+FFFD for an unpaired surrogate, which is three bytes, so counting this
     * string would return a number that is silently wrong -- and wrong in the
     * direction that makes a request look larger than it is, or, under a
     * different unit, smaller. `JSON.parse` produces one of these from the
     * escape sequence for an unpaired high surrogate, which is what a truncated
     * log line or a byte-sliced prompt leaves behind.
     */
    sink.add({
      file,
      ruleId: 'text-lone-surrogate',
      pointer,
      message: 'This text contains an unpaired surrogate, which no UTF-8 encoder can represent; it was not counted, because every encoder would substitute a replacement character and return a different number without saying so.',
      suggestion: 'Repair the text at its source. A lone surrogate usually means a string was cut in the middle of an astral character.',
    })
    state.incomplete = true
    state.uncounted += 1
    return null
  }

  if (profile.exact) {
    const count = countExact(profile.tokenizer, text)
    state.exactTokens += count
    return exactBounds(count)
  }

  if (profile.estimateCharsPerToken === null) {
    if (!state.ratioReported) {
      state.ratioReported = true
      sink.add({
        file,
        ruleId: 'estimate-ratio-undeclared',
        pointer,
        message: `The profile names tokenizer "${excerpt(profile.tokenizer, 64)}", which this tool does not count exactly, and declares no estimateCharsPerToken; nothing was counted for it.`,
        suggestion: `Declare estimateCharsPerToken, or declare a counted block per part, or use one of ${EXACT_TOKENIZERS.join(', ')}. This tool will not invent a ratio.`,
      })
    }
    state.incomplete = true
    state.uncounted += 1
    return null
  }
  if (profile.estimateTolerance === null) {
    if (!state.toleranceReported) {
      state.toleranceReported = true
      sink.add({
        file,
        ruleId: 'estimate-tolerance-undeclared',
        pointer,
        message: `The profile estimates with a ratio but declares no estimateTolerance, so the estimate has no band and no verdict could be reached from it.`,
        suggestion: 'Declare how far the ratio may be wrong, as a fraction above 0 and at most 1.',
      })
    }
    state.incomplete = true
    state.uncounted += 1
    return null
  }

  const point = estimateTokens(scalarsOf(text), profile.estimateCharsPerToken)
  state.estimatedTokens += point
  state.estimatedParts += 1
  return boundsFor(point, profile.estimateTolerance)
}

/** A count somebody else measured, accepted only when it names this profile's tokenizer. */
function useDeclaredCount(sink, file, pointer, profile, counted, state) {
  if (counted.tokenizer !== profile.tokenizer) {
    sink.add({
      file,
      ruleId: 'declared-count-tokenizer-mismatch',
      pointer: `${pointer}/counted/tokenizer`,
      message: `The declared count was measured with "${excerpt(counted.tokenizer, 64)}" but the profile uses "${excerpt(profile.tokenizer, 64)}"; it is a count of something else, so it was not used and nothing was counted here instead.`,
      suggestion: 'Re-measure with the profile tokenizer, or point --budget at the profile the counts came from.',
    })
    state.incomplete = true
    state.uncounted += 1
    return null
  }
  state.exactTokens += counted.tokens
  state.declaredTokens += counted.tokens
  return exactBounds(counted.tokens)
}

/** Count one message: the declared per-message constants plus its role, name and text. */
function countMessage(sink, file, profile, message, state) {
  const overhead = profile.overhead.perMessage + (message.name === undefined ? 0 : profile.overhead.perMessageName)
  state.overheadTokens += overhead

  const role = countText(sink, file, `${message.pointer}/role`, profile, message.role, state)
  const name = message.name === undefined
    ? ZERO_BOUNDS
    : countText(sink, file, `${message.pointer}/name`, profile, message.name, state)
  const text = message.counted === null
    ? countText(sink, file, `${message.pointer}/text`, profile, message.text, state)
    : useDeclaredCount(sink, file, message.pointer, profile, message.counted, state)

  if (role === null || name === null || text === null) return null
  state.checked += 1
  const own = addBounds(addBounds(role, name), text)
  return addBounds(own, exactBounds(overhead))
}

/** Count one tool definition: the declared constant plus its canonical serialisation. */
function countTool(sink, file, profile, tool, limits, state) {
  state.overheadTokens += profile.overhead.perToolDefinition

  let body
  if (tool.counted === null) {
    if (tool.parameters !== undefined && !isPlainObject(tool.parameters)) {
      sink.add({
        file,
        ruleId: 'tool-schema-invalid',
        pointer: `${tool.pointer}/parameters`,
        message: `Tool "${tool.name}" declares parameters that are not a JSON Schema object, so its serialised size was not counted.`,
      })
      state.incomplete = true
      state.uncounted += 1
      return null
    }
    const schema = { name: tool.name }
    if (tool.description !== undefined) schema.description = tool.description
    if (tool.parameters !== undefined) schema.parameters = tool.parameters
    const serialised = canonicalJson(schema, limits.maxSchemaDepth)
    if (!serialised.ok) {
      sink.add({
        file,
        ruleId: serialised.reason === 'too-deep' ? 'tool-schema-too-deep' : 'tool-schema-invalid',
        pointer: `${tool.pointer}${serialised.pointer}`,
        message: serialised.reason === 'too-deep'
          ? `Tool "${tool.name}" has a schema deeper than the maxSchemaDepth limit of ${limits.maxSchemaDepth}; it was not serialised and not counted.`
          : `Tool "${tool.name}" has a schema this tool cannot serialise deterministically, so it was not counted.`,
        suggestion: serialised.reason === 'too-deep' ? 'Raise --max-schema-depth, or flatten the schema.' : undefined,
      })
      state.incomplete = true
      state.uncounted += 1
      return null
    }
    body = countText(sink, file, `${tool.pointer}`, profile, serialised.text, state)
  } else {
    body = useDeclaredCount(sink, file, tool.pointer, profile, tool.counted, state)
  }

  if (body === null) return null
  state.checked += 1
  return addBounds(body, exactBounds(profile.overhead.perToolDefinition))
}

/**
 * Count a request against a budget.
 *
 * @param {object} options
 * @param {string} options.root Directory holding both inputs.
 * @param {string} [options.budget] Budget file, relative to the root.
 * @param {string} [options.request] Request file, relative to the root.
 * @param {object} [options.limits] Limit overrides; an unknown key throws.
 * @returns {Promise<object>} the report.
 */
export async function estimateBudget(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  const budgetName = validateName(options.budget ?? DEFAULT_BUDGET_NAME, '--budget')
  const requestName = validateName(options.request ?? DEFAULT_REQUEST_NAME, '--request')

  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new Error(`--root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new Error(`--root could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must be a directory')

  const sink = new FindingSink()
  const state = emptyState()
  const counts = {
    messages: 0,
    tools: 0,
    contextTokens: 0,
    reserveOutputTokens: 0,
    inputAllowance: 0,
    utilisationPermille: 0,
    requestName,
  }

  const documents = {}
  for (const [kind, name] of [['budget', budgetName], ['request', requestName]]) {
    const located = await resolveInput(realRoot, name)
    if (!located.ok) {
      state.incomplete = true
      if (located.reason === 'escapes') {
        sink.add({
          file: name,
          ruleId: 'path-escapes-root',
          message: `${name} resolves outside --root, so it was refused unread.`,
          suggestion: 'Keep both inputs inside the declared root; a symbolic link out of the tree is refused.',
        })
      } else {
        sink.add({
          file: name,
          ruleId: 'input-unreadable',
          message: `${name} could not be resolved inside --root: ${located.code ?? 'unknown error'}.`,
          suggestion: 'Check the file name and its permissions.',
        })
      }
      documents[kind] = null
      continue
    }
    const loaded = await loadJson(sink, name, located.real, limits)
    if (loaded === null) state.incomplete = true
    documents[kind] = loaded
  }

  let profile = null
  if (documents.budget !== null) {
    profile = compileBudget(sink, budgetName, documents.budget.value)
    if (profile === null) state.incomplete = true
  }

  let request = null
  if (documents.request !== null) {
    request = compileRequest(sink, requestName, documents.request.value, limits)
    if (request === null) state.incomplete = true
  }

  if (profile === null || request === null) return buildReport(sink, state, counts, limits)

  counts.messages = request.messages.length
  counts.tools = request.tools.length
  counts.contextTokens = profile.contextTokens
  if (request.bounded) state.incomplete = true

  /**
   * The output reservation. A request that fills the window exactly leaves no
   * room for the reply, so the input allowance is the window minus what the
   * reply was promised -- and the promise has to have been made.
   */
  const reserve = request.reserveOutputTokens ?? profile.reserveOutputTokens
  counts.reserveOutputTokens = reserve
  if (reserve >= profile.contextTokens) {
    sink.add({
      file: requestName,
      ruleId: 'output-reservation-exceeds-context',
      pointer: '/reserveOutputTokens',
      message: `The request reserves ${reserve} of profile "${profile.name}"'s ${profile.contextTokens} token window for output, leaving no room for input at all.`,
      suggestion: 'Lower the reservation, or budget against a model with a larger window.',
    })
    state.incomplete = true
    return buildReport(sink, state, counts, limits)
  }
  counts.inputAllowance = profile.contextTokens - reserve

  if (profile.minOutputTokens !== undefined && reserve < profile.minOutputTokens) {
    sink.add({
      file: requestName,
      ruleId: 'output-reservation-below-minimum',
      pointer: '/reserveOutputTokens',
      message: `The effective output reservation of ${reserve} is below the ${profile.minOutputTokens} this profile declares as its minimum, so a full reply may not fit even though the input does.`,
      suggestion: 'Raise the reservation, or lower minOutputTokens if the workflow really does want shorter replies.',
    })
  }

  if (request.declaredMessages === 0) {
    state.incomplete = true
    sink.add({
      file: requestName,
      ruleId: 'no-messages',
      pointer: '/messages',
      message: 'The request declares no messages, so there is nothing to budget and the run has no evidence to be green on.',
      suggestion: 'A budget report over an empty request is a number about nothing.',
    })
    return buildReport(sink, state, counts, limits)
  }

  const contributors = []
  let total = exactBounds(profile.overhead.replyPrimer)
  state.overheadTokens += profile.overhead.replyPrimer

  for (const message of request.messages) {
    const counted = countMessage(sink, requestName, profile, message, state)
    if (counted === null) continue
    total = addBounds(total, counted)
    contributors.push({ label: `message "${message.id}"`, pointer: message.pointer, tokens: counted.point })
  }

  if (request.tools.length > 0) {
    total = addBounds(total, exactBounds(profile.overhead.toolsPreamble))
    state.overheadTokens += profile.overhead.toolsPreamble
    for (const tool of request.tools) {
      const counted = countTool(sink, requestName, profile, tool, limits, state)
      if (counted === null) continue
      total = addBounds(total, counted)
      contributors.push({ label: `tool "${tool.name}"`, pointer: tool.pointer, tokens: counted.point })
    }
  }

  state.total = total

  /**
   * The vacuous pass, refused explicitly. A request whose messages all failed
   * to count produces a total made of overhead alone, which would fit any
   * sensible window -- and would be green on nothing.
   */
  if (state.checked === 0) {
    state.incomplete = true
    sink.add({
      file: requestName,
      ruleId: 'no-parts-counted',
      pointer: '/messages',
      message: `The run counted 0 of ${request.declaredMessages + request.declaredTools} declared part(s), so the total is overhead alone and there is no evidence to be green on.`,
      suggestion: 'The accompanying findings name what stopped each part from being counted.',
    })
    return buildReport(sink, state, counts, limits)
  }

  if (state.estimatedParts > 0) {
    sink.add({
      file: budgetName,
      ruleId: 'estimate-used',
      pointer: `/profiles/${profile.name}/tokenizer`,
      message: `${state.estimatedParts} part(s) were estimated for tokenizer "${excerpt(profile.tokenizer, 64)}" at ${profile.estimateCharsPerToken} characters per token with a tolerance of ${profile.estimateTolerance}; ${state.estimatedTokens} of ${total.point} token(s) in this total are estimated rather than counted.`,
      suggestion: 'Declare a counted block per part to replace an estimate with a measurement.',
    })
    if (profile.requireExact) {
      sink.add({
        file: budgetName,
        ruleId: 'estimate-not-permitted',
        pointer: `/profiles/${profile.name}/requireExact`,
        message: `Profile "${profile.name}" declares requireExact, but ${state.estimatedParts} part(s) were estimated rather than counted.`,
        suggestion: 'Supply a counted block for every part, or move to a tokenizer this tool counts exactly, or drop requireExact.',
      })
    }
  }

  const threshold = Math.ceil((total.point * CONTRIBUTOR_PERMILLE) / 1000)
  for (const contributor of contributors) {
    if (total.point === 0 || contributor.tokens < threshold) continue
    sink.add({
      file: requestName,
      ruleId: 'budget-contributor',
      pointer: contributor.pointer,
      message: `${contributor.label} accounts for ${contributor.tokens} of ${total.point} token(s), ${Math.round((contributor.tokens * 1000) / total.point)} permille of the request.`,
    })
  }

  counts.utilisationPermille = counts.inputAllowance === 0
    ? 0
    : Math.round((total.point * 1000) / counts.inputAllowance)

  const verdict = decideBudget(total, counts.inputAllowance)
  if (verdict === 'exceeds') {
    sink.add({
      file: requestName,
      ruleId: 'budget-exceeded',
      pointer: '/messages',
      message: `The request needs at least ${total.lower} token(s) but the input allowance is ${counts.inputAllowance} (a ${profile.contextTokens} token window less ${reserve} reserved for output).`,
      suggestion: 'Shorten the request, send fewer tool definitions, lower the output reservation, or budget against a larger window.',
    })
  } else if (verdict === 'undetermined') {
    /**
     * The whole reason this tool tracks a band.
     *
     * The point estimate may sit either side of the allowance; what is true is
     * that the run cannot tell which. Picking the optimistic end would be a
     * guess dressed as a verdict, and the guess would be wrong exactly when it
     * mattered. So this is `incomplete` and exit 2, and the message says what
     * would settle it.
     */
    state.incomplete = true
    sink.add({
      file: requestName,
      ruleId: 'budget-undetermined',
      pointer: '/messages',
      message: `The request is between ${total.lower} and ${total.upper} token(s) and the input allowance is ${counts.inputAllowance}, so this run cannot tell whether it fits. An estimate that straddles the allowance is not a pass.`,
      suggestion: 'Supply counted blocks measured with the real tokenizer, narrow estimateTolerance if it is genuinely narrower, or leave more headroom.',
    })
  } else if (counts.inputAllowance > 0 && total.upper * 1000 >= counts.inputAllowance * HEADROOM_WARN_PERMILLE) {
    sink.add({
      file: requestName,
      ruleId: 'budget-headroom-low',
      pointer: '/messages',
      message: `The request fits, but at up to ${total.upper} of ${counts.inputAllowance} token(s) it uses ${Math.round((total.upper * 1000) / counts.inputAllowance)} permille of the input allowance, above the ${HEADROOM_WARN_PERMILLE} permille warning threshold.`,
      suggestion: 'A request this close to the limit fails as soon as one more turn is appended.',
    })
  }

  return buildReport(sink, state, counts, limits)
}

/** stdout carries this and nothing else, so it can be piped straight into a parser. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 completed and fits, 1 completed and does not fit, 2 the run could not be completed. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

/** The human summary. It goes to stderr; stdout is the JSON report alone. */
export function formatReport(report, extra = {}) {
  const { summary } = report
  const lines = [
    `budget ${excerpt(extra.budget ?? DEFAULT_BUDGET_NAME, 80)}: window ${summary.contextTokens}, output reservation ${summary.reserveOutputTokens}, input allowance ${summary.inputAllowance}.`,
    `request ${excerpt(extra.request ?? DEFAULT_REQUEST_NAME, 80)}: ${summary.checked} part(s) counted, ${summary.uncounted} not counted, ${summary.messages} message(s), ${summary.tools} tool(s).`,
    `tokens ${summary.tokens} (${summary.tokensLower}-${summary.tokensUpper}): ${summary.exactTokens} exact of which ${summary.declaredTokens} declared, ${summary.estimatedTokens} estimated across ${summary.estimatedParts} part(s), ${summary.overheadTokens} declared overhead.`,
    `utilisation ${summary.utilisationPermille} permille of the input allowance. status ${report.status}.`,
  ]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ` +
      `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export {
  BUDGET_KEYS, BUDGET_SCHEMA_VERSION, MAX_PROFILES, OVERHEAD_KEYS, PROFILE_KEYS,
  compileBudget, decideBudget,
} from './budget.mjs'
export {
  EXACT_TOKENIZERS, addBounds, boundsFor, canonicalJson, countExact, escapePointer,
  estimateTokens, exactBounds, hasLoneSurrogate, scalarsOf,
} from './count.mjs'
export {
  COUNTED_KEYS, MESSAGE_KEYS, REQUEST_KEYS, REQUEST_SCHEMA_VERSION, ROLES, TOOL_KEYS, compileRequest,
} from './request.mjs'
export {
  EXCERPT_LIMIT, MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8, describeValue, excerpt,
  hasForbiddenCharacter, isIdentifier, isPlainObject, parseFailureDetail,
} from './text.mjs'
