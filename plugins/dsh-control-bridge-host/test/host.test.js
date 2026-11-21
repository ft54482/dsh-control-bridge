import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { apply } from '../index.js'
import { decideResume, pageHistory, promptBody } from '../policy.js'
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
