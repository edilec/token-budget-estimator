/**
 * The request document: the messages and tool definitions whose tokens are
 * being budgeted.
 *
 * Message text is never interpreted here and never echoed anywhere. It is
 * measured. A prompt is exactly the kind of document that holds a customer's
 * words, an internal system description or a key somebody pasted, so this tool
 * reports its size and never its content.
 */

import { byCodeUnit, describeValue, isIdentifier, isPlainObject } from './text.mjs'

export const REQUEST_SCHEMA_VERSION = '1'

export const REQUEST_KEYS = Object.freeze(['messages', 'reserveOutputTokens', 'schemaVersion', 'tools'])
export const MESSAGE_KEYS = Object.freeze(['counted', 'id', 'name', 'role', 'text'])
export const TOOL_KEYS = Object.freeze(['counted', 'description', 'name', 'parameters'])
export const COUNTED_KEYS = Object.freeze(['tokenizer', 'tokens'])

/** The roles a message may carry. An unknown role has unknown overhead. */
export const ROLES = Object.freeze(['assistant', 'developer', 'system', 'tool', 'user'])

const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const MAX_DECLARED_TOKENS = 100000000

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key)).sort(byCodeUnit)
}

/**
 * A count somebody else measured.
 *
 * This is the honest route to an exact number for a vendor tokenizer: run your
 * own tokenizer, put the number in the file, and name the tokenizer it came
 * from. The name is checked against the profile at counting time -- a count
 * from a different encoding is not a count of this request, and silently
 * accepting one would be the most convincing wrong number this tool could
 * produce.
 */
function compileCounted(sink, file, pointer, raw) {
  if (raw === undefined) return { ok: true, counted: null }
  if (!isPlainObject(raw) || unknownKeys(raw, COUNTED_KEYS).length > 0) {
    sink.add({
      file,
      ruleId: 'declared-count-invalid',
      pointer,
      message: `counted must be an object with exactly ${COUNTED_KEYS.join(' and ')}; it is ${describeValue(raw)}.`,
    })
    return { ok: false }
  }
  if (!Number.isInteger(raw.tokens) || raw.tokens < 0 || raw.tokens > MAX_DECLARED_TOKENS) {
    sink.add({
      file,
      ruleId: 'declared-count-invalid',
      pointer: `${pointer}/tokens`,
      message: `counted.tokens must be an integer from 0 to ${MAX_DECLARED_TOKENS}; it is ${describeValue(raw.tokens)}.`,
    })
    return { ok: false }
  }
  if (typeof raw.tokenizer !== 'string' || !NAME.test(raw.tokenizer)) {
    sink.add({
      file,
      ruleId: 'declared-count-invalid',
      pointer: `${pointer}/tokenizer`,
      message: `counted.tokenizer must name the tokenizer the count came from and match ${NAME.source}.`,
      suggestion: 'A number with no tokenizer beside it is a number nobody can check.',
    })
    return { ok: false }
  }
  return { ok: true, counted: Object.freeze({ tokens: raw.tokens, tokenizer: raw.tokenizer }) }
}

