/**
 * Pure decisions for the Desktop host plugin.
 *
 * The loopback bearer and in-process sessionController shape follow the
 * MIT-licensed project ft54482/dsh-agent-bridge. This file is a separate
 * implementation. It does not read .credentials.yaml and it does not select
 * a model; the host keeps the session's recorded provider.
 *
 * Every authorization decision takes one immutable grants snapshot
 * (`{ workspaceAllowlist, sessionAllowlist }`), so all endpoints answer from
 * the same state instead of from a per-call copy.
 */

import { eventKind, eventText, redactText } from './host_read.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export { redactText }

export function checkAuth(header, secret) {
  if (!secret || secret.length < 32) return false
  const match = /^Bearer\s+(\S+)$/.exec(header || '')
  if (!match) return false
  const given = match[1]
  if (given.length !== secret.length) return false
  let diff = 0
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i)
  return diff === 0
}

export function loopbackPeer(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function rejectBrowser(headers) {
  const origin = headers.origin || ''
  if (origin) return 'cross_origin'
  const site = headers['sec-fetch-site'] || ''
  if (site && site !== 'none' && site !== 'same-origin') return 'cross_origin'
  return ''
}

export function decideListen({ services, hostSecret, allowlistCount, bootstrap, bind, now }) {
  if (!services) {
    return { listening: false, reason: 'desktop session services are not mounted; headless and incomplete profiles stay silent' }
  }
  if (bind && bind !== '127.0.0.1') return { listening: false, reason: 'bind must be 127.0.0.1' }
  const steady = Boolean(hostSecret && hostSecret.length >= 32 && allowlistCount > 0)
  const clock = now || Date.now()
  // A caller that already classified the window (the plugin's bootstrap source
  // enforces the short-lived cap) is authoritative; the older shape is
  // recomputed here for direct policy tests.
  const armed = typeof (bootstrap && bootstrap.armed) === 'boolean'
    ? Boolean(bootstrap.armed)
    : Boolean(
      bootstrap
      && bootstrap.secret
      && bootstrap.secret.length >= 32
      && Number(bootstrap.expiresAt) > clock
      && !bootstrap.consumed,
    )
  if (!steady && !armed) {
    return { listening: false, reason: 'no steady allowlist and no armed bootstrap' }
  }
  return { listening: true, steady, bootstrap: armed, outbound: false }
}

export function discoverCatalog(workspaces, sessions, extra = {}) {
  const projected = []
  const skipped = []
  for (const item of sessions || []) {
    const subagent = item.origin === 'subagent' || item.top === false || (item.origin === undefined && Boolean(item.parent))
    const safe = {
      session_id: item.sessionId || item.session_id || item.id,
      workspace_id: item.workspaceId || item.workspace_id || '',
      title: redactText(item.title || ''),
      cwd: item.cwd || '',
      profile: item.profile || 'unknown',
      model: item.model || null,
      provider: item.provider || null,
      busy: Boolean(item.busy || item.running),
      parent: item.parent || null,
    }
    if (subagent) {
      skipped.push(safe)
      continue
    }
    projected.push(safe)
  }
  const sessionStatus = extra.session_status || (projected.length || skipped.length ? 'ok' : 'empty')
  return {
    ok: sessionStatus !== 'read_failed' && extra.workspace_status !== 'read_failed',
    source: 'desktop_metadata',
    grants_execution: false,
    includes_history: false,
    workspace_status: extra.workspace_status || 'ok',
    session_status: sessionStatus,
    not_an_empty_history: sessionStatus === 'read_failed',
    filtered_subagents: extra.filtered_subagents ?? skipped.length,
    unreadable: extra.unreadable || 0,
    warnings: extra.warnings || [],
    workspaces: workspaces || [],
    sessions: sessionStatus === 'read_failed' ? null : projected,
    classified_subagents: (extra.classified_subagents || skipped).map((item) => ({
      session_id: item.session_id || item.id,
      parent: item.parent || null,
      workspace_id: item.workspace_id || '',
    })),
  }
}

/**
 * Pure authorization decision for one workspace.
 * @param grants - immutable grants snapshot.
 * @param workspaceId - workspace the caller names.
 */
export function authorizeWorkspace(grants, workspaceId) {
  const workspace = (grants.workspaceAllowlist || []).find((item) => item && item.id === workspaceId) || null
  if (!workspace) return { ok: false, reason: 'workspace_not_allowlisted', workspace: null }
  return { ok: true, workspace }
}

/**
 * Pure authorization decision for one session.
 * @param grants - immutable grants snapshot.
 * @param session - normalized session row, or null when it does not exist.
 * @param options.workspaceId - workspace the caller named.
 * @param options.need - `read` or `write`.
 * @param options.profile - profile the caller claims; must be `desktop`.
 */
export function authorizeSession(grants, session, options = {}) {
  const need = options.need === 'write' ? 'write' : 'read'
  if (!session) return { ok: false, reason: 'missing_session', started_task: false }
  const workspaceId = options.workspaceId || session.workspaceId || ''
  const workspace = authorizeWorkspace(grants, workspaceId)
  if (!workspace.ok) return { ok: false, reason: workspace.reason, started_task: false }
  const grant = (grants.sessionAllowlist || []).find((item) => item && item.sessionId === session.sessionId) || null
  if (!grant) return { ok: false, reason: 'session_not_allowlisted', started_task: false }
  if (grant.workspaceId && session.workspaceId && grant.workspaceId !== session.workspaceId) {
    return { ok: false, reason: 'workspace_mismatch', started_task: false }
  }
  if (need === 'write' && grant.access !== 'write') {
    return { ok: false, reason: 'read_only', started_task: false, access: grant.access }
  }
  const profile = session.profile || 'desktop'
  if (profile !== 'desktop') {
    return { ok: false, reason: 'cross_profile', started_task: false, detail: 'session profile is not desktop' }
  }
  if (options.profile !== undefined && options.profile !== 'desktop') {
    return { ok: false, reason: 'cross_profile', started_task: false, detail: 'caller profile is not desktop' }
  }
  const expected = workspace.workspace && workspace.workspace.cwd
  if (session.cwd && expected && session.cwd !== expected) {
    return { ok: false, reason: 'cwd_mismatch', started_task: false }
  }
  return { ok: true, grant, workspace: workspace.workspace, access: grant.access, started_task: false }
}

/**
 * Resolve one pairing choice into a grant to merge. Only a registered top-level
 * session of a known workspace is eligible; nothing here deletes a grant.
 */
export function selectGrant(catalog, choice) {
  const session = (catalog.sessions || []).find((item) => item.session_id === choice.session_id)
  if (!session) return { ok: false, reason: 'unknown_session', started_task: false }
  const access = choice.access === 'write' ? 'write' : 'read'
  if (access === 'write' && session.busy) {
    return { ok: false, reason: 'busy', detail: 'write refused; existing turn not cancelled', started_task: false }
  }
  if (access === 'write' && session.profile !== 'desktop') {
    return { ok: false, reason: 'cross_profile', started_task: false, model_changed: false }
  }
  const workspace = (catalog.workspaces || []).find((item) => item.id === session.workspace_id)
  if (!workspace) return { ok: false, reason: 'unknown_workspace', started_task: false }
  return {
    ok: true,
    started_task: false,
    model_changed: false,
    workspace: { id: workspace.id, cwd: workspace.cwd, title: workspace.title },
    session: {
      sessionId: session.session_id,
      workspaceId: session.workspace_id,
      access,
      cwd: session.cwd,
      profile: session.profile,
      model: session.model,
      provider: session.provider,
      title: session.title,
    },
  }
}

export function visibleWorkspaces(grants, workspaces) {
  const allowed = new Set((grants.workspaceAllowlist || []).map((item) => item.id))
  return (workspaces || [])
    .filter((item) => allowed.has(item.id))
    .map((item) => ({
      id: item.id,
      title: redactText(item.title || item.id),
      cwd: item.path || item.cwd || '',
      profile: 'desktop',
    }))
}

export function visibleSessions(grants, workspaceId, sessions) {
  const workspace = authorizeWorkspace(grants, workspaceId)
  if (!workspace.ok) return { ok: false, reason: workspace.reason, sessions: [] }
  const allowed = new Set(
    (grants.sessionAllowlist || [])
      .filter((item) => item.workspaceId === workspaceId)
      .map((item) => item.sessionId),
  )
  return {
    ok: true,
    sessions: (sessions || [])
      .filter((item) => item.sessionId && allowed.has(item.sessionId))
      .filter((item) => !item.cwd || !workspace.workspace.cwd || item.cwd === workspace.workspace.cwd)
      .map((item) => ({
        session_id: item.sessionId,
        workspace_id: workspaceId,
        title: item.title || '',
        title_source: item.title_source,
        cwd: item.cwd || '',
        profile: item.profile || 'desktop',
        running: Boolean(item.running),
        busy: Boolean(item.running),
        agent_available: Boolean(item.agent_available),
        model: item.model || null,
        provider: item.provider || null,
        model_source: item.model_source,
        access: (grants.sessionAllowlist || []).find((grant) => grant.sessionId === item.sessionId)?.access || 'read',
      })),
  }
}

/**
 * Page one Session log.
 * @param grants - immutable grants snapshot.
 * @param session - normalized session row.
 * @param snapshot - `{ header, events, inherited, shape }` from readSnapshot.
 */
export function pageHistory(grants, session, snapshot, offset, limit) {
  const auth = authorizeSession(grants, session, { workspaceId: session?.workspaceId, need: 'read' })
  if (!auth.ok) {
    return { ok: false, reason: auth.reason, source: 'desktop_session', started_task: false }
  }
  const events = Array.isArray(snapshot && snapshot.events) ? snapshot.events : null
  if (!events) return { ok: false, reason: 'unexpected_shape', source: 'desktop_session' }
  const start = Math.max(0, Math.floor(Number(offset) || 0))
  const size = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)))
  const total = events.length
  const page = events.slice(start, start + size).map((event) => ({
    seq: event.seq,
    type: event.type,
    kind: eventKind(event.type),
    text: redactText(eventText(event)),
  }))
  const nextOffset = start + page.length
  return {
    ok: true,
    source: 'desktop_session',
    session_id: session.sessionId,
    offset: start,
    limit: size,
    total,
    returned: page.length,
    has_more: nextOffset < total,
    next_offset: nextOffset < total ? nextOffset : null,
    snapshot_shape: snapshot.shape,
    inherited_event_count: snapshot.inherited || 0,
    session_header: snapshot.header
      ? {
        session_id: snapshot.header.id ? String(snapshot.header.id) : session.sessionId,
        cwd: snapshot.header.cwd || '',
        parent_session: snapshot.header.parentSession ? String(snapshot.header.parentSession) : null,
        origin: snapshot.header.origin || null,
        created_at: snapshot.header.createdAt || null,
      }
      : null,
    events: page,
    note: 'desktop session history from the host session service, not bridge history',
  }
}

