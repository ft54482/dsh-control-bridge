/**
 * Read Desktop host lists and one Session log without mistaking a failure for
 * an empty history.
 *
 * Shapes here follow the official 0.2.2 controller, not a fixture:
 * - `sessionController.list(request, signal)` resolves `{ items: SessionSummary[] }`
 *   and a `SessionSummary` carries `sessionId` (never `id`), `running`,
 *   `agentAvailable`, optional `cwd`, and optional
 *   `projections.values` from the Session projection wire.
 * - `sessionQuery.readSession(id)` resolves
 *   `{ session: SessionHeader, inheritedEventCount, events: SessionEvent[] }`.
 * - `modelSelection` on the wire is `{ lastUsed, next }`; the persisted cache
 *   stores `{ lastUsed, pending }` under `rows[key].val`, so the state shape is
 *   tolerated only as a fallback and is labelled.
 */

const SECRET_TEXT = /sk-[A-Za-z0-9_-]{8,}|bearer\s+\S+|eyJ[A-Za-z0-9_-]{8,}/gi

export function redactText(value) {
  return String(value ?? '').replace(SECRET_TEXT, '[redacted]')
}

export function safeError(error, method) {
  const name = error && error.name ? String(error.name) : 'Error'
  const message = String((error && error.message) || '')
  let code = (error && error.code) || 'call_failed'
  if (!(error && error.code)) {
    if (/signal/i.test(message)) code = 'missing_signal'
    else if (/is not a function/i.test(message)) code = 'method_missing'
    else if (/unexpected|map|slice/i.test(message)) code = 'unexpected_shape'
  }
  return { method, error: name, code }
}

function shapeError(message, code) {
  const error = new TypeError(message)
  error.code = code
  return error
}

export function normalizeRows(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.items)) return value.items
  if (value && Array.isArray(value.sessions)) return value.sessions
  throw shapeError('session list did not return an array or an items array', 'unexpected_shape')
}

export function isSubagent(row) {
  const origin = row?.origin
  const parent = row?.parentSessionId ?? row?.parentSession ?? row?.parent
  if (origin === 'subagent') return true
  // An absent origin with a recorded parent is conservative: keep the row under
  // its parent instead of hoisting a child into the root list.
  return origin === undefined && Boolean(parent)
}

function shortText(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160) return null
  if (SECRET_TEXT.test(value)) {
    SECRET_TEXT.lastIndex = 0
    return null
  }
  SECRET_TEXT.lastIndex = 0
  return value
}

function selectionOf(value) {
  if (!value || typeof value !== 'object') return null
  const provider = shortText(value.provider)
  const model = shortText(value.model)
  if (!provider || !model) return null
  const effort = shortText(value.reasoningEffort)
  return effort ? { provider, model, reasoningEffort: effort } : { provider, model }
}

/**
 * Read the Session's recorded model selection from one list row.
 *
 * The wire value is `{ lastUsed, next }` (`next` is `pending ?? lastUsed`).
 * A persisted cache record (`{ ver, seq, val }`) is unwrapped only as a
 * fallback so a caller that passes cache rows still reads a real value.
 *
 * A deployment default is NOT a Session selection: when the row has no
 * selection the answer is `unknown`, never the default. Endpoints report the
 * default separately as `global_default`.
 * @returns `{ selection, source }` where source is `session_recorded | unknown`.
 */
export function modelSelectionOf(row) {
  const values = (row && row.projections && row.projections.values) || {}
  const raw = values.modelSelection
  let wire = raw
  if (wire && typeof wire === 'object' && wire.val && typeof wire === 'object' && !('lastUsed' in wire)) {
    wire = wire.val
  }
  const chosen = wire && typeof wire === 'object'
    ? (selectionOf(wire.next) || selectionOf(wire.lastUsed) || selectionOf(wire.pending) || selectionOf(wire))
    : null
  if (chosen) {
    return { selection: chosen, source: 'session_recorded' }
  }
  return { selection: null, source: 'unknown' }
}

