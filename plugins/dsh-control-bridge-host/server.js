import http from 'node:http'
import { bootstrapSourceFromSecret, createStaticBootstrapSource, hashSecret, matchesSecretHash } from './bootstrap.js'
import { eventsSince, journalStart } from './journal.js'
import { createOutbox } from './outbox.js'
import { hasRoots, resolveWithinRoots } from './paths.js'
import { assembleCatalog, assembleDiscovery, findTurnForRequest, readObservation, readSnapshot, safeError, turnAnswer } from './host_read.js'
import {
  agentIdle, agentSelection, checkSelection, executionModelForTurn, effortSupport, liveAgent,
  modelCatalog, modelStateFromEvents, sameRoute, sameSelection, selectOnAgent, selectionOf,
} from './models.js'
import {
  authorizeSession, authorizeWorkspace, checkAuth, decideResume, loopbackPeer, pageHistory,
  promptBody, redactText, rejectBrowser, selectGrant, terminalKind, visibleSessions, visibleWorkspaces,
} from './policy.js'
import { classifyOwnedTurn, contentHash, createRequestLedger } from './requests.js'

const DEFAULT_RESUME_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_POLL_MAX_INTERVAL_MS = 2_000
const MAX_TEXT_CHARS = 100_000
const MAX_PAIRING_BODY_BYTES = 16 * 1024
const MAX_EVENT_WAIT_MS = 60_000
const MAX_REQUEST_WAIT_MS = 30 * 60_000
const MAX_STREAM_MS = 30 * 60_000
const JOURNAL_TICK_MS = 500
const JOURNAL_HEARTBEAT_MS = 15_000

/**
 * Authorize one loopback request against the live pairing window.
 *
 * The bootstrap window is read again for every request, so re-arming or
 * consuming it never needs a process restart. A consumed secret is matched by
 * its stored hash so a replay is named instead of looking like a random bad
 * bearer; anything unreadable or invalid simply fails closed.
 */
function authScope(header, hostSecret, bootstrap, isSpent) {
  if (hostSecret && checkAuth(header, hostSecret)) return { scope: 'host' }
  const boot = bootstrap.read()
  if (boot.armed && checkAuth(header, boot.secret)) {
    // The durable grant file records the window it spent. That marker still
    // blocks a replay when the bootstrap-file write itself failed, so one
    // window cannot grant twice.
    if (typeof isSpent === 'function' && isSpent(boot.secret)) {
      return { scope: '', reason: 'bootstrap_consumed', bootstrap: boot }
    }
    return { scope: 'bootstrap', secret: boot.secret, bootstrap: boot }
  }
  if (boot.status === 'ok' && boot.consumed && matchesSecretHash(header, boot.consumedSecretHash)) {
    return { scope: '', reason: 'bootstrap_consumed', bootstrap: boot }
  }
  if (boot.status === 'ok' && boot.secret && checkAuth(header, boot.secret)) {
    return { scope: '', reason: boot.reason || 'bootstrap_not_armed', bootstrap: boot }
  }
  return { scope: '', reason: 'unauthorized', bootstrap: boot }
}

function adapterSession(row) {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    cwd: row.cwd,
    profile: row.profile,
    running: Boolean(row.busy),
    agent_available: Boolean(row.agent_available),
    title: row.title,
    model: row.model,
    provider: row.provider,
    model_source: row.model_source,
  }
}

function camelSession(row) {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    cwd: row.cwd,
    profile: row.profile,
    title: row.title,
    title_source: row.title_source,
    running: Boolean(row.busy),
    agent_available: Boolean(row.agent_available),
    model: row.model,
    provider: row.provider,
    model_source: row.model_source,
  }
}