function compileMessages(sink, file, raw, limits) {
  if (!Array.isArray(raw)) {
    sink.add({ file, ruleId: 'request-invalid', pointer: '/messages', message: `messages must be an array; it is ${describeValue(raw)}.` })
    return null
  }
  const messages = []
  const seen = new Set()
  let usable = true
  let bounded = false

  for (const [index, entry] of raw.entries()) {
    const pointer = `/messages/${index}`
    if (messages.length >= limits.maxMessages) {
      sink.add({
        file,
        ruleId: 'too-many-messages',
        pointer,
        message: `The request declares ${raw.length} messages, above the maxMessages limit of ${limits.maxMessages}; the walk stopped here and the rest were not counted.`,
        suggestion: 'Raise --max-messages, or split the request.',
      })
      bounded = true
      break
    }
    if (!isPlainObject(entry)) {
      sink.add({ file, ruleId: 'message-invalid', pointer, message: `A message must be an object; entry ${index} is ${describeValue(entry)}.` })
      usable = false
      continue
    }
    const extra = unknownKeys(entry, MESSAGE_KEYS)
    if (extra.length > 0) {
      sink.add({
        file,
        ruleId: 'message-invalid',
        pointer,
        message: `A message accepts only ${MESSAGE_KEYS.join(', ')}; entry ${index} also declares ${extra.join(', ')}.`,
        suggestion: 'Remove the unknown key rather than leaving content this tool is not counting.',
      })
      usable = false
      continue
    }
    if (!isIdentifier(entry.id)) {
      sink.add({ file, ruleId: 'message-invalid', pointer: `${pointer}/id`, message: `A message id must be a printable identifier; entry ${index} has ${describeValue(entry.id)}.` })
      usable = false
      continue
    }
    if (seen.has(entry.id)) {
      sink.add({
        file,
        ruleId: 'message-duplicate',
        pointer: `${pointer}/id`,
        message: `Message "${entry.id}" appears more than once, so a contributor named in this report would be ambiguous.`,
      })
      usable = false
      continue
    }
    if (!ROLES.includes(entry.role)) {
      sink.add({
        file,
        ruleId: 'role-unknown',
        pointer: `${pointer}/role`,
        message: `Message "${entry.id}" declares a role that is not one of ${ROLES.join(', ')}, so its overhead is unknown.`,
      })
      usable = false
      continue
    }
    if (typeof entry.text !== 'string') {
      sink.add({ file, ruleId: 'message-invalid', pointer: `${pointer}/text`, message: `Message "${entry.id}" must carry text as a string; it has ${describeValue(entry.text)}.` })
      usable = false
      continue
    }
    if (entry.text.length > limits.maxTextChars) {
      sink.add({
        file,
        ruleId: 'too-many-text-chars',
        pointer: `${pointer}/text`,
        message: `Message "${entry.id}" holds ${entry.text.length} characters, above the maxTextChars limit of ${limits.maxTextChars}; it was not counted.`,
        suggestion: 'Raise --max-text-chars, or split the message.',
      })
      bounded = true
      continue
    }
    if (entry.name !== undefined && !isIdentifier(entry.name)) {
      sink.add({ file, ruleId: 'message-invalid', pointer: `${pointer}/name`, message: `Message "${entry.id}" declares a name that is not a printable identifier.` })
      usable = false
      continue
    }
    const counted = compileCounted(sink, file, `${pointer}/counted`, entry.counted)
    if (!counted.ok) {
      usable = false
      continue
    }

    seen.add(entry.id)
    messages.push(Object.freeze({
      id: entry.id,
      role: entry.role,
      text: entry.text,
      name: entry.name,
      counted: counted.counted,
      pointer,
    }))
  }

  return usable ? { messages, bounded, declared: raw.length } : null
}