export function decideResume(grants, session, request) {
  if (!SAFE_ID.test(request.sessionId || '') || !SAFE_ID.test(request.requestId || '')) {
    return { accepted: false, reason: 'unsafe_id', session_id: request.sessionId, started_task: false }
  }
  const auth = authorizeSession(grants, session, {
    workspaceId: request.workspaceId,
    need: 'write',
    profile: request.profile,
  })
  if (!auth.ok) {
    return { accepted: false, reason: auth.reason, session_id: request.sessionId, started_task: false }
  }
  if (session.running) {
    return {
      accepted: false,
      reason: 'busy',
      session_id: session.sessionId,
      detail: 'existing desktop turn was not cancelled',
      started_task: false,
    }
  }
  return {
    accepted: true,
    queued: false,
    reason: 'resumed',
    session_id: session.sessionId,
    delivery: 'queue',
    model_selection: 'session_recorded_not_overridden',
    started_task: false,
  }
}

export function promptBody(request) {
  return {
    sessionId: request.sessionId,
    requestId: request.requestId,
    mode: 'queue',
    content: [{ type: 'text', text: request.text }],
  }
}

/** Classify the terminal reason of a collected turn for callers. */
export function terminalKind(reason) {
  if (!reason || typeof reason !== 'object') return 'unknown'
  const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
  return kind
}