export function titleOf(row) {
  const values = (row && row.projections && row.projections.values) || {}
  const candidates = [row?.title, values.title, values.displayTitle]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return { title: redactText(candidate.trim()), source: 'projection' }
  }
  return { title: '', source: 'missing' }
}

/**
 * Normalize one official `SessionSummary` (or a legacy row) into the shape the
 * rest of this plugin reasons about. This is the only place that knows the
 * transport field names.
 */
export function normalizeSessionRow(row, workspaceId, options = {}) {
  const sessionId = row?.sessionId ?? row?.id
  if (!sessionId) throw shapeError('session row has no sessionId', 'missing_field')
  const parent = row?.parentSessionId ?? row?.parentSession ?? row?.parent ?? null
  const origin = row?.origin ?? null
  const named = titleOf(row)
  const chosen = modelSelectionOf(row)
  return {
    sessionId: String(sessionId),
    workspaceId: String(workspaceId || ''),
    cwd: typeof row?.cwd === 'string' ? row.cwd : '',
    // The official SessionSummary has no profile field. This plugin is only
    // mounted in the desktop profile, so `desktop` is an installation
    // assumption and is labelled as such instead of being read from a row.
    profile: typeof row?.profile === 'string' && row.profile ? row.profile : 'desktop',
    profile_source: typeof row?.profile === 'string' && row.profile ? 'row' : 'plugin_profile_assumption',
    title: named.title,
    title_source: named.source,
    model: chosen.selection ? chosen.selection.model : null,
    provider: chosen.selection ? chosen.selection.provider : null,
    reasoning_effort: chosen.selection && chosen.selection.reasoningEffort ? chosen.selection.reasoningEffort : null,
    model_source: chosen.source,
    running: Boolean(row?.running),
    agent_available: Boolean(row?.agentAvailable),
    blank: Boolean(row?.blank),
    origin,
    parent: parent ? String(parent) : null,
    top: !isSubagent(row),
  }
}

/** Backwards-compatible alias used by the older tests. */
export const projectSession = normalizeSessionRow

async function firstWorking(calls) {
  let last = null
  for (const call of calls) {
    try {
      return { value: await call() }
    } catch (error) {
      last = error
    }
  }
  throw last || new TypeError('method missing')
}

export async function readWorkspaceRows(registry) {
  if (!registry || typeof registry.list !== 'function') {
    throw shapeError('workspaceRegistry.list is not a function', 'method_missing')
  }
  const value = await firstWorking([
    () => registry.list(),
    () => registry.list({}),
  ]).then((item) => item.value)
  return normalizeRows(value)
}

export async function readSessionRows(controller) {
  if (!controller || typeof controller.list !== 'function') {
    throw shapeError('sessionController.list is not a function', 'method_missing')
  }
  const signal = new AbortController().signal
  // Official signature: list(request, signal). The official server tolerates an
  // omitted signal for `list`, but the Remote client shape and every other
  // method take one, so the plugin always passes it. The second shape is
  // tolerated for a controller that only takes the signal.
  const value = await firstWorking([
    () => controller.list({}, signal),
    () => controller.list(signal),
  ]).then((item) => item.value)
  return normalizeRows(value)
}

/**
 * Read one Session log.
 * @returns `{ header, events, inherited, shape }`; throws rather than
 *   reporting an empty history.
 */
export async function readSnapshot(sessionQuery, sessionId) {
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
    throw shapeError('sessionQuery.readSession is not a function', 'method_missing')
  }
  const value = await sessionQuery.readSession(sessionId)
  if (Array.isArray(value)) {
    return { header: null, events: value, inherited: 0, shape: 'legacy_array' }
  }
  if (value && Array.isArray(value.events)) {
    const header = value.session && typeof value.session === 'object' ? value.session : null
    if (header && header.id !== undefined && String(header.id) !== String(sessionId)) {
      const error = new Error('the session log belongs to a different session id')
      error.code = 'identity_mismatch'
      throw error
    }
    return {
      header,
      events: value.events,
      inherited: Number.isFinite(value.inheritedEventCount) ? Number(value.inheritedEventCount) : 0,
      shape: 'official_snapshot',
    }
  }
  throw shapeError('readSession did not return an official snapshot', 'unexpected_shape')
}

