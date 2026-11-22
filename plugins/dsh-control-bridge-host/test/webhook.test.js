/**
 * Outbound completion notifications: classification, persistence, signature,
 * retry, idempotency, SSRF guard and payload redaction. The HTTP receiver is a
 * mock transport; a mocked 200 is not a live end-to-end result.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createOutbox, eventIdFor, outcomeOf, payloadFor, signPayload, validateWebhookUrl,
} from '../outbox.js'
import { WORKSPACE, call, close, officialCtx, startServer } from './fixtures.js'

const WRITE_DEMO = {
  version: 1,
  workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
  sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' }],
}

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outbox-')), 'outbox.json')
}

function record(overrides = {}) {
  return {
    request_id: 'req-notify',
    session_id: 'session-demo',
    phase: 'terminal',
    terminal_scope: 'official',
    response: { terminal: 'completed', completed: true, turn: 3, text: 'private answer' },
    event_seq: 9,
    ...overrides,
  }
}

test('notifications are off by default and only terminal-shaped records are classified', () => {
  const off = createOutbox({ webhook: { enabled: false } })
  assert.equal(off.enqueue(record()), null)

  assert.equal(outcomeOf(record()), 'completed')
  assert.equal(outcomeOf(record({ response: { terminal: 'error', completed: false, turn: 3 } })), 'failed')
  assert.equal(outcomeOf(record({ response: { terminal: 'aborted', completed: false, turn: 3 } })), 'cancelled')
  assert.equal(outcomeOf(record({ response: { terminal: 'model_mismatch', completed: false, turn: 3 } })), 'failed')
  assert.equal(outcomeOf(record({ phase: 'unknown', manual_reconcile: true })), 'unknown')
  assert.equal(outcomeOf(record({ phase: 'accepted', terminal_scope: 'bridge_wait', response: { terminal: 'bridge_timeout' } })), 'bridge_timeout')
  assert.equal(outcomeOf(record({ phase: 'accepted', response: null })), null)
  assert.equal(outcomeOf(record({ phase: 'accepted', needs_input_notified: true, response: null })), 'needs_input')
  // An accepted prompt or a bridge-wait timeout is never completed.
  assert.equal(payloadFor(record({ phase: 'accepted', terminal_scope: 'bridge_wait', response: { terminal: 'bridge_timeout' } }), 'bridge_timeout').completed, false)
  assert.equal(payloadFor(record(), 'completed').completed, true)
})

test('receiver URLs are HTTPS, allowlisted and must resolve to public addresses', async () => {
  const publicResolve = async () => [{ address: '203.0.113.10', family: 4 }]
  assert.equal((await validateWebhookUrl('http://receiver.example/hook', { resolveHost: publicResolve })).reason, 'https_required')
  assert.equal((await validateWebhookUrl('https://user:pass@receiver.example/hook', { resolveHost: publicResolve })).reason, 'userinfo_not_allowed')
  assert.equal((await validateWebhookUrl('https://receiver.example/hook#frag', { resolveHost: publicResolve })).reason, 'fragment_not_allowed')
  assert.equal((await validateWebhookUrl('https://receiver.example/hook', { resolveHost: publicResolve, allowedHosts: ['other.example'] })).reason, 'host_not_allowed')
  assert.equal((await validateWebhookUrl('https://receiver.example/hook', { resolveHost: async () => [{ address: '127.0.0.1', family: 4 }] })).reason, 'private_address')
  assert.equal((await validateWebhookUrl('https://receiver.example/hook', { resolveHost: async () => [{ address: '10.1.2.3', family: 4 }] })).reason, 'private_address')
  assert.equal((await validateWebhookUrl('https://receiver.example/hook', { resolveHost: async () => [{ address: '::1', family: 6 }] })).reason, 'private_address')
  const good = await validateWebhookUrl('https://receiver.example/hook', { resolveHost: publicResolve })
  assert.equal(good.ok, true)
})

test('events are durable, idempotent, signed and carry no history text', async () => {
  const file = tempFile()
  let clock = 1_700_000_000_000
  const sent = []
  const post = async (request) => {
    sent.push(request)
    return { status: 200 }
  }
  const first = createOutbox({
    file,
    webhook: { enabled: true, url: 'https://receiver.example/hook', secret: 'shared-secret', eventTypes: ['completed'] },
    post,
    now: () => clock,
  })
  const one = first.enqueue(record())
  const two = first.enqueue(record())
  assert.equal(one.event_id, two.event_id)
  assert.equal(first.snapshot().length, 1)
  assert.equal(await first.flushOnce(), 1)
  assert.equal(sent.length, 1)
  const headers = sent[0].headers
  assert.equal(headers['x-dsh-event-id'], one.event_id)
  assert.equal(headers['x-dsh-signature'], signPayload('shared-secret', headers['x-dsh-timestamp'], sent[0].body))
  const body = JSON.parse(sent[0].body)
  assert.deepEqual(Object.keys(body).sort(), ['completed', 'event_id', 'occurred_at', 'outcome_scope', 'request_id', 'rpc_id', 'sequence', 'terminal', 'turn', 'type'])
  assert.doesNotMatch(sent[0].body, /private answer|session-demo|C:\/work/)
  assert.equal(body.event_id, eventIdFor(record(), 'completed'))

  const reopened = createOutbox({ file, webhook: { enabled: true, url: 'https://receiver.example/hook', secret: 'x' }, post, now: () => clock })
  assert.equal(reopened.snapshot()[0].status, 'delivered')
  const duplicate = reopened.enqueue(record())
  assert.equal(duplicate.event_id, one.event_id)
  assert.equal(reopened.snapshot().length, 1)
})

test('transient failures back off and stop at the attempt limit', async () => {
  const file = tempFile()
  let clock = 1_700_000_000_000
  let calls = 0
  const post = async () => {
    calls += 1
    return calls === 1 ? { status: 500 } : { status: 200 }
  }
  const box = createOutbox({
    file,
    webhook: { enabled: true, url: 'https://receiver.example/hook', secret: 's', maxAttempts: 2 },
    post,
    now: () => clock,
  })
  box.enqueue(record())
  await box.flushOnce()
  assert.equal(box.snapshot()[0].attempts, 1)
  assert.equal(box.snapshot()[0].status, 'pending')
  clock += 50
  assert.equal(await box.flushOnce(), 0) // not due yet
  clock += 2_000
  await box.flushOnce()
  assert.equal(box.snapshot()[0].status, 'delivered')

  const failing = createOutbox({
    file: tempFile(),
    webhook: { enabled: true, url: 'https://receiver.example/hook', secret: 's', maxAttempts: 1 },
    post: async () => ({ status: 503 }),
    now: () => clock,
  })
  failing.enqueue(record())
  await failing.flushOnce()
  assert.equal(failing.snapshot()[0].status, 'failed')
})

test('a completed turn enqueues one completed event; bridge_timeout is separate and opt-in', async () => {
  const sent = []
  const outbox = createOutbox({
    file: tempFile(),
    webhook: {
      enabled: true,
      url: 'https://receiver.example/hook',
      secret: 's',
      eventTypes: ['completed', 'bridge_timeout'],
    },
    post: async (request) => { sent.push(request); return { status: 200 } },
  })
  const ctx = officialCtx()
  const started = await startServer(ctx, { initial: WRITE_DEMO, outbox })
  await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop',
    request_id: 'req-notify-live', text: 'go', wait: false,
  })
  const finished = await call(started.port, 'GET', '/v1/requests/req-notify-live/wait?timeout_ms=3000')
  assert.equal(finished.body.completed, true)
  await outbox.flushOnce()
  assert.equal(sent.length, 1)
  assert.equal(JSON.parse(sent[0].body).type, 'completed')

  const timeoutBox = createOutbox({
    file: tempFile(),
    webhook: { enabled: true, url: 'https://receiver.example/hook', secret: 's', eventTypes: ['completed', 'bridge_timeout'] },
    post: async (request) => { sent.push(request); return { status: 200 } },
  })
  const held = officialCtx({ holdTurn: true })
  const heldServer = await startServer(held, { initial: WRITE_DEMO, outbox: timeoutBox })
  const timedOut = await call(heldServer.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop',
    request_id: 'req-notify-timeout', text: 'go', wait_ms: 50,
  })
  assert.equal(timedOut.body.terminal_scope, 'bridge_wait')
  await timeoutBox.flushOnce()
  const timeoutEvent = sent.map((request) => JSON.parse(request.body)).find((body) => body.type === 'bridge_timeout')
  assert.ok(timeoutEvent)
  assert.equal(timeoutEvent.completed, false)
  await close(heldServer.server)
  await close(started.server)
})

test('waiting for input is detected from the official state and notified once', async () => {
  const sent = []
  const outbox = createOutbox({
    file: tempFile(),
    webhook: { enabled: true, url: 'https://receiver.example/hook', secret: 's', eventTypes: ['needs_input'] },
    post: async (request) => { sent.push(request); return { status: 200 } },
  })
  const ctx = officialCtx({ holdTurn: true })
  ctx.state.pendingInput = ['approval']
  const started = await startServer(ctx, { initial: WRITE_DEMO, outbox })
  await call(started.port, 'POST', '/v1/resume', {
    workspace_id: WORKSPACE, session_id: 'session-demo', profile: 'desktop',
    request_id: 'req-notify-input', text: 'go', wait: false,
  })
  const read = await call(started.port, 'GET', '/v1/requests/req-notify-input/wait?timeout_ms=200')
  assert.equal(read.status, 200)
  await outbox.flushOnce()
  assert.equal(sent.length, 1)
  assert.equal(JSON.parse(sent[0].body).type, 'needs_input')
  const again = await call(started.port, 'GET', '/v1/requests/req-notify-input/events?after_seq=0&timeout_ms=200')
  assert.equal(again.status, 200)
  await outbox.flushOnce()
  assert.equal(sent.length, 1)
  await close(started.server)
})