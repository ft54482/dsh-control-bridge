/**
 * Path safety for the write-capable control endpoints.
 *
 * The Host runs with the operator's OS permissions, so a bridge endpoint that
 * accepts a path is at least as dangerous as a shell. Everything here is
 * fail-closed: an unconfigured root list allows nothing, a symlink that leaves
 * a root is refused, and a missing directory is only created when the caller
 * explicitly asked for one leaf under an existing parent.
 */

import fs from 'node:fs'
import path from 'node:path'

function realOrNull(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return null
  }
}

function isInside(rootReal, candidateReal) {
  const relative = path.relative(rootReal, candidateReal)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function normaliseRoots(roots) {
  const out = []
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue
    const real = realOrNull(root)
    if (!real) continue
    try {
      if (!fs.statSync(real).isDirectory()) continue
    } catch {
      continue
    }
    if (!out.includes(real)) out.push(real)
  }
  return out
}

/**
 * Resolve one operator-supplied path against the configured roots.
 *
 * @returns `{ ok: true, path, root, created }` or `{ ok: false, reason, detail }`.
 *   `path` is the canonical (realpath) absolute path when it already exists,
 *   or the canonical parent plus one requested leaf when it is created.
 */
export function resolveWithinRoots(roots, requested, { createDirectory = false } = {}) {
  const allowed = normaliseRoots(roots)
  if (allowed.length === 0) {
    return { ok: false, reason: 'no_allowed_roots', detail: 'this Host has no configured workspace root; nothing can be created or opened' }
  }
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    return { ok: false, reason: 'missing_path' }
  }
  if (requested.includes('\0')) return { ok: false, reason: 'invalid_path' }
  const absolute = path.resolve(requested)
  if (!path.isAbsolute(absolute)) return { ok: false, reason: 'invalid_path' }
  const existing = realOrNull(absolute)
  if (existing) {
    let stat
    try {
      stat = fs.statSync(existing)
    } catch {
      return { ok: false, reason: 'unreadable_path' }
    }
    if (!stat.isDirectory()) return { ok: false, reason: 'not_a_directory' }
    const root = allowed.find((candidate) => isInside(candidate, existing))
    if (!root) return { ok: false, reason: 'outside_allowed_roots' }
    return { ok: true, path: existing, root, created: false }
  }
  if (!createDirectory) {
    return { ok: false, reason: 'missing_directory', detail: 'the directory does not exist and create_directory was not requested' }
  }
  const parent = realOrNull(path.dirname(absolute))
  if (!parent) return { ok: false, reason: 'missing_parent', detail: 'creation is limited to one leaf under an existing directory' }
  const root = allowed.find((candidate) => isInside(candidate, parent) || candidate === parent)
  if (!root) return { ok: false, reason: 'outside_allowed_roots' }
  const leaf = path.basename(absolute)
  if (!leaf || leaf === '.' || leaf === '..') return { ok: false, reason: 'invalid_path' }
  const target = path.join(parent, leaf)
  try {
    fs.mkdirSync(target)
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const again = realOrNull(target)
      if (again) {
        const inside = allowed.find((candidate) => isInside(candidate, again))
        if (inside && fs.statSync(again).isDirectory()) return { ok: true, path: again, root: inside, created: false }
      }
    }
    return { ok: false, reason: 'create_failed', detail: String(error && error.message || error) }
  }
  const created = realOrNull(target)
  if (!created) return { ok: false, reason: 'create_failed' }
  return { ok: true, path: created, root, created: true }
}

/** Whether a path is already inside one of the configured roots (no creation). */
export function isWithinRoots(roots, requested) {
  const resolved = resolveWithinRoots(roots, requested, { createDirectory: false })
  return resolved.ok ? resolved : { ok: false, reason: resolved.reason, detail: resolved.detail }
}

export function hasRoots(roots) {
  return normaliseRoots(roots).length > 0
}
