/**
 * Host plugin behaviour tests, against official Desktop shapes
 * (`sessionId`, `readSession` snapshot, `{ accepted: true }`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { compareMembership } from '../host_read.js'
import { apply } from '../index.js'
import { decideListen, discoverCatalog, selectGrant } from '../policy.js'
import { SECRET, WORKSPACE, call, close, officialCtx, startServer } from './fixtures.js'

test('allowlist hides other workspaces and sessions', async () => {
  const ctx = officialCtx()
  const initial = {
    version: 1,
    workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'read', cwd: 'C:/work/demo', profile: 'desktop' }],
  }
  const started = await startServer(ctx, { initial })
  const workspaces = await call(started.port, 'GET', '/v1/workspaces')
  assert.deepEqual(workspaces.body.workspaces.map((item) => item.id), [WORKSPACE])
  const sessions = await call(started.port, 'GET', '/v1/sessions?workspace_id=ws-other')
  assert.equal(sessions.body.ok, false)
  assert.equal(sessions.body.reason, 'workspace_not_allowlisted')
  const granted = await call(started.port, 'GET', '/v1/granted')
  assert.deepEqual(granted.body.sessions.map((item) => item.session_id), ['session-demo'])
  await close(started.server)
})

test('history is paged and redacted and does not grant', async () => {
  const ctx = officialCtx()
  const initial = {
    version: 1,
    workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'read', cwd: 'C:/work/demo', profile: 'desktop' }],
  }
  const started = await startServer(ctx, { initial })
  const page = await call(started.port, 'GET', '/v1/history?session_id=session-demo&offset=2&limit=1')
  assert.equal(page.body.source, 'desktop_session')
  assert.equal(page.body.total, 4)
  assert.equal(page.body.events.length, 1)
  assert.equal(page.body.events[0].text.includes('sk-'), false)
  assert.equal(page.body.events[0].text.includes('[redacted]'), true)
  assert.equal(page.body.has_more, true)
  await close(started.server)
})

test('resume keeps the original session and does not set a model', async () => {
  const ctx = officialCtx()
  const initial = {
    version: 1,
    workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' }],
  }
  const started = await startServer(ctx, { initial })
  const body = { workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-resume', text: 'continue the same session' }
  const first = await call(started.port, 'POST', '/v1/resume', body)
  const second = await call(started.port, 'POST', '/v1/resume', body)
  assert.equal(first.body.accepted, true)
  assert.equal(first.body.session_id, 'session-demo')
  assert.equal(first.body.model_selection, 'session_recorded_not_overridden')
  assert.equal(second.body.session_id, 'session-demo')
  assert.equal(ctx.state.prompts, 1)
  assert.deepEqual(ctx.state.promptRequestIds, ['req-resume'])
  await close(started.server)
})

test('busy session is refused and not cancelled', async () => {
  const ctx = officialCtx()
  const initial = {
    version: 1,
    workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessionAllowlist: [{ sessionId: 'session-busy', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' }],
  }
  const started = await startServer(ctx, { initial })
  const result = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-busy', profile: 'desktop', request_id: 'req-busy', text: 'go',
  })
  assert.equal(result.body.accepted, false)
  assert.equal(result.body.reason, 'busy')
  assert.match(result.body.detail, /not cancelled/)
  assert.equal(ctx.state.prompts, 0)
  assert.equal(ctx.state.cancelled, 0)
  await close(started.server)
})

test('cross profile is an error and does not rewrite the session', async () => {
  const ctx = officialCtx()
  ctx.state.sessions[0].profile = 'headless'
  const initial = {
    version: 1,
    workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' }],
  }
  const started = await startServer(ctx, { initial })
  const result = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-cross', text: 'go',
  })
  assert.equal(result.body.reason, 'cross_profile')
  assert.equal(ctx.state.sessions[0].profile, 'headless')
  const history = await call(started.port, 'GET', '/v1/history?session_id=session-demo')
  assert.equal(history.body.reason, 'cross_profile')
  await close(started.server)
})

test('missing desktop services do not open a port', () => {
  const result = apply({}, { secretEnv: 'DSH_BRIDGE_HOST_SECRET' })
  assert.equal(result.listening, false)
  assert.match(result.reason, /not mounted/)
})

test('missing auth is rejected', async () => {
  const started = await startServer(officialCtx(), { initial: {} })
  const response = await fetch(`http://127.0.0.1:${started.port}/v1/health`)
  assert.equal(response.status, 401)
  const crossOrigin = await fetch(`http://127.0.0.1:${started.port}/v1/health`, {
    headers: { authorization: `Bearer ${SECRET}`, origin: 'http://evil.example' },
  })
  assert.equal(crossOrigin.status, 403)
  await close(started.server)
})

test('empty configuration does not listen and discovery is not execution', () => {
  const silent = decideListen({ services: true, hostSecret: '', allowlistCount: 0, bootstrap: null, bind: '127.0.0.1', now: 1 })
  assert.equal(silent.listening, false)
  const catalog = discoverCatalog(
    [{ id: WORKSPACE, title: 'demo', path: 'C:/work/demo' }],
    [{ sessionId: 'session-demo', title: 'Old chat', cwd: 'C:/work/demo', model: 'example-model', provider: 'example-provider', running: true, text: 'sk-supersecretvalue' }],
  )
  assert.equal(JSON.stringify(catalog).includes('sk-'), false)
  assert.equal(catalog.sessions[0].text, undefined)
  assert.equal(catalog.grants_execution, false)
  const busy = selectGrant(catalog, { session_id: 'session-demo', access: 'write' })
  assert.equal(busy.ok, false)
  assert.equal(busy.reason, 'busy')
  assert.equal(catalog.source, 'desktop_metadata')
})

test('selectGrant only accepts a registered top-level session', () => {
  const catalog = {
    workspaces: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessions: [{ session_id: 'session-demo', workspace_id: WORKSPACE, cwd: 'C:/work/demo', profile: 'desktop', busy: false }],
  }
  const chosen = selectGrant(catalog, { session_id: 'session-demo', access: 'read' })
  assert.equal(chosen.ok, true)
  assert.equal(chosen.session.access, 'read')
  assert.equal(chosen.started_task, false)
  assert.equal(chosen.model_changed, false)
  assert.equal(selectGrant(catalog, { session_id: 'session-unknown', access: 'read' }).reason, 'unknown_session')
})

test('bootstrap lists metadata and then revokes itself', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, {
    secret: { host: SECRET, bootstrap: 'bootstrap-secret-0123456789abcdef', expiresAt: Date.now() + 60_000, consumed: false },
  })
  const headers = { authorization: 'Bearer bootstrap-secret-0123456789abcdef', 'content-type': 'application/json' }
  const catalog = await fetch(`http://127.0.0.1:${started.port}/v1/bootstrap/catalog`, { headers })
  const listed = await catalog.json()
  assert.equal(listed.includes_history, false)
  assert.equal(listed.sessions.some((item) => item.title === 'Demo chat'), true)
  const history = await fetch(`http://127.0.0.1:${started.port}/v1/history?session_id=session-demo`, { headers })
  assert.equal(history.status, 403)
  const selected = await fetch(`http://127.0.0.1:${started.port}/v1/bootstrap/select`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ session_id: 'session-demo', access: 'read' }),
  })
  const body = await selected.json()
  assert.equal(body.ok, true)
  assert.equal(body.allowlist.sessionAllowlist[0].model, 'example-model')
  assert.equal(ctx.state.prompts, 0)
  const again = await fetch(`http://127.0.0.1:${started.port}/v1/bootstrap/catalog`, { headers })
  assert.equal(again.status, 403)
  assert.equal((await again.json()).reason, 'bootstrap_consumed')
  await close(started.server)
})

test('official list shape and a single bad row do not erase the catalog', async () => {
  const ctx = officialCtx()
  ctx.sessionController.list = async (request, signal) => {
    if (!signal) throw new TypeError('signal required')
    return {
      items: [
        {
          sessionId: 'session-demo',
          cwd: 'C:/work/demo',
          running: false,
          agentAvailable: true,
          projections: { kind: 'cached', asOfSeq: 9, values: { title: 'Demo chat', modelSelection: { lastUsed: null, next: { provider: 'example-provider', model: 'example-model' } } } },
        },
        { title: 'broken row' },
      ],
    }
  }
  const started = await startServer(ctx, {
    secret: { host: SECRET, bootstrap: 'bootstrap-secret-0123456789abcdef', expiresAt: Date.now() + 60_000, consumed: false },
  })
  const response = await fetch(`http://127.0.0.1:${started.port}/v1/bootstrap/catalog`, {
    headers: { authorization: 'Bearer bootstrap-secret-0123456789abcdef' },
  }).then(async (item) => ({ body: await item.json() }))
  assert.equal(response.body.session_status, 'ok')
  assert.equal(response.body.sessions.some((item) => item.title === 'Demo chat'), true)
  assert.equal(response.body.warnings.some((item) => item.code === 'missing_field'), true)
  await close(started.server)
})

test('a failed session list is not an empty history', async () => {
  const ctx = officialCtx()
  ctx.sessionController.list = async () => {
    throw new TypeError('sessionController.list is not a function')
  }
  const started = await startServer(ctx, {
    secret: { host: SECRET, bootstrap: 'bootstrap-secret-0123456789abcdef', expiresAt: Date.now() + 60_000, consumed: false },
  })
  const response = await fetch(`http://127.0.0.1:${started.port}/v1/bootstrap/catalog`, {
    headers: { authorization: 'Bearer bootstrap-secret-0123456789abcdef' },
  }).then(async (item) => ({ body: await item.json() }))
  assert.equal(response.body.session_status, 'read_failed')
  assert.equal(response.body.sessions, null)
  assert.equal(response.body.not_an_empty_history, true)
  assert.equal(response.body.warnings[0].code, 'method_missing')
  await close(started.server)
})

test('registered sessions keep a title and workspace without listing removed directories', async () => {
  const ctx = officialCtx()
  ctx.workspaceRegistry.list = () => [{
    id: 'ws-broadcast',
    title: 'example-workspace',
    path: 'D:/work/broadcast',
    sessionIds: ['session-top'],
  }]
  ctx.sessionController.list = async (request, signal) => {
    if (!signal) throw new TypeError('signal required')
    return {
      items: [
        {
          sessionId: 'session-top',
          cwd: 'D:/work/broadcast',
          running: false,
          agentAvailable: false,
          projections: { kind: 'cached', asOfSeq: 4, values: { title: '客服复盘', modelSelection: { lastUsed: { provider: 'example-provider', model: 'example-model' }, next: { provider: 'example-provider', model: 'example-model' } } } },
        },
        { sessionId: 'session-removed', cwd: 'D:/old', running: false, agentAvailable: false },
      ],
    }
  }
  const started = await startServer(ctx, {
    secret: { host: SECRET, bootstrap: 'bootstrap-secret-0123456789abcdef', expiresAt: Date.now() + 60_000, consumed: false },
  })
  const response = await fetch(`http://127.0.0.1:${started.port}/v1/bootstrap/catalog`, {
    headers: { authorization: 'Bearer bootstrap-secret-0123456789abcdef' },
  }).then(async (item) => ({ body: await item.json() }))
  assert.deepEqual(response.body.sessions.map((item) => item.session_id), ['session-top'])
  assert.equal(response.body.sessions[0].title, '客服复盘')
  assert.equal(response.body.sessions[0].workspace_id, 'ws-broadcast')
  assert.equal(response.body.sessions[0].model, 'example-model')
  assert.equal(response.body.sessions[0].provider, 'example-provider')
  assert.equal(response.body.omitted_unregistered, 1)
  const membership = await fetch(`http://127.0.0.1:${started.port}/v1/guard/membership`, {
    headers: { authorization: 'Bearer bootstrap-secret-0123456789abcdef' },
  }).then(async (item) => item.json())
  assert.deepEqual(membership.workspaces[0].top_level, ['session-top'])
  assert.deepEqual(membership.workspaces[0].unreadable, [])
  await close(started.server)
})

test('subagents stay under their parent across an upgrade', () => {
  const children = Array.from({ length: 31 }, (_, index) => ({ id: `child-${index}`, parent: 'session-parent' }))
  const before = {
    status: 'ok',
    workspaces: [{ id: 'ws-broadcast', top_level: ['s1', 's2', 's3', 's4', 's5', 's6'], subagent: children, unreadable: [] }],
  }
  const after = JSON.parse(JSON.stringify(before))
  assert.equal(compareMembership(before, after).ok, true)
  after.workspaces[0].top_level.push(children[0].id)
  after.workspaces[0].subagent = children.slice(1)
  const hoisted = compareMembership(before, after)
  assert.equal(hoisted.ok, false)
  assert.equal(hoisted.hoisted[0].session_id, 'child-0')
  const lost = compareMembership(before, { status: 'ok', workspaces: [{ id: 'ws-broadcast', top_level: ['s1'], subagent: children, unreadable: [] }] })
  assert.equal(lost.ok, false)
  assert.equal(lost.missing.some((item) => item.session_id === 's2'), true)
  assert.equal(compareMembership(before, { status: 'read_failed', workspaces: [] }).reason, 'read_failed')
})

test('cancel aborts only the bridge request and says the desktop turn is kept', async () => {
  const ctx = officialCtx()
  ctx.sessionController.prompt = async (body, signal) => {
    ctx.state.prompts += 1
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
    return { accepted: true }
  }
  const initial = {
    version: 1,
    workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' }],
  }
  const started = await startServer(ctx, { initial, pollIntervalMs: 50 })
  const pending = call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-cancel', text: 'go',
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const cancelled = await call(started.port, 'POST', '/v1/cancel', { request_id: 'req-cancel' })
  const result = await pending
  assert.equal(cancelled.body.confirmed, true)
  assert.equal(cancelled.body.killed_desktop, false)
  assert.equal(cancelled.body.desktop_turn_kept, true)
  assert.match(cancelled.body.note, /stops this wait only/)
  assert.equal(result.body.reason, 'cancelled')
  assert.equal(result.body.desktop_turn_kept, null)
  assert.equal(ctx.state.cancelled, 0)
  await close(started.server)
})
