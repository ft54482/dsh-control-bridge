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
