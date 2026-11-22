import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { classifyOwnedTurn, createRequestLedger } from '../requests.js'
import { WORKSPACE, call, close, makeStore, officialCtx, startServer } from './fixtures.js'

const WRITE = {
  version: 1,
  workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
  sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' }],
}

function body(extra = {}) {
  return {
    workspace_id: WORKSPACE,
    session_id: 'session-demo',
    profile: 'desktop',
    request_id: 'req-life',
    text: 'say hi',
    ...extra,
  }
}

test('the same request id and content does not prompt twice, even concurrently', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE })
  const [first, second] = await Promise.all([
    call(started.port, 'POST', '/v1/resume', body()),
    call(started.port, 'POST', '/v1/resume', body()),
  ])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(first.body.completed, true)
  assert.equal(second.body.request_id, 'req-life')
  assert.equal(ctx.state.prompts, 1)
  await close(started.server)
})

test('the same request id with different content is rejected and does not prompt again', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE })
  const first = await call(started.port, 'POST', '/v1/resume', body())
  const second = await call(started.port, 'POST', '/v1/resume', body({ text: 'different' }))
  assert.equal(first.body.completed, true)
  assert.equal(second.status, 409)
  assert.equal(second.body.reason, 'idempotency_conflict')
  assert.equal(ctx.state.prompts, 1)
  await close(started.server)
})

test('a query reads the official result after the waiting connection is gone', async () => {
  const ctx = officialCtx({ holdTurn: true })
  const started = await startServer(ctx, { initial: WRITE, resumeTimeoutMs: 5000 })
  const pending = call(started.port, 'POST', '/v1/resume', body())
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(ctx.state.prompts, 1)
  const stopped = await call(started.port, 'POST', '/v1/wait/stop', { request_id: 'req-life' })
  const abandoned = await pending
  assert.equal(stopped.body.scope, 'bridge_wait')
  assert.equal(stopped.body.desktop_cancel_called, false)
  assert.equal(abandoned.body.reason, 'bridge_wait_stopped')
  ctx.state.events.push({
    seq: ++ctx.state.seq,
    type: 'turn/end',
    time: Date.now(),
    data: { turn: 7, reason: { kind: 'completed' } },
  })
  const query = await call(started.port, 'GET', '/v1/requests?request_id=req-life&session_id=session-demo')
  assert.equal(query.status, 200)
  assert.equal(query.body.terminal, 'completed')
  assert.equal(query.body.completed, true)
  assert.equal(query.body.terminal_scope, 'official')
  assert.equal(ctx.state.prompts, 1)
  await close(started.server)
})

test('cancel calls the official session cancel only for the owned open turn', async () => {
  const ctx = officialCtx({ holdTurn: true })
  const started = await startServer(ctx, { initial: WRITE, resumeTimeoutMs: 5000 })
  const pending = call(started.port, 'POST', '/v1/resume', body())
  await new Promise((resolve) => setTimeout(resolve, 80))
  const cancelled = await call(started.port, 'POST', '/v1/cancel', body())
  const finished = await pending
  assert.equal(cancelled.body.cancel_accepted, true)
  assert.equal(cancelled.body.desktop_cancel_called, true)
  assert.equal(cancelled.body.killed_desktop, false)
  assert.equal(cancelled.body.terminal, 'aborted')
  assert.equal(cancelled.body.completed, false)
  assert.equal(finished.body.terminal, 'aborted')
  assert.deepEqual(ctx.state.cancelCalls, [{ sessionId: 'session-demo' }])
  await close(started.server)
})

test('a finished turn is not rewritten as cancelled and a foreign turn is not cancelled', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE })
  const done = await call(started.port, 'POST', '/v1/resume', body())
  assert.equal(done.body.terminal, 'completed')
  ctx.state.events.push(
    { seq: ++ctx.state.seq, type: 'turn/start', time: Date.now(), data: { turn: 8 } },
    { seq: ++ctx.state.seq, type: 'user/message', time: Date.now(), data: { content: [{ type: 'text', text: 'from the ui' }], source: { kind: 'user', rpcId: 'ui-request' } } },
  )
  const cancelled = await call(started.port, 'POST', '/v1/cancel', body())
  assert.equal(cancelled.body.cancel_accepted, false)
  assert.equal(cancelled.body.desktop_cancel_called, false)
  assert.equal(cancelled.body.terminal, 'completed')
  assert.equal(ctx.state.cancelled, 0)
  await close(started.server)
})

