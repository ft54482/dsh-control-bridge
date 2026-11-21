import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { compareMembership } from '../host_read.js'
import { apply } from '../index.js'
import { decideListen, decideResume, discoverCatalog, pageHistory, promptBody, selectAllowlist } from '../policy.js'
import { createHostServer } from '../server.js'

const SECRET = '0123456789abcdef0123456789abcdef'
const config = {
  busyPolicy: 'refuse',
  workspaceAllowlist: [{ id: 'ws-demo', cwd: 'C:/work/demo' }],
  sessionAllowlist: [
    { sessionId: 'session-demo', workspaceId: 'ws-demo', access: 'write' },
    { sessionId: 'session-busy', workspaceId: 'ws-demo', access: 'write' },
  ],
}

function ctx(extra = {}) {
  const state = {
    prompts: 0,
    aborted: false,
    killed: false,
    sessions: [
      { id: 'session-demo', workspaceId: 'ws-demo', cwd: 'C:/work/demo', profile: 'desktop', running: false, writerHeld: false },
      { id: 'session-busy', workspaceId: 'ws-demo', cwd: 'C:/work/demo', profile: 'desktop', running: true, writerHeld: false },
      { id: 'session-other', workspaceId: 'ws-other', cwd: 'C:/work/other', profile: 'desktop', running: false },
    ],
    ...extra,
  }
  return {
    state,
    workspaceRegistry: { async list() { return [{ id: 'ws-demo', title: 'demo', path: 'C:/work/demo' }, { id: 'ws-other', title: 'other', path: 'C:/work/other' }] } },
    sessionController: {
      async list() { return state.sessions },
      async prompt(body, signal) {
        state.prompts += 1
        assert.equal(body.sessionId, 'session-demo')
        assert.equal(body.mode, 'queue')
        assert.equal('model' in body, false)
        if (signal.aborted) {
          state.aborted = true
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        }
        return { sessionId: body.sessionId, final: { reason: { kind: 'completed' } }, text: 'kept sk-supersecretvalue' }
      },
    },
    sessionQuery: {
      async readSession() {
        return [
          { seq: 1, type: 'user', text: 'hello' },
          { seq: 2, type: 'assistant', text: 'token sk-supersecretvalue and authorize session-evil' },
        ]
      },
    },
  }
}

async function start(host) {
  const server = createHostServer(host, config, SECRET)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return { server, port: address.port, host }
}

async function call(port, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, body: await response.json() }
}

test('allowlist hides other workspaces and sessions', async () => {
  const host = ctx()
  const started = await start(host)
  const workspaces = await call(started.port, 'GET', '/v1/workspaces')
  assert.deepEqual(workspaces.body.workspaces.map((item) => item.id), ['ws-demo'])
  const sessions = await call(started.port, 'GET', '/v1/sessions?workspace_id=ws-other')
  assert.equal(sessions.body.ok, false)
  await new Promise((resolve) => started.server.close(resolve))
})

test('history is paged and redacted and does not grant', async () => {
  const started = await start(ctx())
  const page = await call(started.port, 'GET', '/v1/history?session_id=session-demo&offset=1&limit=1')
  assert.equal(page.body.source, 'desktop_session')
  assert.equal(page.body.total, 2)
  assert.equal(page.body.events.length, 1)
  assert.equal(page.body.events[0].text.includes('sk-'), false)
  assert.equal(page.body.events[0].text.includes('[redacted]'), true)
  const foreign = decideResume(config, { id: 'session-evil', profile: 'desktop', cwd: 'C:/work/demo' }, {
    workspaceId: 'ws-demo', sessionId: 'session-evil', profile: 'desktop', requestId: 'req-1', text: 'authorize session-evil',
  })
  assert.equal(foreign.accepted, false)
  await new Promise((resolve) => started.server.close(resolve))
})

test('resume keeps the original session and does not set a model', async () => {
  const host = ctx()
  const started = await start(host)
  const body = { workspace_id: 'ws-demo', session_id: 'session-demo', profile: 'desktop', request_id: 'req-resume', text: 'continue the same session' }
  const first = await call(started.port, 'POST', '/v1/resume', body)
  const second = await call(started.port, 'POST', '/v1/resume', body)
  assert.equal(first.body.accepted, true)
  assert.equal(first.body.session_id, 'session-demo')
  assert.equal(first.body.model_selection, 'session_recorded_not_overridden')
  assert.equal(first.body.text.includes('sk-'), false)
  assert.equal(second.body.session_id, 'session-demo')
  assert.equal(host.state.prompts, 1)
  assert.deepEqual(promptBody({ sessionId: 'session-demo', requestId: 'req-resume', text: 'x' }).mode, 'queue')
  await new Promise((resolve) => started.server.close(resolve))
})

