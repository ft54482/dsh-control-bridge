/**
 * Workspace autonomy: an operator-enabled policy for trusted local agents.
 *
 * Default behaviour is unchanged: without `workspaceAutonomy` this module is
 * never consulted on an old path. When the operator opens it, a caller that
 * carries `task_id` + `purpose` may register or reuse any absolute directory the
 * OS already lets the Host touch, take a task-scoped grant, and create the
 * first write Session in a workspace that has none.
 *
 * Nothing here sends a prompt, cancels a Session, or deletes a directory. The
 * operation journal is a side-channel audit: a failed append never rolls back a
 * grant that is already durable.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const TASK_ID_MAX = 200
export const PURPOSE_MAX = 500
export const CLIENT_REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
export const RECORD_FILE_NAME = 'workspace-autonomy.jsonl'

export const OPS = new Set([
  'workspace_create',
  'workspace_reuse',
  'workspace_grant',
  'workspace_grant_failed',
  'session_create',
  'session_grant',
  'session_grant_failed',
  'workspace_task_confirmed',
  'workspace_revoke',
])

/**
 * Only these operations may bind (or replace) an idempotency key: they are the
 * ones that answer a caller's request. Everything else is evidence — it says
 * something happened, never that the key's own request succeeded.
 */
export const BINDING_OPS = new Set([
  'workspace_create',
  'workspace_reuse',
  'workspace_grant',
  'workspace_grant_failed',
  'session_create',
  'session_grant',
  'session_grant_failed',
])

function text(value) {
  return typeof value === 'string' ? value : ''
}

function realOrNull(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return null
  }
}

/**
 * Validate the task triple every autonomy request must carry.
 * @returns `{ ok: true, task_id, purpose }` or `{ ok: false, reason, detail }`.
 */
export function taskFields(body) {
  const taskId = text(body && body.task_id).trim()
  const purpose = text(body && body.purpose).trim()
  if (!taskId || taskId.length > TASK_ID_MAX) {
    return {
      ok: false,
      reason: 'task_required',
      detail: `task_id is required and must be 1..${TASK_ID_MAX} characters after trimming`,
    }
  }
  if (!purpose || purpose.length > PURPOSE_MAX) {
    return {
      ok: false,
      reason: 'task_required',
      detail: `purpose is required and must be 1..${PURPOSE_MAX} characters after trimming`,
    }
  }
  return { ok: true, task_id: taskId, purpose }
}

/** Whether the request carries any task intent at all (even a blank one). */
export function taskIntent(body) {
  return body !== null && typeof body === 'object'
    && (Object.hasOwn(body, 'task_id') || Object.hasOwn(body, 'purpose'))
}

/** Optional idempotency key: absent means "no replay protection requested". */
export function clientRequestKey(body) {
  if (!body || body.client_request_key === undefined || body.client_request_key === null) {
    return { ok: true, key: '' }
  }
  const key = body.client_request_key
  if (typeof key !== 'string' || !CLIENT_REQUEST_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      reason: 'invalid_client_request_key',
      detail: 'client_request_key must match ^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$',
    }
  }
  return { ok: true, key }
}

/**
 * The part of a request an idempotency key is bound to.
 *
 * One key answers one question: a replay must be the *same* operation with the
 * same arguments. A different operation or a different task/path/preset/access/
 * model under the same key is a client bug, not a replay (`idempotency_key_reused`).
 */
export const FINGERPRINT_FIELDS = [
  'task_id', 'purpose', 'path', 'workspace_id', 'preset', 'access', 'model', 'confirm_task',
]