/**
 * Cheaper read for a polling consumer: `sessionQuery.observeSession()` returns
 * a live/prepared observation without a persistence listing. For a live Session
 * the first `events` read materializes the in-memory log without replay
 * validation; a cold observation may still stat, read, and prepare the log.
 * Falls back to `readSession`.
 */
export async function readObservation(sessionQuery, sessionId) {
  if (!sessionQuery || typeof sessionQuery.observeSession !== 'function') {
    const snapshot = await readSnapshot(sessionQuery, sessionId)
    return { ...snapshot, shape: snapshot.shape === 'official_snapshot' ? 'read_session' : snapshot.shape }
  }
  const observation = await sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
  try {
    const header = observation && observation.header ? observation.header : null
    const events = observation && Array.isArray(observation.events) ? observation.events : null
    if (!events) throw shapeError('observeSession did not expose events', 'unexpected_shape')
    if (header && header.id !== undefined && String(header.id) !== String(sessionId)) {
      const error = new Error('the observed log belongs to a different session id')
      error.code = 'identity_mismatch'
      throw error
    }
    return {
      header,
      events,
      inherited: Number.isFinite(observation.inheritedEventCount) ? Number(observation.inheritedEventCount) : 0,
      shape: 'observation',
    }
  } finally {
    if (observation && typeof observation[Symbol.dispose] === 'function') {
      try { observation[Symbol.dispose]() } catch { /* ignore */ }
    }
    if (observation && typeof observation.dispose === 'function') {
      try { observation.dispose() } catch { /* ignore */ }
    }
  }
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') parts.push([block.name, block.arguments].filter(Boolean).join(' '))
  }
  return parts.map((part) => String(part).trim()).filter(Boolean).join('\n')
}

function turnEndText(reason) {
  if (!reason || typeof reason !== 'object') return ''
  if (reason.kind === 'error') return ['error', reason.error && reason.error.message].filter(Boolean).join(' ')
  if (reason.kind === 'completed') return ''
  return typeof reason.kind === 'string' ? reason.kind : ''
}

/** Semantic text of one official SessionEvent, mirroring the official extractor. */
export function eventText(event) {
  if (!event || typeof event !== 'object') return ''
  const data = event.data || {}
  switch (event.type) {
    case 'user/message':
      return contentText(data.content)
    case 'assistant/message':
      return contentText(data.message && data.message.content)
    case 'tool/call':
      return [data.name, data.arguments].filter(Boolean).join('\n')
    case 'tool/result':
      return [
        contentText(data.message && data.message.content),
        data.error && data.error.name,
        data.error && data.error.code,
      ].filter(Boolean).join('\n')
    case 'todo/write':
      return (Array.isArray(data.todos) ? data.todos : [])
        .flatMap((todo) => [todo && todo.status, todo && todo.content])
        .filter(Boolean)
        .join('\n')
    case 'turn/end':
      return turnEndText(data.reason)
    default:
      return ''
  }
}

export function eventKind(type) {
  if (type === 'user/message') return 'user'
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/call' || type === 'tool/result') return 'tool'
  if (type === 'turn/start' || type === 'turn/end') return 'turn'
  return 'other'
}

/**
 * Locate the turn that carries our request id.
 *
 * `prompt()` records `source.rpcId = requestId` on the accepted user message, so
 * the turn boundary is exact. Without a match the caller must not claim the
 * result: `attribution` says which rule was used.
 */