test('restart does not resend a request whose admission is unknown', async () => {
  const ctx = officialCtx()
  const stored = makeStore(WRITE)
  const ledger = createRequestLedger({ file: path.join(stored.dir, 'requests.json') })
  await ledger.claim({
    requestId: 'req-life',
    sessionId: 'session-demo',
    workspaceId: WORKSPACE,
    contentHash: 'different-from-any-live-hash',
  })
  const started = await startServer(ctx, { store: stored.store, file: stored.file, dir: stored.dir })
  const again = await call(started.port, 'POST', '/v1/resume', body())
  assert.equal(again.status, 409)
  assert.equal(again.body.reason, 'idempotency_conflict')
  assert.equal(ctx.state.prompts, 0)
  await close(started.server)
})

test('a crash window with the same content is not prompted again', async () => {
  const ctx = officialCtx()
  const first = await startServer(ctx, { initial: WRITE })
  const ok = await call(first.port, 'POST', '/v1/resume', body())
  assert.equal(ok.body.completed, true)
  const raw = JSON.parse(fs.readFileSync(first.requestsFile, 'utf8'))
  raw.requests['req-life'].phase = 'recorded'
  raw.requests['req-life'].crash_window = true
  raw.requests['req-life'].prompt_attempted = true
  raw.requests['req-life'].response = null
  raw.requests['req-life'].terminal_scope = null
  fs.writeFileSync(first.requestsFile, JSON.stringify(raw))
  await close(first.server)
  ctx.state.events = ctx.state.events.filter((event) => !(event.data && event.data.source && event.data.source.rpcId === 'req-life'))
  ctx.state.prompts = 0
  const second = await startServer(ctx, { store: first.store, file: first.file, dir: first.dir, requestsFile: first.requestsFile })
  const recovered = await call(second.port, 'POST', '/v1/resume', body())
  assert.equal(recovered.status, 409)
  assert.equal(recovered.body.reason, 'manual_reconcile')
  assert.equal(recovered.body.resend, false)
  assert.equal(ctx.state.prompts, 0)
  await close(second.server)
})

test('a damaged request record refuses the prompt', async () => {
  const stored = makeStore(WRITE)
  fs.writeFileSync(path.join(stored.dir, 'requests.json'), '{')
  const ctx = officialCtx()
  await assert.rejects(() => startServer(ctx, { store: stored.store, file: stored.file, dir: stored.dir }))
  assert.equal(ctx.state.prompts, 0)
})

test('revoking the grant hides the stored request', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE })
  const done = await call(started.port, 'POST', '/v1/resume', body())
  assert.equal(done.body.completed, true)
  const revoked = await call(started.port, 'POST', '/v1/revoke', { session_id: 'session-demo' })
  assert.equal(revoked.body.ok, true)
  const query = await call(started.port, 'GET', '/v1/requests?request_id=req-life&session_id=session-demo')
  assert.equal(query.status, 403)
  assert.equal(query.body.text, undefined)
  await close(started.server)
})

test('a read-only grant cannot cancel and a model mismatch is not sent', async () => {
  const ctx = officialCtx()
  const readOnly = {
    version: 1,
    workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'read', cwd: 'C:/work/demo', profile: 'desktop' }],
  }
  const started = await startServer(ctx, { initial: readOnly })
  const denied = await call(started.port, 'POST', '/v1/cancel', body())
  assert.equal(denied.status, 404)
  assert.equal(ctx.state.cancelled, 0)
  await close(started.server)
  const ctx2 = officialCtx()
  const writing = await startServer(ctx2, { initial: WRITE })
  const mismatch = await call(writing.port, 'POST', '/v1/resume', body({
    model: { provider: 'example-provider', model: 'missing-model' },
  }))
  assert.equal(mismatch.body.accepted, false)
  assert.equal(mismatch.body.started_task, false)
  assert.equal(mismatch.body.reason, 'model_not_advertised')
  assert.equal(ctx2.state.prompts, 0)
  const kept = ctx2.state.events.filter((event) => event.seq === 1)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].type, 'turn/start')
  await close(writing.server)
})

test('a request record that cannot be saved does not prompt', async () => {
  const ctx = officialCtx()
  const stored = makeStore(WRITE)
  // A regular file where the requests directory should be makes the write fail
  // with ENOTDIR on every platform. A directory chmod would be a no-op on
  // Windows and would let this regression pass for the wrong reason.
  const blocked = path.join(stored.dir, 'blocked-requests')
  fs.writeFileSync(blocked, 'not a directory')
  const started = await startServer(ctx, {
    store: stored.store,
    file: stored.file,
    dir: stored.dir,
    requestsFile: path.join(blocked, 'requests.json'),
  })
  try {
    const refused = await call(started.port, 'POST', '/v1/resume', body())
    assert.equal(refused.status, 500)
    assert.equal(refused.body.reason, 'request_persist_failed')
    assert.equal(refused.body.started_task, false)
    assert.equal(ctx.state.prompts, 0)
  } finally {
    await close(started.server)
  }
})