function pick(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function requestFingerprint(operation, body) {
  const scope = operation === 'session' ? 'session' : 'workspace'
  const model = body && typeof body.model === 'object' && body.model
    ? {
      provider: pick(body.model.provider),
      model: pick(body.model.model),
      reasoning_effort: pick(body.model.reasoning_effort ?? body.model.reasoningEffort),
    }
    : null
  return {
    operation: scope,
    task_id: pick(body && body.task_id),
    purpose: pick(body && body.purpose),
    path: pick(body && body.path),
    // Only a Session create names a workspace, a preset, an access level or a
    // model; those fields are not part of a workspace registration's identity.
    workspace_id: scope === 'session' ? pick(body && body.workspace_id) : null,
    preset: scope === 'session' ? pick(body && body.agent_preset) : null,
    access: scope === 'session' ? (body && body.access === 'write' ? 'write' : 'read') : null,
    model: scope === 'session' && model ? JSON.stringify(model) : null,
    confirm_task: body ? body.confirm_task === true : false,
  }
}

export function fingerprintHash(fingerprint) {
  return crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex')
}

/** Names of the fields that differ between the bound request and this one. */
export function fingerprintDiff(previous, next) {
  if (!previous || typeof previous !== 'object') return [...FINGERPRINT_FIELDS]
  return FINGERPRINT_FIELDS.filter((field) => (previous[field] ?? null) !== (next[field] ?? null))
}

/**
 * Resolve the operator's autonomy configuration into an honest declaration.
 *
 * `effective` is exactly the frozen conjunction: enabled AND an allowlist file
 * is configured AND the three official capabilities the flow depends on are
 * callable. Anything short of that is reported with the first blocking reason;
 * it never silently falls back to the standard mode.
 */
export function resolveAutonomyConfig(config = {}, ctx = {}) {
  const raw = config.workspaceAutonomy
  const configured = raw !== undefined && raw !== null
  const enabled = raw === true || (Boolean(raw) && typeof raw === 'object' && raw.enabled === true)
  const allowlistFile = text(config.allowlistFile)
  const workspaceCreate = typeof ctx.workspaceRegistry?.create === 'function'
  const sessionCreate = typeof ctx.sessionController?.create === 'function'
  const sessionProjections = typeof ctx.sessionController?.projections === 'function'
  let reason = null
  if (!effectiveCheck(enabled, allowlistFile, workspaceCreate, sessionCreate, sessionProjections)) {
    if (!configured) reason = 'not_configured'
    else if (!enabled) reason = 'disabled'
    else if (!allowlistFile) reason = 'allowlist_file_missing'
    else if (!workspaceCreate) reason = 'workspace_create_unavailable'
    else if (!sessionCreate) reason = 'session_create_unavailable'
    else reason = 'session_projections_unavailable'
  }
  const recordFile = text(config.autonomyRecordFile)
    || (allowlistFile ? path.join(path.dirname(allowlistFile), RECORD_FILE_NAME) : '')
  return {
    configured,
    enabled,
    effective: reason === null,
    reason,
    require_task: true,
    roots_mode: enabled ? 'unrestricted' : 'configured_roots',
    grant_store: allowlistFile ? 'file' : 'memory',
    // The journal path is a fact about this Host, not a claim of effect: report
    // it whenever it is known so an operator can find the file that exists.
    record_file: recordFile,
  }
}

function effectiveCheck(enabled, allowlistFile, workspaceCreate, sessionCreate, sessionProjections) {
  return Boolean(enabled && allowlistFile && workspaceCreate && sessionCreate && sessionProjections)
}

/**
 * Canonical absolute directory for an autonomy request.
 *
 * Realpath first: every spelling, symlink or junction of one directory is one
 * workspace. A missing leaf is only created when asked for, and only under an
 * existing parent.
 */
export function resolveAutonomyPath(requested, { createDirectory = false } = {}) {
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    return { ok: false, reason: 'missing_path' }
  }
  const given = requested.trim()
  if (given.includes('\0')) return { ok: false, reason: 'invalid_path' }
  if (!path.isAbsolute(given)) {
    return { ok: false, reason: 'invalid_path', detail: 'an absolute directory path is required' }
  }
  const absolute = path.resolve(given)
  const existing = realOrNull(absolute)
  if (existing) {
    let stat
    try {
      stat = fs.statSync(existing)
    } catch {
      return { ok: false, reason: 'unreadable_path' }
    }
    if (!stat.isDirectory()) return { ok: false, reason: 'not_a_directory' }
    return { ok: true, path: existing, created: false }
  }
  if (!createDirectory) {
    return {
      ok: false,
      reason: 'missing_directory',
      detail: 'the directory does not exist and create_directory was not requested',
    }
  }
  const parent = realOrNull(path.dirname(absolute))
  if (!parent) {
    return { ok: false, reason: 'missing_parent', detail: 'creation is limited to one leaf under an existing directory' }
  }
  const leaf = path.basename(absolute)
  if (!leaf || leaf === '.' || leaf === '..') return { ok: false, reason: 'invalid_path' }
  const target = path.join(parent, leaf)
  try {
    fs.mkdirSync(target)
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const again = realOrNull(target)
      try {
        if (again && fs.statSync(again).isDirectory()) return { ok: true, path: again, created: false }
      } catch { /* fall through to create_failed */ }
    }
    return { ok: false, reason: 'create_failed', detail: String((error && error.message) || error) }
  }
  const created = realOrNull(target)
  if (!created) return { ok: false, reason: 'create_failed' }
  return { ok: true, path: created, created: true }
}

/**
 * Serialize work per key. One canonical directory (or one client request key)
 * is one queue: concurrent callers observe a single create and a single grant.
 */