export function findTurnForRequest(events, { requestId, afterSeq = 0 } = {}) {
  const list = Array.isArray(events) ? events : []
  const turns = list.filter((event) => event.type === 'turn/start')
  let target = null
  let attribution = 'none'
  if (requestId) {
    const marker = list.find((event) => (
      event.type === 'user/message'
      && event.seq > afterSeq
      && event.data
      && event.data.source
      && event.data.source.rpcId === requestId
    ))
    if (marker) {
      attribution = 'request_id'
      for (const turn of turns) {
        if (turn.seq < marker.seq) target = turn
        else break
      }
      if (!target) {
        const nextTurn = turns.find((turn) => turn.seq > marker.seq)
        target = nextTurn || null
      }
    }
  }
  if (!target) {
    const candidates = turns.filter((turn) => turn.seq > afterSeq)
    if (candidates.length === 1) {
      target = candidates[0]
      attribution = attribution === 'none' ? 'single_new_turn' : attribution
    } else if (candidates.length > 1) {
      return { start: null, end: null, attribution: 'ambiguous', number: null }
    }
  }
  if (!target) return { start: null, end: null, attribution: 'none', number: null }
  const end = list.find((event) => event.type === 'turn/end' && event.seq > target.seq) || null
  return {
    start: target,
    end,
    attribution,
    number: target.data && Number.isFinite(target.data.turn) ? target.data.turn : null,
  }
}

export function turnAnswer(events, turn) {
  const list = Array.isArray(events) ? events : []
  if (!turn || !turn.start) return { texts: [], reason: null }
  const stop = turn.end ? turn.end.seq : Number.POSITIVE_INFINITY
  const texts = list
    .filter((event) => event.type === 'assistant/message' && event.seq > turn.start.seq && event.seq < stop)
    .map((event) => redactText(eventText(event)))
    .filter(Boolean)
  return { texts, reason: turn.end && turn.end.data ? turn.end.data.reason || null : null }
}

export function sessionIndex(rows, options = {}) {
  const index = new Map()
  const failures = []
  for (const row of rows || []) {
    try {
      const normalized = normalizeSessionRow(row, row?.workspaceId || '', options)
      index.set(normalized.sessionId, { normalized, row })
    } catch (error) {
      failures.push(safeError(error, 'sessionController.list.item'))
    }
  }
  return { index, failures }
}

export function registeredSession(workspace, sessionId, listed, options = {}) {
  const normalized = listed
    ? normalizeSessionRow(listed.row, workspace.id, options)
    : normalizeSessionRow({ sessionId }, workspace.id, options)
  const explicit = normalized.title
  return {
    session_id: normalized.sessionId,
    workspace_id: String(workspace.id),
    title: explicit || redactText(workspace.title || ''),
    title_source: explicit ? normalized.title_source : (workspace.title ? 'workspace_name' : 'missing'),
    cwd: normalized.cwd || workspace.cwd || workspace.path || '',
    profile: normalized.profile,
    profile_source: normalized.profile_source,
    model: normalized.model,
    provider: normalized.provider,
    reasoning_effort: normalized.reasoning_effort,
    model_source: normalized.model_source,
    busy: normalized.running,
    running: normalized.running,
    agent_available: normalized.agent_available,
    origin: normalized.origin,
    parent: normalized.parent,
    top: normalized.top,
  }
}