test('a dropped client connection can be looked up after the turn ends', async () => {
  const ctx = officialCtx({ holdTurn: true })
  const started = await startServer(ctx, { initial: WRITE, resumeTimeoutMs: 5000 })
  const controller = new AbortController()
  const pending = fetch(`http://127.0.0.1:${started.port}/v1/resume`, {
    method: 'POST',
    headers: { authorization: 'Bearer 0123456789abcdef0123456789abcdef', 'content-type': 'application/json' },
    body: JSON.stringify(body()),
    signal: controller.signal,
  }).catch((error) => error)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(ctx.state.prompts, 1)
  controller.abort()
  await pending

  // The bridge wait is not the Desktop turn: ending the official turn is
  // enough for the durable record to become readable.
  ctx.state.events.push({
    seq: ++ctx.state.seq,
    type: 'turn/end',
    time: Date.now(),
    data: { turn: 7, reason: { kind: 'completed' } },
  })
  const query = await call(started.port, 'GET', '/v1/requests?request_id=req-life&session_id=session-demo')
  assert.equal(query.status, 200)
  assert.equal(query.body.terminal, 'completed')
  assert.equal(query.body.completed, true)
  assert.equal(query.body.query, true)
  assert.equal(ctx.state.prompts, 1)
  await close(started.server)
})

test('wait/stop on an unknown request changes nothing', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE })
  const stopped = await call(started.port, 'POST', '/v1/wait/stop', { request_id: 'req-never-sent' })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.confirmed, false)
  assert.equal(stopped.body.reason, 'no_bridge_wait')
  assert.equal(stopped.body.desktop_cancel_called, false)
  assert.equal(ctx.state.prompts, 0)
  assert.equal(ctx.state.cancelled, 0)
  await close(started.server)
})

test('a request query refuses an unknown request and a mismatched session', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE })
  const missing = await call(started.port, 'GET', '/v1/requests?request_id=req-nope&session_id=session-demo')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.reason, 'unknown_request')
  const done = await call(started.port, 'POST', '/v1/resume', body())
  assert.equal(done.body.completed, true)
  const mismatch = await call(started.port, 'GET', '/v1/requests?request_id=req-life&session_id=session-busy')
  assert.equal(mismatch.status, 404)
  assert.equal(mismatch.body.reason, 'unknown_request')
  await close(started.server)
})

test('a finished turn is not cancelled again and the official cancel is not called', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE })
  const done = await call(started.port, 'POST', '/v1/resume', body())
  assert.equal(done.body.completed, true)
  const cancelled = await call(started.port, 'POST', '/v1/cancel', body())
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.cancel_accepted, false)
  assert.equal(cancelled.body.desktop_cancel_called, false)
  assert.equal(cancelled.body.reason, 'already_terminal')
  assert.equal(cancelled.body.terminal, 'completed')
  assert.equal(ctx.state.cancelled, 0)
  await close(started.server)
})

test('cancel refuses a session without a live agent instead of calling the official cancel', async () => {
  const ctx = officialCtx({ holdTurn: true })
  const started = await startServer(ctx, { initial: WRITE, resumeTimeoutMs: 5000 })
  const pending = call(started.port, 'POST', '/v1/resume', body())
  await new Promise((resolve) => setTimeout(resolve, 80))
  // The official cancel resolves the live Agent; the projection says this one
  // is not attached, so the bridge must not report a failed Desktop cancel.
  const row = ctx.state.sessions.find((item) => item.sessionId === 'session-demo')
  row.agentAvailable = false
  const refused = await call(started.port, 'POST', '/v1/cancel', body())
  assert.equal(refused.status, 409)
  assert.equal(refused.body.reason, 'agent_not_attached')
  assert.equal(refused.body.desktop_cancel_called, false)
  assert.equal(ctx.state.cancelled, 0)
  await call(started.port, 'POST', '/v1/wait/stop', { request_id: 'req-life' })
  await pending
  await close(started.server)
})

test('a prompt spliced before its turn start is not cancellable as an owned turn', () => {
  const queued = [
    { seq: 1, type: 'user/message', data: { source: { rpcId: 'req-q' } } },
    { seq: 2, type: 'turn/start', data: { turn: 9 } },
  ]
  const verdict = classifyOwnedTurn(queued, 'req-q')
  assert.equal(verdict.owned, false)
  assert.equal(verdict.reason, 'prompt_not_started')

  const started = [
    { seq: 1, type: 'turn/start', data: { turn: 9 } },
    { seq: 2, type: 'user/message', data: { source: { rpcId: 'req-q' } } },
  ]
  assert.equal(classifyOwnedTurn(started, 'req-q').owned, true)
})
