/**
 * Counting, estimating and the canonical serialisation of a tool schema.
 *
 * The distinction this module exists to keep is the one the whole tool is about:
 * a **count** is a number this package can derive from the text and the declared
 * unit, and an **estimate** is a number derived from a ratio somebody supplied.
 * They are never added together without being tracked separately, and a budget
 * verdict that depends on which of the two it was says so.
 */

/**
 * The tokenizers this package counts exactly.
 *
 * Each is exact because its unit is *defined*, not modelled: the number of
 * UTF-8 bytes, Unicode scalar values or UTF-16 code units in a string is a fact
 * about the string. None of them is a vendor's byte-pair encoding, and this
 * package deliberately ships no vocabulary data, no merge table and no
 * downloader -- it would be a large binary blob, it would go stale, and
 * pretending a wrong table is exact is worse than labelling an estimate.
 *
 * For a vendor tokenizer there are two honest routes, and both are supported:
 * declare a `counted` block on the part, carrying a number your own tokenizer
 * produced; or declare `estimateCharsPerToken` and get a labelled estimate with
 * a band.
 */
export const EXACT_TOKENIZERS = Object.freeze(['unicode-scalars', 'utf16-code-units', 'utf8-bytes'])

const ENCODER = new TextEncoder()

/**
 * True when the string contains a surrogate code unit that is not part of a
 * pair.
 *
 * This is checked before anything is counted, and the reason is specific.
 * `TextEncoder` -- like every UTF-8 encoder that follows the standard --
 * replaces a lone surrogate with U+FFFD, which is three bytes. So a string with
 * one lone surrogate does not fail to encode: it encodes to a *different*
 * number, silently, and the budget is wrong by three bytes per occurrence with
 * nothing anywhere to say so.
 *
 * A lone surrogate reaches this tool easily: `JSON.parse` produces one from the
 * escape sequence for an unpaired high surrogate, which is what a truncated
 * log line or a naive byte-slice of a prompt leaves behind.
 *
 * Written as a loop rather than a regular expression so this file stays plain
 * ASCII: a lone surrogate cannot be written literally in a UTF-8 source file.
 */
export function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0xd800 || code > 0xdfff) continue
    if (code >= 0xdc00) return true
    const next = index + 1 < text.length ? text.charCodeAt(index + 1) : -1
    if (next < 0xdc00 || next > 0xdfff) return true
    index += 1
  }
  return false
}

/**
 * Count one string in the declared unit.
 *
 * The caller must have rejected lone surrogates first; `countExact` assumes a
 * well-formed string and would otherwise return the encoder's substituted
 * count. The three units genuinely differ, which is the point of offering them:
 * a family emoji joined with zero-width joiners is one grapheme, several
 * scalars, more code units and more bytes again, and a budget built on the
 * wrong one is wrong by a factor, not by a rounding.
 */
export function countExact(tokenizer, text) {
  if (tokenizer === 'utf8-bytes') return ENCODER.encode(text).length
  if (tokenizer === 'utf16-code-units') return text.length
  if (tokenizer === 'unicode-scalars') {
    let scalars = 0
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code >= 0xd800 && code <= 0xdbff) index += 1
      scalars += 1
    }
    return scalars
  }
  throw new Error(`countExact was asked for "${tokenizer}", which is not one of ${EXACT_TOKENIZERS.join(', ')}`)
}

/** Unicode scalar values, the unit an estimate ratio is expressed against. */
export const scalarsOf = (text) => countExact('unicode-scalars', text)

/**
 * Turn a character count into an estimated token count.
 *
 * The ratio is declared per profile and this package never invents one. A
 * default ratio would be a number nobody chose, applied to a tokenizer nobody
 * named, and it would silently become the reason a deployment fitted or did
 * not.
 */
export function estimateTokens(scalars, charsPerToken) {
  return Math.ceil(scalars / charsPerToken)
}

/**
 * The band around an estimate.
 *
 * `tolerance` is relative and symmetric in the multiplicative sense: the true
 * count is taken to lie in `[point / (1 + t), point * (1 + t)]`. The band is
 * what makes an estimate usable for a decision -- see `decideBudget` in
 * `src/budget.mjs`, where a band that straddles the allowance produces
 * `incomplete` rather than a guess dressed as a verdict.
 */
