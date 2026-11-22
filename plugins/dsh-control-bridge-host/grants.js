/**
 * Durable grant state for the Desktop host plugin.
 *
 * One authority for both memory and disk: a mutation is durable before it is
 * visible, and a failed write never widens (or narrows) the in-memory grants.
 * External edits are picked up per request, so a pairing script that rewrites
 * the file does not need a restart.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const ACCESS = new Set(['read', 'write'])

export class GrantPersistError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'GrantPersistError'
    this.code = 'allowlist_persist_failed'
    this.cause = cause
  }
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

function normalizeWorkspace(item) {
  if (!item || typeof item !== 'object') return null
  const id = text(item.id)
  if (!id) return null
  return {
    id,
    cwd: text(item.cwd || item.path),
    title: text(item.title),
  }
}

function normalizeSession(item) {
  if (!item || typeof item !== 'object') return null
  const sessionId = text(item.sessionId || item.session_id)
  if (!sessionId) return null
  return {
    sessionId,
    workspaceId: text(item.workspaceId || item.workspace_id),
    access: ACCESS.has(item.access) ? item.access : 'read',
    cwd: text(item.cwd),
    profile: text(item.profile) || 'desktop',
    model: text(item.model) || null,
    provider: text(item.provider) || null,
    title: text(item.title),
  }
}

export function emptyState() {
  return { version: 1, workspaceAllowlist: [], sessionAllowlist: [] }
}

export function normalizeState(raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return { state, dropped: 0 }
  if (Number.isFinite(raw.version)) state.version = Number(raw.version)
  let dropped = 0
  if (Array.isArray(raw.workspaceAllowlist)) {
    for (const item of raw.workspaceAllowlist) {
      const workspace = normalizeWorkspace(item)
      if (!workspace) { dropped += 1; continue }
      if (state.workspaceAllowlist.some((known) => known.id === workspace.id)) { dropped += 1; continue }
      state.workspaceAllowlist.push(workspace)
    }
  } else if (raw.workspaceAllowlist !== undefined) {
    dropped += 1
  }
  if (Array.isArray(raw.sessionAllowlist)) {
    for (const item of raw.sessionAllowlist) {
      const session = normalizeSession(item)
      if (!session) { dropped += 1; continue }
      if (state.sessionAllowlist.some((known) => known.sessionId === session.sessionId)) { dropped += 1; continue }
      state.sessionAllowlist.push(session)
    }
  } else if (raw.sessionAllowlist !== undefined) {
    dropped += 1
  }
  return { state, dropped }
}

function clone(state) {
  return {
    version: state.version,
    workspaceAllowlist: state.workspaceAllowlist.map((item) => ({ ...item })),
    sessionAllowlist: state.sessionAllowlist.map((item) => ({ ...item })),
  }
}

function stampOf(file) {
  if (!file) return null
  try {
    const stat = fs.statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  }
}

function readFileState(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return normalizeState(raw)
}

/**
 * Classify the allowlist file at startup.
 *
 * A missing file is the first run. A file that exists but cannot be parsed, or
 * whose entries are structurally invalid, is NOT an empty allowlist: treating
 * it as empty would silently drop the grants it holds on the next write.
 * @returns `{ state, status, dropped, detail }` where status is
 *   `unconfigured | missing | ok | unreadable | invalid_entries`.
 */