function compileTools(sink, file, raw, limits) {
  if (raw === undefined) return { tools: [], bounded: false, declared: 0 }
  if (!Array.isArray(raw)) {
    sink.add({ file, ruleId: 'request-invalid', pointer: '/tools', message: `tools must be an array when it is present; it is ${describeValue(raw)}.` })
    return null
  }
  const tools = []
  const seen = new Set()
  let usable = true
  let bounded = false

  for (const [index, entry] of raw.entries()) {
    const pointer = `/tools/${index}`
    if (tools.length >= limits.maxTools) {
      sink.add({
        file,
        ruleId: 'too-many-tools',
        pointer,
        message: `The request declares ${raw.length} tools, above the maxTools limit of ${limits.maxTools}; the walk stopped here and the rest were not counted.`,
        suggestion: 'Raise --max-tools, or send fewer tool definitions.',
      })
      bounded = true
      break
    }
    if (!isPlainObject(entry)) {
      sink.add({ file, ruleId: 'tool-invalid', pointer, message: `A tool must be an object; entry ${index} is ${describeValue(entry)}.` })
      usable = false
      continue
    }
    const extra = unknownKeys(entry, TOOL_KEYS)
    if (extra.length > 0) {
      sink.add({ file, ruleId: 'tool-invalid', pointer, message: `A tool accepts only ${TOOL_KEYS.join(', ')}; entry ${index} also declares ${extra.join(', ')}.` })
      usable = false
      continue
    }
    if (typeof entry.name !== 'string' || !NAME.test(entry.name)) {
      sink.add({
        file,
        ruleId: 'tool-invalid',
        pointer: `${pointer}/name`,
        message: `A tool name must match ${NAME.source}; entry ${index} has ${describeValue(entry.name)}.`,
      })
      usable = false
      continue
    }
    if (seen.has(entry.name)) {
      sink.add({ file, ruleId: 'tool-duplicate', pointer: `${pointer}/name`, message: `Tool "${entry.name}" is declared more than once.` })
      usable = false
      continue
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      sink.add({ file, ruleId: 'tool-invalid', pointer: `${pointer}/description`, message: `Tool "${entry.name}" must carry description as a string when it carries one at all.` })
      usable = false
      continue
    }
    if (entry.description !== undefined && entry.description.length > limits.maxTextChars) {
      sink.add({
        file,
        ruleId: 'too-many-text-chars',
        pointer: `${pointer}/description`,
        message: `Tool "${entry.name}" has a description of ${entry.description.length} characters, above the maxTextChars limit of ${limits.maxTextChars}; it was not counted.`,
      })
      bounded = true
      continue
    }
    const counted = compileCounted(sink, file, `${pointer}/counted`, entry.counted)
    if (!counted.ok) {
      usable = false
      continue
    }

    seen.add(entry.name)
    tools.push(Object.freeze({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      counted: counted.counted,
      pointer,
    }))
  }

  return usable ? { tools, bounded, declared: raw.length } : null
}

/**
 * Compile the request document.
 *
 * @returns {{messages: object[], tools: object[], declaredMessages: number,
 *   declaredTools: number, bounded: boolean, reserveOutputTokens: number|undefined}|null}
 */
export function compileRequest(sink, file, document, limits) {
  if (!isPlainObject(document)) {
    sink.add({ file, ruleId: 'request-invalid', pointer: '', message: `The request file must be a JSON object; it is ${describeValue(document)}.` })
    return null
  }
  const extra = unknownKeys(document, REQUEST_KEYS)
  if (extra.length > 0) {
    sink.add({ file, ruleId: 'request-invalid', pointer: '', message: `The request file accepts only ${REQUEST_KEYS.join(', ')}; it also declares ${extra.join(', ')}.` })
    return null
  }
  if (document.schemaVersion !== REQUEST_SCHEMA_VERSION) {
    sink.add({
      file,
      ruleId: 'request-invalid',
      pointer: '/schemaVersion',
      message: `The request file must declare schemaVersion "${REQUEST_SCHEMA_VERSION}"; it declares ${describeValue(document.schemaVersion)}.`,
    })
    return null
  }
  if (document.reserveOutputTokens !== undefined &&
      (!Number.isInteger(document.reserveOutputTokens) || document.reserveOutputTokens < 0 || document.reserveOutputTokens > MAX_DECLARED_TOKENS)) {
    sink.add({
      file,
      ruleId: 'request-invalid',
      pointer: '/reserveOutputTokens',
      message: `reserveOutputTokens must be an integer from 0 to ${MAX_DECLARED_TOKENS} when the request overrides the profile.`,
    })
    return null
  }

  const messages = compileMessages(sink, file, document.messages, limits)
  if (messages === null) return null
  const tools = compileTools(sink, file, document.tools, limits)
  if (tools === null) return null

  return {
    messages: messages.messages,
    tools: tools.tools,
    declaredMessages: messages.declared,
    declaredTools: tools.declared,
    bounded: messages.bounded || tools.bounded,
    reserveOutputTokens: document.reserveOutputTokens,
  }
}
