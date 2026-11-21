import http from 'node:http'
import { assembleCatalog, readSessionRows, safeError } from './host_read.js'
import { decideResume, checkAuth, loopbackPeer, pageHistory, promptBody, redactText, rejectBrowser, selectAllowlist, visibleSessions, visibleWorkspaces } from './policy.js'

function authScope(header, secrets) {
  if (secrets.bootstrap && checkAuth(header, secrets.bootstrap) && !secrets.consumed && Number(secrets.expiresAt) > Date.now()) {
    return 'bootstrap'
  }
  if (secrets.host && checkAuth(header, secrets.host)) return 'host'
  return ''
}

export function createHostServer(ctx, config, secret) {
  const secrets = typeof secret === 'string'
    ? { host: secret, bootstrap: '', expiresAt: 0, consumed: true }
    : { consumed: false, expiresAt: 0, ...secret }
  const seen = new Map()
  const live = new Map()
  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress || ''
    if (!loopbackPeer(remote)) return send(res, 401, { ok: false, reason: 'unauthorized' })
    const browser = rejectBrowser(req.headers)
    if (browser) return send(res, 403, { ok: false, reason: browser })
    const scope = authScope(req.headers.authorization, secrets)
    if (!scope) return send(res, 401, { ok: false, reason: 'unauthorized' })
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return send(res, 200, {
          ok: true,
          listening: '127.0.0.1',
          outbound: false,
          desktop_verified: false,
          services: Boolean(ctx.sessionController && ctx.workspaceRegistry && ctx.sessionQuery),
        })
      }
      if (req.method === 'GET' && url.pathname === '/v1/guard/membership') {
        const loaded = await assembleCatalog(ctx)
        note(config, loaded.warnings)
        return send(res, 200, loaded.membership)
      }
      if (url.pathname.startsWith('/v1/bootstrap/')) {
        if (scope !== 'bootstrap') return send(res, 403, { ok: false, reason: 'bootstrap_required' })
        if (req.method === 'GET' && url.pathname === '/v1/bootstrap/catalog') {
          const loaded = await assembleCatalog(ctx)
          note(config, loaded.warnings)
          return send(res, 200, loaded.catalog)
        }
        if (req.method === 'POST' && url.pathname === '/v1/bootstrap/select') {
          const body = await readJson(req)
          const loaded = await assembleCatalog(ctx)
          if (loaded.catalog.session_status === 'read_failed') {
            return send(res, 409, { ok: false, reason: 'read_failed', started_task: false, warnings: loaded.warnings })
          }
          const chosen = selectAllowlist(loaded.catalog, {
            session_id: body.session_id,
            access: body.access,
          })
          if (!chosen.ok) return send(res, 409, chosen)
          if (config.saveAllowlist) config.saveAllowlist(chosen.allowlist)
          secrets.consumed = true
          if (config.consumeBootstrap) config.consumeBootstrap()
          return send(res, 200, chosen)
        }
        return send(res, 404, { ok: false, reason: 'not_found' })
      }
      if (scope !== 'host') return send(res, 403, { ok: false, reason: 'host_secret_required' })
      if (req.method === 'GET' && url.pathname === '/v1/granted') {
        return send(res, 200, {
          sessions: (config.sessionAllowlist || []).map((item) => ({
            session_id: item.sessionId,
            title: item.title || '',
            cwd: item.cwd || '',
            access: item.access,
            profile: item.profile || 'unknown',
            model: item.model || null,
            busy: false,
          })),
        })
      }
      if (req.method === 'GET' && url.pathname === '/v1/workspaces') {
        const rows = await ctx.workspaceRegistry.list()
        return send(res, 200, { ok: true, workspaces: visibleWorkspaces(config, rows) })
      }
      if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const workspaceId = url.searchParams.get('workspace_id') || ''
        const rows = await ctx.sessionController.list({ workspaceId })
        return send(res, 200, visibleSessions(config, workspaceId, rows))
      }
      if (req.method === 'GET' && url.pathname === '/v1/history') {
        const sessionId = url.searchParams.get('session_id') || ''
        const session = await findSession(ctx, sessionId)
        if (!session) return send(res, 404, { ok: false, reason: 'missing_session', source: 'desktop_session' })
        const events = await ctx.sessionQuery.readSession(sessionId)
        return send(res, 200, pageHistory(config, session, events, url.searchParams.get('offset'), url.searchParams.get('limit')))
      }
      if (req.method === 'POST' && url.pathname === '/v1/resume') {
        const body = await readJson(req)
        if (seen.has(body.request_id)) return send(res, 200, seen.get(body.request_id))
        const session = await findSession(ctx, body.session_id)
        const decision = decideResume(config, session, {
          workspaceId: body.workspace_id,
          sessionId: body.session_id,
          profile: body.profile,
          requestId: body.request_id,
          text: body.text,
        })
        if (!decision.accepted) return send(res, 409, decision)
        const controller = new AbortController()
        live.set(body.request_id, controller)
        try {
          const prompted = await ctx.sessionController.prompt(promptBody({
            sessionId: body.session_id,
            requestId: body.request_id,
            text: body.text,
          }), controller.signal)
          if (!prompted || prompted.sessionId !== body.session_id) {
            const rejected = {
              accepted: false,
              reason: 'identity_changed',
              session_id: body.session_id,
              detail: 'host returned a different session; it was not adopted',
            }
            seen.set(body.request_id, rejected)
            return send(res, 409, rejected)
          }
          const result = {
            ...decision,
            final: prompted.final || null,
            text: redactText(prompted.text || ''),
            model_selection: 'session_recorded_not_overridden',
          }
          seen.set(body.request_id, result)
          return send(res, 200, result)
        } catch (error) {
          if (error && error.name === 'AbortError') {
            return send(res, 409, { accepted: false, reason: 'cancelled', session_id: body.session_id, scope: 'bridge_request' })
          }
          return send(res, 502, { accepted: false, reason: 'host_error', session_id: body.session_id })
        } finally {
          live.delete(body.request_id)
        }
      }
      if (req.method === 'POST' && url.pathname === '/v1/access') {
        const body = await readJson(req)
        const current = (config.sessionAllowlist || []).find((item) => item.sessionId === body.session_id)
        if (!current) return send(res, 403, { ok: false, reason: 'not_allowlisted', started_task: false })
        const loaded = await assembleCatalog(ctx)
        const live = (loaded.catalog.sessions || []).find((item) => item.session_id === body.session_id)
        if (body.access === 'write' && live && live.busy) {
          return send(res, 409, { ok: false, reason: 'busy', detail: 'write refused; existing turn not cancelled', started_task: false })
        }
        const next = {
          version: 1,
          workspaceAllowlist: config.workspaceAllowlist || [],
          sessionAllowlist: (config.sessionAllowlist || []).map((item) => (
            item.sessionId === body.session_id ? { ...item, access: body.access === 'write' ? 'write' : 'read' } : item
          )),
        }
        if (config.saveAllowlist) config.saveAllowlist(next)
        config.sessionAllowlist = next.sessionAllowlist
        return send(res, 200, { ok: true, started_task: false, model_changed: false, access: body.access === 'write' ? 'write' : 'read', session_id: body.session_id })
      }
      if (req.method === 'POST' && url.pathname === '/v1/cancel') {
        const body = await readJson(req)
        const controller = live.get(body.request_id)
        if (!controller) return send(res, 200, { confirmed: false, reason: 'no_bridge_request', killed_desktop: false })
        controller.abort()
        return send(res, 200, { confirmed: true, reason: 'aborted_bridge_request', killed_desktop: false })
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

async function findSession(ctx, sessionId) {
  const rows = await readSessionRows(ctx.sessionController)
  return rows.find((item) => (item.sessionId || item.id) === sessionId) || null
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
