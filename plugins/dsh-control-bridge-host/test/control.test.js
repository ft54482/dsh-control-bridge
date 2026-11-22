/**
 * Regression for the 0.2.0 control-plane features:
 *   - durable request journal, long-poll / SSE / wait with retry-safe seq;
 *   - provider/model catalog and per-session reasoning-effort control;
 *   - read-only discovery across every registered workspace.
 *
 * All of it runs against the official 0.2.2 controller fixture and a real
 * loopback server; none of it is a live Desktop result.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { BOOTSTRAP, SECRET, WORKSPACE, call, close, officialCtx, startServer } from './fixtures.js'

const WRITE_DEMO = {
  version: 1,
  workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
  sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' }],
}

const SESSION = 'session-demo'

function resumeBody(requestId, extra = {}) {
  return { workspace_id: WORKSPACE, session_id: SESSION, profile: 'desktop', request_id: requestId, text: 'go', ...extra }
}

function endOpenTurn(ctx) {
  const open = [...ctx.state.events].reverse().find((event) => event.type === 'turn/start')
  assert.ok(open, 'a turn must be open')
  ctx.state.events.push({
    seq: ++ctx.state.seq,
    type: 'turn/end',
    time: Date.now(),
    data: { turn: open.data && open.data.turn, reason: { kind: 'completed' } },
  })
}

test('wait:false returns the accepted record, and the task result survives the wait ending', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const accepted = await call(started.port, 'POST', '/v1/resume', resumeBody('req-async', { wait: false }))
  assert.equal(accepted.status, 202)
  assert.equal(accepted.body.accepted, true)
  assert.equal(accepted.body.completed, false)
  assert.equal(accepted.body.phase, 'accepted')
  assert.equal(accepted.body.wait, 'none')

  const waited = await call(started.port, 'GET', `/v1/requests/req-async/wait?timeout_ms=3000`)
  assert.equal(waited.status, 200)
  assert.equal(waited.body.completed, true)
  assert.equal(waited.body.terminal, 'completed')
  assert.equal(waited.body.request_id, 'req-async')
  assert.equal(waited.body.query, true)
  await close(started.server)
})

test('the event journal exposes monotonic seqs, appends the terminal event, and resumes with after_seq', async () => {
  const ctx = officialCtx({ holdTurn: true })
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const accepted = await call(started.port, 'POST', '/v1/resume', resumeBody('req-journal', { wait: false }))
  assert.equal(accepted.status, 202)

  const first = await call(started.port, 'GET', `/v1/requests/req-journal/events?after_seq=0&timeout_ms=3000`)
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.phase, 'accepted')
  assert.ok(first.body.seq >= 1)
  const kinds = first.body.events.map((event) => event.kind)
  assert.ok(kinds.includes('recorded'))
  assert.ok(kinds.includes('accepted'))
  assert.equal(first.body.events.some((event) => event.kind === 'terminal'), false)

  endOpenTurn(ctx)
  const second = await call(started.port, 'GET', `/v1/requests/req-journal/events?after_seq=${first.body.seq}&timeout_ms=5000`)
  assert.equal(second.status, 200)
  assert.equal(second.body.terminal_phase, true)
  assert.equal(second.body.terminal, 'completed')
  const terminal = second.body.events.find((event) => event.kind === 'terminal')
  assert.ok(terminal)
  assert.equal(terminal.terminal, 'completed')
  assert.ok(second.body.events.every((event) => event.seq > first.body.seq))
  await close(started.server)
})

test('SSE streams heartbeat/seq frames and closes with an end event after the official turn ends', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const accepted = await call(started.port, 'POST', '/v1/resume', resumeBody('req-sse', { wait: false }))
  assert.equal(accepted.status, 202)

  const response = await fetch(`http://127.0.0.1:${started.port}/v1/requests/req-sse/stream`, {
    headers: { authorization: `Bearer ${SECRET}`, accept: 'text/event-stream' },
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 2_000)),
    ])
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    if (buffer.includes('event: end')) break
  }
  try { await reader.cancel() } catch { /* already closed */ }
  assert.match(buffer, /^retry: 1000/m)
  assert.match(buffer, /^id: \d+$/m)
  assert.match(buffer, /^event: request$/m)
  assert.match(buffer, /^event: end$/m)
  assert.match(buffer, /"terminal":"completed"/)
  await close(started.server)
})