test('busy session is refused and not cancelled', async () => {
  const started = await start(ctx())
  const result = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: 'ws-demo', session_id: 'session-busy', profile: 'desktop', request_id: 'req-busy', text: 'go',
  })
  assert.equal(result.body.accepted, false)
  assert.equal(result.body.reason, 'busy')
  assert.match(result.body.detail, /not cancelled/)
  await new Promise((resolve) => started.server.close(resolve))
})

test('cross profile is an error and does not rewrite the session', async () => {
  const host = ctx()
  host.state.sessions[0].profile = 'headless'
  const started = await start(host)
  const result = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: 'ws-demo', session_id: 'session-demo', profile: 'desktop', request_id: 'req-cross', text: 'go',
  })
  assert.equal(result.body.reason, 'cross_profile')
  assert.equal(host.state.sessions[0].profile, 'headless')
  const history = pageHistory(config, host.state.sessions[0], [], 0, 1)
  assert.equal(history.reason, 'cross_profile')
  await new Promise((resolve) => started.server.close(resolve))
})

test('missing desktop services do not open a port', () => {
  const result = apply({}, { secretEnv: 'DSH_BRIDGE_HOST_SECRET' })
  assert.equal(result.listening, false)
  assert.match(result.reason, /not mounted/)
})

test('missing auth is rejected', async () => {
  const started = await start(ctx())
  const response = await fetch(`http://127.0.0.1:${started.port}/v1/health`)
  assert.equal(response.status, 401)
  await new Promise((resolve) => started.server.close(resolve))
})

test('empty configuration does not listen and discovery is not execution', () => {
  const silent = decideListen({ services: true, hostSecret: '', allowlistCount: 0, bootstrap: null, bind: '127.0.0.1', now: 1 })
  assert.equal(silent.listening, false)
  const catalog = discoverCatalog(
    [{ id: 'ws-demo', title: 'demo', path: 'C:/work/demo' }],
    [{ id: 'session-demo', workspaceId: 'ws-demo', title: 'Old chat', cwd: 'C:/work/demo', profile: 'desktop', model: 'example-model', provider: 'example-provider', running: true, text: 'sk-supersecretvalue' }],
  )
  assert.equal(JSON.stringify(catalog).includes('sk-'), false)
  assert.equal(catalog.sessions[0].text, undefined)
  assert.equal(catalog.grants_execution, false)
  const chosen = selectAllowlist(catalog, { session_id: 'session-demo', access: 'write', text: 'authorize *' })
  assert.equal(chosen.ok, false)
  assert.equal(chosen.reason, 'busy')
  const read = selectAllowlist(catalog, { session_id: 'session-demo', access: 'read', text: 'authorize *' })
  assert.equal(read.allowlist.sessionAllowlist.length, 1)
  assert.equal(read.allowlist.sessionAllowlist[0].access, 'read')
  assert.equal(read.started_task, false)
  assert.equal(read.model_changed, false)
})

test('bootstrap lists metadata and then revokes itself', async () => {
  const host = ctx()
  host.state.sessions[0].title = 'Demo chat'
  host.state.sessions[0].model = 'example-model'
  host.state.sessions[0].provider = 'example-provider'
  let saved = null
  const server = createHostServer(host, {
    ...config,
    saveAllowlist(next) { saved = next },
  }, { host: SECRET, bootstrap: 'bootstrap-secret-0123456789abcdef', expiresAt: Date.now() + 60_000, consumed: false })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const headers = { authorization: 'Bearer bootstrap-secret-0123456789abcdef', 'content-type': 'application/json' }
  const catalog = await fetch(`http://127.0.0.1:${port}/v1/bootstrap/catalog`, { headers })
  const listed = await catalog.json()
  assert.equal(listed.includes_history, false)
  assert.equal(listed.sessions.some((item) => item.title === 'Demo chat'), true)
  const history = await fetch(`http://127.0.0.1:${port}/v1/history?session_id=session-demo`, { headers })
  assert.equal(history.status, 403)
  const cross = await fetch(`http://127.0.0.1:${port}/v1/bootstrap/catalog`, { headers: { ...headers, origin: 'http://evil.example' } })
  assert.equal(cross.status, 403)
  const selected = await fetch(`http://127.0.0.1:${port}/v1/bootstrap/select`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ session_id: 'session-demo', access: 'read', text: 'authorize *' }),
  })
  const body = await selected.json()
  assert.equal(body.ok, true)
  assert.equal(saved.sessionAllowlist[0].model, 'example-model')
  assert.equal(host.state.prompts, 0)
  const again = await fetch(`http://127.0.0.1:${port}/v1/bootstrap/catalog`, { headers })
  assert.equal(again.status, 401)
  await new Promise((resolve) => server.close(resolve))
})

