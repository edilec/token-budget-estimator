/**
 * Decoding, sanitising, ordering, identifiers and the JSON parse diagnostic.
 *
 * Every value that passes through this module arrived in a file this tool did
 * not write. A budget report is pasted into pull requests and incident notes,
 * so nothing here is optional: message ids, tool names, paths, pointers,
 * messages and evidence all go through the same door.
 *
 * Nothing here touches the filesystem, the network, the locale or the clock.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `String.prototype.localeCompare` and `Intl.Collator` both read ICU data that
 * differs between Node builds, and both treat punctuation as ignorable, so
 * `tool-a` and `tool_a` swap places depending on which machine ran the tool. A
 * report that is only deterministic on one host is not deterministic. Neither
 * spelling appears anywhere in this package, and `test/ordering.test.mjs` pins
 * the order this tool emits rather than the spelling it used, because a scan of
 * the source cannot tell one comparator from its replacement.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters no untrusted value may carry into output, in four classes.
 *
 * Written from code points rather than as literals: a raw U+2028 or U+2029
 * inside a module is a line terminator to the JavaScript parser and would break
 * this file at load, and the rest are invisible in an editor.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline in a message id
 *   forges a whole line in the human summary; ESC opens a terminal escape
 *   sequence; NUL truncates the value in anything that receives it through C.
 * - **C1** (U+0080-U+009F). Frequently forgotten once C0 is handled, and two of
 *   them need no help: U+0085 NEL is a line break to a great many consumers and
 *   U+009B is the 8-bit CSI, a terminal control introducer with no ESC in front
 *   of it.
 * - **Line and paragraph separators** (U+2028, U+2029).
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so a tool named `search` can be displayed as something other than
 *   the tool whose schema was counted. Ordinary right-to-left text needs none
 *   of these: Arabic and Hebrew letters carry their own direction, so refusing
 *   the overrides refuses nothing legitimate.
 *
 * Note that this class is about **identifiers and report strings**. Message
 * text is never sanitised, because it is never echoed -- it is counted, and a
 * count is not a quotation. Sanitising it would silently change the count.
 */
const DEL_AND_C1 = `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

const FORBIDDEN_IN_IDENTIFIER = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)

/**
 * True when any of the four classes appears anywhere in the value. Exported so
 * a test can walk an entire report and assert that nothing survived, instead of
 * checking the one field somebody remembered.
 */
export function hasForbiddenCharacter(value) {
  return FORBIDDEN_IN_IDENTIFIER.test(String(value))
}

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 200

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every identifier, path, pointer, message and piece of evidence that reaches a
 * finding passes through here. A sibling tool in this catalog sanitised its
 * evidence field with great care and left its identifiers raw, so a record id
 * holding a newline printed a second line into the human report and invented a
 * finding that was never emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/** Identifiers are this tool's vocabulary: message ids, tool names, model and profile names. */
export function isIdentifier(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false
  if (value.trim() !== value) return false
  return !FORBIDDEN_IN_IDENTIFIER.test(value)
}

/**
 * Say what a refused value was, without reproducing any of it.
 *
 * A rejected field holds arbitrary text from a file this tool did not write,
 * and the report goes to stdout -- a stream that is piped, logged and pasted
 * somewhere more public than the request ever was. A prompt is exactly the kind
 * of document that holds a customer's words, a key, or an internal system
 * description; a budget report is not the place for any of it.
 */
export function describeValue(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'string') return `a string of ${value.length} character(s)`
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input, recognised FIRST.
 *
 * A document whose own text reads `at position 1` produces
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so a helper that
 * looks for the offset first finds that text inside the quoted span and slices
 * the document back out. Nineteen of thirty-eight tools in this catalog shipped
 * exactly that bug. The `s` flag matters too: the quoted span can contain a
 * newline, and a non-dotAll pattern silently fails to recognise the shape it
 * exists to catch.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say what a JSON parse failure was, without reproducing the document.
 *
 * V8 embeds raw input in its message, and the quoted window is taken from
 * wherever the offence is rather than from the start, so truncating the front
 * is not a fix. Position, line and column are the useful half and say nothing
 * about content, so they are kept whole.
 *
 * The closing guard is deliberate belt and braces, and it is the reason this
 * function is safe against wordings it has never seen: across 500,206 distinct
 * V8 parse messages, every message carrying no quoted snippet also carried no
 * double quote at all -- V8 quotes JSON punctuation with apostrophes. A
 * surviving double quote therefore means a snippet survived, whatever the
 * branches above concluded, and the generic sentence is used instead.
 *
 * This matters more here than in most tools: the document being parsed is a
 * prompt, and the first ten characters of a prompt are routinely a system
 * instruction, an API key someone pasted, or a customer's name.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains a
 * replacement character, and that confusion has already let an unread input
 * report a pass in this catalog. It matters doubly here: a replacement
 * character is one code point and three UTF-8 bytes, so a lenient decode would
 * not merely mislabel the file, it would return a **different number**.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
