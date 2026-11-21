/** Read Desktop host lists without treating a failure as an empty history. */

const SECRET_TEXT = /sk-[A-Za-z0-9_-]{8,}|bearer\s+\S+|eyJ[A-Za-z0-9_-]{8,}/gi

export function redactText(value) {
  return String(value ?? '').replace(SECRET_TEXT, '[redacted]')
}

export function safeError(error, method) {
  const name = error && error.name ? String(error.name) : 'Error'
  const message = String(error && error.message || '')
  let code = 'call_failed'
  if (/signal/i.test(message)) code = 'missing_signal'
  else if (/is not a function/i.test(message)) code = 'method_missing'
  else if (/unexpected|map/i.test(message)) code = 'unexpected_shape'
  else if (error && error.code === 'missing_field') code = 'missing_field'
  return { method, error: name, code }
}

export function normalizeRows(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.items)) return value.items
  if (value && Array.isArray(value.sessions)) return value.sessions
  if (value == null) return []
  const error = new TypeError('unexpected list shape')
  error.code = 'unexpected_shape'
  throw error
}

export function isSubagent(row) {
  const header = row?.header || {}
  return header.origin === 'subagent'
    || row?.origin === 'subagent'
    || Boolean(header.parentSession || row?.parentSession || row?.parentSessionId)
    || header.top === false
    || row?.top === false
}

function shortText(value) {
  if (typeof value !== 'string' || value.length > 160) return null
  if (SECRET_TEXT.test(value)) return null
  SECRET_TEXT.lastIndex = 0
  return value
}

export function projectSession(row, workspaceId) {
  const header = row?.header || {}
  const id = row?.sessionId || row?.id || header.id
  if (!id) {
    const error = new TypeError('missing session id')
    error.code = 'missing_field'
    throw error
  }
  const parent = header.parentSession || row?.parentSession || row?.parentSessionId || null
  return {
    session_id: String(id),
    workspace_id: String(row?.workspaceId || workspaceId || ''),
    title: redactText(row?.title || header.title || ''),
    cwd: row?.cwd || header.cwd || '',
    profile: row?.profile || header.profile || 'unknown',
    model: shortText(row?.model || row?.modelId || header.model || null),
    provider: shortText(row?.provider || header.provider || null),
    busy: Boolean(row?.running || row?.writerHeld),
    origin: header.origin || row?.origin || null,
    parent: parent ? String(parent) : null,
    top: !isSubagent({ ...row, header }),
  }
}

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
    const error = new TypeError('workspaceRegistry.list is not a function')
    throw error
  }
  const value = await firstWorking([
    () => registry.list(),
    () => registry.list({}),
  ]).then((item) => item.value)
  return normalizeRows(value)
}

export async function readSessionRows(controller) {
  if (!controller || typeof controller.list !== 'function') {
    throw new TypeError('sessionController.list is not a function')
  }
  const signal = new AbortController().signal
  const value = await firstWorking([
    () => controller.list({}, signal),
    () => controller.list(signal),
    () => controller.list({}),
    () => controller.list(),
  ]).then((item) => item.value)
  return normalizeRows(value)
}

export function classifyWorkspace(workspace, sessionRows) {
  const headers = safeHeaders(workspace)
  const byId = new Map()
  for (const row of sessionRows) {
    try {
      const projected = projectSession(row, workspace.id)
      byId.set(projected.session_id, projected)
    } catch {
      // One bad list row is recorded by the caller.
    }
  }
  const topLevel = []
  const subagent = []
  const unreadable = []
  const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
  const seen = new Set()
  for (const id of ids) {
    seen.add(String(id))
    const header = headers.get(String(id))
    const listed = byId.get(String(id))
    const row = header || listed
    if (!row) {
      unreadable.push(String(id))
      continue
    }
    if (row.top === false || isSubagent(header ? { header: header.raw || header, origin: header.origin, parentSession: header.parent, top: header.top } : listed)) {
      subagent.push({ id: String(id), parent: (header && header.parent) || (listed && listed.parent) || null })
    } else {
      topLevel.push(String(id))
    }
  }
  for (const [id, listed] of byId) {
    if (seen.has(id) || listed.workspace_id !== workspace.id) continue
    if (!listed.top) subagent.push({ id, parent: listed.parent })
    else topLevel.push(id)
  }
  return { top_level: topLevel, subagent, unreadable }
}

function safeHeaders(workspace) {
  const found = new Map()
  if (!workspace || typeof workspace.getSessionHeaders !== 'function') return found
  let headers = []
  try {
    headers = workspace.getSessionHeaders() || []
  } catch {
    return found
  }
  for (const header of headers) {
    if (!header || !header.id) continue
    found.set(String(header.id), {
      origin: header.origin || null,
      parent: header.parentSession || null,
      cwd: header.cwd || '',
      top: !(header.origin === 'subagent' || header.parentSession || header.top === false),
      raw: header,
    })
  }
  return found
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

export async function assembleCatalog(ctx) {
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
        sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds.map(String) : [],
        headers: typeof row.getSessionHeaders === 'function' ? row.getSessionHeaders() || [] : [],
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
  const projected = []
  if (sessionRows) {
    for (const row of sessionRows) {
      try {
        projected.push(projectSession(row, ''))
      } catch (error) {
        warnings.push(safeError(error, 'sessionController.list.item'))
      }
    }
  }
  const top = []
  const classified = []
  for (const session of projected) {
    if (session.top) top.push(session)
    else classified.push(session)
  }
  const membership = buildMembership({ status: workspaceStatus === 'read_failed' ? 'read_failed' : 'ok', workspaces })
  return {
    catalog: {
      ok: workspaceStatus !== 'read_failed' && sessionStatus !== 'read_failed',
      source: 'desktop_metadata',
      grants_execution: false,
      includes_history: false,
      workspace_status: workspaceStatus,
      session_status: sessionStatus,
      not_an_empty_history: sessionStatus === 'read_failed',
      filtered_subagents: classified.length,
      unreadable: membership.workspaces.reduce((sum, item) => sum + item.unreadable.length, 0),
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

export function buildMembership(input) {
  const workspaces = []
  for (const workspace of input.workspaces || []) {
    const headers = new Map()
    for (const header of workspace.headers || []) {
      if (header && header.id) headers.set(String(header.id), header)
    }
    const topLevel = []
    const subagent = []
    const unreadable = []
    for (const id of workspace.sessionIds || []) {
      const header = headers.get(String(id))
      if (!header) {
        unreadable.push(String(id))
        continue
      }
      if (header.origin === 'subagent' || header.parentSession || header.top === false) {
        subagent.push({ id: String(id), parent: header.parentSession ? String(header.parentSession) : null })
      } else {
        topLevel.push(String(id))
      }
    }
    workspaces.push({
      id: workspace.id,
      title: workspace.title || '',
      cwd: workspace.cwd || '',
      top_level: topLevel,
      subagent,
      unreadable,
    })
  }
  return { status: input.status || 'ok', includes_history: false, workspaces }
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
