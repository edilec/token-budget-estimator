/**
 * The budget document: the tokenizer and model mapping, the declared overhead,
 * the context window and the output reservation.
 *
 * Everything in here is a *declaration*. This package does not know what any
 * provider charges per message or how it serialises a tool definition, and it
 * does not guess: the numbers come from the file, they are named in the report,
 * and a missing one is an error rather than a default nobody chose.
 */

import { EXACT_TOKENIZERS } from './count.mjs'
import { byCodeUnit, describeValue, isPlainObject } from './text.mjs'

export const BUDGET_SCHEMA_VERSION = '1'

export const BUDGET_KEYS = Object.freeze(['model', 'profiles', 'schemaVersion'])

export const PROFILE_KEYS = Object.freeze([
  'contextTokens', 'estimateCharsPerToken', 'estimateTolerance', 'minOutputTokens',
  'overhead', 'requireExact', 'reserveOutputTokens', 'tokenizer',
])

/**
 * Every overhead component, each a declared constant in tokens.
 *
 * They are all required. An omitted component is not zero: it is a number
 * nobody supplied, and treating it as zero makes a budget that fits on paper
 * and does not fit in the request.
 */
export const OVERHEAD_KEYS = Object.freeze([
  'perMessage', 'perMessageName', 'perToolDefinition', 'replyPrimer', 'toolsPreamble',
])

/** Model, profile and tokenizer names. Vendor encodings use dots and underscores. */
const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/

export const MAX_PROFILES = 64
export const MAX_CONTEXT_TOKENS = 100000000
export const MAX_OVERHEAD_TOKENS = 100000
export const MAX_CHARS_PER_TOKEN = 100
export const MIN_CHARS_PER_TOKEN = 0.1

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key)).sort(byCodeUnit)
}

const isCount = (value, cap) => Number.isInteger(value) && value >= 0 && value <= cap

function compileOverhead(sink, file, pointer, raw) {
  if (raw === undefined) {
    sink.add({
      file,
      ruleId: 'overhead-undeclared',
      pointer: `${pointer}/overhead`,
      message: `The profile declares no overhead block, so the per-message and per-tool cost of the request is unknown. It is not assumed to be zero.`,
      suggestion: `Declare all of ${OVERHEAD_KEYS.join(', ')} in tokens, from your provider's documentation or from a measured request.`,
    })
    return null
  }
  if (!isPlainObject(raw)) {
    sink.add({ file, ruleId: 'overhead-invalid', pointer: `${pointer}/overhead`, message: `overhead must be an object; it is ${describeValue(raw)}.` })
    return null
  }
  const extra = unknownKeys(raw, OVERHEAD_KEYS)
  if (extra.length > 0) {
    sink.add({
      file,
      ruleId: 'overhead-invalid',
      pointer: `${pointer}/overhead`,
      message: `overhead accepts only ${OVERHEAD_KEYS.join(', ')}; it also declares ${extra.join(', ')}.`,
      suggestion: 'Remove the unknown key. A key this tool ignores is a cost nobody is counting.',
    })
    return null
  }
  const overhead = {}
  let usable = true
  for (const key of OVERHEAD_KEYS) {
    if (!isCount(raw[key], MAX_OVERHEAD_TOKENS)) {
      sink.add({
        file,
        ruleId: 'overhead-invalid',
        pointer: `${pointer}/overhead/${key}`,
        message: `overhead.${key} must be an integer from 0 to ${MAX_OVERHEAD_TOKENS}; it is ${describeValue(raw[key])}.`,
      })
      usable = false
      continue
    }
    overhead[key] = raw[key]
  }
  return usable ? Object.freeze(overhead) : null
}