export function loadAllowlistFile(file) {
  if (!file) return { state: emptyState(), status: 'unconfigured', dropped: 0, detail: '' }
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: emptyState(), status: 'missing', dropped: 0, detail: '' }
    return { state: emptyState(), status: 'unreadable', dropped: 0, detail: `read failed: ${error && error.code ? error.code : 'error'}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: emptyState(), status: 'unreadable', dropped: 0, detail: 'invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: emptyState(), status: 'unreadable', dropped: 0, detail: 'top-level value is not an object' }
  }
  const { state, dropped } = normalizeState(parsed)
  if (dropped > 0) {
    return { state, status: 'invalid_entries', dropped, detail: `${dropped} invalid allowlist entries` }
  }
  return { state, status: 'ok', dropped: 0, detail: '' }
}

function writeAtomic(file, payload) {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true })
  const tmp = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  let handle
  try {
    handle = fs.openSync(tmp, 'wx', 0o600)
    fs.writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    handle = undefined
    fs.renameSync(tmp, file)
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle) } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw new GrantPersistError('the allowlist file could not be written', error)
  }
}

/**
 * Build the single grant authority.
 * @param options.file - allowlist path; when absent every mutation fails loudly.
 * @param options.initial - parsed allowlist read at plugin start.
 * @param options.now - clock injection for tests.
 */
export function createGrantStore({ file, initial, now = () => Date.now() } = {}) {
  let loaded
  if (initial !== undefined) {
    loaded = normalizeState(initial)
  } else if (file) {
    try {
      loaded = readFileState(file)
    } catch {
      loaded = normalizeState(null)
    }
  } else {
    loaded = normalizeState(null)
  }
  let state = loaded.state
  let revision = 1
  let stamp = stampOf(file)
  let warnings = loaded.dropped > 0 ? [`allowlist: dropped ${loaded.dropped} invalid entries`] : []
  let tail = Promise.resolve()

  function snapshot() {
    return {
      ...clone(state),
      revision,
      file: file || '',
      loaded: Boolean(file),
      warnings: [...warnings],
      read_at: now(),
    }
  }

  function refresh() {
    if (!file) return false
    const next = stampOf(file)
    if (next === stamp) return false
    const previous = stamp
    stamp = next
    if (next === null) {
      if (previous === null) return false
      // The file was removed while running. Removing the allowlist is the
      // plainest "revoke everything", so it must take effect immediately.
      state = emptyState()
      revision += 1
      warnings = ['allowlist file was removed; every grant was revoked']
      return true
    }
    try {
      const parsed = readFileState(file)
      state = parsed.state
      revision += 1
      warnings = parsed.dropped > 0 ? [`allowlist: dropped ${parsed.dropped} invalid entries`] : []
      return true
    } catch {
      warnings = ['allowlist file could not be parsed; keeping the grants already loaded']
      return false
    }
  }

  function serialized(work) {
    const run = tail.then(work, work)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  function commit(next) {
    if (!file) {
      const error = new GrantPersistError('no allowlist file is configured, so the change was not saved')
      error.code = 'allowlist_file_missing'
      throw error
    }
    writeAtomic(file, next)
    state = next
    revision += 1
    stamp = stampOf(file)
    warnings = []
  }

  function withState(work) {
    return serialized(() => {
      refresh()
      const draft = clone(state)
      const outcome = work(draft) || {}
      commit(outcome.state || draft)
      return { ...snapshot(), ...(outcome.result || {}) }
    })
  }

  function upsertWorkspace(list, workspace) {
    if (!workspace || !workspace.id) return list
    const entry = normalizeWorkspace(workspace)
    if (!entry) return list
    const index = list.findIndex((item) => item.id === entry.id)
    if (index === -1) return [...list, entry]
    const merged = { ...list[index], ...entry, title: entry.title || list[index].title, cwd: entry.cwd || list[index].cwd }
    return list.map((item, at) => (at === index ? merged : item))
  }

  function upsertSession(list, session) {
    const entry = normalizeSession(session)
    if (!entry) return list
    const index = list.findIndex((item) => item.sessionId === entry.sessionId)
    if (index === -1) return [...list, entry]
    const merged = {
      ...list[index],
      ...entry,
      title: entry.title || list[index].title,
      cwd: entry.cwd || list[index].cwd,
      access: list[index].access === 'write' || entry.access === 'write' ? 'write' : 'read',
    }
    return list.map((item, at) => (at === index ? merged : item))
  }

  return {
    get file() { return file || '' },
    snapshot,
    refresh,
    /** Merge (never replace) workspaces and sessions, then persist. */
    grant({ workspace, workspaceAllowlist, session, sessionAllowlist } = {}) {
      return withState((next) => {
        if (workspace) next.workspaceAllowlist = upsertWorkspace(next.workspaceAllowlist, workspace)
        for (const item of workspaceAllowlist || []) next.workspaceAllowlist = upsertWorkspace(next.workspaceAllowlist, item)
        if (session) next.sessionAllowlist = upsertSession(next.sessionAllowlist, session)
        for (const item of sessionAllowlist || []) next.sessionAllowlist = upsertSession(next.sessionAllowlist, item)
        next.version = 1
        return next
      })
    },
    /** Change one existing grant's access. An unknown session is not created here. */
    setAccess(sessionId, access) {
      return withState((next) => {
        const index = next.sessionAllowlist.findIndex((item) => item.sessionId === sessionId)
        if (index === -1) {
          const error = new Error('session is not allowlisted')
          error.code = 'not_allowlisted'
          throw error
        }
        const wanted = ACCESS.has(access) ? access : 'read'
        next.sessionAllowlist = next.sessionAllowlist.map((item, at) => (at === index ? { ...item, access: wanted } : item))
        return next
      })
    },
    /** Remove one grant. Revocation is the only path that deletes an authorization. */
    revoke(sessionId) {
      return withState((next) => {
        const before = next.sessionAllowlist.length
        next.sessionAllowlist = next.sessionAllowlist.filter((item) => item.sessionId !== sessionId)
        return { state: next, result: { revoked: before !== next.sessionAllowlist.length } }
      })
    },
  }
}