function lastSeqOf(snapshot) {
  let last = 0
  for (const event of (snapshot && snapshot.events) || []) {
    if (Number.isFinite(event.seq) && event.seq > last) last = event.seq
  }
  return last
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
      return
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createHostServer(ctx, config, secret) {
  const hostSecret = typeof secret === 'string' ? secret : String((secret && secret.host) || '')
  // A file-backed source re-reads the window per request; the legacy object
  // form is a static source so existing isolated tests keep their shape.
  const bootstrap = typeof secret === 'string'
    ? createStaticBootstrapSource({})
    : bootstrapSourceFromSecret(secret)
  const grants = config.grants
  const seen = new Map()
  let pairingTail = Promise.resolve()
  const live = new Map()
  const inflight = new Map()
  const waiters = new Map()
  const ledger = config.ledger || createRequestLedger({ file: config.requestsFile || '' })
  const outbox = config.outbox || createOutbox({
    file: config.outboxFile || '',
    webhook: config.webhook,
    logger: (warning) => note(config, [warning]),
  })

  /** Enqueue one durable notification; never let a receiver failure affect the turn. */
  function notify(record) {
    if (!record) return
    try { outbox.enqueue(record) } catch { /* notification is best-effort */ }
  }
  const resumeTimeoutMs = Math.min(
    DEFAULT_RESUME_TIMEOUT_MS,
    Math.max(1_000, Number(config.resumeTimeoutMs) || DEFAULT_RESUME_TIMEOUT_MS),
  )
  const pollIntervalMs = Math.max(50, Number(config.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS)
  const pollMaxIntervalMs = Math.max(pollIntervalMs, Number(config.pollMaxIntervalMs) || DEFAULT_POLL_MAX_INTERVAL_MS)
  const globalDefault = typeof config.globalDefault === 'function' ? config.globalDefault : undefined
  // Write-capable directory/session creation is opt-in twice: a capability flag
  // and an explicit root list. With neither configured, all three endpoints
  // refuse and explain; nothing is guessed from the process cwd.
  const workspaceRoots = Array.isArray(config.workspaceRoots) ? config.workspaceRoots : []
  const createSessionEnabled = config.allowCreateSession === true
  const createWorkspaceEnabled = config.allowCreateWorkspace === true
  const openPathEnabled = config.allowOpenPath === true
  const rootsUnavailable = () => !hasRoots(workspaceRoots)

  function state() {
    if (!grants) throw new Error('grant store is not configured')
    grants.refresh()
    return grants.snapshot()
  }

  /** Pairing attempts are serialized so one armed window can be spent once. */
  function serializedPairing(work) {
    const run = pairingTail.then(work, work)
    pairingTail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Whether the durable grant file already records this window as spent. */
  function spentWindow(secret) {
    try {
      const grantsNow = state()
      return Boolean(grantsNow.spentBootstrapHash) && grantsNow.spentBootstrapHash === hashSecret(secret)
    } catch {
      return false
    }
  }

  /** An in-flight resume belongs to one session: the same id on another is not shared. */
  function waitKey(sessionId, requestId) {
    return `${sessionId}\u0000${requestId}`
  }

  /** Authorize one stored request by its own record. */
  async function authorizeRequestById(requestId, need = 'read') {
    const record = ledger.get(requestId)
    if (!record) return { ok: false, status: 404, reason: 'unknown_request' }
    const grantsNow = state()
    const found = await findSessionRow(record.session_id)
    if (found.status === 'read_failed') return { ok: false, status: 502, reason: 'session_list_read_failed' }
    if (found.status !== 'ok') return { ok: false, status: 404, reason: 'missing_session' }
    const view = adapterSession(found.row)
    const auth = authorizeSession(grantsNow, view, { workspaceId: record.workspace_id || view.workspaceId, need })
    if (!auth.ok) return { ok: false, status: 403, reason: auth.reason }
    return { ok: true, record, view, auth }
  }

  /**
   * Reconcile one stored request from the official log, read-only.
   *
   * This is what lets a coordinator learn about a finished long task after the
   * original synchronous wait ended, and after the Host itself restarted: the
   * durable request holds the rpcId, the official log holds the turn. A turn
   * that is not bound, is ambiguous, or is not finished leaves the record
   * unchanged; nothing is ever resent here.
   */
  async function advanceRequest(requestId) {
    const record = ledger.get(requestId)
    if (!record) return null
    if (record.phase === 'terminal') return record
    if (record.phase === 'unknown') return record
    if (record.prompt_attempted !== true) return record
    let snap
    try {
      snap = await readSnapshot(ctx.sessionQuery, record.session_id)
    } catch {
      return record
    }
    const turn = findTurnForRequest(snap.events, { requestId, afterSeq: Number(record.last_seq) || 0 })
    if (!turn || turn.attribution === 'ambiguous') return record
    if (turn.end) {
      const built = describeTurn(record.session_id, requestId, record, snap, turn)
      try {
        const updated = await ledger.append(requestId, 'terminal', {
          terminal: built.terminal,
          completed: built.completed,
          source: 'log_reconcile',
        }, {
          phase: 'terminal',
          terminal_scope: 'official',
          crash_window: false,
          manual_reconcile: false,
          accepted: true,
          started_task: true,
          response: built,
          http_status: 200,
          last_seq: lastSeqOf(snap),
        })
        notify(updated)
        return updated
      } catch {
        return record
      }
    }
    // The official state service is the only honest "waiting for input" source.
    // Query it only while a turn is open and this request has not been marked
    // yet; a missing state service is not a reason to invent the status.
    if (record.phase === 'accepted' && record.needs_input_notified !== true
      && ctx.sessionController && typeof ctx.sessionController.state === 'function') {
      try {
        const pending = await ctx.sessionController.state(
          { sessionId: record.session_id },
          new AbortController().signal,
        )
        const list = pending && Array.isArray(pending.pendingInput) ? pending.pendingInput : []
        if (list.length > 0) {
          const updated = await ledger.append(requestId, 'needs_input', {
            pending: list.slice(0, 3).map(String),
          }, { needs_input_notified: true })
          notify(updated)
          return updated
        }
      } catch { /* state is advisory; never block the reconcile loop */ }
    }
    // The cursor must stay before this request's rpcId marker. Advancing it to
    // the turn boundary hides the marker from the next reconcile pass when the
    // prompt's user/message was written before its own turn/start.
    if (record.phase === 'accepted') return record
    try {
      return await ledger.append(requestId, 'running', { turn: turn.number }, {
        phase: 'accepted',
        accepted: true,
        started_task: true,
      })
    } catch {
      return record
    }
  }

  /** Compact frame shared by the events endpoint and SSE. */
  function requestFrame(record, extra = {}) {
    return {
      request_id: record.request_id,
      session_id: record.session_id,
      phase: record.phase,
      accepted: record.accepted === true ? true : (record.accepted === false ? false : null),
      started_task: record.started_task === true,
      completed: record.phase === 'terminal' ? Boolean(record.response && record.response.completed) : false,
      terminal: record.phase === 'terminal' && record.response ? record.response.terminal : null,
      seq: Number(record.event_seq) || 0,
      ...extra,
    }
  }

  /** Normalize the two official workspace shapes (entity or `{ workspace }`). */
  function workspaceView(value) {
    const workspace = value && value.workspace ? value.workspace : value
    if (!workspace || typeof workspace !== 'object') return null
    const id = String(workspace.id || '')
    if (!id) return null
    return {
      id,
      path: String(workspace.path || ''),
      title: redactText(workspace.title || ''),
      sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
    }
  }

  /** Map the official ApiError code to an HTTP status; unknown codes are a 502. */
  function sendOfficialError(res, error, method) {
    const detail = safeError(error, method)
    const code = (error && error.code) || 'call_failed'
    let status = 502
    if (code === 'gateway/bad-request' || code === 'gateway/arguments-invalid') status = 400
    else if (code === 'workspace/invalid-path' || code === 'workspace/move-invalid') status = 400
    else if (/session\/invalid|session\/bad/.test(code)) status = 400
    else if (code === 'workspace/not-found' || code === 'session/not-found') status = 404
    else if (code === 'workspace/session-active' || code === 'session/conflict' || code === 'agent-preset/conflict') status = 409
    else if (code === 'workspace/name-conflict') status = 409
    else if (code === 'gateway/cancelled') status = 409
    return send(res, status, { ok: false, reason: code, started_task: false, detail })
  }

  function bodyOfRequest(record) {    if (record.phase === 'terminal' && record.response) return { status: record.http_status || 200, body: record.response }
    if (record.phase === 'unknown') {
      return {
        status: 409,
        body: {
          accepted: record.accepted === true ? true : null,
          completed: false,
          reason: 'manual_reconcile',
          phase: 'unknown',
          session_id: record.session_id,
          request_id: record.request_id,
          started_task: record.prompt_attempted === true,
          exactly_once: false,
          resend: false,
          detail: 'the bridge cannot prove whether the official prompt was admitted; it will not send the prompt again',
        },
      }
    }
    return {
      status: 200,
      body: {
        accepted: record.accepted === true ? true : null,
        completed: false,
        phase: record.phase,
        terminal: null,
        session_id: record.session_id,
        request_id: record.request_id,
        started_task: record.started_task === true,
        exactly_once: false,
        requested_model: record.requested_model || null,
        confirmed_selection: record.confirmed_selection || null,
        note: 'the bridge wait and the Desktop task are separate; this read does not send or cancel anything',
      },
    }
  }

  async function recoverStored(sessionId, requestId, record) {
    if (record && record.response && record.phase === 'terminal') {
      return { status: record.http_status || 200, body: record.response }
    }
    let snap
    try {
      snap = await readSnapshot(ctx.sessionQuery, sessionId)
    } catch (error) {
      return {
        status: 502,
        body: {
          accepted: record.accepted === true,
          completed: false,
          reason: 'session_read_failed',
          session_id: sessionId,
          request_id: requestId,
          started_task: record.started_task === true,
          exactly_once: false,
          detail: safeError(error, 'sessionQuery.readSession'),
        },
      }
    }
    const owned = classifyOwnedTurn(snap.events, requestId)
    if (owned.turn && owned.turn.attribution === 'request_id' && owned.ended) {
      const built = describeTurn(sessionId, requestId, record, snap, owned.turn)
      try {
        await ledger.append(requestId, 'terminal', {
          terminal: built.terminal,
          completed: built.completed,
          source: 'stored_reconcile',
        }, {
          phase: 'terminal',
          crash_window: false,
          manual_reconcile: false,
          accepted: true,
          started_task: true,
          terminal_scope: 'official',
          response: built,
          http_status: 200,
        })
        notify(ledger.get(requestId))
      } catch {
        return { status: 500, body: { ...built, completed: false, reason: 'request_persist_failed', exactly_once: false } }
      }
      return { status: 200, body: built }
    }
    // A bridge-wait timeout is a stored answer even though the Desktop turn is
    // still running: replay it instead of reporting a fresh accepted state.
    if (record.terminal_scope === 'bridge_wait' && record.response) {
      return { status: 200, body: record.response }
    }
    // An admitted prompt whose turn has not started yet is normal queueing, not
    // a crash window: reading it must not write `unknown` and strand the
    // record. Only a prompt that was never acknowledged is unreconciled.
    if (record.phase === 'accepted') {
      return {
        status: 200,
        body: {
          accepted: true,
          completed: false,
          phase: owned.owned ? 'running' : 'accepted',
          terminal: null,
          session_id: sessionId,
          request_id: requestId,
          started_task: true,
          exactly_once: false,
          requested_model: record.requested_model,
          confirmed_selection: record.confirmed_selection,
          note: 'the prompt was accepted; this read does not send it again',
        },
      }
    }
    if (record.terminal_scope === 'bridge_wait' && record.response) {
      return { status: 200, body: record.response }
    }
    if (record.phase === 'accepted' || record.prompt_attempted !== true) {      return {
        status: 200,
        body: {
          accepted: record.accepted === true ? true : null,
          completed: false,
          phase: record.phase,
          terminal: null,
          session_id: sessionId,
          request_id: requestId,
          started_task: record.started_task === true,
          exactly_once: false,
          note: 'no durable proof of a turn yet; nothing was sent again',
        },
      }
    }
    try {
      await ledger.append(requestId, 'unknown', { reason: 'manual_reconcile' }, {
        phase: 'unknown', manual_reconcile: true, crash_window: true,
      })
      notify(ledger.get(requestId))
    } catch {
      return {
        status: 500,
        body: { accepted: null, completed: false, reason: 'request_persist_failed', session_id: sessionId, request_id: requestId, started_task: false, exactly_once: false },
      }
    }
    return {
      status: 409,
      body: {
        accepted: record.accepted,
        completed: false,
        reason: 'manual_reconcile',
        session_id: sessionId,
        request_id: requestId,
        phase: 'unknown',
        started_task: record.prompt_attempted === true,
        exactly_once: false,
        resend: false,
        detail: 'the bridge cannot prove whether the official prompt was admitted; it will not send the prompt again',
      },
    }
  }

  /**
   * Compare the execution header with the confirmed selection. Route and
   * reasoning effort are separate answers: an effort missing from the header is
   * `unknown`, never silently equal. `model_match` is true only when both are
   * known and equal, false when either known part differs, and null when the
   * comparison cannot be made.
   */
  function selectionMatch(execution, confirmed) {
    if (!execution || !confirmed) {
      return { route_match: null, effort_match: null, effort_verified: false, model_match: null, mismatch: null }
    }
    const routeMatch = sameRoute(execution, confirmed)
    const executionEffort = execution.reasoningEffort
    const confirmedEffort = confirmed.reasoningEffort
    let effortMatch
    let effortVerified = true
    if (executionEffort === undefined && confirmedEffort === undefined) {
      // Both sides let the adapter choose: equal by absence, but the concrete
      // effort is not named, so it is not "verified" as a specific value.
      effortMatch = true
    } else if (executionEffort === undefined || confirmedEffort === undefined) {
      // One side names an effort and the other follows the adapter default.
      // That is not evidence of a mismatch: the adapter may have resolved the
      // default to exactly that value. Do not rewrite a completed turn.
      effortMatch = null
      effortVerified = false
    } else {
      effortMatch = executionEffort === confirmedEffort
    }
    const modelMatch = routeMatch === false
      ? false
      : (effortMatch === false ? false : (effortMatch === true ? true : null))
    return {
      route_match: routeMatch,
      effort_match: effortMatch,
      effort_verified: effortVerified,
      model_match: modelMatch,
      mismatch: modelMatch === false ? (routeMatch === false ? 'route' : 'reasoning_effort') : null,
    }
  }

  function describeTurn(sessionId, requestId, record, snap, turn) {
    const answer = turnAnswer(snap.events, turn)
    const execution = executionModelForTurn(snap.events, turn)
    const confirmedSelection = record.confirmed_selection
    const match = selectionMatch(execution, confirmedSelection)
    let terminal = terminalKind(answer.reason)
    let finalReason = answer.reason || { kind: terminal }
    if (match.model_match === false) {
      terminal = 'model_mismatch'
      finalReason = { kind: 'model_mismatch', mismatch: match.mismatch, requested: confirmedSelection, execution }
    }
    return {
      accepted: true,
      completed: terminal === 'completed',
      phase: 'terminal',
      terminal_scope: 'official',
      session_id: sessionId,
      request_id: requestId,
      model_selection: record.explicit_model ? 'session_selected_by_bridge' : 'session_recorded_not_overridden',
      requested_model: record.requested_model,
      confirmed_selection: confirmedSelection,
      execution_model: execution,
      execution_model_source: execution ? 'request_header' : 'unknown',
      route_match: match.route_match,
      effort_match: match.effort_match,
      effort_verified: match.effort_verified,
      effort_unverified: record.effort_unverified === true,
      model_match: match.model_match,
      model_mismatch: match.mismatch,
      text: redactText(answer.texts.join('\n\n')),
      final: { reason: finalReason },
      terminal,
      turn: turn.number,
      attribution: turn.attribution,
      started_task: true,
      exactly_once: false,
    }
  }

  /** The deployment default, reported separately and never as a Session model. */
  function defaultSelection() {
    try {
      return selectionOf(globalDefault ? globalDefault() : null)
    } catch {
      return null
    }
  }

  /** Read one Session's model state from its log; the cached projection is the fallback. */
  async function modelStateOf(sessionId, row) {
    const fromRow = () => {
      const selection = row && row.model && row.provider
        ? selectionOf({ provider: row.provider, model: row.model, reasoningEffort: row.reasoning_effort })
        : null
      return selection
        ? { lastUsed: selection, pending: null, next: selection, lastExecution: null, last_header_seq: -1, source: 'session_projection' }
        : { lastUsed: null, pending: null, next: null, lastExecution: null, last_header_seq: -1, source: 'unknown' }
    }
    try {
      const snapshot = await readSnapshot(ctx.sessionQuery, sessionId)
      const fromEvents = modelStateFromEvents(snapshot.events)
      if (fromEvents.lastUsed || fromEvents.pending) return { ...fromEvents, source: 'session_log' }
      return fromRow()
    } catch (error) {
      const fallback = fromRow()
      if (fallback.next) return fallback
      return {
        ...fallback,
        detail: safeError(error, 'sessionQuery.readSession'),
      }
    }
  }

  async function loadCatalog() {
    return assembleCatalog(ctx)
  }

  async function findSessionRow(sessionId) {
    const loaded = await loadCatalog()
    if (loaded.catalog.session_status === 'read_failed') {
      return { status: 'read_failed', loaded, row: null }
    }
    const row = (loaded.catalog.sessions || []).find((item) => item.session_id === sessionId) || null
    return { status: row ? 'ok' : 'missing', loaded, row }
  }

  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress || ''
    if (!loopbackPeer(remote)) return send(res, 401, { ok: false, reason: 'unauthorized' })
    const browser = rejectBrowser(req.headers)
    if (browser) return send(res, 403, { ok: false, reason: browser })
    const auth = authScope(req.headers.authorization, hostSecret, bootstrap, spentWindow)
    if (!auth.scope) {
      const status = auth.reason === 'unauthorized' ? 401 : 403
      return send(res, status, { ok: false, reason: auth.reason || 'unauthorized' })
    }
    const scope = auth.scope
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    try {
      if (url.pathname.startsWith('/v1/bootstrap/')) {
        if (scope !== 'bootstrap') return send(res, 403, { ok: false, reason: 'bootstrap_required' })
        if (req.method === 'GET' && url.pathname === '/v1/bootstrap/catalog') {
          const loaded = await loadCatalog()
          note(config, loaded.warnings)
          return send(res, 200, loaded.catalog)
        }
        if (req.method === 'POST' && url.pathname === '/v1/bootstrap/select') {
          // Read the body before taking the pairing lock: a client that never
          // finishes its body must not block every later pairing attempt.
          let body
          try {
            body = await readJsonLimited(req, MAX_PAIRING_BODY_BYTES)
          } catch (error) {
            const tooLarge = error && error.code === 'body_too_large'
            return send(res, tooLarge ? 413 : 400, {
              ok: false,
              saved: false,
              started_task: false,
              reason: tooLarge ? 'body_too_large' : 'invalid_json',
            })
          }
          return await serializedPairing(async () => {
            // Re-check under the pairing lock: a concurrent select may have
            // spent this window, and a re-arm may have replaced it.
            const usedSecret = auth.secret
            const current = bootstrap.read()
            if (!current.armed || current.secret !== usedSecret) {
              const status = current.status === 'invalid' ? 401 : 403
              return send(res, status, {
                ok: false,
                saved: false,
                started_task: false,
                reason: current.reason || 'bootstrap_not_armed',
              })
            }
            // The durable grant file records the spent window; it still blocks
            // a replay when the bootstrap-file write failed after the grant.
            if (spentWindow(usedSecret)) {
              return send(res, 403, { ok: false, saved: false, started_task: false, reason: 'bootstrap_consumed' })
            }
            const loaded = await loadCatalog()
            if (loaded.catalog.session_status === 'read_failed') {
              return send(res, 409, { ok: false, reason: 'read_failed', started_task: false, warnings: loaded.warnings })
            }
            const chosen = selectGrant(loaded.catalog, { session_id: body.session_id, access: body.access })
            if (!chosen.ok) return send(res, 409, chosen)
            const spentBootstrapHash = hashSecret(usedSecret)
            let after
            try {
              // The spent-window marker is written in the same atomic file as
              // the grant, so a later bootstrap-file write failure cannot turn
              // one window into two grants.
              after = await grants.grant({
                workspace: chosen.workspace,
                session: chosen.session,
                spentBootstrapHash,
              })
            } catch (error) {
              const detail = safeError(error, 'grants.save')
              note(config, [detail])
              // A failed grant write must leave the window armed so pairing can
              // be retried, and must not change the in-memory grants.
              return send(res, 500, {
                ok: false,
                reason: error && error.code ? error.code : 'allowlist_persist_failed',
                saved: false,
                started_task: false,
                bootstrap_consumed: false,
                detail,
              })
            }
            // The pairing window is only retired after the grant is durable.
            // consume() compares the secret that authenticated this request, so
            // a window re-armed in the meantime stays armed.
            const retired = bootstrap.consume(usedSecret)
            if (!retired.consumed) note(config, [{ method: 'bootstrap.consume', error: 'BootstrapConsume', code: retired.reason }])
            return send(res, 200, {
              ok: true,
              started_task: false,
              model_changed: false,
              granted: {
                session_id: chosen.session.sessionId,
                workspace_id: chosen.session.workspaceId,
                access: chosen.session.access,
                title: chosen.session.title,
                cwd: chosen.session.cwd,
              },
              bootstrap_consumed: retired.consumed,
              bootstrap_retired: true,
              bootstrap_rearm_detected: !retired.consumed && retired.reason === 'bootstrap_changed',
              bootstrap_consume_reason: retired.reason,
              allowlist: {
                version: after.version,
                workspaceAllowlist: after.workspaceAllowlist,
                sessionAllowlist: after.sessionAllowlist,
              },
              revision: after.revision,
            })
          })
        }
        return send(res, 404, { ok: false, reason: 'not_found' })
      }
      if (scope !== 'host') return send(res, 403, { ok: false, reason: 'host_secret_required' })

      if (req.method === 'GET' && url.pathname === '/v1/health') {
        const grantsNow = state()
        const boot = bootstrap.read()
        return send(res, 200, {
          ok: true,
          listening: '127.0.0.1',
          outbound: outbox.enabled,
          outbox_enabled: outbox.enabled,
          outbox_event_types: outbox.eventTypes,
          outbox_pending: outbox.snapshot().filter((event) => event.status === 'pending').length,
          outbox_failed: outbox.snapshot().filter((event) => event.status === 'failed').length,
          desktop_verified: false,
          services: Boolean(ctx.sessionController && ctx.workspaceRegistry && ctx.sessionQuery),
          model_services: Boolean(ctx.agents && ctx.llm),
          allowlist_loaded: grantsNow.loaded,
          grants_revision: grantsNow.revision,
          grants_count: grantsNow.workspaceAllowlist.length + grantsNow.sessionAllowlist.length,
          allowlist_warnings: grantsNow.warnings,
          bootstrap_status: boot.status,
          bootstrap_armed: boot.armed,
          bootstrap_consumed: boot.consumed,
          bootstrap_retired: spentWindow(boot.secret || ''),
          bootstrap_expires_at: boot.expiresAt || null,
          resume_timeout_ms: resumeTimeoutMs,
        })
      }
      if (req.method === 'GET' && url.pathname === '/v1/outbox') {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50))
        const all = outbox.snapshot()
        return send(res, 200, {
          ok: true,
          enabled: outbox.enabled,
          event_types: outbox.eventTypes,
          total: all.length,
          pending: all.filter((event) => event.status === 'pending').length,
          failed: all.filter((event) => event.status === 'failed').length,
          delivered: all.filter((event) => event.status === 'delivered').length,
          items: all.slice(-limit),
          note: 'status metadata only: payload bodies, receiver URL and signing secret are not exposed',
        })
      }
      if (req.method === 'GET' && url.pathname === '/v1/guard/membership') {        const loaded = await loadCatalog()
        note(config, loaded.warnings)
        return send(res, 200, loaded.membership)
      }

      if (req.method === 'GET' && url.pathname === '/v1/discover') {
        const discovery = await assembleDiscovery(ctx, {
          workspace_id: url.searchParams.get('workspace_id') || '',
          kind: url.searchParams.get('kind') || '',
          status: url.searchParams.get('status') || '',
          offset: url.searchParams.get('offset') || '',
          limit: url.searchParams.get('limit') || '',
        })
        note(config, discovery.warnings)
        return send(res, discovery.ok ? 200 : 502, discovery)
      }
      if (req.method === 'POST' && url.pathname === '/v1/workspaces') {
        if (!createWorkspaceEnabled) {
          return send(res, 403, {
            ok: false,
            reason: 'create_workspace_disabled',
            detail: 'set allowCreateWorkspace: true and workspaceRoots in the plugin config to enable it',
          })
        }
        if (!ctx.workspaceRegistry || typeof ctx.workspaceRegistry.create !== 'function') {
          return send(res, 501, { ok: false, reason: 'workspace_create_unavailable', detail: 'the official workspaceRegistry.create is not mounted' })
        }
        if (rootsUnavailable()) return send(res, 403, { ok: false, reason: 'no_allowed_roots' })
        const body = await readJson(req)
        const resolved = resolveWithinRoots(workspaceRoots, body.path, { createDirectory: body.create_directory === true })
        if (!resolved.ok) {
          return send(res, 400, { ok: false, reason: resolved.reason, detail: resolved.detail || null, path: null })
        }
        let existing = null
        try {
          if (typeof ctx.workspaceRegistry.resolveByPath === 'function') {
            existing = await ctx.workspaceRegistry.resolveByPath(resolved.path)
          }
        } catch { /* resolveByPath is optional */ }
        try {
          const value = await ctx.workspaceRegistry.create(resolved.path, typeof body.title === 'string' ? body.title : undefined)
          const workspace = workspaceView(value)
          return send(res, 200, {
            ok: true,
            workspace_id: workspace ? workspace.id : '',
            workspace,
            path: resolved.path,
            created: !existing,
            created_directory: resolved.created,
            note: 'workspace registration only; no session was created and no file was written inside it',
          })
        } catch (error) {
          return sendOfficialError(res, error, 'workspaceRegistry.create')
        }
      }
      if (req.method === 'POST' && url.pathname === '/v1/sessions') {
        if (!createSessionEnabled) {
          return send(res, 403, {
            ok: false,
            reason: 'create_session_disabled',
            detail: 'set allowCreateSession: true and workspaceRoots in the plugin config to enable it',
          })
        }
        if (!ctx.sessionController || typeof ctx.sessionController.create !== 'function') {
          return send(res, 501, { ok: false, reason: 'session_create_unavailable', detail: 'the official sessionController.create is not mounted' })
        }
        if (rootsUnavailable()) return send(res, 403, { ok: false, reason: 'no_allowed_roots' })
        const body = await readJson(req)
        let workspaceId = typeof body.workspace_id === 'string' ? body.workspace_id : ''
        let workspace = null
        if (workspaceId) {
          const registry = ctx.workspaceRegistry
          let found = null
          try {
            if (registry && typeof registry.get === 'function') found = registry.get(workspaceId)
            if (!found && registry && typeof registry.list === 'function') {
              found = (registry.list() || []).find((item) => String(item.id) === workspaceId) || null
            }
          } catch { found = null }
          if (!found) return send(res, 404, { ok: false, reason: 'workspace_not_found', workspace_id: workspaceId })
          workspace = workspaceView(found)
          const resolved = resolveWithinRoots(workspaceRoots, String(found.path || ''), { createDirectory: false })
          if (!resolved.ok) {
            return send(res, 403, {
              ok: false,
              reason: resolved.reason,
              detail: 'the workspace directory is outside the configured workspaceRoots',
            })
          }
        } else {
          if (body.create_workspace !== true) {
            return send(res, 400, {
              ok: false,
              reason: 'workspace_required',
              detail: 'pass workspace_id, or path plus create_workspace:true; an unbound cwd Session is not supported here',
            })
          }
          if (!createWorkspaceEnabled) {
            return send(res, 403, { ok: false, reason: 'create_workspace_disabled' })
          }
          if (!ctx.workspaceRegistry || typeof ctx.workspaceRegistry.create !== 'function') {
            return send(res, 501, { ok: false, reason: 'workspace_create_unavailable' })
          }
          const resolved = resolveWithinRoots(workspaceRoots, body.path, { createDirectory: body.create_directory === true })
          if (!resolved.ok) {
            return send(res, 400, { ok: false, reason: resolved.reason, detail: resolved.detail || null })
          }
          try {
            workspace = workspaceView(await ctx.workspaceRegistry.create(resolved.path, typeof body.title === 'string' ? body.title : undefined))
          } catch (error) {
            return sendOfficialError(res, error, 'workspaceRegistry.create')
          }
          workspaceId = workspace ? workspace.id : ''
        }
        if (!workspaceId || !workspace) {
          return send(res, 502, { ok: false, reason: 'workspace_unresolved' })
        }
        // Validate the requested model before create(): a rejected effort must
        // not leave behind a created Session and a persisted write grant.
        let plannedSelection = null
        let plannedEffortUnverified = false
        if (body.model && typeof body.model === 'object') {
          plannedSelection = selectionOf({
            provider: body.model.provider,
            model: body.model.model,
            reasoningEffort: body.model.reasoning_effort ?? body.model.reasoningEffort,
          })
          if (!plannedSelection) return send(res, 400, { ok: false, reason: 'invalid_requested_model' })
          if (plannedSelection.reasoningEffort === 'auto') {
            return send(res, 400, {
              ok: false,
              reason: 'auto_not_an_effort',
              detail: 'omit reasoning_effort to follow the adapter default; "auto" is not an official value',
            })
          }
          const support = await effortSupport(ctx, plannedSelection)
          if (support.known && plannedSelection.reasoningEffort && !support.efforts.includes(plannedSelection.reasoningEffort)) {
            return send(res, 409, {
              ok: false,
              reason: 'unsupported_reasoning_effort',
              supported_reasoning_efforts: support.efforts,
            })
          }
          plannedEffortUnverified = Boolean(plannedSelection.reasoningEffort && !support.known)
        }
        const createRequest = { workspaceId }
        if (typeof body.agent_preset === 'string' && body.agent_preset) createRequest.agentPreset = body.agent_preset
        if (typeof body.session_id === 'string' && body.session_id) createRequest.sessionId = body.session_id
        let created
        try {
          created = await ctx.sessionController.create(createRequest)
        } catch (error) {
          return sendOfficialError(res, error, 'sessionController.create')
        }
        const sessionId = String((created && created.sessionId) || createRequest.sessionId || '')
        if (!sessionId) return send(res, 502, { ok: false, reason: 'create_returned_no_session_id' })
        const access = body.access === 'write' ? 'write' : 'read'
        const sessionGrant = {
          sessionId,
          workspaceId,
          access,
          cwd: workspace.path || '',
          profile: typeof body.profile === 'string' && body.profile ? body.profile : 'desktop',
          title: typeof body.title === 'string' ? body.title : '',
        }
        let after
        try {
          after = await grants.grant({
            workspace: { id: workspace.id, cwd: workspace.path || '', title: workspace.title || '' },
            session: sessionGrant,
          })
        } catch (error) {
          const detail = safeError(error, 'grants.save')
          note(config, [detail])
          return send(res, 500, {
            ok: false,
            reason: 'grant_persist_failed',
            session_id: sessionId,
            workspace_id: workspaceId,
            saved: false,
            detail,
            note: 'the Session exists but is not granted; fix the allowlist and grant it explicitly',
          })
        }
        // A new Session has no recorded model selection. The bridge never
        // substitutes the deployment default; an explicit model is selected
        // only when the live Agent already exists and is idle.
        let modelInfo = {
          selection: null,
          source: 'deferred',
          note: 'a new Session has no recorded selection; pass model on the first resume or set it with POST /v1/model',
        }
        if (plannedSelection) {
          const agent = liveAgent(ctx, sessionId)
          if (agent && agentIdle(agent)) {
            const selected = selectOnAgent(agent, plannedSelection)
            modelInfo = selected.ok
              ? { selection: selected.confirmed, source: 'session_selected_by_bridge', effort_unverified: plannedEffortUnverified }
              : { selection: null, source: 'deferred', reason: selected.reason }
          } else {
            modelInfo = { selection: null, source: 'deferred', reason: agent ? 'busy' : 'needs_ui' }
          }
        }
        return send(res, 200, {
          ok: true,
          session_id: sessionId,
          workspace_id: workspaceId,
          path: workspace.path || '',
          access,
          grant: {
            session_id: sessionId,
            workspace_id: workspaceId,
            access,
            cwd: workspace.path || '',
          },
          model: modelInfo,
          revision: after.revision,
          started_task: false,
          note: 'the Session is created and granted; no prompt was sent and the deployment default model was not changed',
        })
      }
      if (req.method === 'POST' && url.pathname === '/v1/open') {
        if (!openPathEnabled) {
          return send(res, 403, {
            ok: false,
            reason: 'open_path_disabled',
            detail: 'set allowOpenPath: true and workspaceRoots in the plugin config to enable it',
          })
        }
        if (!ctx.sessionController || typeof ctx.sessionController.openWorkspacePath !== 'function') {
          return send(res, 501, { ok: false, reason: 'open_path_unavailable', detail: 'the official openWorkspacePath is not mounted' })
        }
        if (rootsUnavailable()) return send(res, 403, { ok: false, reason: 'no_allowed_roots' })
        if (typeof ctx.sessionController.canOpenWorkspacePath === 'function') {
          let possible = false
          try { possible = ctx.sessionController.canOpenWorkspacePath() === true } catch { possible = false }
          if (!possible) {
            return send(res, 501, { ok: false, reason: 'open_path_unavailable', detail: 'this Host cannot open paths from the bridge process' })
          }
        }
        const body = await readJson(req)
        const resolved = resolveWithinRoots(workspaceRoots, body.path, { createDirectory: false })
        if (!resolved.ok) return send(res, 400, { ok: false, reason: resolved.reason, detail: resolved.detail || null })
        const request = { path: resolved.path }
        if (body.action === 'reveal') request.action = 'reveal'
        if (typeof body.application === 'string' && body.application) request.application = body.application
        const controller = new AbortController()
        try {
          const value = await ctx.sessionController.openWorkspacePath(request, controller.signal)
          return send(res, 200, {
            ok: true,
            opened: Boolean(value && value.opened),
            path: resolved.path,
            action: request.action || 'open',
            note: 'this opens the path on the Host desktop; it does not create or modify anything',
          })
        } catch (error) {
          return sendOfficialError(res, error, 'sessionController.openWorkspacePath')
        }
      }
      if (req.method === 'GET' && url.pathname === '/v1/granted') {
        const grantsNow = state()
        const loaded = await loadCatalog()
        const catalogOk = loaded.catalog.session_status !== 'read_failed'
        const byId = new Map(catalogOk
          ? (loaded.catalog.sessions || []).map((item) => [item.session_id, item])
          : [])
        const sessions = []
        for (const item of grantsNow.sessionAllowlist || []) {
          const row = byId.get(item.sessionId)
          // The grant record is never evidence of the Session's model. The log
          // is, and when it says nothing the answer is unknown.
          const models = row
            ? await modelStateOf(item.sessionId, row)
            : { lastUsed: null, pending: null, next: null, lastExecution: null, source: 'unknown' }
          sessions.push({
            session_id: item.sessionId,
            workspace_id: item.workspaceId,
            title: (row && row.title) || item.title || '',
            title_source: (row && row.title_source) || (item.title ? 'projection' : 'missing'),
            cwd: (row && row.cwd) || item.cwd || '',
            access: item.access,
            profile: (row && row.profile) || item.profile || 'unknown',
            // `model`/`provider` keep the compatibility meaning "next turn".
            model: models.next ? models.next.model : null,
            provider: models.next ? models.next.provider : null,
            model_source: models.next ? models.source : 'unknown',
            model_last_used: models.lastUsed,
            model_pending: models.pending,
            model_next: models.next,
            model_last_execution: models.lastExecution,
            model_known: Boolean(models.next),
            global_default: defaultSelection(),
            running: Boolean(row && row.busy),
            busy: Boolean(row && row.busy),
            agent_available: Boolean(row && row.agent_available),
            catalog_row: Boolean(row),
          })
        }
        return send(res, 200, {
          revision: grantsNow.revision,
          catalog_status: catalogOk ? loaded.catalog.session_status : 'read_failed',
          global_default: defaultSelection(),
          sessions,
        })
      }
      if (req.method === 'GET' && url.pathname === '/v1/workspaces') {
        const grantsNow = state()
        const rows = await ctx.workspaceRegistry.list()
        return send(res, 200, { ok: true, revision: grantsNow.revision, workspaces: visibleWorkspaces(grantsNow, rows) })
      }
      if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const grantsNow = state()
        const workspaceId = url.searchParams.get('workspace_id') || ''
        const auth = authorizeWorkspace(grantsNow, workspaceId)
        if (!auth.ok) return send(res, 200, { ok: false, reason: auth.reason, sessions: [] })
        const loaded = await loadCatalog()
        if (loaded.catalog.session_status === 'read_failed') {
          return send(res, 502, { ok: false, reason: 'session_list_read_failed', sessions: [], warnings: loaded.warnings })
        }
        const rows = (loaded.catalog.sessions || [])
          .filter((item) => item.workspace_id === workspaceId)
          .map(camelSession)
        const body = visibleSessions(grantsNow, workspaceId, rows)
        body.global_default = defaultSelection()
        return send(res, 200, body)
      }
      if (req.method === 'GET' && url.pathname === '/v1/history') {
        const grantsNow = state()
        const sessionId = url.searchParams.get('session_id') || ''
        const found = await findSessionRow(sessionId)
        if (found.status === 'read_failed') {
          return send(res, 502, { ok: false, reason: 'session_list_read_failed', source: 'desktop_session', not_an_empty_history: true })
        }
        if (found.status === 'missing') {
          return send(res, 404, { ok: false, reason: 'missing_session', source: 'desktop_session' })
        }
        const view = adapterSession(found.row)
        const auth = authorizeSession(grantsNow, view, { workspaceId: view.workspaceId, need: 'read' })
        if (!auth.ok) return send(res, 403, { ok: false, reason: auth.reason, source: 'desktop_session' })
        let snapshot
        try {
          snapshot = await readSnapshot(ctx.sessionQuery, sessionId)
        } catch (error) {
          const detail = safeError(error, 'sessionQuery.readSession')
          note(config, [detail])
          const status = detail.code === 'identity_mismatch' ? 409 : 502
          return send(res, status, { ok: false, reason: detail.code, source: 'desktop_session', detail })
        }
        return send(res, 200, pageHistory(grantsNow, view, snapshot, url.searchParams.get('offset'), url.searchParams.get('limit')))
      }
      if (req.method === 'GET' && url.pathname === '/v1/model-catalog') {
        const catalog = await modelCatalog(ctx)
        return send(res, catalog.ok ? 200 : 502, catalog)
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const grantsNow = state()
        const sessionId = url.searchParams.get('session_id') || ''
        if (!sessionId) return send(res, 400, { ok: false, reason: 'missing_session_id' })
        const found = await findSessionRow(sessionId)
        if (found.status === 'read_failed') {
          return send(res, 502, { ok: false, reason: 'session_list_read_failed', session_id: sessionId })
        }
        if (found.status === 'missing') {
          return send(res, 404, { ok: false, reason: 'missing_session', session_id: sessionId })
        }
        const view = adapterSession(found.row)
        const auth = authorizeSession(grantsNow, view, { workspaceId: view.workspaceId, need: 'read' })
        if (!auth.ok) return send(res, 403, { ok: false, reason: auth.reason, session_id: sessionId })
        const models = await modelStateOf(sessionId, found.row)
        const agent = liveAgent(ctx, sessionId)
        const availability = models.next
          ? await checkSelection(ctx, models.next)
          : { available: false, reason: 'unknown_model', detail: 'the session records no model selection' }
        const canSet = auth.access === 'write' && !view.running && Boolean(agent)
        return send(res, 200, {
          ok: true,
          session_id: sessionId,
          access: auth.access,
          running: Boolean(view.running),
          agent_available: Boolean(agent),
          global_default: defaultSelection(),
          session: {
            last_used: models.lastUsed,
            pending: models.pending,
            next: models.next,
            last_execution: models.lastExecution,
            source: models.source,
          },
          availability,
          can_set: canSet,
          can_set_reason: canSet
            ? null
            : (auth.access !== 'write' ? 'read_only' : (view.running ? 'busy' : 'agent_not_attached')),
        })
      }
      if (req.method === 'POST' && url.pathname === '/v1/model') {
        const body = await readJson(req)
        const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
        const selection = selectionOf({
          provider: body.provider,
          model: body.model,
          reasoningEffort: body.reasoning_effort ?? body.reasoningEffort,
        })
        if (!sessionId) return send(res, 400, { ok: false, reason: 'missing_session_id' })
        if (!selection) return send(res, 400, { ok: false, reason: 'invalid_selection', detail: 'provider and model are required' })
        // An explicit null clears the effort; it is not the same as omitting it.
        const effortAsked = Object.prototype.hasOwnProperty.call(body, 'reasoning_effort')
          ? body.reasoning_effort
          : body.reasoningEffort
        if (effortAsked === 'auto') {
          return send(res, 400, {
            ok: false,
            reason: 'auto_not_an_effort',
            detail: 'omit reasoning_effort to follow the adapter default, or pass null to clear the recorded effort; "auto" is not an official value',
          })
        }
        const effortCleared = effortAsked === null
        const support = await effortSupport(ctx, selection)
        if (support.known && selection.reasoningEffort && !support.efforts.includes(selection.reasoningEffort)) {
          return send(res, 409, {
            ok: false,
            reason: 'unsupported_reasoning_effort',
            requested: selection,
            supported_reasoning_efforts: support.efforts,
            detail: 'the registered route does not advertise this reasoning effort',
          })
        }
        const grantsNow = state()
        const found = await findSessionRow(sessionId)
        if (found.status === 'read_failed') return send(res, 502, { ok: false, reason: 'session_list_read_failed' })
        if (found.status === 'missing') return send(res, 404, { ok: false, reason: 'missing_session' })
        const view = adapterSession(found.row)
        const auth = authorizeSession(grantsNow, view, { workspaceId: view.workspaceId, need: 'write' })
        if (!auth.ok) return send(res, 403, { ok: false, reason: auth.reason, session_id: sessionId })
        if (view.running) {
          return send(res, 409, { ok: false, reason: 'busy', detail: 'the session is running a turn; the model was not changed' })
        }
        const availability = await checkSelection(ctx, selection)
        if (!availability.available) {
          return send(res, 409, { ok: false, reason: availability.reason, detail: availability.detail, requested: selection })
        }
        const agent = liveAgent(ctx, sessionId)
        if (!agent) {
          return send(res, 409, {
            ok: false,
            reason: 'needs_ui',
            detail: 'the session has no live agent; choose the model in the Desktop UI for this session. The bridge does not attach agents and does not change history files.',
            requested: selection,
          })
        }
        if (!agentIdle(agent)) {
          return send(res, 409, { ok: false, reason: 'busy', detail: 'the live agent is running a turn; the model was not changed' })
        }
        const defaultBefore = defaultSelection()
        const selected = selectOnAgent(agent, selection)
        if (!selected.ok) {
          const status = selected.reason === 'readback_mismatch' ? 500 : 409
          return send(res, status, { ok: false, reason: selected.reason, detail: selected.detail || null, requested: selection, confirmed: selected.confirmed || null })
        }
        return send(res, 200, {
          ok: true,
          session_id: sessionId,
          requested: selection,
          confirmed: selected.confirmed,
          effort_cleared: effortCleared,
          effort_unverified: Boolean(selection.reasoningEffort && !support.known),
          supported_reasoning_efforts: support.efforts,
          model_source: 'session_pending',
          global_default: defaultSelection(),
          global_default_unchanged: JSON.stringify(defaultBefore) === JSON.stringify(defaultSelection()),
          next_requires_request: true,
          note: 'recorded as a session-level model/selection event; it applies to the next request of this session only',
        })
      }
      if (req.method === 'POST' && url.pathname === '/v1/resume') {
        const body = await readJson(req)
        const requestId = typeof body.request_id === 'string' ? body.request_id : ''
        const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
        if (waiters.has(waitKey(sessionId, requestId))) {
          const shared = await waiters.get(waitKey(sessionId, requestId))
          return send(res, shared.status, shared.body)
        }
        if (typeof body.text !== 'string' || body.text.trim().length === 0) {
          return send(res, 400, { accepted: false, reason: 'empty_text', session_id: sessionId, started_task: false })
        }
        if (body.text.length > MAX_TEXT_CHARS) {
          return send(res, 413, { accepted: false, reason: 'text_too_long', session_id: sessionId, started_task: false })
        }
        if (inflight.has(sessionId)) {
          return send(res, 409, {
            accepted: false,
            reason: 'bridge_request_in_flight',
            session_id: sessionId,
            detail: 'another bridge request is already waiting on this session',
            started_task: false,
          })
        }
        const grantsNow = state()
        const found = await findSessionRow(sessionId)
        if (found.status === 'read_failed') {
          return send(res, 502, { accepted: false, reason: 'session_list_read_failed', session_id: sessionId, started_task: false })
        }
        if (found.status === 'missing') {
          return send(res, 404, { accepted: false, reason: 'missing_session', session_id: sessionId, started_task: false })
        }
        const view = adapterSession(found.row)
        const decision = decideResume(grantsNow, view, {
          workspaceId: body.workspace_id || view.workspaceId,
          sessionId,
          profile: body.profile,
          requestId,
          text: body.text,
        })
        if (!decision.accepted) return send(res, 409, decision)

        // A duplicate request id must be answered from its durable record
        // before the model gate: resolving a model here would mutate the
        // session for a request that is then rejected as a conflict.
        const prior = ledger.get(requestId)
        if (prior) {
          const priorModel = prior.requested_model || null
          // The replay's own explicit model participates in the hash, so the
          // same id with a different model is a conflict, not an idempotent hit.
          const replayModel = body.model && typeof body.model === 'object'
            ? selectionOf({
              provider: body.model.provider,
              model: body.model.model,
              reasoningEffort: body.model.reasoning_effort ?? body.model.reasoningEffort,
            })
            : priorModel
          let early
          try {
            early = await ledger.claim({
              requestId,
              sessionId,
              workspaceId: body.workspace_id || view.workspaceId,
              contentHash: contentHash({ sessionId, text: body.text, model: replayModel }),
              requestedModel: priorModel,
              confirmedSelection: prior.confirmed_selection,
              explicitModel: Boolean(prior.explicit_model),
            })
          } catch {
            return send(res, 500, {
              accepted: false, completed: false, reason: 'request_persist_failed',
              session_id: sessionId, request_id: requestId, started_task: false, exactly_once: false,
            })
          }
          if (early.conflict) {
            return send(res, 409, {
              accepted: false, completed: false, reason: 'idempotency_conflict',
              session_id: sessionId, request_id: requestId, started_task: false,
              detail: 'this request id is already bound to different content or a different session',
            })
          }
          if (!early.created) {
            if (waiters.has(waitKey(sessionId, requestId))) {
              const shared = await waiters.get(waitKey(sessionId, requestId))
              return send(res, shared.status, shared.body)
            }
            const reused = await recoverStored(sessionId, requestId, early.record)
            return send(res, reused.status, reused.body)
          }
        }

        // ---- model gate: a route that is unknown or has no adapter is refused
        // before prompt(), never discovered as NO_ADAPTER in the middle of a turn.
        const models = await modelStateOf(sessionId, found.row)
        let requested = models.next
        const explicitModel = body.model && typeof body.model === 'object'
        if (explicitModel) {
          requested = selectionOf({
            provider: body.model.provider,
            model: body.model.model,
            reasoningEffort: body.model.reasoning_effort ?? body.model.reasoningEffort,
          })
          if (!requested) {
            return send(res, 400, { accepted: false, completed: false, reason: 'invalid_requested_model', session_id: sessionId, started_task: false })
          }
        }
        if (!requested) {
          return send(res, 409, {
            accepted: false,
            completed: false,
            reason: 'model_unknown',
            session_id: sessionId,
            detail: 'the session records no model selection; set one with POST /v1/model or in the Desktop UI',
            started_task: false,
          })
        }
        const agentAtStart = liveAgent(ctx, sessionId)
        // The effort a caller asked for must be checked against what the
        // registered route advertises, when the deployment enumerates it. An
        // unenumerable list is reported as unverified, not silently accepted as
        // a guarantee. "auto" is not an official value.
        if (requested.reasoningEffort === 'auto') {
          return send(res, 400, {
            accepted: false,
            completed: false,
            reason: 'auto_not_an_effort',
            detail: 'omit reasoning_effort to follow the adapter default; "auto" is not an official value',
            started_task: false,
          })
        }
        const effortInfo = await effortSupport(ctx, requested)
        if (effortInfo.known && requested.reasoningEffort && !effortInfo.efforts.includes(requested.reasoningEffort)) {
          return send(res, 409, {
            accepted: false,
            completed: false,
            reason: 'unsupported_reasoning_effort',
            requested_model: requested,
            supported_reasoning_efforts: effortInfo.efforts,
            started_task: false,
          })
        }
        const effortUnverified = Boolean(requested.reasoningEffort && !effortInfo.known)
        if (explicitModel && !sameSelection(agentSelection(agentAtStart), requested)) {
          const availability = await checkSelection(ctx, requested)
          if (!availability.available) {
            return send(res, 409, {
              accepted: false,
              completed: false,
              reason: availability.reason,
              detail: availability.detail,
              requested_model: requested,
              started_task: false,
            })
          }
          if (!agentAtStart) {
            return send(res, 409, {
              accepted: false,
              completed: false,
              reason: 'needs_ui',
              detail: 'the session has no live agent; choose the model in the Desktop UI for this session',
              requested_model: requested,
              started_task: false,
            })
          }
          if (!agentIdle(agentAtStart)) {
            return send(res, 409, { accepted: false, completed: false, reason: 'busy', session_id: sessionId, started_task: false })
          }
          const selected = selectOnAgent(agentAtStart, requested)
          if (!selected.ok) {
            return send(res, selected.reason === 'readback_mismatch' ? 500 : 409, {
              accepted: false,
              completed: false,
              reason: selected.reason,
              detail: selected.detail || null,
              requested_model: requested,
              confirmed_selection: selected.confirmed || null,
              started_task: false,
            })
          }
        }
        const confirmed = agentSelection(liveAgent(ctx, sessionId)) || requested
        if (!sameSelection(confirmed, requested)) {
          return send(res, 409, {
            accepted: false,
            completed: false,
            reason: 'model_changed_before_send',
            requested_model: requested,
            confirmed_selection: confirmed,
            detail: 'the session selection differs from the requested model; nothing was sent',
            started_task: false,
          })
        }
        const availabilityAtStart = await checkSelection(ctx, confirmed)
        if (!availabilityAtStart.available) {
          return send(res, 409, {
            accepted: false,
            completed: false,
            reason: availabilityAtStart.reason,
            detail: availabilityAtStart.detail,
            requested_model: requested,
            confirmed_selection: confirmed,
            started_task: false,
          })
        }
        const hash = contentHash({ sessionId, text: body.text, model: requested })
        let claim
        try {
          claim = await ledger.claim({
            requestId,
            sessionId,
            workspaceId: body.workspace_id || view.workspaceId,
            contentHash: hash,
            requestedModel: requested,
            confirmedSelection: confirmed,
            explicitModel,
          })
        } catch {
          return send(res, 500, {
            accepted: false, completed: false, reason: 'request_persist_failed',
            session_id: sessionId, request_id: requestId, started_task: false, exactly_once: false,
          })
        }
        if (claim.conflict) {
          return send(res, 409, {
            accepted: false, completed: false, reason: 'idempotency_conflict',
            session_id: sessionId, request_id: requestId, started_task: false,
            detail: 'this request id is already bound to different content or a different session',
          })
        }
        if (!claim.created) {
          if (waiters.has(waitKey(sessionId, requestId))) {
            const shared = await waiters.get(waitKey(sessionId, requestId))
            return send(res, shared.status, shared.body)
          }
          const reused = await recoverStored(sessionId, requestId, claim.record)
          return send(res, reused.status, reused.body)
        }
        let settleWait
        const pendingResult = new Promise((resolve) => { settleWait = resolve })
        waiters.set(waitKey(sessionId, requestId), pendingResult)
        try {
          await ledger.append(requestId, 'recorded', {
            session_id: sessionId,
            explicit_model: explicitModel,
          }, { effort_unverified: effortUnverified })
        } catch { /* a failed journal append must not undo a durable claim */ }
        const publish = async (status, payload, patch) => {
          let nextStatus = status
          let nextBody = payload
          try {
            const kind = patch.phase === 'terminal'
              ? 'terminal'
              : (patch.phase === 'unknown'
                ? 'unknown'
                : (payload && payload.reason === 'revoked_during_wait'
                  ? 'revoked'
                  : (patch.terminal_scope === 'bridge_wait'
                    ? 'bridge_timeout'
                    : (patch.phase === 'accepted' ? 'accepted' : 'status'))))
            await ledger.append(requestId, kind, {
              phase: patch.phase || null,
              terminal: (payload && payload.terminal) || null,
              completed: Boolean(payload && payload.completed === true),
              reason: (payload && payload.reason) || null,
            }, patch)
            notify(ledger.get(requestId))
          } catch {
            nextStatus = 500
            nextBody = {
              ...payload,
              completed: false,
              reason: 'request_persist_failed',
              exactly_once: false,
              started_task: payload.started_task === true,
            }
          }
          settleWait({ status: nextStatus, body: nextBody })
          waiters.delete(waitKey(sessionId, requestId))
          return send(res, nextStatus, nextBody)
        }
        const controller = new AbortController()
        live.set(requestId, controller)
        inflight.set(sessionId, requestId)
        // A client that disconnects must not keep this request polling for up to
        // 30 minutes and block the session's next bridge request.
        req.on('close', () => {
          if (!res.writableEnded) controller.abort()
        })
        const startedAt = Date.now()
        let acceptedOnce = false
        try {
          let before
          try {
            before = await readSnapshot(ctx.sessionQuery, sessionId)
          } catch (error) {
            const detail = safeError(error, 'sessionQuery.readSession')
            note(config, [detail])
            return publish(502, { accepted: false, reason: detail.code, session_id: sessionId, started_task: false, detail, exactly_once: false }, {
              phase: 'unknown', manual_reconcile: true, crash_window: true,
            })
          }
          const lastSeq = lastSeqOf(before)
          // The selection must still be the one confirmed above, and the adapter
          // must still be registered: both can change between preflight and send.
          const liveBeforeSend = agentSelection(liveAgent(ctx, sessionId))
          if (liveBeforeSend && !sameSelection(liveBeforeSend, confirmed)) {
            return publish(409, {
              accepted: false,
              completed: false,
              reason: 'model_changed_before_send',
              requested_model: requested,
              confirmed_selection: confirmed,
              current_selection: liveBeforeSend,
              detail: 'the selection changed after the preflight; nothing was sent',
              started_task: false,
            }, { phase: 'unknown', manual_reconcile: true, crash_window: true })
          }
          const availableBeforeSend = await checkSelection(ctx, liveBeforeSend || confirmed)
          if (!availableBeforeSend.available) {
            return publish(409, {
              accepted: false,
              completed: false,
              reason: availableBeforeSend.reason,
              detail: availableBeforeSend.detail,
              requested_model: requested,
              confirmed_selection: confirmed,
              started_task: false,
            }, { phase: 'unknown', manual_reconcile: true, crash_window: true })
          }
          let accepted
          try {
            await ledger.update(requestId, { prompt_attempted: true })
          } catch {
            return publish(500, {
              accepted: false, completed: false, reason: 'request_persist_failed',
              session_id: sessionId, request_id: requestId, started_task: false, exactly_once: false,
            }, { prompt_attempted: false })
          }
          try {
            accepted = await ctx.sessionController.prompt(promptBody({
              sessionId,
              requestId,
              text: body.text,
            }), controller.signal)
          } catch (error) {
            if (error && error.name === 'AbortError') {
              return publish(409, {
                accepted: null,
                completed: false,
                reason: 'manual_reconcile',
                scope: 'unreconciled',
                desktop_cancel_called: false,
                session_id: sessionId,
                request_id: requestId,
                detail: 'the wait stopped before an acknowledgement; the bridge will not send this prompt again',
                started_task: false,
                exactly_once: false,
                resend: false,
              }, { phase: 'unknown', manual_reconcile: true, crash_window: true, prompt_attempted: true })
            }
            const detail = safeError(error, 'sessionController.prompt')
            note(config, [detail])
            return publish(502, {
              accepted: null, completed: false, reason: 'manual_reconcile', session_id: sessionId,
              request_id: requestId, started_task: false, exactly_once: false, resend: false, detail,
            }, { phase: 'unknown', manual_reconcile: true, crash_window: true, prompt_attempted: true })
          }
          if (!accepted || accepted.accepted !== true) {
            const rejected = {
              accepted: false,
              completed: false,
              reason: 'prompt_not_accepted',
              session_id: sessionId,
              request_id: requestId,
              started_task: false,
              exactly_once: false,
              detail: 'the host did not acknowledge the prompt',
            }
            return publish(502, rejected, {
              phase: 'terminal', terminal_scope: 'admission', crash_window: false,
              accepted: false, started_task: false, response: rejected, http_status: 502,
            })
          }
          acceptedOnce = true
          try {
            await ledger.append(requestId, 'accepted', {
              phase: 'accepted',
              requested_model: requested,
              confirmed_selection: confirmed,
              explicit_model: explicitModel,
            }, { phase: 'accepted', accepted: true, started_task: true, crash_window: true })
          } catch { /* journal is secondary to the durable record */ }
          // The synchronous wait is a convenience only. `wait: false` (or
          // wait_ms: 0) returns the accepted record immediately; a coordinator
          // then uses /v1/requests/:id/events, /stream or /wait for the real
          // Desktop task lifetime, which can outlive this HTTP connection.
          const requestedWaitMs = body.wait === false
            ? 0
            : Number(body.wait_ms ?? body.waitMs ?? resumeTimeoutMs)
          const waitMs = Number.isFinite(requestedWaitMs)
            ? Math.min(MAX_REQUEST_WAIT_MS, Math.max(0, Math.floor(requestedWaitMs)))
            : resumeTimeoutMs
          if (waitMs === 0) {
            return publish(202, {
              accepted: true,
              completed: false,
              phase: 'accepted',
              wait: 'none',
              session_id: sessionId,
              request_id: requestId,
              model_selection: explicitModel ? 'session_selected_by_bridge' : 'session_recorded_not_overridden',
              requested_model: requested,
              confirmed_selection: confirmed,
              started_task: true,
              exactly_once: false,
              note: 'the prompt was accepted; the Desktop turn continues independently of this response',
            }, { phase: 'accepted', accepted: true, started_task: true, crash_window: false })
          }
          const deadline = startedAt + waitMs
          let turn = null
          let lastSnapshot = before
          let polls = 0
          let wait = pollIntervalMs
          let readMsTotal = 0
          for (;;) {
            const current = state()
            const still = authorizeSession(current, view, { workspaceId: view.workspaceId, need: 'write' })
            if (!still.ok) {
              const revoked = {
                accepted: true,
                completed: false,
                reason: 'revoked_during_wait',
                session_id: sessionId,
                request_id: requestId,
                started_task: true,
                queued_prompt_kept: true,
                exactly_once: false,
                detail: 'the grant changed while this request was waiting; the queued prompt is not withdrawn',
              }
              return publish(409, revoked, {
                phase: 'accepted', accepted: true, started_task: true, response: null,
              })
            }
            if (Date.now() >= deadline) break
            await sleep(Math.min(wait, Math.max(50, deadline - Date.now())), controller.signal)
            const readStart = Date.now()
            try {
              // observeSession avoids a persistence listing and a full replay
              // validation on every poll; readSession remains the fallback.
              lastSnapshot = await readObservation(ctx.sessionQuery, sessionId)
            } catch (error) {
              note(config, [safeError(error, 'sessionQuery.observeSession')])
              wait = Math.min(pollMaxIntervalMs, Math.round(wait * 1.5))
              continue
            }
            readMsTotal += Date.now() - readStart
            polls += 1
            wait = Math.min(pollMaxIntervalMs, Math.round(wait * 1.5))
            turn = findTurnForRequest(lastSnapshot.events, { requestId, afterSeq: lastSeq })
            if (turn && turn.attribution === 'ambiguous') {
              const ambiguous = {
                accepted: true,
                completed: false,
                session_id: sessionId,
                request_id: requestId,
                model_selection: explicitModel ? 'session_selected_by_bridge' : 'session_recorded_not_overridden',
                requested_model: requested,
                confirmed_selection: confirmed,
                execution_model: null,
                execution_model_source: 'unknown',
                model_match: null,
                text: '',
                final: { reason: { kind: 'unattributed_turn' } },
                attribution: 'ambiguous',
                last_seq: lastSeqOf(lastSnapshot),
                polls,
                elapsed_ms: Date.now() - startedAt,
                started_task: true,
                note: 'more than one new turn appeared; no text was attributed and no retry was sent',
              }
              return publish(200, ambiguous, {
                phase: 'terminal', terminal_scope: 'official', crash_window: false,
                accepted: true, started_task: true, response: ambiguous,
              })
            }
            if (turn && turn.end) break
          }
          if (!turn || !turn.end) {
            const timedOut = {
              accepted: true,
              completed: false,
              session_id: sessionId,
              request_id: requestId,
              model_selection: explicitModel ? 'session_selected_by_bridge' : 'session_recorded_not_overridden',
              requested_model: requested,
              confirmed_selection: confirmed,
              execution_model: executionModelForTurn(lastSnapshot.events, turn),
              execution_model_source: executionModelForTurn(lastSnapshot.events, turn) ? 'request_header' : 'unknown',
              model_match: null,
              text: '',
              final: { reason: { kind: 'bridge_timeout' } },
              terminal: 'bridge_timeout',
              terminal_scope: 'bridge_wait',
              model_timeout: false,
              turn: turn && turn.number !== null ? turn.number : null,
              last_seq: lastSeqOf(lastSnapshot),
              timeout_ms: waitMs,
              polls,
              read_ms_total: readMsTotal,
              elapsed_ms: Date.now() - startedAt,
              started_task: true,
              note: 'the prompt was accepted but the turn did not finish before the timeout; no retry was sent',
            }
            return publish(200, timedOut, {
              phase: 'accepted', terminal_scope: 'bridge_wait', crash_window: false,
              accepted: true, started_task: true, response: timedOut,
            })
          }
          const answer = turnAnswer(lastSnapshot.events, turn)
          // A turn that ended is not the same as a turn that succeeded: only a
          // `completed` reason is reported as completed, so an error, an abort,
          // or a token limit cannot be mistaken for a finished task.
          const execution = executionModelForTurn(lastSnapshot.events, turn)
          const match = selectionMatch(execution, confirmed)
          let terminal = terminalKind(answer.reason)
          let finalReason = answer.reason || { kind: terminal }
          if (match.model_match === false) {
            terminal = 'model_mismatch'
            finalReason = { kind: 'model_mismatch', mismatch: match.mismatch, requested: confirmed, execution }
          }
          const result = {
            accepted: true,
            completed: terminal === 'completed',
            session_id: sessionId,
            request_id: requestId,
            model_selection: explicitModel ? 'session_selected_by_bridge' : 'session_recorded_not_overridden',
            requested_model: requested,
            confirmed_selection: confirmed,
            execution_model: execution,
            execution_model_source: execution ? 'request_header' : 'unknown',
            route_match: match.route_match,
            effort_match: match.effort_match,
            effort_verified: match.effort_verified,
            model_match: match.model_match,
            model_mismatch: match.mismatch,
            effort_unverified: effortUnverified,
            supported_reasoning_efforts: effortInfo.efforts,
            global_default: defaultSelection(),
            model: execution ? execution.model : null,
            provider: execution ? execution.provider : null,
            model_source: execution ? 'request_header' : 'unknown',
            text: redactText(answer.texts.join('\n\n')),
            final: { reason: finalReason },
            terminal,
            turn: turn.number,
            events_count: answer.texts.length,
            attribution: turn.attribution,
            polls,
            read_ms_total: readMsTotal,
            elapsed_ms: Date.now() - startedAt,
            started_task: true,
          }
          return publish(200, result, {
            phase: 'terminal', terminal_scope: 'official', crash_window: false,
            accepted: true, started_task: true, manual_reconcile: false, response: result,
          })
        } catch (error) {
          if (error && error.name === 'AbortError') {
            const stopped = {
              accepted: acceptedOnce,
              completed: false,
              reason: 'bridge_wait_stopped',
              scope: 'bridge_wait',
              desktop_cancel_called: false,
              killed_desktop: false,
              desktop_turn_kept: true,
              session_id: sessionId,
              request_id: requestId,
              detail: 'this only stops the bridge wait; the desktop turn is unchanged',
              started_task: acceptedOnce,
              exactly_once: false,
            }
            return publish(409, stopped, {
              phase: acceptedOnce ? 'accepted' : 'unknown',
              manual_reconcile: !acceptedOnce,
              crash_window: !acceptedOnce,
              accepted: acceptedOnce ? true : null,
              started_task: acceptedOnce,
            })
          }
          const detail = safeError(error, 'resume')
          note(config, [detail])
          return publish(500, {
            accepted: acceptedOnce, completed: false, reason: detail.code || 'request_failed',
            session_id: sessionId, request_id: requestId, started_task: acceptedOnce, detail, exactly_once: false,
          }, { phase: acceptedOnce ? 'accepted' : 'unknown', manual_reconcile: !acceptedOnce, crash_window: !acceptedOnce })
        } finally {
          live.delete(requestId)
          inflight.delete(sessionId)
        }
      }
      if (req.method === 'POST' && url.pathname === '/v1/access') {
        const body = await readJson(req)
        const wanted = body.access === 'write' ? 'write' : 'read'
        const grantsNow = state()
        const existing = (grantsNow.sessionAllowlist || []).find((item) => item.sessionId === body.session_id)
        if (!existing) return send(res, 403, { ok: false, reason: 'not_allowlisted', started_task: false })
        const found = await findSessionRow(body.session_id)
        if (found.status === 'read_failed') {
          return send(res, 502, { ok: false, reason: 'session_list_read_failed', started_task: false })
        }
        if (found.status === 'missing') {
          return send(res, 404, { ok: false, reason: 'missing_session', started_task: false })
        }
        const view = adapterSession(found.row)
        if (wanted === 'write' && view.running) {
          return send(res, 409, { ok: false, reason: 'busy', detail: 'write refused; existing turn not cancelled', started_task: false })
        }
        if (wanted === 'write') {
          const workspace = authorizeWorkspace(grantsNow, view.workspaceId)
          if (!workspace.ok || (view.cwd && workspace.workspace.cwd && view.cwd !== workspace.workspace.cwd)) {
            return send(res, 403, { ok: false, reason: workspace.ok ? 'cwd_mismatch' : workspace.reason, started_task: false })
          }
        }
        let after
        try {
          after = await grants.setAccess(body.session_id, wanted)
        } catch (error) {
          const detail = safeError(error, 'grants.save')
          note(config, [detail])
          if (error && error.code === 'not_allowlisted') {
            return send(res, 403, { ok: false, reason: 'not_allowlisted', started_task: false })
          }
          return send(res, 500, { ok: false, reason: error && error.code ? error.code : 'allowlist_persist_failed', saved: false, started_task: false, detail })
        }
        return send(res, 200, {
          ok: true,
          started_task: false,
          model_changed: false,
          access: wanted,
          session_id: body.session_id,
          revision: after.revision,
        })
      }
      if (req.method === 'POST' && url.pathname === '/v1/revoke') {
        const body = await readJson(req)
        if (typeof body.session_id !== 'string' || !body.session_id) {
          return send(res, 400, { ok: false, reason: 'missing_session_id', started_task: false })
        }
        let after
        try {
          after = await grants.revoke(body.session_id)
        } catch (error) {
          const detail = safeError(error, 'grants.save')
          note(config, [detail])
          return send(res, 500, { ok: false, reason: error && error.code ? error.code : 'allowlist_persist_failed', saved: false, started_task: false, detail })
        }
        return send(res, 200, {
          ok: true,
          revoked: Boolean(after.revoked),
          session_id: body.session_id,
          revision: after.revision,
          started_task: false,
          remaining: after.sessionAllowlist.length,
        })
      }
      const requestStream = /^\/v1\/requests\/([^/]+)\/(events|wait|stream)$/.exec(url.pathname)
      if (req.method === 'GET' && requestStream) {
        let requestId
        try {
          requestId = decodeURIComponent(requestStream[1])
        } catch {
          return send(res, 400, { ok: false, reason: 'malformed_request_id' })
        }
        const op = requestStream[2]
        const authorized = await authorizeRequestById(requestId, 'read')
        if (!authorized.ok) {
          return send(res, authorized.status, { ok: false, reason: authorized.reason, request_id: requestId })
        }
        if (op === 'events') {
          const afterSeq = Math.max(0, Number(url.searchParams.get('after_seq')) || 0)
          const timeoutMs = Math.min(MAX_EVENT_WAIT_MS, Math.max(0, Number(url.searchParams.get('timeout_ms')) || 30_000))
          const startedWait = Date.now()
          for (;;) {
            const record = await advanceRequest(requestId)
            if (!record) return send(res, 404, { ok: false, reason: 'unknown_request', request_id: requestId })
            const events = eventsSince(record, afterSeq)
            const terminal = record.phase === 'terminal' || record.phase === 'unknown'
            const waited = Date.now() - startedWait
            if (events.length > 0 || terminal || waited >= timeoutMs) {
              return send(res, 200, {
                ok: true,
                ...requestFrame(record, { events, terminal_phase: terminal }),
                heartbeat: events.length === 0 && !terminal,
                waited_ms: waited,
                journal_start: journalStart(record),
              })
            }
            await sleep(Math.min(JOURNAL_TICK_MS, Math.max(10, timeoutMs - waited)))
          }
        }
        if (op === 'wait') {
          const timeoutMs = Math.min(MAX_REQUEST_WAIT_MS, Math.max(0, Number(url.searchParams.get('timeout_ms')) || 60_000))
          const startedWait = Date.now()
          for (;;) {
            const record = await advanceRequest(requestId)
            if (!record) return send(res, 404, { ok: false, reason: 'unknown_request', request_id: requestId })
            const waited = Date.now() - startedWait
            if (record.phase === 'terminal' || record.phase === 'unknown') {
              const built = bodyOfRequest(record)
              return send(res, record.phase === 'terminal' ? built.status : 409, {
                ...built.body,
                query: true,
                waited_ms: waited,
                acceptance: built.body.completed === true ? 'completed' : 'not_completed',
              })
            }
            if (waited >= timeoutMs) {
              const built = bodyOfRequest(record)
              return send(res, 200, {
                ...built.body,
                query: true,
                wait: 'timeout',
                reason: 'wait_timeout',
                waited_ms: waited,
                timeout_ms: timeoutMs,
                note: 'the Desktop task continues; read again or subscribe to the event stream',
              })
            }
            await sleep(Math.min(JOURNAL_TICK_MS, Math.max(10, timeoutMs - waited)))
          }
        }
        // Server-Sent Events: heartbeat, monotonic seq, resume with Last-Event-ID
        // or after_seq. This is an observation channel only; it never prompts,
        // cancels, or resends.
        const afterSeq = Math.max(
          0,
          Number(req.headers['last-event-id']) || Number(url.searchParams.get('after_seq')) || 0,
        )
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write('retry: 1000\n\n')
        let closed = false
        const write = (chunk) => {
          if (closed) return false
          try {
            res.write(chunk)
            return true
          } catch {
            closed = true
            return false
          }
        }
        res.on('close', () => { closed = true })
        let lastSeq = afterSeq
        const streamStart = Date.now()
        let lastBeat = Date.now()
        try {
          for (;;) {
            if (closed) break
            const record = await advanceRequest(requestId)
            if (!record) {
              write(`event: error\ndata: ${JSON.stringify({ ok: false, reason: 'unknown_request', request_id: requestId })}\n\n`)
              break
            }
            for (const event of eventsSince(record, lastSeq)) {
              write(`id: ${event.seq}\nevent: request\ndata: ${JSON.stringify(event)}\n\n`)
              lastSeq = Number(event.seq)
            }
            if (record.phase === 'terminal' || record.phase === 'unknown') {
              write(`event: end\ndata: ${JSON.stringify(requestFrame(record))}\n\n`)
              break
            }
            if (Date.now() - lastBeat >= JOURNAL_HEARTBEAT_MS) {
              write(`: heartbeat ${new Date().toISOString()}\n\n`)
              lastBeat = Date.now()
            }
            if (Date.now() - streamStart >= MAX_STREAM_MS) {
              write(`event: end\ndata: ${JSON.stringify({ ...requestFrame(record), reason: 'stream_timeout' })}\n\n`)
              break
            }
            await sleep(JOURNAL_TICK_MS)
          }
        } catch {
          write(`event: error\ndata: ${JSON.stringify({ ok: false, reason: 'stream_failed' })}\n\n`)
        } finally {
          try { res.end() } catch { /* client already gone */ }
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/requests') {
        const requestId = url.searchParams.get('request_id') || ''
        const sessionId = url.searchParams.get('session_id') || ''
        const record = ledger.get(requestId)
        if (!record || record.session_id !== sessionId) {
          return send(res, 404, { ok: false, reason: 'unknown_request', started_task: false })
        }
        const grantsNow = state()
        const found = await findSessionRow(sessionId)
        if (found.status === 'read_failed') {
          return send(res, 502, { ok: false, reason: 'session_list_read_failed', started_task: false })
        }
        if (found.status !== 'ok') return send(res, 404, { ok: false, reason: 'missing_session', started_task: false })
        const view = adapterSession(found.row)
        const auth = authorizeSession(grantsNow, view, { workspaceId: record.workspace_id || view.workspaceId, need: 'read' })
        if (!auth.ok) return send(res, 403, { ok: false, reason: auth.reason, started_task: false })
        const current = await advanceRequest(requestId)
        if (!current) return send(res, 404, { ok: false, reason: 'unknown_request', started_task: false })
        const built = bodyOfRequest(current)
        return send(res, built.status === 409 ? 200 : built.status, {
          ...built.body,
          query: true,
          acceptance: built.body.completed === true ? 'completed' : 'not_completed',
        })
      }
      if (req.method === 'POST' && url.pathname === '/v1/wait/stop') {
        const body = await readJson(req)
        const controller = live.get(body.request_id)
        if (!controller) {
          return send(res, 200, {
            confirmed: false, scope: 'bridge_wait', reason: 'no_bridge_wait',
            desktop_cancel_called: false, killed_desktop: false,
          })
        }
        controller.abort()
        const stopping = ledger.get(body.request_id)
        if (stopping) {
          try {
            await ledger.append(body.request_id, 'wait_stopped', {
              scope: 'bridge_wait',
              desktop_turn_kept: true,
            })
          } catch { /* journal only */ }
        }
        return send(res, 200, {
          confirmed: true,
          scope: 'bridge_wait',
          reason: 'bridge_wait_stopped',
          desktop_cancel_called: false,
          killed_desktop: false,
          desktop_turn_kept: true,
          note: 'this only stops the bridge wait and does not cancel the desktop turn',
        })
      }
      if (req.method === 'POST' && url.pathname === '/v1/cancel') {
        const body = await readJson(req)
        const requestId = typeof body.request_id === 'string' ? body.request_id : ''
        const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
        const record = ledger.get(requestId)
        if (!record || record.session_id !== sessionId) {
          return send(res, 404, { cancel_accepted: false, desktop_cancel_called: false, reason: 'unknown_request', started_task: false })
        }
        const grantsNow = state()
        const found = await findSessionRow(sessionId)
        if (found.status === 'read_failed') {
          return send(res, 502, { cancel_accepted: false, desktop_cancel_called: false, reason: 'session_list_read_failed', started_task: false })
        }
        if (found.status !== 'ok') {
          return send(res, 404, { cancel_accepted: false, desktop_cancel_called: false, reason: 'missing_session', started_task: false })
        }
        const view = adapterSession(found.row)
        const auth = authorizeSession(grantsNow, view, { workspaceId: record.workspace_id || view.workspaceId, need: 'write' })
        if (!auth.ok) {
          return send(res, 403, { cancel_accepted: false, desktop_cancel_called: false, reason: auth.reason, started_task: false })
        }
        let snap
        try {
          snap = await readSnapshot(ctx.sessionQuery, sessionId)
        } catch (error) {
          return send(res, 502, {
            cancel_accepted: false, desktop_cancel_called: false, reason: 'session_read_failed',
            started_task: false, detail: safeError(error, 'sessionQuery.readSession'),
          })
        }
        const owned = classifyOwnedTurn(snap.events, requestId)
        if (owned.ended && owned.turn && owned.turn.attribution === 'request_id') {
          const described = describeTurn(sessionId, requestId, record, snap, owned.turn)
          return send(res, 200, {
            ...described,
            cancel_accepted: false,
            desktop_cancel_called: false,
            reason: 'already_terminal',
            detail: 'the official turn already ended; it was not rewritten',
          })
        }
        if (!owned.owned) {
          return send(res, 409, {
            cancel_accepted: false,
            desktop_cancel_called: false,
            killed_desktop: false,
            reason: owned.reason,
            session_id: sessionId,
            request_id: requestId,
            started_task: false,
            detail: 'the active desktop turn is not this bridge request, so cancel was not called',
          })
        }
        if (typeof ctx.sessionController.cancel !== 'function') {
          return send(res, 501, {
            cancel_accepted: false, desktop_cancel_called: false, reason: 'cancel_unavailable',
            session_id: sessionId, request_id: requestId, started_task: false,
          })
        }
        // The official cancel resolves the live Agent and throws when the
        // Session is not attached. Refuse before the call so a non-live Session
        // is not reported as a failed Desktop cancel.
        if (!view.agent_available) {
          return send(res, 409, {
            cancel_accepted: false,
            desktop_cancel_called: false,
            killed_desktop: false,
            reason: 'agent_not_attached',
            session_id: sessionId,
            request_id: requestId,
            started_task: true,
            detail: 'the official cancel needs a live Agent; nothing was called and the turn was not touched',
          })
        }
        // The official cancel has no compare-and-cancel, so re-read immediately
        // before the call: the check→call gap is one snapshot read, not a
        // grant-list read plus a model/catalog round trip. If ownership moved,
        // nothing is called.
        let confirmedSnap
        try {
          confirmedSnap = await readSnapshot(ctx.sessionQuery, sessionId)
        } catch (error) {
          return send(res, 502, {
            cancel_accepted: false, desktop_cancel_called: false, reason: 'session_read_failed',
            started_task: false, detail: safeError(error, 'sessionQuery.readSession'),
          })
        }
        const confirmedOwned = classifyOwnedTurn(confirmedSnap.events, requestId)
        if (!confirmedOwned.owned) {
          return send(res, 409, {
            cancel_accepted: false,
            desktop_cancel_called: false,
            killed_desktop: false,
            reason: confirmedOwned.ended ? 'already_terminal' : 'ownership_changed',
            session_id: sessionId,
            request_id: requestId,
            started_task: false,
            detail: 'the owned open turn changed between the check and the call; nothing was cancelled',
          })
        }
        let receipt
        try {
          receipt = await ctx.sessionController.cancel({ sessionId })
        } catch (error) {
          return send(res, 502, {
            cancel_accepted: false, desktop_cancel_called: true, reason: 'cancel_failed',
            session_id: sessionId, request_id: requestId, started_task: true,
            detail: safeError(error, 'sessionController.cancel'),
          })
        }
        if (!receipt || receipt.accepted !== true) {
          return send(res, 502, {
            cancel_accepted: false, desktop_cancel_called: true, reason: 'cancel_not_accepted',
            session_id: sessionId, request_id: requestId, started_task: true,
          })
        }
        const deadline = Date.now() + resumeTimeoutMs
        let finalSnap = snap
        let finalOwned = owned
        while (Date.now() < deadline) {
          await sleep(pollIntervalMs)
          try {
            finalSnap = await readSnapshot(ctx.sessionQuery, sessionId)
          } catch {
            continue
          }
          finalOwned = classifyOwnedTurn(finalSnap.events, requestId)
          if (finalOwned.ended) break
        }
        if (!finalOwned.ended || !finalOwned.turn) {
          return send(res, 200, {
            cancel_accepted: true,
            desktop_cancel_called: true,
            killed_desktop: false,
            completed: false,
            terminal: null,
            phase: 'running',
            session_id: sessionId,
            request_id: requestId,
            started_task: true,
            exactly_once: false,
            detail: 'cancellation was admitted but the official turn has not ended yet',
          })
        }
        const described = describeTurn(sessionId, requestId, record, finalSnap, finalOwned.turn)
        try {
          await ledger.update(requestId, {
            phase: 'terminal', terminal_scope: 'official', crash_window: false,
            accepted: true, started_task: true, response: described,
          })
        } catch {
          described.reason = 'request_persist_failed'
        }
        return send(res, 200, {
          ...described,
          cancel_accepted: true,
          desktop_cancel_called: true,
          killed_desktop: false,
          reason: 'official_terminal',
          detail: 'cancel admission and the official turn end are separate',
        })
      }
      return send(res, 404, { ok: false, reason: 'not_found' })
    } catch (error) {
      if (error && error.code === 'body_too_large') {
        return send(res, 413, { ok: false, reason: 'body_too_large' })
      }
      if (error && error.code === 'invalid_json') {
        return send(res, 400, { ok: false, reason: 'invalid_json' })
      }
      const detail = safeError(error, 'request')
      note(config, [detail])
      return send(res, 500, { ok: false, reason: 'request_failed', ...detail })
    }
  })
  server.on('close', () => {
    outbox.close()
  })
  void outbox.start()
  return server
}

function note(config, warnings) {
  if (!config.logFile || !warnings || warnings.length === 0) return
  const lines = warnings.map((item) => `${new Date().toISOString()} ${item.method} ${item.error} ${item.code}`).join('\n') + '\n'
  import('node:fs').then((fs) => fs.appendFileSync(config.logFile, lines)).catch(() => {})
}

function readJson(req) {
  return readJsonLimited(req, 1_048_576)
}

function readJsonLimited(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('request body is too large')
        error.code = 'body_too_large'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(JSON.parse(text || '{}'))
      } catch (error) {
        error.code = 'invalid_json'
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}
