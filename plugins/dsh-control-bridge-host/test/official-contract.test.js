/**
 * Regression suite against the official 0.2.2 controller contract.
 *
 * Every fixture uses `sessionId` (never `id`), an official readSession snapshot,
 * and a `{ accepted: true }` prompt result, because the 0.1.3 suite used
 * invented shapes that hid three independent defects.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createGrantStore, loadAllowlistFile } from '../grants.js'
import { readSnapshot } from '../host_read.js'
import { apply } from '../index.js'
import { BOOTSTRAP, SECRET, WORKSPACE, call, close, officialCtx, readGrantFile, startServer } from './fixtures.js'

function bootstrapSecret() {
  return { host: SECRET, bootstrap: BOOTSTRAP, expiresAt: Date.now() + 60_000, consumed: false }
}

async function bootServer(ctx, extra = {}) {
  return startServer(ctx, { secret: bootstrapSecret(), ...extra })
}

const WRITE_DEMO = {
  version: 1,
  workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
  sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' }],
}

const READ_DEMO = {
  version: 1,
  workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
  sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'read', cwd: 'C:/work/demo', profile: 'desktop' }],
}

test('pairing takes effect immediately in the same process', async () => {
  const ctx = officialCtx()
  const started = await bootServer(ctx)
  const boot = (method, pathname, body) => call(started.port, method, pathname, body, BOOTSTRAP)
  const host = (method, pathname, body) => call(started.port, method, pathname, body, SECRET)

  const catalog = await boot('GET', '/v1/bootstrap/catalog')
  assert.equal(catalog.status, 200)
  assert.equal(catalog.body.session_status, 'ok')
  assert.equal(catalog.body.sessions.filter((item) => item.session_id === 'session-child').length, 0)
  assert.equal(catalog.body.filtered_subagents, 1)
  const demo = catalog.body.sessions.find((item) => item.session_id === 'session-demo')
  assert.equal(demo.title, 'Demo chat')
  assert.equal(demo.model, 'example-model')
  assert.equal(demo.provider, 'example-provider')
  assert.equal(demo.model_source, 'session_recorded')

  const selected = await boot('POST', '/v1/bootstrap/select', { session_id: 'session-demo', access: 'read' })
  assert.equal(selected.status, 200)
  assert.equal(selected.body.ok, true)
  assert.equal(selected.body.allowlist.sessionAllowlist.length, 1)

  // The point of the fix: no restart, the grant is visible to every read endpoint.
  const granted = await host('GET', '/v1/granted')
  assert.equal(granted.body.sessions.length, 1)
  assert.equal(granted.body.sessions[0].session_id, 'session-demo')
  const workspaces = await host('GET', '/v1/workspaces')
  assert.deepEqual(workspaces.body.workspaces.map((item) => item.id), [WORKSPACE])
  const sessions = await host('GET', '/v1/sessions?workspace_id=ws-demo')
  assert.equal(sessions.body.ok, true)
  assert.deepEqual(sessions.body.sessions.map((item) => item.session_id), ['session-demo'])
  const history = await host('GET', '/v1/history?session_id=session-demo')
  assert.equal(history.status, 200)
  assert.equal(history.body.ok, true)
  assert.equal(history.body.total, 4)
  assert.equal(history.body.snapshot_shape, 'official_snapshot')
  assert.equal(history.body.session_header.session_id, 'session-demo')
  assert.equal(history.body.events.some((event) => event.text.includes('[redacted]')), true)
  assert.equal(history.body.events.some((event) => event.text.includes('sk-supersecretvalue')), false)
  assert.equal(history.body.events[2].kind, 'assistant')
  await close(started.server)
})

test('read-only grant cannot resume', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: READ_DEMO })
  const result = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-read-only', text: 'go',
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.accepted, false)
  assert.equal(result.body.reason, 'read_only')
  assert.equal(ctx.state.prompts, 0)
  await close(started.server)
})

test('write grant resumes the same session and collects the turn result', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const result = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-write', text: 'say hi',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.accepted, true)
  assert.equal(result.body.completed, true)
  assert.equal(result.body.session_id, 'session-demo')
  assert.equal(result.body.model_selection, 'session_recorded_not_overridden')
  assert.equal(result.body.final.reason.kind, 'completed')
  assert.equal(result.body.attribution, 'request_id')
  assert.match(result.body.text, /answer to say hi/)
  assert.equal(result.body.text.includes('sk-livevalue012345'), false)
  assert.equal(ctx.state.prompts, 1)

  // The answer comes from the session log, not from the prompt return value.
  const history = await call(started.port, 'GET', '/v1/history?session_id=session-demo')
  assert.equal(history.body.total > 4, true)
  assert.equal(history.body.events.some((event) => event.text.includes('answer to say hi')), true)
  await close(started.server)
})

test('a turn that ends with an error is not reported as completed', async () => {
  const ctx = officialCtx()
  ctx.state.endReason = { kind: 'error', error: { message: 'provider exploded' } }
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const result = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-error', text: 'say hi',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.accepted, true)
  // The turn ended, but the task did not succeed.
  assert.equal(result.body.completed, false)
  assert.equal(result.body.terminal, 'error')
  assert.equal(result.body.final.reason.kind, 'error')
  await close(started.server)
})

test('a turn with no end reason is reported as unknown, not completed', async () => {
  const ctx = officialCtx()
  // turn/end without a reason object: the bridge must not invent "completed".
  ctx.state.endReason = {}
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const result = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-noreason', text: 'say hi',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.completed, false)
  assert.equal(result.body.terminal, 'unknown')
  await close(started.server)
})

test('a grant revoked while waiting keeps accepted true so nothing is resent', async () => {
  const ctx = officialCtx()
  ctx.state.autoComplete = false
  const started = await startServer(ctx, { initial: WRITE_DEMO, pollIntervalMs: 50 })
  const pending = call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-revoke-wait', text: 'go',
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const revoked = await call(started.port, 'POST', '/v1/revoke', { session_id: 'session-demo' })
  assert.equal(revoked.body.ok, true)
  const result = await pending
  assert.equal(result.status, 409)
  assert.equal(result.body.reason, 'revoked_during_wait')
  // The prompt was accepted before the revoke; "accepted: false" would invite a resend.
  assert.equal(result.body.accepted, true)
  assert.equal(result.body.completed, false)
  assert.equal(ctx.state.prompts, 1)
  await close(started.server)
})

test('revocation takes effect on the next request', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const before = await call(started.port, 'GET', '/v1/history?session_id=session-demo')
  assert.equal(before.status, 200)
  const revoked = await call(started.port, 'POST', '/v1/revoke', { session_id: 'session-demo' })
  assert.equal(revoked.body.ok, true)
  assert.equal(revoked.body.revoked, true)
  assert.equal(revoked.body.remaining, 0)
  const after = await call(started.port, 'GET', '/v1/history?session_id=session-demo')
  assert.equal(after.status, 403)
  assert.equal(after.body.reason, 'session_not_allowlisted')
  const resume = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-after-revoke', text: 'go',
  })
  assert.equal(resume.body.reason, 'session_not_allowlisted')
  assert.equal(ctx.state.prompts, 0)
  const granted = await call(started.port, 'GET', '/v1/granted')
  assert.equal(granted.body.sessions.length, 0)
  assert.equal(readGrantFile(started.file).sessionAllowlist.length, 0)
  await close(started.server)
})

test('a failed save does not widen grants and does not consume the bootstrap secret', async () => {
  const ctx = officialCtx()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-blocked-'))
  const blocked = path.join(dir, 'allowlist.json')
  fs.mkdirSync(blocked) // a directory at the target path makes the rename fail
  const store = createGrantStore({ file: blocked })
  const started = await bootServer(ctx, { store, file: blocked })
  const boot = (method, pathname, body) => call(started.port, method, pathname, body, BOOTSTRAP)
  const host = (method, pathname, body) => call(started.port, method, pathname, body, SECRET)

  const selected = await boot('POST', '/v1/bootstrap/select', { session_id: 'session-demo', access: 'read' })
  assert.equal(selected.status, 500)
  assert.equal(selected.body.ok, false)
  assert.equal(selected.body.reason, 'allowlist_persist_failed')
  assert.equal(selected.body.saved, false)

  const granted = await host('GET', '/v1/granted')
  assert.equal(granted.body.sessions.length, 0)
  const history = await host('GET', '/v1/history?session_id=session-demo')
  assert.equal(history.body.reason, 'workspace_not_allowlisted')
  // the bootstrap secret still works, so pairing can be retried after the fault is fixed
  const again = await boot('GET', '/v1/bootstrap/catalog')
  assert.equal(again.status, 200)
  await close(started.server)
})

test('grants survive a restart and a revoke survives a restart', async () => {
  const first = await startServer(officialCtx(), { initial: WRITE_DEMO })
  const granted = await call(first.port, 'GET', '/v1/granted')
  assert.equal(granted.body.sessions.length, 1)
  await close(first.server)

  // A brand new store reads the same file, as after a Desktop restart.
  const second = await startServer(officialCtx(), { store: createGrantStore({ file: first.file }), file: first.file })
  const again = await call(second.port, 'GET', '/v1/granted')
  assert.equal(again.body.sessions.length, 1)
  assert.equal(again.body.sessions[0].access, 'write')
  const history = await call(second.port, 'GET', '/v1/history?session_id=session-demo')
  assert.equal(history.status, 200)
  await call(second.port, 'POST', '/v1/revoke', { session_id: 'session-demo' })
  await close(second.server)

  const third = await startServer(officialCtx(), { store: createGrantStore({ file: first.file }), file: first.file })
  const emptied = await call(third.port, 'GET', '/v1/granted')
  assert.equal(emptied.body.sessions.length, 0)
  await close(third.server)
})

test('repeated pairing merges instead of replacing earlier grants', async () => {
  const ctx = officialCtx()
  const first = await bootServer(ctx)
  const firstSelect = await call(first.port, 'POST', '/v1/bootstrap/select', { session_id: 'session-demo', access: 'read' }, BOOTSTRAP)
  assert.equal(firstSelect.body.ok, true)
  await close(first.server)

  // Re-pairing needs a fresh bootstrap (the previous one is consumed by design),
  // and it must merge into the existing file rather than replace it.
  const second = await bootServer(ctx, { store: first.store, file: first.file })
  const secondSelect = await call(second.port, 'POST', '/v1/bootstrap/select', { session_id: 'session-plain', access: 'read' }, BOOTSTRAP)
  assert.equal(secondSelect.body.ok, true)
  assert.equal(secondSelect.body.allowlist.sessionAllowlist.length, 2)
  assert.equal(secondSelect.body.allowlist.workspaceAllowlist.length, 1)
  assert.deepEqual(
    secondSelect.body.allowlist.sessionAllowlist.map((item) => item.sessionId).sort(),
    ['session-demo', 'session-plain'],
  )
  const onDisk = readGrantFile(second.file)
  assert.equal(onDisk.sessionAllowlist.length, 2)
  await close(second.server)
})

test('an expired bootstrap is refused without touching the allowlist', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, {
    secret: { host: SECRET, bootstrap: BOOTSTRAP, expiresAt: Date.now() - 1_000, consumed: false },
  })
  const boot = (method, pathname, body) => call(started.port, method, pathname, body, BOOTSTRAP)
  const catalog = await boot('GET', '/v1/bootstrap/catalog')
  assert.equal(catalog.status, 403)
  assert.equal(catalog.body.reason, 'bootstrap_expired')
  const selected = await boot('POST', '/v1/bootstrap/select', { session_id: 'session-demo', access: 'read' })
  assert.equal(selected.status, 403)
  assert.equal(selected.body.reason, 'bootstrap_expired')
  const granted = await call(started.port, 'GET', '/v1/granted', null, SECRET)
  assert.equal(granted.body.sessions.length, 0)
  assert.equal(fs.existsSync(started.file), false)
  await close(started.server)
})

test('two concurrent pairings both land and keep the file valid', async () => {
  const ctx = officialCtx()
  const shared = await startServer(ctx)
  await close(shared.server)
  const one = await bootServer(ctx, { store: shared.store, file: shared.file })
  const two = await bootServer(ctx, { store: shared.store, file: shared.file })
  const [left, right] = await Promise.all([
    call(one.port, 'POST', '/v1/bootstrap/select', { session_id: 'session-demo', access: 'read' }, BOOTSTRAP),
    call(two.port, 'POST', '/v1/bootstrap/select', { session_id: 'session-plain', access: 'read' }, BOOTSTRAP),
  ])
  assert.equal(left.body.ok, true)
  assert.equal(right.body.ok, true)
  const onDisk = readGrantFile(shared.file)
  assert.equal(onDisk.sessionAllowlist.length, 2)
  assert.equal(onDisk.workspaceAllowlist.length, 1)
  assert.deepEqual(onDisk.sessionAllowlist.map((item) => item.sessionId).sort(), ['session-demo', 'session-plain'])
  await close(one.server)
  await close(two.server)
})

test('concurrent access changes keep memory and disk identical', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: READ_DEMO })
  const calls = []
  for (let index = 0; index < 20; index += 1) {
    calls.push(call(started.port, 'POST', '/v1/access', {
      session_id: 'session-demo', access: index % 2 === 0 ? 'write' : 'read',
    }))
  }
  const results = await Promise.all(calls)
  assert.equal(results.every((item) => item.status === 200), true)
  const onDisk = readGrantFile(started.file)
  const inMemory = started.store.snapshot()
  assert.deepEqual(onDisk.sessionAllowlist, inMemory.sessionAllowlist)
  assert.deepEqual(onDisk.workspaceAllowlist, inMemory.workspaceAllowlist)
  assert.equal(onDisk.sessionAllowlist.length, 1)
  assert.equal(['read', 'write'].includes(onDisk.sessionAllowlist[0].access), true)
  await close(started.server)
})

test('a busy session refuses write without cancelling anything', async () => {
  const ctx = officialCtx()
  const started = await bootServer(ctx)
  const boot = (method, pathname, body) => call(started.port, method, pathname, body, BOOTSTRAP)
  const selected = await boot('POST', '/v1/bootstrap/select', { session_id: 'session-busy', access: 'read' })
  assert.equal(selected.body.ok, true)
  const upgrade = await call(started.port, 'POST', '/v1/access', { session_id: 'session-busy', access: 'write' })
  assert.equal(upgrade.status, 409)
  assert.equal(upgrade.body.reason, 'busy')
  assert.match(upgrade.body.detail, /not cancelled/)
  const resume = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-busy', profile: 'desktop', request_id: 'req-busy', text: 'go',
  })
  assert.equal(resume.body.accepted, false)
  assert.equal(ctx.state.prompts, 0)
  assert.equal(ctx.state.cancelled, 0)
  await close(started.server)
})

test('a turn that never finishes reports a timeout and is not retried', async () => {
  const ctx = officialCtx({ autoComplete: false })
  const started = await startServer(ctx, { initial: WRITE_DEMO, resumeTimeoutMs: 1_000, pollIntervalMs: 50 })
  const result = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-timeout', text: 'go',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.accepted, true)
  assert.equal(result.body.completed, false)
  assert.equal(result.body.final.reason.kind, 'bridge_timeout')
  assert.equal(result.body.model_timeout, false)
  assert.equal(result.body.terminal_scope, 'bridge_wait')
  assert.equal(result.body.timeout_ms, 1_000)
  assert.equal(ctx.state.prompts, 1)
  // a repeated request id replays the terminal answer instead of prompting again
  const replay = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-timeout', text: 'go',
  })
  assert.equal(replay.body.final.reason.kind, 'bridge_timeout')
  assert.equal(ctx.state.prompts, 1)
  await close(started.server)
})

test('a failed log read is an error, never an empty history', async () => {
  const ctx = officialCtx()
  ctx.sessionQuery.readSession = async () => { throw new TypeError('cannot read the log') }
  const started = await startServer(ctx, { initial: READ_DEMO })
  const history = await call(started.port, 'GET', '/v1/history?session_id=session-demo')
  assert.equal(history.status, 502)
  assert.equal(history.body.ok, false)
  assert.equal(Array.isArray(history.body.events), false)
  assert.equal(history.body.reason, 'call_failed')
  await close(started.server)

  const broken = officialCtx()
  broken.sessionController.list = async () => { throw new TypeError('sessionController.list is not a function') }
  const second = await startServer(broken, { initial: READ_DEMO })
  const listing = await call(second.port, 'GET', '/v1/history?session_id=session-demo')
  assert.equal(listing.status, 502)
  assert.equal(listing.body.reason, 'session_list_read_failed')
  assert.equal(listing.body.not_an_empty_history, true)
  await close(second.server)
})

test('a deployment default is never reported as a session model', async () => {
  const withDefault = await bootServer(officialCtx(), {
    globalDefault: () => ({ provider: 'default-provider', model: 'default-model' }),
  })
  const boot = (method, pathname, body) => call(withDefault.port, method, pathname, body, BOOTSTRAP)
  const catalog = await boot('GET', '/v1/bootstrap/catalog')
  const demo = catalog.body.sessions.find((item) => item.session_id === 'session-demo')
  assert.equal(demo.model, 'example-model')
  assert.equal(demo.provider, 'example-provider')
  assert.equal(demo.model_source, 'session_recorded')
  // session-plain recorded nothing: the deployment default must not fill it in.
  const plain = catalog.body.sessions.find((item) => item.session_id === 'session-plain')
  assert.equal(plain.model, null)
  assert.equal(plain.provider, null)
  assert.equal(plain.model_source, 'unknown')
  await close(withDefault.server)

  // The default is still visible, but only as a separate field.
  const started = await startServer(officialCtx(), {
    initial: READ_DEMO,
    globalDefault: () => ({ provider: 'default-provider', model: 'default-model' }),
  })
  const granted = await call(started.port, 'GET', '/v1/granted')
  assert.equal(granted.body.global_default.provider, 'default-provider')
  assert.equal(granted.body.global_default.model, 'default-model')
  assert.equal(granted.body.sessions[0].model, 'example-model')
  assert.equal(granted.body.sessions[0].model_source, 'session_projection')
  await close(started.server)
})

test('ids come from sessionId and a legacy event array is labelled', async () => {
  const legacy = await readSnapshot({
    readSession: async () => [{ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'x' }] } }],
  }, 'session-demo')
  assert.equal(legacy.shape, 'legacy_array')
  assert.equal(legacy.events.length, 1)

  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: READ_DEMO })
  const sessions = await call(started.port, 'GET', '/v1/sessions?workspace_id=ws-demo')
  assert.equal(typeof sessions.body.sessions[0].session_id, 'string')
  assert.equal(sessions.body.sessions[0].session_id, 'session-demo')
  const history = await call(started.port, 'GET', '/v1/history?session_id=session-demo&offset=1&limit=1')
  assert.equal(history.body.has_more, true)
  assert.equal(history.body.next_offset, 2)
  assert.equal(history.body.events.length, 1)
  await close(started.server)
})

test('a removed session is a 404, not an empty history', async () => {
  const ctx = officialCtx()
  const initial = {
    version: 1,
    workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessionAllowlist: [{ sessionId: 'session-removed', workspaceId: WORKSPACE, access: 'read', cwd: 'C:/elsewhere', profile: 'desktop' }],
  }
  const started = await startServer(ctx, { initial })
  const history = await call(started.port, 'GET', '/v1/history?session_id=session-removed')
  assert.equal(history.status, 404)
  assert.equal(history.body.reason, 'missing_session')
  await close(started.server)
})

test('a second request on the same session is refused while one is waiting', async () => {
  const ctx = officialCtx({ autoComplete: false })
  const started = await startServer(ctx, { initial: WRITE_DEMO, resumeTimeoutMs: 1_000, pollIntervalMs: 50 })
  const first = call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-one', text: 'go',
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const second = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-two', text: 'go',
  })
  assert.equal(second.status, 409)
  assert.equal(second.body.reason, 'bridge_request_in_flight')
  const firstResult = await first
  assert.equal(firstResult.body.final.reason.kind, 'bridge_timeout')
  assert.equal(firstResult.body.model_timeout, false)
  assert.equal(ctx.state.prompts, 1)
  await close(started.server)
})

test('an unreadable allowlist file fails closed even with an armed bootstrap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-broken-'))
  const allowlistFile = path.join(dir, 'allowlist.json')
  const secretFile = path.join(dir, 'host.secret')
  const bootstrapSecretFile = path.join(dir, 'bootstrap.secret')
  const bootstrapFile = path.join(dir, 'bootstrap.json')
  fs.writeFileSync(secretFile, SECRET)
  fs.writeFileSync(bootstrapSecretFile, BOOTSTRAP)
  fs.writeFileSync(bootstrapFile, JSON.stringify({ secret: BOOTSTRAP, expiresAt: Date.now() + 60_000, consumed: false }))
  fs.writeFileSync(allowlistFile, '{"workspaceAllowlist": [ {"id": "ws-demo"')
  const before = fs.readFileSync(allowlistFile)
  const ctx = { sessionController: {}, workspaceRegistry: {}, sessionQuery: {} }
  const result = apply(ctx, {
    allowlistFile,
    secretFile,
    bootstrapSecretFile,
    bootstrapFile,
    bind: '127.0.0.1',
    port: 18_765,
    workspaceAllowlist: [],
    sessionAllowlist: [],
  })
  assert.equal(result.listening, false)
  assert.equal(result.reason, 'allowlist_unreadable')
  assert.equal(result.allowlist_status, 'unreadable')
  // The unreadable file is left exactly as it was: no write, no truncation.
  assert.deepEqual(fs.readFileSync(allowlistFile), before)

  // Structurally invalid entries are the same class of failure.
  fs.writeFileSync(allowlistFile, JSON.stringify({ workspaceAllowlist: 'nope', sessionAllowlist: [] }))
  const structural = apply(ctx, {
    allowlistFile,
    secretFile,
    bootstrapSecretFile,
    bootstrapFile,
    bind: '127.0.0.1',
    port: 18_765,
  })
  assert.equal(structural.listening, false)
  assert.equal(structural.reason, 'allowlist_unreadable')
  assert.equal(structural.allowlist_status, 'invalid_entries')

  // A missing file is the first run, not a failure.
  assert.equal(loadAllowlistFile(path.join(dir, 'absent.json')).status, 'missing')
  assert.equal(loadAllowlistFile(allowlistFile).status, 'invalid_entries')
})

test('deleting the allowlist file at runtime revokes every grant', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const before = await call(started.port, 'GET', '/v1/granted')
  assert.equal(before.body.sessions.length, 1)
  const revision = before.body.revision
  fs.unlinkSync(started.file)

  const after = await call(started.port, 'GET', '/v1/granted')
  assert.equal(after.body.sessions.length, 0)
  assert.equal(after.body.revision > revision, true)
  const health = await call(started.port, 'GET', '/v1/health')
  assert.equal(health.body.grants_count, 0)
  assert.equal(health.body.allowlist_warnings.some((item) => item.includes('removed')), true)
  const history = await call(started.port, 'GET', '/v1/history?session_id=session-demo')
  assert.equal(history.status, 403)
  const resume = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-after-delete', text: 'go',
  })
  assert.equal(resume.body.accepted, false)
  assert.equal(ctx.state.prompts, 0)
  await close(started.server)
})

test('granted model fields come from the current row, never the pairing snapshot', async () => {
  const ctx = officialCtx()
  const stale = {
    version: 1,
    workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessionAllowlist: [{
      sessionId: 'session-plain',
      workspaceId: WORKSPACE,
      access: 'read',
      cwd: 'C:/work/demo',
      profile: 'desktop',
      model: 'stale-model',
      provider: 'stale-provider',
      title: 'plain',
    }],
  }
  const started = await startServer(ctx, { initial: stale })
  const granted = await call(started.port, 'GET', '/v1/granted')
  const row = granted.body.sessions[0]
  assert.equal(row.model, null)
  assert.equal(row.provider, null)
  assert.equal(row.model_source, 'unknown')
  assert.equal(row.catalog_row, true)
  await close(started.server)

  const withRow = await startServer(officialCtx(), { initial: WRITE_DEMO })
  const demo = (await call(withRow.port, 'GET', '/v1/granted')).body.sessions[0]
  assert.equal(demo.model, 'example-model')
  assert.equal(demo.provider, 'example-provider')
  assert.equal(demo.model_source, 'session_projection')
  await close(withRow.server)
})

// ---------------------------------------------------------------------------
// Model gate: the deployment default is not a Session selection, and a route
// without an adapter must be refused before prompt(), not after NO_ADAPTER.
// ---------------------------------------------------------------------------

function headerEvent(seq, provider, model) {
  return { seq, type: 'request/header', time: 1_700_000_000_000 + seq, data: { header: { config: { provider, model } } } }
}

function selectionEvent(seq, provider, model) {
  return { seq, type: 'model/selection', time: 1_700_000_000_000 + seq, data: { provider, model } }
}

test('a recorded alternate session is not shown or sent as the deployment default', async () => {
  const ctx = officialCtx()
  ctx.state.events.push(headerEvent(40, 'alternate-provider', 'alternate-model'))
  ctx.state.selection = { provider: 'alternate-provider', model: 'alternate-model' }
  const started = await startServer(ctx, {
    initial: WRITE_DEMO,
    globalDefault: () => ({ provider: 'example-provider', model: 'example-model' }),
  })

  const granted = await call(started.port, 'GET', '/v1/granted')
  const row = granted.body.sessions[0]
  assert.equal(row.provider, 'alternate-provider')
  assert.equal(row.model, 'alternate-model')
  assert.equal(row.model_source, 'session_log')
  assert.deepEqual(granted.body.global_default, { provider: 'example-provider', model: 'example-model' })

  const resume = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-alternate', text: 'go',
  })
  assert.equal(resume.status, 409)
  assert.equal(resume.body.reason, 'no_adapter')
  assert.equal(resume.body.completed, false)
  assert.equal(ctx.state.prompts, 0)
  await close(started.server)
})

test('a pending selection is adopted by the next request and reported as executed', async () => {
  const ctx = officialCtx()
  ctx.state.events.push(headerEvent(40, 'alternate-provider', 'alternate-model'))
  ctx.state.events.push(selectionEvent(41, 'example-provider', 'example-model'))
  ctx.state.seq = 41
  ctx.state.selection = { provider: 'example-provider', model: 'example-model' }
  const started = await startServer(ctx, { initial: WRITE_DEMO })

  const models = await call(started.port, 'GET', '/v1/models?session_id=session-demo')
  assert.equal(models.body.session.pending.provider, 'example-provider')
  assert.equal(models.body.session.next.provider, 'example-provider')
  assert.equal(models.body.availability.available, true)

  const resume = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-pending', text: 'go',
  })
  assert.equal(resume.status, 200)
  assert.equal(resume.body.completed, true)
  assert.equal(resume.body.confirmed_selection.provider, 'example-provider')
  assert.equal(resume.body.execution_model.provider, 'example-provider')
  assert.equal(resume.body.execution_model_source, 'request_header')
  assert.equal(resume.body.model_match, true)
  await close(started.server)
})

test('a provider without an adapter is refused before any prompt', async () => {
  const ctx = officialCtx()
  ctx.state.providers = []
  const started = await startServer(ctx, { initial: WRITE_DEMO })

  const set = await call(started.port, 'POST', '/v1/model', {
    session_id: 'session-demo', provider: 'example-provider', model: 'example-model',
  })
  assert.equal(set.status, 409)
  assert.equal(set.body.reason, 'no_adapter')
  assert.equal(ctx.state.selectCalls.length, 0)

  const resume = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-noadapter', text: 'go',
  })
  assert.equal(resume.status, 409)
  assert.equal(resume.body.reason, 'no_adapter')
  assert.equal(ctx.state.prompts, 0)
  await close(started.server)
})

test('a read-only grant cannot change the session model', async () => {
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: READ_DEMO })
  const set = await call(started.port, 'POST', '/v1/model', {
    session_id: 'session-demo', provider: 'example-provider', model: 'example-model',
  })
  assert.equal(set.status, 403)
  assert.equal(ctx.state.selectCalls.length, 0)
  assert.equal(ctx.state.prompts, 0)
  await close(started.server)
})

test('a cold session reports needs_ui instead of pretending the model changed', async () => {
  const ctx = officialCtx()
  ctx.state.liveSessions = new Set()
  const started = await startServer(ctx, { initial: WRITE_DEMO })

  const set = await call(started.port, 'POST', '/v1/model', {
    session_id: 'session-demo', provider: 'example-provider', model: 'example-model',
  })
  assert.equal(set.status, 409)
  assert.equal(set.body.reason, 'needs_ui')
  assert.equal(ctx.state.selectCalls.length, 0)

  const resume = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-cold',
    text: 'go',
    model: { provider: 'example-provider', model: 'example-model' },
  })
  assert.equal(resume.status, 409)
  assert.equal(resume.body.reason, 'needs_ui')
  assert.equal(ctx.state.prompts, 0)
  await close(started.server)
})

test('changing one session model leaves another session unchanged', async () => {
  const ctx = officialCtx()
  const initial = {
    version: 1,
    workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
    sessionAllowlist: [
      { sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' },
      { sessionId: 'session-plain', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' },
    ],
  }
  const started = await startServer(ctx, { initial })
  const set = await call(started.port, 'POST', '/v1/model', {
    session_id: 'session-demo', provider: 'example-provider', model: 'example-model',
  })
  assert.equal(set.status, 200)
  assert.equal(set.body.confirmed.model, 'example-model')
  const granted = await call(started.port, 'GET', '/v1/granted')
  const plain = granted.body.sessions.find((item) => item.session_id === 'session-plain')
  assert.equal(plain.model, null)
  assert.equal(plain.model_source, 'unknown')
  await close(started.server)
})

test('a selection that changes after the preflight is refused before sending', async () => {
  const ctx = officialCtx()
  const originalRead = ctx.sessionQuery.readSession
  let reads = 0
  ctx.sessionQuery.readSession = async (sessionId) => {
    reads += 1
    if (reads === 2) ctx.state.selection = { provider: 'alternate-provider', model: 'alternate-model' }
    return originalRead(sessionId)
  }
  ctx.state.providers = ['example-provider', 'alternate-provider']
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const resume = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-change', text: 'go',
  })
  assert.equal(resume.status, 409)
  assert.equal(resume.body.reason, 'model_changed_before_send')
  assert.equal(ctx.state.prompts, 0)
  await close(started.server)
})

test('a turn without a request header reports execution as unknown', async () => {
  const ctx = officialCtx()
  ctx.state.headerOnPrompt = false
  const originalPrompt = ctx.sessionController.prompt
  ctx.sessionController.prompt = async (body, signal) => {
    const result = await originalPrompt(body, signal)
    ctx.state.events = ctx.state.events.filter((event) => event.type !== 'request/header')
    return result
  }
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const resume = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-noheader', text: 'go',
  })
  assert.equal(resume.status, 200)
  assert.equal(resume.body.execution_model, null)
  assert.equal(resume.body.execution_model_source, 'unknown')
  assert.equal(resume.body.model_match, null)
  await close(started.server)
})

test('an explicit model on the write request is set, confirmed and executed', async () => {
  const ctx = officialCtx()
  ctx.state.selection = { provider: 'alternate-provider', model: 'alternate-model' }
  ctx.state.providers = ['example-provider', 'alternate-provider']
  ctx.state.providerModels['alternate-provider'] = ['alternate-model']
  const started = await startServer(ctx, { initial: WRITE_DEMO })
  const resume = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop', request_id: 'req-explicit', text: 'go',
    model: { provider: 'example-provider', model: 'example-model' },
  })
  assert.equal(resume.status, 200)
  assert.equal(resume.body.model_selection, 'session_selected_by_bridge')
  assert.equal(resume.body.requested_model.provider, 'example-provider')
  assert.equal(resume.body.execution_model.provider, 'example-provider')
  assert.equal(resume.body.completed, true)
  assert.equal(ctx.state.selectCalls.length, 1)
  await close(started.server)
})