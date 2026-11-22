/**
 * Unit tests for the write-path guard. These prove traversal, prefix confusion,
 * root-itself and symlink escapes fail closed; they are not a live Host test.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hasRoots, resolveWithinRoots, sameDirectory } from '../paths.js'

function layout() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-paths-')))
  const root = path.join(base, 'root')
  const sibling = path.join(base, 'root-sibling')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(sibling)
  fs.mkdirSync(outside)
  return { base, root, sibling, outside }
}

test('no roots means no capability', () => {
  const verdict = resolveWithinRoots([], 'C:/work/demo')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'no_allowed_roots')
  assert.equal(hasRoots([]), false)
  assert.equal(hasRoots(['relative-only']), false)
})

test('two different missing directory names cannot establish shared identity', () => {
  const { root } = layout()
  assert.equal(sameDirectory(path.join(root, 'missing-a'), path.join(root, 'missing-b')), false)
})

test('existing directories inside a root pass; outside, sibling-prefix and the root itself do not', () => {
  const { root, sibling, outside } = layout()
  const inside = path.join(root, 'project')
  fs.mkdirSync(inside)
  const allowed = resolveWithinRoots([root], inside)
  assert.equal(allowed.ok, true)
  assert.equal(allowed.path, fs.realpathSync.native(inside))
  assert.equal(allowed.created, false)

  for (const candidate of [outside, sibling, root]) {
    const verdict = resolveWithinRoots([root], candidate)
    assert.equal(verdict.ok, false, candidate)
    assert.equal(verdict.reason, 'outside_allowed_roots', candidate)
  }
  const traversal = resolveWithinRoots([root], path.join(root, '..', 'outside'))
  assert.equal(traversal.ok, false)
  assert.equal(traversal.reason, 'outside_allowed_roots')
})

test('missing leaves need explicit creation, and a symlink cannot leave a root', () => {
  const { root, outside } = layout()
  const missing = path.join(root, 'new-project')
  const refused = resolveWithinRoots([root], missing)
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'missing_directory')

  const made = resolveWithinRoots([root], missing, { createDirectory: true })
  assert.equal(made.ok, true)
  assert.equal(made.created, true)
  assert.equal(fs.statSync(missing).isDirectory(), true)

  const deep = path.join(missing, 'a', 'b')
  const noParent = resolveWithinRoots([root], deep, { createDirectory: true })
  assert.equal(noParent.ok, false)
  assert.equal(noParent.reason, 'missing_parent')

  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'dir')
  } catch {
    return // Windows without symlink privilege; the lexical checks above still ran.
  }
  const escaped = resolveWithinRoots([root], path.join(root, 'escape'))
  assert.equal(escaped.ok, false)
  assert.equal(escaped.reason, 'outside_allowed_roots')
})