test('a stored request is still queryable with its terminal result after a Host restart', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const accepted = await call(started.port, 'POST', '/v1/resume', resumeBody('req-restart', { wait: false }))
  assert.equal(accepted.status, 202)
  await close(started.server)

  const second = await startServer(ctx, {
    store: started.store,
    file: started.file,
    dir: started.dir,
    requestsFile: started.requestsFile,
  })
  const queried = await call(second.port, 'GET', `/v1/requests?request_id=req-restart&session_id=${SESSION}`)
  assert.equal(queried.status, 200)
  assert.equal(queried.body.completed, true)
  assert.equal(queried.body.terminal, 'completed')
  await close(second.server)
})

test('the model catalog reports official reasoning efforts, and unknown when the deployment cannot enumerate them', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const unknown = await call(started.port, 'GET', '/v1/model-catalog')
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.ok, true)
  assert.equal(unknown.body.effort_source, 'unknown')
  assert.equal(unknown.body.providers[0].models[0].reasoning_efforts, null)
  assert.equal(unknown.body.providers[0].models[0].reasoning_efforts_source, 'unknown')

  ctx.state.modelEfforts = { 'example-model': ['low', 'high'] }
  const known = await call(started.port, 'GET', '/v1/model-catalog')
  assert.equal(known.body.effort_source, 'official')
  assert.deepEqual(known.body.providers[0].models[0].reasoning_efforts, ['low', 'high'])
  await close(started.server)
})

test('model control rejects an unadvertised effort and clears an old effort instead of inheriting it', async () => {
  const ctx = officialCtx()
  ctx.state.modelEfforts = { 'example-model': ['low', 'high'] }
  const started = await startServer(ctx, { initial: WRITE_DEMO })

  const rejected = await call(started.port, 'POST', '/v1/model', {
    session_id: SESSION, provider: 'example-provider', model: 'example-model', reasoning_effort: 'medium',
  })
  assert.equal(rejected.status, 409)
  assert.equal(rejected.body.reason, 'unsupported_reasoning_effort')
  assert.deepEqual(rejected.body.supported_reasoning_efforts, ['low', 'high'])
  assert.deepEqual(ctx.state.selectCalls, [])

  const high = await call(started.port, 'POST', '/v1/model', {
    session_id: SESSION, provider: 'example-provider', model: 'example-model', reasoning_effort: 'high',
  })
  assert.equal(high.status, 200)
  assert.equal(high.body.confirmed.reasoningEffort, 'high')
  assert.equal(high.body.effort_cleared, false)

  const highTurn = await call(started.port, 'POST', '/v1/resume', resumeBody('req-effort-high', {
    model: { provider: 'example-provider', model: 'example-model', reasoning_effort: 'high' },
  }))
  assert.equal(highTurn.status, 200)
  assert.equal(highTurn.body.confirmed_selection.reasoningEffort, 'high')
  assert.equal(highTurn.body.execution_model.reasoningEffort, 'high')
  assert.equal(highTurn.body.effort_match, true)
  assert.equal(highTurn.body.effort_verified, true)
  assert.equal(highTurn.body.model_match, true)

  // Clear the effort explicitly: the next request must not inherit "high".
  const cleared = await call(started.port, 'POST', '/v1/model', {
    session_id: SESSION, provider: 'example-provider', model: 'example-model', reasoning_effort: null,
  })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.effort_cleared, true)
  assert.equal('reasoningEffort' in cleared.body.confirmed, false)

  const plain = await call(started.port, 'POST', '/v1/resume', resumeBody('req-effort-cleared'))
  assert.equal(plain.status, 200)
  assert.equal(plain.body.completed, true)
  assert.equal('reasoningEffort' in plain.body.confirmed_selection, false)
  await close(started.server)
})

test('model_match reports an effort mismatch instead of comparing the route only', async () => {
  const ctx = officialCtx()
  ctx.state.modelEfforts = { 'example-model': ['low', 'high'] }
  // The adapter really executed a different effort than the confirmed one.
  ctx.state.requestHeaderConfig = { provider: 'example-provider', model: 'example-model', reasoningEffort: 'low' }
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const result = await call(started.port, 'POST', '/v1/resume', resumeBody('req-effort-mismatch', {
    model: { provider: 'example-provider', model: 'example-model', reasoning_effort: 'high' },
  }))
  assert.equal(result.status, 200)
  assert.equal(result.body.route_match, true)
  assert.equal(result.body.effort_match, false)
  assert.equal(result.body.model_match, false)
  assert.equal(result.body.terminal, 'model_mismatch')
  assert.equal(result.body.model_mismatch, 'reasoning_effort')
  await close(started.server)
})

