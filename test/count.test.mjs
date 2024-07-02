import assert from 'node:assert/strict'
import test from 'node:test'

import { EXACT_TOKENIZERS, addBounds, boundsFor, canonicalJson, countExact, estimateTokens, exactBounds, hasLoneSurrogate, scalarsOf } from '../src/index.mjs'
import { UNICODE } from './support.mjs'

/**
 * Counting, and the Unicode cases that separate a correct counter from one that
 * happens to agree on ASCII.
 *
 * The three units are not interchangeable and the difference is not small: an
 * astral character is one scalar, two UTF-16 code units and four UTF-8 bytes,
 * so a budget built on the wrong unit is wrong by a factor rather than by a
 * rounding. Every case below asserts all three, because a counter that returns
 * `text.length` for everything passes any test that only checks one.
 */

const counts = (text) => ({
  scalars: countExact('unicode-scalars', text),
  codeUnits: countExact('utf16-code-units', text),
  bytes: countExact('utf8-bytes', text),
})

test('ASCII agrees on all three units, which is why ASCII proves nothing', () => {
  assert.deepEqual(counts('abc'), { scalars: 3, codeUnits: 3, bytes: 3 })
})

test('an astral character is one scalar, two code units and four bytes', () => {
  assert.deepEqual(counts(UNICODE.astral), { scalars: 1, codeUnits: 2, bytes: 4 })
})

test('a zero-width-joiner sequence is one glyph and three scalars', () => {
  // U+1F469 U+200D U+1F4BB. Anything that counts "emoji" as one is counting
  // graphemes, which is a fourth unit this package deliberately does not offer.
  assert.deepEqual(counts(UNICODE.zwjSequence), { scalars: 3, codeUnits: 5, bytes: 11 })
})

test('a combining mark is a scalar of its own, and the precomposed form is not', () => {
  assert.deepEqual(counts(UNICODE.combining), { scalars: 2, codeUnits: 2, bytes: 3 })
  assert.deepEqual(counts(UNICODE.precomposed), { scalars: 1, codeUnits: 1, bytes: 2 })
  // The two render identically. Normalising one into the other would change
  // the count, so this package does not normalise: it counts the bytes it was
  // given, which are the bytes that will be sent.
  assert.notDeepEqual(counts(UNICODE.combining), counts(UNICODE.precomposed))
})

test('Japanese is three bytes per scalar and Arabic is two', () => {
  assert.deepEqual(counts(UNICODE.japanese), { scalars: 3, codeUnits: 3, bytes: 9 })
  assert.deepEqual(counts(UNICODE.arabic), { scalars: 5, codeUnits: 5, bytes: 10 })
})

test('an unpaired surrogate is detected, in both directions and at the end of a string', () => {
  assert.equal(hasLoneSurrogate('plain'), false)
  assert.equal(hasLoneSurrogate(UNICODE.astral), false, 'a well-formed pair is not a lone surrogate')
  assert.equal(hasLoneSurrogate(UNICODE.zwjSequence), false)
  assert.equal(hasLoneSurrogate(UNICODE.loneHighSurrogate), true)
  assert.equal(hasLoneSurrogate(UNICODE.loneLowSurrogate), true)
  assert.equal(hasLoneSurrogate(`a${UNICODE.loneHighSurrogate}b`), true)
  assert.equal(hasLoneSurrogate(`ab${UNICODE.loneHighSurrogate}`), true, 'a high surrogate at the very end has no partner')
  assert.equal(hasLoneSurrogate(`${UNICODE.loneLowSurrogate}${UNICODE.loneHighSurrogate}`), true, 'the pair in the wrong order is two lone surrogates')
  assert.equal(hasLoneSurrogate(`${UNICODE.astral}${UNICODE.astral}`), false)
})

test('two unpaired low surrogates in a row are two lone surrogates, not a pair', () => {
  /**
   * The branch that catches a low surrogate arriving first had no case of its
   * own: every existing case still returned true through the later branch, so
   * deleting `if (code >= 0xdc00) return true` left the suite green while the
   * function called consecutive unpaired lows well-formed. Those two code units
   * would then have been counted as six UTF-8 bytes of substituted U+FFFD --
   * the exact silently-different number the guarantee exists to prevent.
   */
  const two = `${UNICODE.loneLowSurrogate}${UNICODE.loneLowSurrogate}`
  assert.equal(hasLoneSurrogate(two), true)
  assert.equal(new TextEncoder().encode(two).length, 6, 'what the encoder would have returned instead')
  assert.equal(hasLoneSurrogate(`a${UNICODE.loneLowSurrogate}${UNICODE.loneLowSurrogate}b`), true)
  assert.equal(hasLoneSurrogate(`${UNICODE.loneLowSurrogate}${UNICODE.astral}`), true, 'a low surrogate before a valid pair')
})

test('the encoder would silently return a different number for an unpaired surrogate', () => {
  /**
   * The justification for refusing rather than counting. `TextEncoder`
   * substitutes U+FFFD, which is three bytes, so a one-code-unit string
   * "measures" three bytes and nothing anywhere says so. This assertion exists
   * so that the guard is visibly protecting against a real behaviour rather
   * than a hypothetical one.
   */
  assert.equal(new TextEncoder().encode(UNICODE.loneHighSurrogate).length, 3)
  assert.equal(UNICODE.loneHighSurrogate.length, 1)
})