export async function assembleCatalog(ctx, options = {}) {
  const warnings = []
  let workspaceStatus = 'ok'
  let workspaceRows = []
  try {
    workspaceRows = await readWorkspaceRows(ctx.workspaceRegistry)
    if (workspaceRows.length === 0) workspaceStatus = 'empty'
  } catch (error) {
    workspaceStatus = 'read_failed'
    warnings.push(safeError(error, 'workspaceRegistry.list'))
  }
  const workspaces = []
  for (const row of workspaceRows) {
    try {
      workspaces.push({
        id: String(row.id),
        title: redactText(row.title || ''),
        cwd: row.path || row.cwd || '',
        path: row.path || row.cwd || '',
        sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds.map(String) : [],
      })
    } catch (error) {
      warnings.push(safeError(error, 'workspaceRegistry.list.item'))
    }
  }
  let sessionStatus = 'ok'
  let sessionRows = []
  try {
    sessionRows = await readSessionRows(ctx.sessionController)
    if (sessionRows.length === 0) sessionStatus = 'empty'
  } catch (error) {
    sessionStatus = 'read_failed'
    warnings.push(safeError(error, 'sessionController.list'))
    sessionRows = null
  }
  const indexed = sessionRows ? sessionIndex(sessionRows, options) : { index: new Map(), failures: [] }
  warnings.push(...indexed.failures)
  const registered = new Set(workspaces.flatMap((item) => item.sessionIds))
  const top = []
  const classified = []
  const metadataFailed = []
  if (sessionStatus !== 'read_failed') {
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) {
        try {
          const session = registeredSession(workspace, sessionId, indexed.index.get(sessionId), options)
          if (session.top) top.push(session)
          else classified.push(session)
        } catch (error) {
          metadataFailed.push(String(sessionId))
          warnings.push(safeError(error, 'session.metadata'))
        }
      }
    }
  }
  const membership = buildMembership({
    status: workspaceStatus === 'read_failed' ? 'read_failed' : 'ok',
    workspaces,
    listed: indexed.index,
    metadataFailed,
  })
  const listedIds = indexed.index ? [...indexed.index.keys()] : []
  return {
    catalog: {
      ok: workspaceStatus !== 'read_failed' && sessionStatus !== 'read_failed',
      source: 'registered_workspaces',
      grants_execution: false,
      includes_history: false,
      workspace_status: workspaceStatus,
      session_status: sessionStatus,
      not_an_empty_history: sessionStatus === 'read_failed',
      filtered_subagents: classified.length,
      omitted_unregistered: listedIds.filter((id) => !registered.has(id)).length,
      unreadable: metadataFailed.length,
      warnings,
      workspaces: workspaces.map((item) => ({ id: item.id, title: item.title, cwd: item.cwd })),
      sessions: sessionStatus === 'read_failed' ? null : top,
      classified_subagents: classified.map((item) => ({
        session_id: item.session_id,
        parent: item.parent,
        workspace_id: item.workspace_id,
      })),
    },
    membership,
    warnings,
  }
}

/**
 * Read-only discovery across every workspace the Desktop registry knows.
 *
 * This does NOT use the grant allowlist: it is the operator-anointed global
 * view. It reads metadata only (never message content), never hoists a
 * subagent into a top-level list, and never invents a terminal status: when the
 * projection does not say, the answer is `unknown`.
 */
