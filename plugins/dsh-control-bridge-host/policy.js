/**
 * Pure decisions for the Desktop host plugin.
 *
 * The loopback bearer and in-process sessionController shape follow the
 * MIT-licensed project ft54482/dsh-agent-bridge. This file is a separate
 * implementation. It does not read .credentials.yaml and it does not select
 * a model; the host keeps the session's recorded provider.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SECRET_TEXT = /sk-[A-Za-z0-9_-]{8,}/g

export function redactText(value) {
  return String(value ?? '').replace(SECRET_TEXT, '[redacted]')
}

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
  const armed = Boolean(
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
    const subagent = item.origin === 'subagent' || item.top === false || Boolean(item.parent)
    const safe = {
      session_id: item.session_id || item.id,
      workspace_id: item.workspace_id || item.workspaceId || '',
      title: redactText(item.title || ''),
      cwd: item.cwd || '',
      profile: item.profile || 'unknown',
      model: item.model || null,
      provider: item.provider || null,
      busy: Boolean(item.busy || item.running),
      parent: item.parent || null,
    }
    if (subagent || item.top === false) {
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

export function selectAllowlist(catalog, choice) {
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
  return {
    ok: true,
    started_task: false,
    model_changed: false,
    allowlist: {
      version: 1,
      workspaceAllowlist: workspace ? [{ id: workspace.id, cwd: workspace.cwd, title: workspace.title }] : [],
      sessionAllowlist: [{
        sessionId: session.session_id,
        workspaceId: session.workspace_id,
        access,
        cwd: session.cwd,
        profile: session.profile,
        model: session.model,
        provider: session.provider,
        title: session.title,
      }],
    },
  }
}

function workspaceGrant(config, workspaceId) {
  return (config.workspaceAllowlist || []).find((item) => item && item.id === workspaceId) || null
}

function sessionGrant(config, sessionId) {
  return (config.sessionAllowlist || []).find((item) => item && item.sessionId === sessionId) || null
}

export function visibleWorkspaces(config, workspaces) {
  const allowed = new Set((config.workspaceAllowlist || []).map((item) => item.id))
  return (workspaces || [])
    .filter((item) => allowed.has(item.id))
    .map((item) => ({
      id: item.id,
      title: redactText(item.title || item.id),
      cwd: item.path || item.cwd || '',
      profile: 'desktop',
    }))
}

export function visibleSessions(config, workspaceId, sessions) {
  const workspace = workspaceGrant(config, workspaceId)
  if (!workspace) return { ok: false, reason: 'workspace_not_allowlisted', sessions: [] }
  const allowed = new Set(
    (config.sessionAllowlist || [])
      .filter((item) => item.workspaceId === workspaceId)
      .map((item) => item.sessionId),
  )
  return {
    ok: true,
    sessions: (sessions || [])
      .filter((item) => allowed.has(item.id) && (item.workspaceId === workspaceId || item.cwd === workspace.cwd))
      .map((item) => ({
        session_id: item.id,
        workspace_id: workspaceId,
        cwd: item.cwd || '',
        profile: item.profile || 'desktop',
        running: Boolean(item.running),
        access: sessionGrant(config, item.id)?.access || 'read',
      })),
  }
}

export function pageHistory(config, session, events, offset, limit) {
  const grant = sessionGrant(config, session?.id)
  if (!grant || grant.access !== 'read' && grant.access !== 'write') {
    return { ok: false, reason: 'session_not_allowlisted', source: 'desktop_session' }
  }
  if (grant.workspaceId && session.workspaceId && grant.workspaceId !== session.workspaceId) {
    return { ok: false, reason: 'workspace_mismatch', source: 'desktop_session' }
  }
  if ((session.profile || 'desktop') !== 'desktop') {
    return {
      ok: false,
      reason: 'cross_profile',
      source: 'desktop_session',
      detail: 'session profile is not desktop; the record was not modified',
    }
  }
  const start = Math.max(0, Number(offset) || 0)
  const size = Math.min(50, Math.max(1, Number(limit) || 20))
  const page = (events || []).slice(start, start + size).map((event) => ({
    seq: event.seq,
    type: event.type,
    text: redactText(event.text || ''),
  }))
  return {
    ok: true,
    source: 'desktop_session',
    session_id: session.id,
    offset: start,
    limit: size,
    total: (events || []).length,
    events: page,
    note: 'desktop session history from the host session service, not bridge history',
  }
}

export function decideResume(config, session, request) {
  const grant = sessionGrant(config, request.sessionId)
  const workspace = workspaceGrant(config, request.workspaceId)
  if (!SAFE_ID.test(request.sessionId || '') || !SAFE_ID.test(request.requestId || '')) {
    return { accepted: false, reason: 'unsafe_id', session_id: request.sessionId }
  }
  if (!workspace || !grant || grant.workspaceId !== request.workspaceId) {
    return { accepted: false, reason: 'not_allowlisted', session_id: request.sessionId }
  }
  if (grant.access !== 'write') {
    return { accepted: false, reason: 'read_only', session_id: request.sessionId }
  }
  if ((session?.profile || 'desktop') !== 'desktop' || request.profile !== 'desktop') {
    return {
      accepted: false,
      reason: 'cross_profile',
      session_id: request.sessionId,
      detail: 'cross-profile resume is rejected and the stored session is unchanged',
    }
  }
  if (!session || session.id !== request.sessionId) {
    return { accepted: false, reason: 'missing_session', session_id: request.sessionId }
  }
  if (session.cwd && workspace.cwd && session.cwd !== workspace.cwd) {
    return { accepted: false, reason: 'cwd_mismatch', session_id: request.sessionId }
  }
  if (session.running || session.writerHeld) {
    if (config.busyPolicy === 'queue' && session.running && !session.writerHeld) {
      return {
        accepted: true,
        queued: true,
        reason: 'queued',
        session_id: session.id,
        delivery: 'queue',
        model_selection: 'session_recorded_not_overridden',
      }
    }
    return { accepted: false, reason: 'busy', session_id: session.id, detail: 'existing desktop turn was not cancelled' }
  }
  return {
    accepted: true,
    queued: false,
    reason: 'resumed',
    session_id: session.id,
    delivery: 'queue',
    model_selection: 'session_recorded_not_overridden',
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