export function boundsFor(point, tolerance) {
  return {
    lower: Math.floor(point / (1 + tolerance)),
    point,
    upper: Math.ceil(point * (1 + tolerance)),
  }
}

/** An exact count has no band: the three numbers are the same number. */
export const exactBounds = (count) => ({ lower: count, point: count, upper: count })

/** Add two bands componentwise. */
export function addBounds(left, right) {
  return { lower: left.lower + right.lower, point: left.point + right.point, upper: left.upper + right.upper }
}

export const ZERO_BOUNDS = Object.freeze({ lower: 0, point: 0, upper: 0 })

/**
 * Serialise a tool schema deterministically.
 *
 * Object keys are emitted in code-unit order and no whitespace is inserted, so
 * the same schema produces the same string on every machine and in every Node
 * build -- `JSON.stringify` alone would preserve whatever insertion order the
 * parser happened to produce.
 *
 * This is emphatically **not** a claim about what a provider sends on the wire.
 * A provider may pretty-print, may order keys differently, may add fields of
 * its own. That difference is exactly what `overhead.perToolDefinition` is for,
 * and the README says so rather than implying a fidelity this cannot have.
 *
 * A string carrying an unpaired surrogate is refused here rather than written.
 * `JSON.stringify` turns a lone surrogate into the six characters `\uD83D` --
 * well-formed text that no longer contains a surrogate at all -- so counting
 * the serialisation would count six characters that the provider will never
 * receive, `hasLoneSurrogate` would see nothing wrong with the result, and the
 * run would report `pass` with `uncounted: 0`. That is exactly what this
 * package shipped: the guarantee held for message text and was silently absent
 * for every tool description and every schema. It is refused for a key as well
 * as for a value, because `JSON.stringify` escapes both the same way.
 *
 * @returns {{ok: true, text: string}|{ok: false, reason: 'too-deep'|'not-serialisable'|'lone-surrogate', pointer: string}}
 */
export function canonicalJson(value, maxDepth) {
  const write = (node, depth, pointer) => {
    if (depth > maxDepth) return { ok: false, reason: 'too-deep', pointer }
    if (node === null) return { ok: true, text: 'null' }
    if (typeof node === 'boolean') return { ok: true, text: node ? 'true' : 'false' }
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) return { ok: false, reason: 'not-serialisable', pointer }
      return { ok: true, text: JSON.stringify(node) }
    }
    if (typeof node === 'string') {
      if (hasLoneSurrogate(node)) return { ok: false, reason: 'lone-surrogate', pointer }
      return { ok: true, text: JSON.stringify(node) }
    }
    if (Array.isArray(node)) {
      const parts = []
      for (const [index, item] of node.entries()) {
        const written = write(item, depth + 1, `${pointer}/${index}`)
        if (!written.ok) return written
        parts.push(written.text)
      }
      return { ok: true, text: `[${parts.join(',')}]` }
    }
    if (typeof node === 'object') {
      const parts = []
      for (const key of Object.keys(node).sort(byCodeUnitLocal)) {
        const at = `${pointer}/${escapePointer(key)}`
        if (hasLoneSurrogate(key)) return { ok: false, reason: 'lone-surrogate', pointer: at }
        const written = write(node[key], depth + 1, at)
        if (!written.ok) return written
        parts.push(`${JSON.stringify(key)}:${written.text}`)
      }
      return { ok: true, text: `{${parts.join(',')}}` }
    }
    return { ok: false, reason: 'not-serialisable', pointer }
  }
  return write(value, 0, '')
}

/**
 * The same comparator as `text.mjs`, kept here so this module has no reason to
 * import anything and a reader can see the ordering that decides the bytes.
 */
function byCodeUnitLocal(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** JSON Pointer escaping, so a schema key containing a slash still names one place. */
export function escapePointer(key) {
  return String(key).replaceAll('~', '~0').replaceAll('/', '~1')
}