export async function assembleDiscovery(ctx, query = {}) {
  const warnings = []
  let workspaceStatus = 'ok'
  let workspaceRows = []
  try {
    workspaceRows = await readWorkspaceRows(ctx.workspaceRegistry)
    if (workspaceRows.length === 0) workspaceStatus = 'empty'
  } catch (error) {
    workspaceStatus = 'read_failed'
    warnings.push(safeError(error, 'workspaceRegistry.list'))
  }
  const workspaces = []
  for (const row of workspaceRows) {
    try {
      workspaces.push({
        id: String(row.id),
        title: redactText(row.title || ''),
        path: row.path || row.cwd || '',
        sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds.map(String) : [],
      })
    } catch (error) {
      warnings.push(safeError(error, 'workspaceRegistry.list.item'))
    }
  }
  let sessionStatus = 'ok'
  let sessionRows = []
  try {
    sessionRows = await readSessionRows(ctx.sessionController)
    if (sessionRows.length === 0) sessionStatus = 'empty'
  } catch (error) {
    sessionStatus = 'read_failed'
    warnings.push(safeError(error, 'sessionController.list'))
  }
  const workspaceOfSession = new Map()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) workspaceOfSession.set(sessionId, workspace)
  }
  const failures = []
  const seen = new Set()
  const items = []
  for (const row of sessionStatus === 'read_failed' ? [] : sessionRows) {
    try {
      const sessionId = String(row.sessionId ?? row.id ?? '')
      if (!sessionId) {
        failures.push({ method: 'session.metadata', code: 'missing_session_id' })
        continue
      }
      if (seen.has(sessionId)) continue
      seen.add(sessionId)
      const workspace = workspaceOfSession.get(sessionId)
        || (row.workspaceId ? workspaces.find((item) => item.id === String(row.workspaceId)) : null)
        || null
      const workspaceId = workspace ? workspace.id : (row.workspaceId ? String(row.workspaceId) : '')
      const normalized = normalizeSessionRow(row, workspaceId, {})
      const kind = normalized.origin === 'subagent'
        ? 'subagent'
        : (normalized.origin === 'worker'
          ? 'worker'
          : (normalized.top ? 'top' : 'subagent'))
      const derived = discoveryStatus(row, normalized)
      const cwd = normalized.cwd || (workspace && workspace.path) || ''
      items.push({
        session_id: sessionId,
        workspace_id: workspaceId,
        workspace_title: workspace ? workspace.title : '',
        title: normalized.title || '',
        title_source: normalized.title_source,
        kind,
        origin: normalized.origin || 'unknown',
        parent: normalized.parent || null,
        status: derived.status,
        status_source: derived.status_source,
        running: Boolean(normalized.running),
        agent_available: Boolean(normalized.agent_available),
        cwd,
        cwd_source: normalized.cwd ? 'session_row' : (workspace && workspace.path ? 'workspace' : 'missing'),
        profile: normalized.profile,
        model: normalized.model,
        provider: normalized.provider,
        reasoning_effort: normalized.reasoning_effort || null,
        model_source: normalized.model_source,
        updated_at: typeof row.updatedAt === 'string' ? row.updatedAt : null,
      })
    } catch (error) {
      failures.push(safeError(error, 'session.metadata'))
    }
  }
  const wantedWorkspace = query.workspace_id ? String(query.workspace_id) : ''
  const wantedKind = query.kind ? String(query.kind) : ''
  const wantedStatus = query.status ? String(query.status) : ''
  const filtered = items
    .filter((item) => !wantedWorkspace || item.workspace_id === wantedWorkspace)
    .filter((item) => !wantedKind || item.kind === wantedKind)
    .filter((item) => !wantedStatus || item.status === wantedStatus)
    .sort((left, right) => {
      if (left.workspace_id !== right.workspace_id) return left.workspace_id < right.workspace_id ? -1 : 1
      return left.session_id < right.session_id ? -1 : (left.session_id > right.session_id ? 1 : 0)
    })
  const offset = Math.max(0, Number(query.offset) || 0)
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50))
  const counts = { top: 0, subagent: 0, worker: 0, unknown: 0 }
  const statusCounts = { running: 0, waiting_input: 0, error: 0, terminal: 0, unknown: 0 }
  for (const item of filtered) {
    counts[item.kind] = (counts[item.kind] || 0) + 1
    statusCounts[item.status] = (statusCounts[item.status] || 0) + 1
  }
  return {
    ok: workspaceStatus !== 'read_failed' && sessionStatus !== 'read_failed',
    source: 'official_registry_all_workspaces',
    discovered: true,
    includes_history: false,
    workspace_status: workspaceStatus,
    session_status: sessionStatus,
    not_an_empty_history: sessionStatus === 'read_failed',
    warnings,
    failures,
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessions_total: workspace.sessionIds.length,
    })),
    total: filtered.length,
    offset,
    limit,
    counts,
    status_counts: statusCounts,
    items: filtered.slice(offset, offset + limit),
  }
}