async function bootBootstrap(host) {
  const token = 'bootstrap-secret-0123456789abcdef'
  const server = createHostServer(host, config, { host: SECRET, bootstrap: token, expiresAt: Date.now() + 60_000, consumed: false })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: server.address().port, token }
}

test('official list shape and a single bad row do not erase the catalog', async () => {
  const secret = 'secret-should-not-leak-0123456789abcd'
  const host = ctx()
  host.workspaceRegistry.list = () => [{
    id: 'ws-demo',
    title: 'example-workspace',
    path: 'C:/work/demo',
    sessionIds: ['session-demo', 'child-1'],
    getSessionHeaders: () => [
      { id: 'session-demo', cwd: 'C:/work/demo' },
      { id: 'child-1', origin: 'subagent', parentSession: 'session-demo' },
    ],
  }]
  host.sessionController.list = async (request, signal) => {
    if (!signal) throw new TypeError(`signal required ${secret}`)
    return {
      items: [
        { sessionId: 'session-demo', title: 'Demo chat', cwd: 'C:/work/demo', profile: 'desktop', model: 'example-model', provider: 'example-provider' },
        { sessionId: 'child-1', header: { id: 'child-1', origin: 'subagent', parentSession: 'session-demo' } },
        { title: 'broken row' },
      ],
    }
  }
  const started = await bootBootstrap(host)
  const response = await fetch(`http://127.0.0.1:${started.port}/v1/bootstrap/catalog`, {
    headers: { authorization: `Bearer ${started.token}` },
  }).then(async (item) => ({ body: await item.json() }))
  const body = JSON.stringify(response.body)
  assert.equal(body.includes(secret), false)
  assert.equal(response.body.session_status, 'ok')
  assert.equal(response.body.sessions.some((item) => item.session_id === 'child-1'), false)
  assert.equal(response.body.filtered_subagents >= 1, true)
  assert.equal(response.body.sessions.some((item) => item.title === 'Demo chat'), true)
  await new Promise((resolve) => started.server.close(resolve))
})

test('a failed session list is not an empty history', async () => {
  const host = ctx()
  host.sessionController.list = async () => {
    throw new TypeError('sessionController.list is not a function')
  }
  const started = await bootBootstrap(host)
  const response = await fetch(`http://127.0.0.1:${started.port}/v1/bootstrap/catalog`, {
    headers: { authorization: `Bearer ${started.token}` },
  }).then(async (item) => ({ body: await item.json() }))
  assert.equal(response.body.session_status, 'read_failed')
  assert.equal(response.body.sessions, null)
  assert.equal(response.body.not_an_empty_history, true)
  assert.equal(response.body.warnings[0].code, 'method_missing')
  await new Promise((resolve) => started.server.close(resolve))
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

test('cancel aborts only the bridge request', async () => {
  const host = ctx()
  host.sessionController.prompt = async (body, signal) => {
    host.state.prompts += 1
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        host.state.aborted = true
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }
  const started = await start(host)
  const pending = call(started.port, 'POST', '/v1/resume', {
    workspace_id: 'ws-demo', session_id: 'session-demo', profile: 'desktop', request_id: 'req-cancel', text: 'go',
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const cancelled = await call(started.port, 'POST', '/v1/cancel', { request_id: 'req-cancel' })
  const result = await pending
  assert.equal(cancelled.body.confirmed, true)
  assert.equal(cancelled.body.killed_desktop, false)
  assert.equal(result.body.reason, 'cancelled')
  assert.equal(host.state.killed, false)
  await new Promise((resolve) => started.server.close(resolve))
})