test('discovery lists every registered workspace and session without reading history', async () => {
  const ctx = officialCtx()
  ctx.state.sessions.find((row) => row.sessionId === 'session-plain').projections = {
    kind: 'cached',
    asOfSeq: 6,
    values: { title: 'Plain chat', sessionState: 'input-required' },
  }
  const started = await startServer(ctx, {
    initial: WRITE_DEMO,
    secret: { host: SECRET, bootstrap: BOOTSTRAP, expiresAt: Date.now() + 60_000, consumed: false },
  })
  const first = await call(started.port, 'GET', '/v1/discover?limit=2')
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.source, 'official_registry_all_workspaces')
  assert.equal(first.body.includes_history, false)
  assert.equal(first.body.total, 5)
  assert.equal(first.body.items.length, 2)
  assert.deepEqual(first.body.workspaces.map((item) => item.id), [WORKSPACE])
  assert.equal(first.body.workspaces[0].sessions_total, 4)
  assert.equal(first.body.counts.subagent, 1)
  assert.equal(first.body.counts.top, 4)
  assert.equal(first.body.status_counts.running, 1)
  assert.equal(first.body.status_counts.waiting_input, 1)

  const second = await call(started.port, 'GET', '/v1/discover?limit=10&offset=2')
  assert.equal(second.body.items.length, 3)
  const all = [...first.body.items, ...second.body.items]
  const ids = all.map((item) => item.session_id)
  assert.equal(new Set(ids).size, 5)
  const child = all.find((item) => item.session_id === 'session-child')
  assert.equal(child.kind, 'subagent')
  assert.equal(child.parent, 'session-demo')
  const removed = all.find((item) => item.session_id === 'session-removed')
  assert.equal(removed.workspace_id, '')
  assert.equal(removed.cwd, 'C:/elsewhere')
  assert.equal(removed.cwd_source, 'session_row')
  const plain = all.find((item) => item.session_id === 'session-plain')
  assert.equal(plain.status, 'waiting_input')
  assert.equal(plain.status_source, 'projection')

  const denied = await call(started.port, 'GET', '/v1/discover', null, BOOTSTRAP)
  assert.equal(denied.status, 403)
  assert.equal(denied.body.reason, 'host_secret_required')
  await close(started.server)
})

test('a prompt written before its own turn/start is still attributed to the new turn, not the previous answer', async () => {
  const ctx = officialCtx()
  // Official ordering: prompt() records user/message at admission; turn/start
  // comes later. The fixture's earlier turn is already finished.
  ctx.sessionController.prompt = async (body) => {
    ctx.state.prompts += 1
    ctx.state.events.push({
      seq: ++ctx.state.seq,
      type: 'user/message',
      time: Date.now(),
      data: { content: body.content || [], source: { kind: 'user', rpcId: body.requestId } },
    })
    ctx.state.events.push({ seq: ++ctx.state.seq, type: 'turn/start', time: Date.now(), data: { turn: 50 } })
    ctx.state.events.push({
      seq: ++ctx.state.seq,
      type: 'assistant/message',
      time: Date.now(),
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'new answer' }] } },
    })
    ctx.state.events.push({ seq: ++ctx.state.seq, type: 'turn/end', time: Date.now(), data: { turn: 50, reason: { kind: 'completed' } } })
    return { accepted: true }
  }
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const accepted = await call(started.port, 'POST', '/v1/resume', resumeBody('req-queued', { wait: false }))
  assert.equal(accepted.status, 202)
  const waited = await call(started.port, 'GET', '/v1/requests/req-queued/wait?timeout_ms=3000')
  assert.equal(waited.status, 200)
  assert.equal(waited.body.completed, true)
  assert.equal(waited.body.turn, 50)
  assert.match(waited.body.text, /new answer/)
  assert.doesNotMatch(waited.body.text, /earlier answer/)

  const events = await call(started.port, 'GET', '/v1/requests/req-queued/events?after_seq=0&timeout_ms=1000')
  assert.equal(events.body.terminal_phase, true)
  assert.equal(events.body.terminal, 'completed')
  await close(started.server)
})

