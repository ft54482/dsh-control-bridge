/**
 * Durable record of bridge-started Desktop requests.
 *
 * The file is local operator state. It may hold a redacted assistant result.
 * It is not a log, not a release artifact, and it never stores a credential.
 * A failed write leaves memory unchanged. A damaged file fails closed.
 *
 * Persistence is not exactly-once across the official prompt. A record written
 * before prompt() can outlive a crash; restart reconciliation may only bind an
 * official rpcId it can see, otherwise the request stays unknown and is not sent again.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { findTurnForRequest } from './host_read.js'

export class RequestPersistError extends Error {
  constructor(message, code = 'request_persist_failed') {
    super(message)
    this.name = 'RequestPersistError'
    this.code = code
  }
}

export function contentHash({ sessionId, text, model }) {
  const body = JSON.stringify({
    sessionId: String(sessionId || ''),
    text: String(text || ''),
    provider: model && model.provider ? String(model.provider) : '',
    model: model && model.model ? String(model.model) : '',
  })
  return crypto.createHash('sha256').update(body).digest('hex')
}

function emptyState() {
  return { version: 1, requests: {} }
}

export function loadRequestFile(file) {
  if (!file) return { status: 'unconfigured', state: emptyState() }
  if (!fs.existsSync(file)) return { status: 'missing', state: emptyState() }
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { status: 'invalid', detail: 'unreadable' }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.requests || typeof parsed.requests !== 'object' || Array.isArray(parsed.requests)) {
      return { status: 'invalid', detail: 'shape' }
    }
    return { status: 'ok', state: { version: 1, requests: parsed.requests } }
  } catch {
    return { status: 'invalid', detail: 'json' }
  }
}

function writeAtomic(file, state) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function createRequestLedger({ file } = {}) {
  const loaded = loadRequestFile(file)
  if (loaded.status === 'invalid') {
    const error = new RequestPersistError('request record is damaged')
    error.code = 'request_record_damaged'
    throw error
  }
  let state = loaded.state
  let tail = Promise.resolve()

  function serialized(work) {
    const run = tail.then(work, work)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  function commit(next) {
    if (file) writeAtomic(file, next)
    state = next
  }

  function get(requestId) {
    return state.requests[requestId] || null
  }

  return {
    file: file || '',
    get,
    snapshot() {
      return state
    },
    claim(identity) {
      return serialized(() => {
        const current = state.requests[identity.requestId]
        if (current) {
          const same = current.session_id === identity.sessionId && current.content_hash === identity.contentHash
          return { created: false, conflict: !same, record: current }
        }
        const record = {
          request_id: identity.requestId,
          session_id: identity.sessionId,
          workspace_id: identity.workspaceId || '',
          content_hash: identity.contentHash,
          requested_model: identity.requestedModel || null,
          confirmed_selection: identity.confirmedSelection || null,
          explicit_model: Boolean(identity.explicitModel),
          phase: 'recorded',
          crash_window: true,
          prompt_attempted: false,
          manual_reconcile: false,
          accepted: null,
          started_task: false,
          terminal_scope: null,
          response: null,
        }
        const next = { version: 1, requests: { ...state.requests, [identity.requestId]: record } }
        try {
          commit(next)
        } catch (error) {
          throw new RequestPersistError(error.message || 'request record was not saved')
        }
        return { created: true, conflict: false, record }
      })
    },
    update(requestId, patch) {
      return serialized(() => {
        const current = state.requests[requestId]
        if (!current) throw new RequestPersistError('request record is missing', 'unknown_request')
        const record = { ...current, ...patch }
        const next = { version: 1, requests: { ...state.requests, [requestId]: record } }
        try {
          commit(next)
        } catch (error) {
          throw new RequestPersistError(error.message || 'request record was not saved')
        }
        return record
      })
    },
  }
}

/**
 * Whether the open official turn is the one this request id admitted.
 * A later turn, a missing rpcId, or an already finished turn is not cancellable here.
 */
export function classifyOwnedTurn(events, requestId) {
  const turn = findTurnForRequest(events, { requestId, afterSeq: 0 })
  if (!turn || turn.attribution !== 'request_id' || !turn.start) {
    return { owned: false, ended: false, turn, reason: 'turn_not_bound' }
  }
  const later = (Array.isArray(events) ? events : []).some((event) => (
    event && event.type === 'turn/start' && event.seq > turn.start.seq
  ))
  if (later) return { owned: false, ended: Boolean(turn.end), turn, reason: 'not_our_turn' }
  if (turn.end) return { owned: false, ended: true, turn, reason: 'already_terminal' }
  return { owned: true, ended: false, turn, reason: 'owned_open_turn' }
}
