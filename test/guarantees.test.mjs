import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliReport, fixture, projectDirectory } from './support.mjs'

/**
 * The claims the README makes, each held by something that fails when the claim
 * stops being true.
 *
 * The source scans below are a **secondary** guard and are labelled as such: a
 * scan cannot tell a comparator from its replacement, which is why ordering is
 * pinned behaviourally in `test/ordering.test.mjs` and severity in
 * `test/severity-behaviour.test.mjs`. What a scan is good for is catching a
 * whole capability arriving -- a socket, a clock, a download -- which has no
 * behavioural signature until the day it misbehaves.
 */

async function shippedSource() {
  const parts = []
  for (const directory of ['src', 'bin']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  return parts.join('\n')
}

test('the shipped source opens no network connection of any kind', async () => {
  // "It does not contact a provider" is a README claim, and a token counter is
  // exactly the kind of tool that grows an API call to "check" its own answer.
  const source = await shippedSource()
  for (const name of [
    'node:net', 'node:http', 'node:https', 'node:http2', 'node:dns', 'node:tls',
    'node:dgram', 'fetch(', 'XMLHttpRequest', 'WebSocket',
  ]) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
})

test('the shipped source starts no process and runs no code it did not parse', async () => {
  const source = await shippedSource()
  for (const name of [
    'node:child_process', 'node:worker_threads', 'node:cluster', 'node:vm',
    'node:repl', 'node:inspector', 'execFile', 'execSync', 'spawnSync', 'process.binding',
  ]) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
  assert.equal(/\bnew\s+Function\b/.test(source), false, 'the Function constructor is eval under another name')
  assert.equal(/\beval\s*\(/.test(source), false)
  assert.equal(/\bimport\s*\(/.test(source), false, 'a dynamic import decides at run time which code runs')
  // `process.exitCode` hands the code to the runtime, which flushes stdout
  // before the process leaves. `process.exit()` does not wait, and a large JSON
  // report on a pipe is precisely what it truncates.
  assert.equal(/\bprocess\.exit\s*\(/.test(source), false, 'process.exit can truncate the report on stdout')
  assert.equal(source.includes('process.exitCode = '), true, 'the exit code is handed over, not taken')
})

test('the shipped source reads no clock, no random source and no environment', async () => {
  const source = await shippedSource()
  assert.equal(/\bnew\s+Date\b/.test(source), false, 'a wall clock in the output breaks byte-identical runs')
  assert.equal(/\bDate\.\w+\s*\(/.test(source), false)
  assert.equal(/\bMath\.random\s*\(/.test(source), false)
  assert.equal(/\bperformance\.now\s*\(/.test(source), false)
  assert.equal(/\bprocess\.env\b/.test(source), false)
})

test('the shipped source never reaches for a locale-aware comparison', async () => {
  // Secondary only. `Intl.Collator` drifts exactly as `localeCompare` does and
  // spells differently, so this scan would pass while ordering became
  // machine-dependent. The names appear in prose in src/text.mjs deliberately,
  // so the scan looks for call sites rather than for the words.
  const source = await shippedSource()
  for (const pattern of [/\.localeCompare\s*\(/, /\bIntl\s*\.\s*\w+\s*\(/, /\.toLocale\w*\s*\(/]) {
    assert.equal(pattern.test(source), false, `the source calls ${pattern}`)
  }
})

test('the shipped source writes nothing and deletes nothing', async () => {
  // "It does not modify anything. Read-only, always."
  const source = await shippedSource()
  for (const name of [
    'writeFile', 'appendFile', 'createWriteStream', 'rm(', 'rmdir(', 'unlink(',
    'truncate(', 'mkdir(', 'chmod(', 'rename(', 'copyFile(',
  ]) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
})

test('the shipped source carries no vocabulary data', async () => {
  // "This package ships no vocabulary data and downloads nothing." A merge
  // table would be a large literal; this bounds the whole shipped source
  // instead, which no vocabulary could hide inside.
  let bytes = 0
  for (const directory of ['src', 'bin']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      bytes += (await readFile(join(projectDirectory, directory, name))).length
    }
  }
  assert.ok(bytes < 200000, `the shipped source is ${bytes} bytes`)

  const files = await readdir(projectDirectory)
  for (const name of files) {
    assert.equal(/\.(bin|dat|tiktoken|model|vocab|bpe)$/.test(name), false, `${name} looks like tokenizer data`)
  }
})

test('the package declares no dependencies of any kind', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
  assert.equal(manifest.name, 'token-budget-estimator')
  assert.equal(manifest.type, 'module')
})

test('the tool id equals the directory name and the package name', async () => {
  const { TOOL_ID } = await import('../src/index.mjs')
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  assert.equal(TOOL_ID, 'token-budget-estimator')
  assert.equal(TOOL_ID, manifest.name)
  assert.equal(TOOL_ID, projectDirectory.split('/').pop())
  const { report } = await cliReport(fixture())
  assert.equal(report.tool, TOOL_ID)
})

test('the README claims nothing the package does not do', async () => {
  const readme = (await readFile(join(projectDirectory, 'README.md'), 'utf8')).replace(/\s+/g, ' ')
  // Each of these sentences is held by a test elsewhere in this suite. The
  // assertion here is that the sentence is still the one being held.
  for (const claim of [
    'An uncounted part is never counted as zero',
    'An unpaired surrogate is refused, not encoded',
    'No ratio is invented',
    'A declared count must name the profile',
    'An estimate that cannot decide says so',
    'Every overhead component is required',
    'This package ships no vocabulary data and downloads nothing',
    'It does not contact a provider',
    'It does not count graphemes',
    'It does not normalise text',
    'It does not modify anything',
    'Ordering is by UTF-16 code unit',
  ]) {
    assert.ok(readme.includes(claim), `the README no longer states: ${claim}`)
  }
  assert.equal(readme.includes('Zero runtime dependencies and zero development dependencies'), true)
})

test('every shipped source file is plain ASCII, so no invisible character hides in it', async () => {
  // A literal U+2028 inside a regular expression breaks the module at load, and
  // the rest of the class is invisible in an editor. Writing the escape text
  // and checking the bytes is cheaper than finding out later.
  for (const directory of ['src', 'bin']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      const bytes = await readFile(join(projectDirectory, directory, name))
      for (const [index, byte] of bytes.entries()) {
        const ok = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)
        assert.ok(ok, `${directory}/${name} byte ${index} is 0x${byte.toString(16)}`)
      }
    }
  }
})

test('no test file carries a literal control, separator or bidi character', async () => {
  const forbidden = new Set([
    ...Array.from({ length: 32 }, (unused, index) => index).filter((code) => ![9, 10, 13].includes(code)),
    0x7f, 0x2028, 0x2029, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2066, 0x2067, 0x2068, 0x2069,
    ...Array.from({ length: 32 }, (unused, index) => 0x80 + index),
  ])
  for (const name of (await readdir(join(projectDirectory, 'test'))).sort()) {
    const text = await readFile(join(projectDirectory, 'test', name), 'utf8')
    for (const character of text) {
      assert.equal(forbidden.has(character.codePointAt(0)), false, `test/${name} carries U+${character.codePointAt(0).toString(16)}`)
    }
  }
})