test('a read while a queued prompt has no turn yet does not strand the request in unknown', async () => {
  const ctx = officialCtx()
  ctx.sessionController.prompt = async (body) => {
    ctx.state.prompts += 1
    ctx.state.promptRequestIds.push(body.requestId)
    ctx.state.events.push({
      seq: ++ctx.state.seq,
      type: 'user/message',
      time: Date.now(),
      data: { content: body.content || [], source: { kind: 'user', rpcId: body.requestId } },
    })
    return { accepted: true }
  }
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const accepted = await call(started.port, 'POST', '/v1/resume', resumeBody('req-queued-read', { wait: false }))
  assert.equal(accepted.status, 202)
  const read = await call(started.port, 'GET', `/v1/requests?request_id=req-queued-read&session_id=${SESSION}`)
  assert.equal(read.status, 200)
  assert.equal(read.body.accepted, true)
  assert.notEqual(read.body.phase, 'unknown')

  ctx.state.events.push({ seq: ++ctx.state.seq, type: 'turn/start', time: Date.now(), data: { turn: 51 } })
  ctx.state.events.push({ seq: ++ctx.state.seq, type: 'turn/end', time: Date.now(), data: { turn: 51, reason: { kind: 'completed' } } })
  const finished = await call(started.port, 'GET', '/v1/requests/req-queued-read/wait?timeout_ms=3000')
  assert.equal(finished.body.completed, true)
  await close(started.server)
})

test('an execution header that names an effort while the confirmed choice follows the default is not a mismatch', async () => {
  const ctx = officialCtx()
  ctx.state.requestHeaderConfig = { provider: 'example-provider', model: 'example-model', reasoningEffort: 'high' }
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const result = await call(started.port, 'POST', '/v1/resume', resumeBody('req-default-effort'))
  assert.equal(result.status, 200)
  assert.equal(result.body.completed, true)
  assert.equal(result.body.route_match, true)
  assert.equal(result.body.effort_match, null)
  assert.equal(result.body.effort_verified, false)
  assert.equal(result.body.model_match, null)
  await close(started.server)
})

test('/events heartbeats when a turn is open and nothing changed', async () => {
  const ctx = officialCtx({ holdTurn: true })
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  await call(started.port, 'POST', '/v1/resume', resumeBody('req-heartbeat', { wait: false }))
  const first = await call(started.port, 'GET', '/v1/requests/req-heartbeat/events?after_seq=0&timeout_ms=2000')
  assert.equal(first.body.terminal_phase, false)
  const second = await call(started.port, 'GET', `/v1/requests/req-heartbeat/events?after_seq=${first.body.seq}&timeout_ms=250`)
  assert.equal(second.status, 200)
  assert.equal(second.body.heartbeat, true)
  assert.equal(second.body.events.length, 0)
  await close(started.server)
})

test('"auto" is rejected as a reasoning effort instead of being persisted', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const rejected = await call(started.port, 'POST', '/v1/model', {
    session_id: SESSION, provider: 'example-provider', model: 'example-model', reasoning_effort: 'auto',
  })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.reason, 'auto_not_an_effort')
  assert.deepEqual(ctx.state.selectCalls, [])
  await close(started.server)
})

test('malformed JSON is a 400, not a 500', async () => {  const started = await startServer(officialCtx(), { initial: WRITE_DEMO })
  const response = await fetch(`http://127.0.0.1:${started.port}/v1/model`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).reason, 'invalid_json')
  await close(started.server)
})

test('a child with a non-subagent origin but a parent is not hoisted to top', async () => {
  const ctx = officialCtx()
  ctx.state.sessions.push({
    sessionId: 'session-worker-child',
    updatedAt: 1_700_000_000_009,
    running: false,
    blank: false,
    agentAvailable: false,
    cwd: 'C:/work/demo',
    origin: 'worker',
    parentSessionId: 'session-demo',
  })
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const found = await call(started.port, 'GET', '/v1/discover?limit=50')
  const row = found.body.items.find((item) => item.session_id === 'session-worker-child')
  assert.ok(row)
  assert.notEqual(row.kind, 'top')
  assert.equal(row.kind, 'worker')
  await close(started.server)
})