function compileProfile(sink, file, name, raw) {
  const pointer = `/profiles/${name}`
  if (!isPlainObject(raw)) {
    sink.add({ file, ruleId: 'profile-invalid', pointer, message: `A profile must be an object; "${name}" is ${describeValue(raw)}.` })
    return null
  }
  const extra = unknownKeys(raw, PROFILE_KEYS)
  if (extra.length > 0) {
    sink.add({
      file,
      ruleId: 'profile-invalid',
      pointer,
      message: `A profile accepts only ${PROFILE_KEYS.join(', ')}; "${name}" also declares ${extra.join(', ')}.`,
    })
    return null
  }
  if (typeof raw.tokenizer !== 'string' || !NAME.test(raw.tokenizer)) {
    sink.add({
      file,
      ruleId: 'profile-invalid',
      pointer: `${pointer}/tokenizer`,
      message: `Profile "${name}" must name a tokenizer matching ${NAME.source}; it has ${describeValue(raw.tokenizer)}.`,
      suggestion: `Counted exactly: ${EXACT_TOKENIZERS.join(', ')}. Any other name is counted as a labelled estimate.`,
    })
    return null
  }

  let usable = true

  if (raw.contextTokens === undefined) {
    sink.add({
      file,
      ruleId: 'context-tokens-undeclared',
      pointer: `${pointer}/contextTokens`,
      message: `Profile "${name}" declares no contextTokens, so there is no window to budget against.`,
    })
    usable = false
  } else if (!Number.isInteger(raw.contextTokens) || raw.contextTokens < 1 || raw.contextTokens > MAX_CONTEXT_TOKENS) {
    sink.add({
      file,
      ruleId: 'profile-invalid',
      pointer: `${pointer}/contextTokens`,
      message: `Profile "${name}" must declare contextTokens as an integer from 1 to ${MAX_CONTEXT_TOKENS}; it has ${describeValue(raw.contextTokens)}.`,
    })
    usable = false
  }

  /**
   * The output reservation is required, and that is the whole point of it.
   *
   * A request that fits the window exactly leaves no room for the answer, so
   * the model stops mid-sentence or the call is refused. Budgeting the input
   * alone is the commonest way to get this wrong, so a profile that says
   * nothing about the reply is refused rather than assumed to want none.
   */
  if (raw.reserveOutputTokens === undefined) {
    sink.add({
      file,
      ruleId: 'output-reservation-undeclared',
      pointer: `${pointer}/reserveOutputTokens`,
      message: `Profile "${name}" declares no reserveOutputTokens, so the reply has no room budgeted and the input allowance is unknown.`,
      suggestion: 'Declare the largest reply this workflow needs. Reserving nothing is a choice; it must be an explicit one.',
    })
    usable = false
  } else if (!isCount(raw.reserveOutputTokens, MAX_CONTEXT_TOKENS)) {
    sink.add({
      file,
      ruleId: 'profile-invalid',
      pointer: `${pointer}/reserveOutputTokens`,
      message: `Profile "${name}" must declare reserveOutputTokens as an integer from 0 to ${MAX_CONTEXT_TOKENS}; it has ${describeValue(raw.reserveOutputTokens)}.`,
    })
    usable = false
  }

  if (raw.minOutputTokens !== undefined && !isCount(raw.minOutputTokens, MAX_CONTEXT_TOKENS)) {
    sink.add({
      file,
      ruleId: 'profile-invalid',
      pointer: `${pointer}/minOutputTokens`,
      message: `Profile "${name}" must declare minOutputTokens as an integer from 0 to ${MAX_CONTEXT_TOKENS} when it declares one at all.`,
    })
    usable = false
  }

  if (raw.requireExact !== undefined && typeof raw.requireExact !== 'boolean') {
    sink.add({
      file,
      ruleId: 'profile-invalid',
      pointer: `${pointer}/requireExact`,
      message: `Profile "${name}" must declare requireExact as a boolean when it declares one at all.`,
    })
    usable = false
  }

  const exact = EXACT_TOKENIZERS.includes(raw.tokenizer)
  let ratio = null
  let tolerance = null
  if (raw.estimateCharsPerToken !== undefined) {
    if (typeof raw.estimateCharsPerToken !== 'number' || !Number.isFinite(raw.estimateCharsPerToken) ||
        raw.estimateCharsPerToken < MIN_CHARS_PER_TOKEN || raw.estimateCharsPerToken > MAX_CHARS_PER_TOKEN) {
      sink.add({
        file,
        ruleId: 'profile-invalid',
        pointer: `${pointer}/estimateCharsPerToken`,
        message: `Profile "${name}" must declare estimateCharsPerToken as a finite number from ${MIN_CHARS_PER_TOKEN} to ${MAX_CHARS_PER_TOKEN}.`,
      })
      usable = false
    } else ratio = raw.estimateCharsPerToken
  }
  if (raw.estimateTolerance !== undefined) {
    if (typeof raw.estimateTolerance !== 'number' || !Number.isFinite(raw.estimateTolerance) ||
        raw.estimateTolerance <= 0 || raw.estimateTolerance > 1) {
      sink.add({
        file,
        ruleId: 'profile-invalid',
        pointer: `${pointer}/estimateTolerance`,
        message: `Profile "${name}" must declare estimateTolerance as a number above 0 and at most 1.`,
      })
      usable = false
    } else tolerance = raw.estimateTolerance
  }

  const overhead = compileOverhead(sink, file, pointer, raw.overhead)
  if (overhead === null) usable = false
  if (!usable) return null

  if (raw.reserveOutputTokens >= raw.contextTokens) {
    sink.add({
      file,
      ruleId: 'output-reservation-exceeds-context',
      pointer: `${pointer}/reserveOutputTokens`,
      message: `Profile "${name}" reserves ${raw.reserveOutputTokens} of a ${raw.contextTokens} token window for output, leaving no room for input at all.`,
      suggestion: 'Lower the reservation, or move to a model with a larger window.',
    })
    return null
  }

  return Object.freeze({
    name,
    tokenizer: raw.tokenizer,
    exact,
    contextTokens: raw.contextTokens,
    reserveOutputTokens: raw.reserveOutputTokens,
    minOutputTokens: raw.minOutputTokens,
    requireExact: raw.requireExact === true,
    estimateCharsPerToken: ratio,
    estimateTolerance: tolerance,
    overhead,
  })
}

