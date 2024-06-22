import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { estimateBudget, isInside } from '../src/index.mjs'
import { budgetOf, cliRun, everyString, message, requestOf } from './support.mjs'

/**
 * Path confinement, tested against the thing that actually defeats it.
 *
 * Rejecting `..` and absolute paths is not confinement. A symbolic link planted
 * inside the declared root contains no `..` at all, and following one let
 * out-of-root content be echoed into a report elsewhere in this catalog. Here
 * the file at the end of such a link would be somebody's prompt.
 */

const OUTSIDE = 'ZZQ-a-prompt-from-outside-the-declared-root'

async function withTree(body) {
  const base = await mkdtemp(join(tmpdir(), 'token-budget-estimator-tree-'))
  try {
    const root = join(base, 'root')
    const elsewhere = join(base, 'elsewhere')
    await mkdir(root)
    await mkdir(elsewhere)
    await writeFile(join(root, 'budget.json'), JSON.stringify(budgetOf()))
    await writeFile(join(elsewhere, 'secret.json'), JSON.stringify(requestOf([message({ id: 'leaked', text: OUTSIDE })])))
    return await body({ base, root, elsewhere })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('a symbolic link planted inside the root is refused unread', async () => {
  await withTree(async ({ root, elsewhere }) => {
    await symlink(join(elsewhere, 'secret.json'), join(root, 'request.json'))
    const report = await estimateBudget({ root })

    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'))
    assert.equal(report.summary.checked, 0, 'nothing out of the tree was counted')
    for (const value of everyString(report)) {
      assert.equal(value.includes(OUTSIDE), false, 'out-of-root content reached the report')
    }
  })
})

test('a symbolic link to a directory inside the root is refused as well', async () => {
  await withTree(async ({ root, elsewhere }) => {
    await symlink(elsewhere, join(root, 'linked'))
    const report = await estimateBudget({ root, request: 'linked/secret.json' })
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'))
  })
})

test('a missing file reached through a symlinked parent is refused, not reported as absent', async () => {
  // The entry does not exist, so realpath fails with ENOENT before it can say
  // anything about where the path pointed. Confining the nearest existing
  // ancestor is what stops a symlinked parent deciding where a "missing" file
  // would have been read from.
  await withTree(async ({ root, elsewhere }) => {
    await symlink(elsewhere, join(root, 'linked'))
    const report = await estimateBudget({ root, request: 'linked/absent.json' })
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'))
  })
})

test('a relative path that steps out of the root is a configuration error with empty stdout', async () => {
  await withTree(async ({ root }) => {
    const result = await cliRun(['--root', root, '--request', '../elsewhere/secret.json', '--json'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error never had a subject to report on')
    assert.match(result.stderr, /must not step outside --root/)
    assert.equal(result.stderr.includes(OUTSIDE), false)
  })
})

test('an absolute path is a configuration error too', async () => {
  await withTree(async ({ root, elsewhere }) => {
    const result = await cliRun(['--root', root, '--request', join(elsewhere, 'secret.json'), '--json'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /must be relative to --root/)
  })
})

test('a root reached through a symbolic link is not falsely refused', async () => {
  // The other half of confinement, and the easier half to get wrong: comparing
  // a real root against an unresolved candidate refuses legitimate files
  // whenever the root itself is a link. On macOS a temporary directory usually
  // is one, which is how this defect hides.
  await withTree(async ({ base, root }) => {
    await writeFile(join(root, 'request.json'), JSON.stringify(requestOf()))
    const linkedRoot = join(base, 'linked-root')
    await symlink(root, linkedRoot)
    const report = await estimateBudget({ root: linkedRoot })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 1)
  })
})

test('isInside compares whole path segments, not string prefixes', () => {
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false, 'a sibling whose name starts with the root name is not inside it')
  assert.equal(isInside('/a/b/', '/a/b/c'), true)
})

test('a root that is not a directory is a configuration error', async () => {
  await withTree(async ({ root }) => {
    await assert.rejects(() => estimateBudget({ root: join(root, 'budget.json') }), /--root must be a directory/)
    await assert.rejects(() => estimateBudget({ root: join(root, 'absent') }), /--root could not be resolved/)
  })
})

test('a file name carrying a control character is refused as configuration', async () => {
  await withTree(async ({ root }) => {
    await assert.rejects(
      () => estimateBudget({ root, request: `req${String.fromCharCode(0x0a)}uest.json` }),
      /must not contain a control, separator or bidi character/,
    )
  })
})