test('countExact refuses a tokenizer it does not count, rather than guessing', () => {
  assert.throws(() => countExact('o200k_base', 'abc'), /not one of unicode-scalars, utf16-code-units, utf8-bytes/)
  assert.deepEqual([...EXACT_TOKENIZERS], ['unicode-scalars', 'utf16-code-units', 'utf8-bytes'])
})

test('an estimate rounds up and a band brackets it', () => {
  assert.equal(scalarsOf('abcdefgh'), 8)
  assert.equal(estimateTokens(8, 4), 2)
  assert.equal(estimateTokens(9, 4), 3, 'a partial token is a token')
  assert.deepEqual(boundsFor(100, 0.25), { lower: 80, point: 100, upper: 125 })
  assert.deepEqual(boundsFor(0, 0.5), { lower: 0, point: 0, upper: 0 })
  const band = boundsFor(37, 0.3)
  assert.ok(band.lower <= band.point && band.point <= band.upper, 'the band always brackets the point')
})

test('an exact count has no band, and bands add componentwise', () => {
  assert.deepEqual(exactBounds(12), { lower: 12, point: 12, upper: 12 })
  assert.deepEqual(
    addBounds({ lower: 1, point: 2, upper: 3 }, { lower: 10, point: 20, upper: 30 }),
    { lower: 11, point: 22, upper: 33 },
  )
})

test('canonical JSON orders keys by code unit and inserts no whitespace', () => {
  const schema = { b: 1, a: 2, Z: 3, 'a-b': 4, a_b: 5 }
  const written = canonicalJson(schema, 10)
  assert.equal(written.ok, true)
  assert.equal(written.text, '{"Z":3,"a":2,"a-b":4,"a_b":5,"b":1}')

  // The same object built in a different insertion order serialises identically,
  // which is the whole point: JSON.stringify alone would preserve whichever
  // order the parser happened to produce.
  const other = canonicalJson({ a_b: 5, 'a-b': 4, a: 2, Z: 3, b: 1 }, 10)
  assert.equal(other.text, written.text)
  assert.notEqual(JSON.stringify(schema), written.text)
})

test('canonical JSON handles the whole JSON value space a schema can hold', () => {
  const written = canonicalJson({
    type: 'object',
    properties: { n: { type: 'integer', minimum: -1, maximum: 2.5 }, f: { const: false }, z: { const: null } },
    required: ['n'],
  }, 10)
  assert.equal(written.ok, true)
  assert.equal(written.text.includes('"minimum":-1'), true)
  assert.equal(written.text.includes('"maximum":2.5'), true)
  assert.equal(written.text.includes('"const":false'), true)
  assert.equal(written.text.includes('"const":null'), true)
  assert.equal(written.text.includes('"required":["n"]'), true)
})

test('canonical JSON stops at the declared depth and names where it stopped', () => {
  const deep = { a: { b: { c: { d: 1 } } } }
  assert.equal(canonicalJson(deep, 10).ok, true)
  const stopped = canonicalJson(deep, 2)
  assert.deepEqual(stopped, { ok: false, reason: 'too-deep', pointer: '/a/b/c' })
})

test('canonical JSON escapes a pointer segment that contains a slash or a tilde', () => {
  const stopped = canonicalJson({ 'a/b': { 'c~d': { e: { f: 1 } } } }, 2)
  assert.equal(stopped.ok, false)
  assert.equal(stopped.pointer, '/a~1b/c~0d/e')
})

test('canonical JSON refuses a value it cannot write deterministically', () => {
  // Unreachable through JSON.parse, reachable through the library API. It is
  // refused rather than serialised as null, because a schema that silently
  // loses a field is a schema whose size was not measured.
  assert.deepEqual(canonicalJson({ a: Number.POSITIVE_INFINITY }, 10), { ok: false, reason: 'not-serialisable', pointer: '/a' })
  assert.deepEqual(canonicalJson({ a: Number.NaN }, 10), { ok: false, reason: 'not-serialisable', pointer: '/a' })
  assert.equal(canonicalJson({ a: () => {} }, 10).ok, false)
})

test('canonical JSON refuses a string carrying an unpaired surrogate, in a value and in a key', () => {
  /**
   * `JSON.stringify` turns a lone surrogate into the six characters of an
   * escape -- well-formed text with no surrogate left in it -- so a tool that
   * serialised first and checked afterwards counted escape text the provider
   * will never receive and found nothing wrong with the result. That is exactly
   * what this package shipped for tool descriptions and schemas.
   */
  assert.equal(JSON.stringify(UNICODE.loneHighSurrogate).length, 8, 'six escape characters inside two quotes')
  assert.equal(hasLoneSurrogate(JSON.stringify(UNICODE.loneHighSurrogate)), false, 'why checking the serialisation cannot work')

  assert.deepEqual(
    canonicalJson({ description: `broken ${UNICODE.loneHighSurrogate} here` }, 10),
    { ok: false, reason: 'lone-surrogate', pointer: '/description' },
  )
  assert.deepEqual(
    canonicalJson({ a: { b: [1, UNICODE.loneLowSurrogate] } }, 10),
    { ok: false, reason: 'lone-surrogate', pointer: '/a/b/1' },
  )
  assert.deepEqual(
    canonicalJson({ [`bro${UNICODE.loneHighSurrogate}ken`]: 1 }, 10),
    { ok: false, reason: 'lone-surrogate', pointer: `/bro${UNICODE.loneHighSurrogate}ken` },
  )
  assert.equal(canonicalJson({ description: `intact ${UNICODE.astral} here` }, 10).ok, true, 'a well-formed pair is not refused')
})