function discoveryStatus(row, normalized) {
  const values = (row && row.projections && row.projections.values) || {}
  if (normalized.running) return { status: 'running', status_source: 'session_list.running' }
  // Official pending-input signals: approvals, questions, inbox items.
  const approval = values.approvalState
  const questions = values.userQuestions
  const inbox = values.inbox
  const approvalPending = Boolean(approval && (
    approval.pending === true
    || (typeof approval.kind === 'string' && approval.kind !== 'none' && approval.kind !== 'resolved')
    || (Array.isArray(approval.items) && approval.items.length > 0)
  ))
  const questionPending = Array.isArray(questions) ? questions.length > 0 : Boolean(questions && questions.pending === true)
  const inboxPending = Array.isArray(inbox) ? inbox.length > 0 : false
  if (approvalPending || questionPending || inboxPending) {
    return { status: 'waiting_input', status_source: 'projection' }
  }
  // A non-null continuation projection means the last turn ended in a
  // resumable error state (official semantics); null means no such marker.
  if (values.conversationContinuation !== undefined && values.conversationContinuation !== null) {
    return { status: 'error', status_source: 'projection' }
  }
  const raw = values.sessionState ?? values.state ?? values.turnState ?? null
  const text = typeof raw === 'string' ? raw : ((raw && (raw.kind || raw.status)) || null)
  if (text === 'input-required' || text === 'waiting-input' || text === 'waiting_input') {
    return { status: 'waiting_input', status_source: 'projection' }
  }
  if (text === 'error' || text === 'failed') return { status: 'error', status_source: 'projection' }
  if (text === 'idle' || text === 'completed' || text === 'terminal') {
    return { status: 'terminal', status_source: 'projection' }
  }
  return { status: 'unknown', status_source: 'unknown' }
}

export function buildMembership(input) {
  const listed = input.listed || new Map()
  const failed = new Set(input.metadataFailed || [])
  const workspaces = []
  for (const workspace of input.workspaces || []) {
    const topLevel = []
    const subagent = []
    const unreadable = []
    for (const id of workspace.sessionIds || []) {
      if (failed.has(String(id))) {
        unreadable.push(String(id))
        continue
      }
      const known = listed.get(String(id))
      const normalized = known ? known.normalized : null
      if (normalized && !normalized.top) {
        subagent.push({ id: String(id), parent: normalized.parent })
      } else {
        topLevel.push(String(id))
      }
    }
    workspaces.push({
      id: workspace.id,
      title: workspace.title || '',
      cwd: workspace.cwd || workspace.path || '',
      top_level: topLevel,
      subagent,
      unreadable,
    })
  }
  return { status: input.status || 'ok', includes_history: false, workspaces }
}

export function compareMembership(before, after) {
  if (!before || before.status === 'read_failed' || !after || after.status === 'read_failed') {
    return { ok: false, reason: 'read_failed', missing: [], hoisted: [], moved: [] }
  }
  const missing = []
  const hoisted = []
  const moved = []
  const afterIndex = indexMembership(after)
  for (const workspace of before.workspaces || []) {
    if (!afterIndex.workspaces.has(workspace.id)) {
      missing.push({ kind: 'workspace', workspace_id: workspace.id, session_id: null })
      continue
    }
    for (const id of workspace.top_level || []) {
      const found = afterIndex.sessions.get(id)
      if (!found) missing.push({ kind: 'top_level', workspace_id: workspace.id, session_id: id })
      else if (found.workspace_id !== workspace.id) moved.push({ session_id: id, from: workspace.id, to: found.workspace_id })
    }
    for (const child of workspace.subagent || []) {
      const found = afterIndex.sessions.get(child.id)
      if (!found) missing.push({ kind: 'subagent', workspace_id: workspace.id, session_id: child.id, parent: child.parent })
      else if (found.bucket === 'top_level') hoisted.push({ session_id: child.id, parent: child.parent })
      else if (found.parent !== child.parent) moved.push({ session_id: child.id, parent: child.parent, found_parent: found.parent })
    }
  }
  return { ok: missing.length === 0 && hoisted.length === 0 && moved.length === 0, missing, hoisted, moved }
}

function indexMembership(snapshot) {
  const workspaces = new Set()
  const sessions = new Map()
  for (const workspace of snapshot.workspaces || []) {
    workspaces.add(workspace.id)
    for (const id of workspace.top_level || []) sessions.set(id, { bucket: 'top_level', workspace_id: workspace.id, parent: null })
    for (const child of workspace.subagent || []) sessions.set(child.id, { bucket: 'subagent', workspace_id: workspace.id, parent: child.parent || null })
  }
  return { workspaces, sessions }
}
