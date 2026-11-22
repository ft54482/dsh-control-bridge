import http from 'node:http'
import { assembleCatalog, findTurnForRequest, readObservation, readSnapshot, safeError, turnAnswer } from './host_read.js'
import {
  agentIdle, agentSelection, checkSelection, executionModelForTurn, liveAgent,
  modelStateFromEvents, modelStateFromProjection, sameRoute, selectOnAgent, selectionOf,
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

function authScope(header, secrets) {
  if (secrets.bootstrap && checkAuth(header, secrets.bootstrap)) {
    if (secrets.consumed) return { scope: '', reason: 'bootstrap_consumed' }
    if (!(Number(secrets.expiresAt) > Date.now())) return { scope: '', reason: 'bootstrap_expired' }
    return { scope: 'bootstrap' }
  }
  if (secrets.host && checkAuth(header, secrets.host)) return { scope: 'host' }
  return { scope: '', reason: 'unauthorized' }
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
  const secrets = typeof secret === 'string'
    ? { host: secret, bootstrap: '', expiresAt: 0, consumed: true }
    : { consumed: false, expiresAt: 0, ...secret }
  const grants = config.grants
  const seen = new Map()
  const live = new Map()
  const inflight = new Map()
  const waiters = new Map()
  const ledger = config.ledger || createRequestLedger({ file: config.requestsFile || '' })
  const resumeTimeoutMs = Math.min(
    DEFAULT_RESUME_TIMEOUT_MS,
    Math.max(1_000, Number(config.resumeTimeoutMs) || DEFAULT_RESUME_TIMEOUT_MS),
  )
  const pollIntervalMs = Math.max(50, Number(config.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS)
  const pollMaxIntervalMs = Math.max(pollIntervalMs, Number(config.pollMaxIntervalMs) || DEFAULT_POLL_MAX_INTERVAL_MS)
  const globalDefault = typeof config.globalDefault === 'function' ? config.globalDefault : undefined

  function state() {
    if (!grants) throw new Error('grant store is not configured')
    grants.refresh()
    return grants.snapshot()
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
        await ledger.update(requestId, {
          phase: 'terminal',
          crash_window: false,
          manual_reconcile: false,
          accepted: true,
          started_task: true,
          terminal_scope: 'official',
          response: built,
        })
      } catch {
        return { status: 500, body: { ...built, completed: false, reason: 'request_persist_failed', exactly_once: false } }
      }
      return { status: 200, body: built }
    }
    if (record.phase === 'accepted' && owned.owned) {
      return {
        status: 200,
        body: {
          accepted: true,
          completed: false,
          phase: 'running',
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
    try {
      await ledger.update(requestId, { phase: 'unknown', manual_reconcile: true, crash_window: true })
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

  function describeTurn(sessionId, requestId, record, snap, turn) {
    const answer = turnAnswer(snap.events, turn)
    const execution = executionModelForTurn(snap.events, turn)
    const confirmedSelection = record.confirmed_selection
    const modelMatch = execution ? sameRoute(execution, confirmedSelection) : null
    let terminal = terminalKind(answer.reason)
    let finalReason = answer.reason || { kind: terminal }
    if (modelMatch === false) {
      terminal = 'model_mismatch'
      finalReason = { kind: 'model_mismatch', requested: confirmedSelection, execution }
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
      model_match: modelMatch,
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
    const auth = authScope(req.headers.authorization, secrets)
    if (!auth.scope) {
      const status = auth.reason === 'unauthorized' ? 401 : 403
      return send(res, status, { ok: false, reason: auth.reason || 'unauthorized' })
    }
    const scope = auth.scope
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        const grantsNow = state()
        return send(res, 200, {
          ok: true,
          listening: '127.0.0.1',
          outbound: false,
          desktop_verified: false,
          services: Boolean(ctx.sessionController && ctx.workspaceRegistry && ctx.sessionQuery),
          model_services: Boolean(ctx.agents && ctx.llm),
          allowlist_loaded: grantsNow.loaded,
          grants_revision: grantsNow.revision,
          grants_count: grantsNow.workspaceAllowlist.length + grantsNow.sessionAllowlist.length,
          allowlist_warnings: grantsNow.warnings,
          resume_timeout_ms: resumeTimeoutMs,
        })
      }
      if (req.method === 'GET' && url.pathname === '/v1/guard/membership') {
        const loaded = await loadCatalog()
        note(config, loaded.warnings)
        return send(res, 200, loaded.membership)
      }
      if (url.pathname.startsWith('/v1/bootstrap/')) {
        if (scope !== 'bootstrap') return send(res, 403, { ok: false, reason: 'bootstrap_required' })
        if (req.method === 'GET' && url.pathname === '/v1/bootstrap/catalog') {
          const loaded = await loadCatalog()
          note(config, loaded.warnings)
          return send(res, 200, loaded.catalog)
        }
        if (req.method === 'POST' && url.pathname === '/v1/bootstrap/select') {
          const body = await readJson(req)
          const loaded = await loadCatalog()
          if (loaded.catalog.session_status === 'read_failed') {
            return send(res, 409, { ok: false, reason: 'read_failed', started_task: false, warnings: loaded.warnings })
          }
          const chosen = selectGrant(loaded.catalog, { session_id: body.session_id, access: body.access })
          if (!chosen.ok) return send(res, 409, chosen)
          let after
          try {
            after = await grants.grant({ workspace: chosen.workspace, session: chosen.session })
          } catch (error) {
            const detail = safeError(error, 'grants.save')
            note(config, [detail])
            return send(res, 500, {
              ok: false,
              reason: error && error.code ? error.code : 'allowlist_persist_failed',
              saved: false,
              started_task: false,
              detail,
            })
          }
          // The bootstrap secret is only retired after the grant is durable.
          secrets.consumed = true
          if (config.consumeBootstrap) {
            try {
              config.consumeBootstrap()
            } catch (error) {
              note(config, [safeError(error, 'bootstrap.consume')])
            }
          }
          return send(res, 200, {
            ok: true,
            started_task: false,
            model_changed: false,
            allowlist: {
              version: after.version,
              workspaceAllowlist: after.workspaceAllowlist,
              sessionAllowlist: after.sessionAllowlist,
            },
            revision: after.revision,
          })
        }
        return send(res, 404, { ok: false, reason: 'not_found' })
      }
      if (scope !== 'host') return send(res, 403, { ok: false, reason: 'host_secret_required' })

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
        if (waiters.has(requestId)) {
          const shared = await waiters.get(requestId)
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
        if (explicitModel && !sameRoute(agentSelection(agentAtStart), requested)) {
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
        if (!sameRoute(confirmed, requested)) {
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
          if (waiters.has(requestId)) {
            const shared = await waiters.get(requestId)
            return send(res, shared.status, shared.body)
          }
          const reused = await recoverStored(sessionId, requestId, claim.record)
          return send(res, reused.status, reused.body)
        }
        let settleWait
        const pendingResult = new Promise((resolve) => { settleWait = resolve })
        waiters.set(requestId, pendingResult)
        const publish = async (status, payload, patch) => {
          let nextStatus = status
          let nextBody = payload
          try {
            await ledger.update(requestId, patch)
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
          waiters.delete(requestId)
          return send(res, nextStatus, nextBody)
        }
        const controller = new AbortController()
        live.set(requestId, controller)
        inflight.set(sessionId, requestId)
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
          if (liveBeforeSend && !sameRoute(liveBeforeSend, confirmed)) {
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
          await ledger.update(requestId, { phase: 'accepted', accepted: true, started_task: true, crash_window: true })
          const deadline = startedAt + resumeTimeoutMs
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
              timeout_ms: resumeTimeoutMs,
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
          const modelMatch = execution ? sameRoute(execution, confirmed) : null
          let terminal = terminalKind(answer.reason)
          let finalReason = answer.reason || { kind: terminal }
          if (modelMatch === false) {
            terminal = 'model_mismatch'
            finalReason = { kind: 'model_mismatch', requested: confirmed, execution }
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
            model_match: modelMatch,
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
        const reused = await recoverStored(sessionId, requestId, ledger.get(requestId))
        return send(res, reused.status === 409 ? 200 : reused.status, {
          ...reused.body,
          query: true,
          acceptance: reused.body.completed === true ? 'completed' : 'not_completed',
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
      const detail = safeError(error, 'request')
      note(config, [detail])
      return send(res, 500, { ok: false, reason: 'request_failed', ...detail })
    }
  })
  return server
}

function note(config, warnings) {
  if (!config.logFile || !warnings || warnings.length === 0) return
  const lines = warnings.map((item) => `${new Date().toISOString()} ${item.method} ${item.error} ${item.code}`).join('\n') + '\n'
  import('node:fs').then((fs) => fs.appendFileSync(config.logFile, lines)).catch(() => {})
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
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
