/**
 * Stage B regression: re-arm the one-time pairing window and pick up grant
 * changes while the Host keeps running.
 *
 * These tests drive the real file-backed bootstrap source through a live
 * loopback server. "No restart" means the same `createHostServer()` instance
 * answers before and after the operator rewrites the bootstrap files; no
 * process is restarted and no module is re-imported.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MAX_WINDOW_MS, createBootstrapSource, readBootstrap } from '../bootstrap.js'
import { createGrantStore } from '../grants.js'
import { SECRET, WORKSPACE, call, close, officialCtx, startServer } from './fixtures.js'

const NEW_SECRET = 'rearm-secret-0123456789abcdef01234567'
const NEXT_SECRET = 'rearm-secret-fedcba9876543210fedcba98'

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

function files(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rearm-'))
  const allowlist = path.join(dir, 'allowlist.json')
  if (initial) fs.writeFileSync(allowlist, JSON.stringify(initial, null, 2))
  const hostSecret = path.join(dir, 'host.secret')
  fs.writeFileSync(hostSecret, SECRET)
  const bootstrapFile = path.join(dir, 'bootstrap.json')
  const bootstrapSecretFile = path.join(dir, 'bootstrap.secret')
  const source = createBootstrapSource({ bootstrapFile, bootstrapSecretFile })
  return { dir, allowlist, hostSecret, bootstrapFile, bootstrapSecretFile, source }
}

function arm(state, options = {}) {
  const secret = options.secret || NEW_SECRET
  const expiresAt = options.expiresAt || Date.now() + (options.minutes || 20) * 60_000
  fs.writeFileSync(state.bootstrapSecretFile, secret)
  fs.writeFileSync(state.bootstrapFile, JSON.stringify({ version: 1, secret, expiresAt, consumed: Boolean(options.consumed) }))
  return secret
}

async function start(state, initial, options = {}) {
  const store = options.store || createGrantStore({ file: state.allowlist })
  const started = await startServer(officialCtx(), {
    store,
    file: state.allowlist,
    dir: state.dir,
    requestsFile: path.join(state.dir, 'requests.json'),
    secret: { host: SECRET, bootstrapSource: state.source },
    ...options.startOptions,
  })
  return started
}

const host = (started, method, pathname, body) => call(started.port, method, pathname, body, SECRET)
const boot = (started, secret, method, pathname, body) => call(started.port, method, pathname, body, secret)

function body(extra = {}) {
  return {
    workspace_id: WORKSPACE,
    session_id: 'session-demo',
    profile: 'desktop',
    request_id: 'req-rearm',
    text: 'say hi',
    ...extra,
  }
}

test('a pairing window can be re-armed and spent while the same server keeps running', async () => {
  const state = files(WRITE_DEMO)
  const started = await start(state, WRITE_DEMO)
  try {
    // Steady state: one durable grant, no window.
    const before = await host(started, 'GET', '/v1/health')
    assert.equal(before.body.grants_count, 2) // one workspace + one session
    assert.equal(before.body.bootstrap_armed, false)
    const unarmed = await boot(started, NEW_SECRET, 'GET', '/v1/bootstrap/catalog')
    assert.equal(unarmed.status, 401)

    // The operator re-arms only the bootstrap files; the process is untouched.
    arm(state)
    const health = await host(started, 'GET', '/v1/health')
    assert.equal(health.body.bootstrap_armed, true)
    assert.equal(health.body.bootstrap_status, 'ok')

    const catalog = await boot(started, NEW_SECRET, 'GET', '/v1/bootstrap/catalog')
    assert.equal(catalog.status, 200)
    assert.equal(catalog.body.session_status, 'ok')

    const selected = await boot(started, NEW_SECRET, 'POST', '/v1/bootstrap/select', { session_id: 'session-plain', access: 'read' })
    assert.equal(selected.status, 200)
    assert.equal(selected.body.ok, true)
    assert.equal(selected.body.bootstrap_consumed, true)
    assert.equal(selected.body.allowlist.sessionAllowlist.length, 2)
    // The response names the grant that was just written, not allowlist[0]
    // (which is an older entry on a second pairing).
    assert.equal(selected.body.granted.session_id, 'session-plain')
    assert.equal(selected.body.granted.workspace_id, WORKSPACE)
    assert.equal(selected.body.granted.access, 'read')
    assert.equal(selected.body.granted.cwd, 'C:/work/demo')

    // Same process, next request: the grant is live and the earlier grant survived.
    const granted = await host(started, 'GET', '/v1/granted')
    assert.equal(granted.body.sessions.length, 2)
    assert.deepEqual(granted.body.sessions.map((item) => item.session_id).sort(), ['session-demo', 'session-plain'])
    const demo = granted.body.sessions.find((item) => item.session_id === 'session-demo')
    assert.equal(demo.access, 'write')

    // Single use: the spent secret is named, not misreported as arbitrary.
    const replay = await boot(started, NEW_SECRET, 'GET', '/v1/bootstrap/catalog')
    assert.equal(replay.status, 403)
    assert.equal(replay.body.reason, 'bootstrap_consumed')
    const retired = readBootstrap({ bootstrapFile: state.bootstrapFile, bootstrapSecretFile: state.bootstrapSecretFile })
    assert.equal(retired.consumed, true)
    assert.equal(retired.secret, '')
    assert.equal(retired.consumedSecretHash.length, 64)
    assert.equal(fs.readFileSync(state.bootstrapSecretFile, 'utf8'), '')

    // The long-lived host secret was not rotated by pairing.
    assert.equal(fs.readFileSync(state.hostSecret, 'utf8'), SECRET)
    const stillHost = await host(started, 'GET', '/v1/granted')
    assert.equal(stillHost.status, 200)

    // The preserved write grant still resumes.
    const resumed = await host(started, 'POST', '/v1/resume', body())
    assert.equal(resumed.body.completed, true)
  } finally {
    await close(started.server)
  }
})

test('re-arming after a spent window works without a restart and keeps existing grants', async () => {
  const state = files(WRITE_DEMO)
  const started = await start(state, WRITE_DEMO)
  try {
    arm(state)
    assert.equal((await boot(started, NEW_SECRET, 'POST', '/v1/bootstrap/select', { session_id: 'session-plain', access: 'read' })).status, 200)

    arm(state, { secret: NEXT_SECRET })
    const health = await host(started, 'GET', '/v1/health')
    assert.equal(health.body.bootstrap_armed, true)
    // The retired secret is gone; only the new window is accepted.
    const old = await boot(started, NEW_SECRET, 'GET', '/v1/bootstrap/catalog')
    assert.equal(old.status, 401)
    const catalog = await boot(started, NEXT_SECRET, 'GET', '/v1/bootstrap/catalog')
    assert.equal(catalog.status, 200)

    const selected = await boot(started, NEXT_SECRET, 'POST', '/v1/bootstrap/select', { session_id: 'session-busy', access: 'read' })
    assert.equal(selected.status, 200)
    assert.equal(selected.body.allowlist.sessionAllowlist.length, 3)
    assert.deepEqual(
      selected.body.allowlist.sessionAllowlist.map((item) => item.sessionId).sort(),
      ['session-busy', 'session-demo', 'session-plain'],
    )
    assert.equal(fs.readFileSync(state.hostSecret, 'utf8'), SECRET)
  } finally {
    await close(started.server)
  }
})

test('one armed window is spent once even under concurrent pairing attempts', async () => {
  const state = files(WRITE_DEMO)
  const started = await start(state, WRITE_DEMO)
  try {
    arm(state)
    const [left, right] = await Promise.all([
      boot(started, NEW_SECRET, 'POST', '/v1/bootstrap/select', { session_id: 'session-plain', access: 'read' }),
      boot(started, NEW_SECRET, 'POST', '/v1/bootstrap/select', { session_id: 'session-busy', access: 'read' }),
    ])
    const statuses = [left.status, right.status].sort()
    assert.deepEqual(statuses, [200, 403])
    const denied = left.status === 403 ? left : right
    assert.equal(denied.body.reason, 'bootstrap_consumed')
    const stored = JSON.parse(fs.readFileSync(state.allowlist, 'utf8'))
    assert.equal(stored.sessionAllowlist.length, 2)
    assert.equal(stored.sessionAllowlist.some((item) => item.sessionId === 'session-demo'), true)
    assert.equal(fs.readFileSync(state.bootstrapSecretFile, 'utf8'), '')
  } finally {
    await close(started.server)
  }
})

test('an expired window or one whose remaining life exceeds the cap fails closed and changes no grant', async () => {
  const state = files(WRITE_DEMO)
  const before = fs.readFileSync(state.allowlist)
  const started = await start(state, WRITE_DEMO)
  try {
    arm(state, { expiresAt: Date.now() - 1_000 })
    const expired = await boot(started, NEW_SECRET, 'GET', '/v1/bootstrap/catalog')
    assert.equal(expired.status, 403)
    assert.equal(expired.body.reason, 'bootstrap_expired')
    const select = await boot(started, NEW_SECRET, 'POST', '/v1/bootstrap/select', { session_id: 'session-plain', access: 'read' })
    assert.equal(select.status, 403)
    assert.equal(select.body.reason, 'bootstrap_expired')
    assert.deepEqual(fs.readFileSync(state.allowlist), before)

    arm(state, { expiresAt: Date.now() + MAX_WINDOW_MS + 60_000 })
    const tooLong = await boot(started, NEW_SECRET, 'GET', '/v1/bootstrap/catalog')
    assert.equal(tooLong.status, 403)
    assert.equal(tooLong.body.reason, 'bootstrap_window_too_long')
    assert.deepEqual(fs.readFileSync(state.allowlist), before)
  } finally {
    await close(started.server)
  }
})

test('unreadable or invalid bootstrap JSON fails closed and recovers on the next edit', async () => {
  const state = files(WRITE_DEMO)
  const started = await start(state, WRITE_DEMO)
  try {
    arm(state)
    assert.equal((await boot(started, NEW_SECRET, 'GET', '/v1/bootstrap/catalog')).status, 200)
    // Damage the file while the secret file still carries the old secret: the
    // window must not fall back to a cached or unverified state.
    fs.writeFileSync(state.bootstrapFile, '{"secret":')
    const broken = await boot(started, NEW_SECRET, 'GET', '/v1/bootstrap/catalog')
    assert.equal(broken.status, 401)
    const health = await host(started, 'GET', '/v1/health')
    assert.equal(health.body.bootstrap_status, 'invalid')
    assert.equal(health.body.bootstrap_armed, false)
    assert.equal((await boot(started, NEW_SECRET, 'POST', '/v1/bootstrap/select', { session_id: 'session-plain', access: 'read' })).status, 401)
    const stored = JSON.parse(fs.readFileSync(state.allowlist, 'utf8'))
    assert.equal(stored.sessionAllowlist.length, 1)

    // Rewriting a valid window is picked up without a restart.
    arm(state, { secret: NEXT_SECRET })
    assert.equal((await boot(started, NEXT_SECRET, 'GET', '/v1/bootstrap/catalog')).status, 200)
    assert.equal(fs.readFileSync(state.hostSecret, 'utf8'), SECRET)
  } finally {
    await close(started.server)
  }
})

test('a failed grant write leaves the armed window spendable and keeps existing grants', async () => {
  const state = files(null)
  // A directory at the allowlist path makes every grant write fail. The store
  // starts from the existing grant, so a failed pairing must neither widen nor
  // drop it.
  fs.mkdirSync(state.allowlist)
  const store = createGrantStore({ file: state.allowlist, initial: WRITE_DEMO })
  const started = await start(state, null, { store })
  try {
    arm(state)
    const refused = await boot(started, NEW_SECRET, 'POST', '/v1/bootstrap/select', { session_id: 'session-plain', access: 'read' })
    assert.equal(refused.status, 500)
    assert.equal(refused.body.saved, false)
    assert.equal(refused.body.bootstrap_consumed, false)
    // Memory did not widen, and the grant that existed before is still usable.
    const granted = await host(started, 'GET', '/v1/granted')
    assert.equal(granted.body.sessions.length, 1)
    assert.equal(granted.body.sessions[0].session_id, 'session-demo')
    assert.equal(granted.body.sessions[0].access, 'write')
    // The window is still armed, so the operator can retry after the fault.
    const retryCatalog = await boot(started, NEW_SECRET, 'GET', '/v1/bootstrap/catalog')
    assert.equal(retryCatalog.status, 200)
    assert.equal((await host(started, 'GET', '/v1/health')).body.bootstrap_armed, true)
  } finally {
    await close(started.server)
  }
})

test('an external allowlist edit is visible without a restart (raise, then revoke)', async () => {
  const state = files(READ_DEMO)
  const started = await start(state, READ_DEMO)
  try {
    const readOnly = await host(started, 'POST', '/v1/resume', body())
    assert.equal(readOnly.body.accepted, false)
    assert.equal(readOnly.body.reason, 'read_only')

    const raised = {
      version: 1,
      workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
      sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' }],
    }
    fs.writeFileSync(state.allowlist, JSON.stringify(raised, null, 2))
    const upgraded = await host(started, 'POST', '/v1/resume', body({ request_id: 'req-raised' }))
    assert.equal(upgraded.body.completed, true)

    const revoked = { version: 1, workspaceAllowlist: [], sessionAllowlist: [] }
    fs.writeFileSync(state.allowlist, JSON.stringify(revoked, null, 2))
    const denied = await host(started, 'GET', '/v1/granted')
    assert.equal(denied.body.sessions.length, 0)
    const afterRevoke = await host(started, 'POST', '/v1/resume', body({ request_id: 'req-after' }))
    assert.equal(afterRevoke.body.reason, 'workspace_not_allowlisted')
  } finally {
    await close(started.server)
  }
})

test('the durable grant marker blocks a second spending when the window-file write fails', async () => {
  const state = files(WRITE_DEMO)
  arm(state)
  // The window stays armed on disk (the consume write "fails"), but the grant
  // file records the spent window in the same atomic write as the grant.
  const failingConsume = {
    read: (now) => state.source.read(now),
    consume: () => ({ consumed: false, reason: 'bootstrap_persist_failed' }),
  }
  const store = createGrantStore({ file: state.allowlist })
  const started = await start(state, WRITE_DEMO, {
    store,
    startOptions: { secret: { host: SECRET, bootstrapSource: failingConsume } },
  })
  try {
    const first = await boot(started, NEW_SECRET, 'POST', '/v1/bootstrap/select', { session_id: 'session-plain', access: 'read' })
    assert.equal(first.status, 200)
    assert.equal(first.body.ok, true)
    assert.equal(first.body.bootstrap_consumed, false)
    assert.equal(first.body.bootstrap_retired, true)
    assert.equal(JSON.parse(fs.readFileSync(state.allowlist, 'utf8')).spentBootstrapHash.length, 64)

    // Same window, same process: the marker refuses it even though the file
    // still looks armed.
    const replay = await boot(started, NEW_SECRET, 'GET', '/v1/bootstrap/catalog')
    assert.equal(replay.status, 403)
    assert.equal(replay.body.reason, 'bootstrap_consumed')
    const second = await boot(started, NEW_SECRET, 'POST', '/v1/bootstrap/select', { session_id: 'session-busy', access: 'read' })
    assert.equal(second.status, 403)
    const granted = JSON.parse(fs.readFileSync(state.allowlist, 'utf8'))
    assert.deepEqual(granted.sessionAllowlist.map((item) => item.sessionId).sort(), ['session-demo', 'session-plain'])
  } finally {
    await close(started.server)
  }
})

test('consume does not retire a window that was re-armed between auth and spend', () => {
  const state = files(WRITE_DEMO)
  const used = arm(state)
  // A re-arm that wrote the new JSON while the legacy secret file still holds
  // the old secret is an inconsistent window: it fails closed and the JSON on
  // disk is left exactly as the re-arm wrote it.
  fs.writeFileSync(state.bootstrapFile, JSON.stringify({
    version: 1,
    secret: NEXT_SECRET,
    expiresAt: Date.now() + 60_000,
    consumed: false,
  }))
  const inconsistent = state.source.consume(used)
  assert.equal(inconsistent.consumed, false)
  assert.equal(inconsistent.reason, 'bootstrap_invalid')
  const onDisk = JSON.parse(fs.readFileSync(state.bootstrapFile, 'utf8'))
  assert.equal(onDisk.secret, NEXT_SECRET)
  assert.equal(onDisk.consumed, false)

  // Once the legacy file no longer contradicts the JSON, the old request's
  // consume is a CAS miss: it must not overwrite the new window.
  fs.writeFileSync(state.bootstrapSecretFile, '')
  const changed = state.source.consume(used)
  assert.equal(changed.consumed, false)
  assert.equal(changed.reason, 'bootstrap_changed')
  assert.equal(JSON.parse(fs.readFileSync(state.bootstrapFile, 'utf8')).secret, NEXT_SECRET)
  assert.equal(state.source.read().armed, true)
})

test('the bootstrap source itself never writes the host secret or the allowlist', async () => {
  const state = files(WRITE_DEMO)
  const allowlistBefore = fs.readFileSync(state.allowlist)
  const hostBefore = fs.readFileSync(state.hostSecret)
  const secret = arm(state)
  const read = state.source.read()
  assert.equal(read.armed, true)
  assert.equal(read.secret, secret)
  const retired = state.source.consume(secret)
  assert.equal(retired.consumed, true)
  assert.equal(state.source.read().armed, false)
  // A second consume is a no-op, not a second retirement.
  assert.equal(state.source.consume(secret).consumed, false)
  assert.deepEqual(fs.readFileSync(state.allowlist), allowlistBefore)
  assert.deepEqual(fs.readFileSync(state.hostSecret), hostBefore)
  assert.deepEqual(JSON.parse(fs.readFileSync(state.bootstrapFile, 'utf8')).secret, '')
})
