import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8, describeValue,
  hasForbiddenCharacter, isIdentifier, isPlainObject,
} from '../src/index.mjs'
import { FORBIDDEN, UNICODE } from './support.mjs'

test('byCodeUnit orders by UTF-16 code unit', () => {
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a', 'Z'), 1)
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  assert.deepEqual(
    ['assets', 'README', 'a_b', 'a-b', 'Zebra'].sort(byCodeUnit),
    ['README', 'Zebra', 'a-b', 'a_b', 'assets'],
  )
})

test('hasForbiddenCharacter covers all four classes and nothing legitimate', () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(hasForbiddenCharacter(`a${character}b`), true, name)
  }
  // Ordinary right-to-left text needs none of the overrides: the letters carry
  // their own direction, so refusing the overrides refuses nothing legitimate.
  for (const legitimate of [
    'plain words and spaces',
    `Arabic: ${UNICODE.arabic}`,
    `Japanese: ${UNICODE.japanese}`,
    `emoji: ${UNICODE.astral}`,
    `combining: ${UNICODE.combining}`,
    `a replacement character: ${String.fromCodePoint(0xfffd)}`,
  ]) {
    assert.equal(hasForbiddenCharacter(legitimate), false, legitimate)
  }
  // Tab, newline and carriage return are refused in an identifier and collapsed
  // to a space in an excerpt -- two routes to the same result.
  assert.equal(hasForbiddenCharacter('tabs\tinside'), true)
})

test('isIdentifier refuses the empty, the padded, the over-long and the controlled', () => {
  assert.equal(isIdentifier('system-turn'), true)
  assert.equal(isIdentifier(''), false)
  assert.equal(isIdentifier(' padded '), false)
  assert.equal(isIdentifier('x'.repeat(MAX_IDENTIFIER_LENGTH)), true)
  assert.equal(isIdentifier('x'.repeat(MAX_IDENTIFIER_LENGTH + 1)), false)
  assert.equal(isIdentifier(5), false)
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(isIdentifier(`a${character}b`), false, name)
  }
})

test('decodeUtf8 lets the decoder decide, and returns no text when it refuses', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x61, 0x62])), { ok: true, text: 'ab' })
  assert.deepEqual(decodeUtf8(new Uint8Array([0xff])), { ok: false, reason: 'not-utf8' })
  // A legitimate replacement character decodes; it is not evidence of anything.
  assert.equal(decodeUtf8(new Uint8Array([0xef, 0xbf, 0xbd])).ok, true)
  // A byte-order mark is consumed by the decoder rather than handed to the JSON
  // parser, which would refuse it. A file written on Windows still counts.
  assert.deepEqual(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), { ok: true, text: 'a' })
  // A truncated multi-byte sequence is refused rather than repaired, which
  // matters here: repairing it would change the byte count.
  assert.equal(decodeUtf8(new Uint8Array([0xe6, 0x97])).ok, false)
})

test('describeValue says the shape and never the value', () => {
  assert.equal(describeValue(undefined), 'nothing')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(true), 'true')
  assert.equal(describeValue(3), 'an integer')
  assert.equal(describeValue(3.5), 'a number')
  assert.equal(describeValue('a whole prompt'), 'a string of 14 character(s)')
  assert.equal(describeValue(['a', 'b']), 'an array of 2 item(s)')
  assert.equal(describeValue({ a: 1 }), 'an object')
  assert.equal(describeValue(() => {}), 'a function')
})

test('isPlainObject refuses arrays, null and instances dressed up as objects', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Date(0)), false)
  assert.equal(isPlainObject('a'), false)
})