/**
 * Compile the budget document and select the named profile.
 *
 * Only the selected profile is compiled. Compiling the others would report
 * findings about models this run is not budgeting, which is noise on a report
 * whose whole job is one number.
 */
export function compileBudget(sink, file, document) {
  if (!isPlainObject(document)) {
    sink.add({ file, ruleId: 'budget-invalid', pointer: '', message: `The budget file must be a JSON object; it is ${describeValue(document)}.` })
    return null
  }
  const extra = unknownKeys(document, BUDGET_KEYS)
  if (extra.length > 0) {
    sink.add({
      file,
      ruleId: 'budget-invalid',
      pointer: '',
      message: `The budget file accepts only ${BUDGET_KEYS.join(', ')}; it also declares ${extra.join(', ')}.`,
    })
    return null
  }
  if (document.schemaVersion !== BUDGET_SCHEMA_VERSION) {
    sink.add({
      file,
      ruleId: 'budget-invalid',
      pointer: '/schemaVersion',
      message: `The budget file must declare schemaVersion "${BUDGET_SCHEMA_VERSION}"; it declares ${describeValue(document.schemaVersion)}.`,
    })
    return null
  }
  if (typeof document.model !== 'string' || !NAME.test(document.model)) {
    sink.add({
      file,
      ruleId: 'budget-invalid',
      pointer: '/model',
      message: `model must name a profile and match ${NAME.source}; it is ${describeValue(document.model)}.`,
    })
    return null
  }
  if (!isPlainObject(document.profiles)) {
    sink.add({ file, ruleId: 'budget-invalid', pointer: '/profiles', message: `profiles must be an object; it is ${describeValue(document.profiles)}.` })
    return null
  }
  const names = Object.keys(document.profiles).sort(byCodeUnit)
  if (names.length === 0 || names.length > MAX_PROFILES) {
    sink.add({
      file,
      ruleId: 'budget-invalid',
      pointer: '/profiles',
      message: `profiles must hold between 1 and ${MAX_PROFILES} entries; it holds ${names.length}.`,
    })
    return null
  }
  for (const name of names) {
    if (!NAME.test(name)) {
      sink.add({
        file,
        ruleId: 'budget-invalid',
        pointer: '/profiles',
        message: `A profile name must match ${NAME.source}; one does not.`,
      })
      return null
    }
  }
  if (!Object.hasOwn(document.profiles, document.model)) {
    sink.add({
      file,
      ruleId: 'profile-missing',
      pointer: '/model',
      message: `model names "${document.model}", which is not one of the declared profiles (${names.join(', ')}).`,
      suggestion: 'A model with no profile has no window, no reservation and no overhead, so nothing can be budgeted for it.',
    })
    return null
  }

  return compileProfile(sink, file, document.model, document.profiles[document.model])
}

/**
 * Decide whether the counted request fits the input allowance.
 *
 * Three outcomes, not two, and the third is the one that matters. When the band
 * around an estimate straddles the allowance, this run genuinely does not know
 * whether the request fits -- and an unknown is not a pass. The caller turns
 * `undetermined` into an `incomplete` report and exit 2, which is what a
 * consumer needs in order to go and get a real count.
 */
export function decideBudget(total, allowance) {
  if (total.upper <= allowance) return 'fits'
  if (total.lower > allowance) return 'exceeds'
  return 'undetermined'
}