export function createKeyedLock() {
  const tails = new Map()
  return function withKeyLock(key, work) {
    const previous = tails.get(key) || Promise.resolve()
    const run = previous.then(work, work)
    const tail = run.then(() => undefined, () => undefined)
    tails.set(key, tail)
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}

/**
 * Append-only operation journal.
 *
 * One JSON object per line; never a bearer token. The file is also the replay
 * source: `lookup(key)` answers "did this client request key already succeed,
 * and if it stopped after the Session existed, which Session?". The caller
 * compares the binding's `operation` with its own, so one key can never answer
 * another operation's request. Every line carries 17 fixed keys; the lines that
 * need them add `receipt` or `revoked`.
 *
 * Two classes of line share the file but not the index:
 * - binding lines (BINDING_OPS) answer a caller's request and own the key;
 * - evidence lines (confirmations, revocations) say what happened to an
 *   authorization. They never bind a key and never downgrade a binding.
 */
export function createAutonomyRecord({ file, now = () => new Date() } = {}) {
  const target = text(file)
  let operations = 0
  const byKey = new Map()
  const confirmations = new Map()
  const recent = []
  let readError = ''

  function rememberConfirmation(entry) {
    const key = text(entry.client_request_key) || text(entry.parent_key)
    if (!key) return
    confirmations.set(key, {
      task_id: text(entry.task_id) || null,
      workspace_id: text(entry.workspace_id) || null,
      at: text(entry.at) || null,
    })
  }

  function remember(entry) {
    if (typeof entry.op !== 'string' || !OPS.has(entry.op)) return
    if (recent.length >= 50) recent.shift()
    recent.push(entry)
    if (entry.op === 'workspace_task_confirmed') {
      rememberConfirmation(entry)
      return
    }
    if (!BINDING_OPS.has(entry.op)) return
    const key = text(entry.client_request_key)
    if (!key) return
    const receipt = entry.receipt && typeof entry.receipt === 'object' ? entry.receipt : null
    const next = {
      operation: entry.operation === 'session' ? 'session' : 'workspace',
      request_hash: text(entry.request_hash),
      request: entry.request && typeof entry.request === 'object' ? entry.request : null,
      parent_key: text(entry.parent_key) || null,
      task_id: text(entry.task_id) || null,
      purpose: text(entry.purpose) || null,
      path: text(entry.path) || null,
      session_id: text(entry.session_id) || null,
      workspace_id: text(entry.workspace_id) || null,
      preset: text(entry.preset) || null,
      access: text(entry.access) || null,
      phase: text(entry.phase) || null,
      at: text(entry.at) || null,
      complete: Boolean(receipt) && entry.result === 'ok',
      receipt,
    }
    const existing = byKey.get(key)
    if (existing && existing.complete) {
      // A completed binding is only replaced by a completed binding of the very
      // same request (the repair path). A later failure or evidence line must
      // never make a succeeded key look unfinished — that is what let a
      // revoked workspace be re-granted by replaying its own case.
      if (!next.complete) return
      if (existing.request_hash && next.request_hash && existing.request_hash !== next.request_hash) return
      byKey.set(key, next)
      return
    }
    if (next.complete) {
      byKey.set(key, next)
      return
    }
    // A partial may only update a partial of the same operation.
    if (existing && existing.operation !== next.operation) return
    byKey.set(key, next)
  }

  if (target && fs.existsSync(target)) {
    try {
      const body = fs.readFileSync(target, 'utf8')
      for (const line of body.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        operations += 1
        try {
          remember(JSON.parse(trimmed))
        } catch { /* one damaged line does not hide the others */ }
      }
    } catch (error) {
      readError = `read failed: ${(error && error.code) || 'error'}`
    }
  }

  /** Append one entry. Returns `{ ok, error }`; callers must not fail the grant. */
  function append(entry) {
    if (!target) return { ok: false, error: 'no_record_file' }
    // Every line carries the same key set, so a reader never has to guess
    // whether a missing field means "not applicable" or "not written".
    const full = {
      at: now().toISOString(),
      op: null,
      operation: null,
      workspace_id: null,
      path: null,
      task_id: null,
      purpose: null,
      session_id: null,
      preset: null,
      access: null,
      client_request_key: null,
      parent_key: null,
      request_hash: null,
      request: null,
      phase: null,
      result: null,
      reason: null,
      ...entry,
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.appendFileSync(target, `${JSON.stringify(full)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, error: String((error && error.code) || (error && error.message) || error) }
    }
    operations += 1
    remember(full)
    return { ok: true, entry: full }
  }

  return {
    get file() { return target },
    get operations() { return operations },
    get read_error() { return readError },
    append,
    /** The binding for one idempotency key, whatever operation wrote it. */
    lookup(key) {
      return byKey.get(text(key)) || null
    },
    /** Whether this key carries an explicit task confirmation for that workspace. */
    confirmed(key, taskId, workspaceId) {
      const row = confirmations.get(text(key))
      if (!row) return false
      if (taskId && row.task_id !== taskId) return false
      if (workspaceId && row.workspace_id !== workspaceId) return false
      return true
    },
    entries() {
      return [...recent]
    },
  }
}

/** Health shape declared by the frozen contract (3.2). */
export function autonomyHealth(config, record) {
  return {
    configured: config.configured,
    enabled: config.enabled,
    effective: config.effective,
    reason: config.effective ? null : config.reason,
    require_task: true,
    roots_mode: config.roots_mode,
    grant_store: config.grant_store,
    record_file: config.record_file,
    operations: record ? record.operations : 0,
  }
}
