/**
 * Durable outbound completion notifications.
 *
 * This is the *uplink*: the bridge tells an operator-controlled HTTPS receiver
 * that a stored request reached a terminal outcome (or needs input). It is not
 * the official inbound webhook that creates Sessions, and it never carries
 * message text, history, titles, cwd, credentials or workspace names.
 *
 * Defaults are off. Delivery is:
 *   terminal state -> persistent outbox -> authenticated HTTPS POST
 * with a stable `event_id`, HMAC signature, bounded exponential retry, and
 * at-most-once *acceptance* semantics per event id on the bridge side. The
 * receiver must still be idempotent by `event_id`.
 */

import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export const DEFAULT_EVENT_TYPES = ['completed', 'failed', 'cancelled', 'needs_input', 'unknown']
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000]
const MAX_EVENTS = 500

function iso(now) {
  return new Date(now).toISOString()
}

function isPrivateAddress(address) {
  const family = net.isIP(address)
  if (family === 4) {
    const octets = address.split('.').map(Number)
    const [a, b] = octets
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }
  if (family === 6) {
    const value = address.toLowerCase()
    if (value === '::1' || value === '::') return true
    if (value.startsWith('fc') || value.startsWith('fd')) return true
    if (value.startsWith('fe80')) return true
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7))
    return false
  }
  return true
}

/**
 * Validate one receiver URL. HTTPS only, no credentials/fragment, host must be
 * listed in `allowedHosts` when that list is non-empty, and every resolved
 * address must be public (SSRF guard). `resolveHost` is injectable for tests.
 */
export async function validateWebhookUrl(url, options = {}) {
  if (typeof url !== 'string' || !url) return { ok: false, reason: 'missing_url' }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'malformed_url' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'https_required' }
  if (parsed.username || parsed.password) return { ok: false, reason: 'userinfo_not_allowed' }
  if (parsed.hash) return { ok: false, reason: 'fragment_not_allowed' }
  const allowedHosts = Array.isArray(options.allowedHosts) ? options.allowedHosts : []
  if (allowedHosts.length > 0 && !allowedHosts.includes(parsed.hostname)) {
    return { ok: false, reason: 'host_not_allowed' }
  }
  const resolveHost = typeof options.resolveHost === 'function'
    ? options.resolveHost
    : (hostname) => dns.lookup(hostname, { all: true })
  let addresses
  try {
    addresses = await resolveHost(parsed.hostname)
  } catch {
    return { ok: false, reason: 'dns_failed' }
  }
  const list = Array.isArray(addresses) ? addresses : [addresses]
  if (list.length === 0) return { ok: false, reason: 'dns_empty' }
  for (const entry of list) {
    const address = typeof entry === 'string' ? entry : entry && entry.address
    if (typeof address !== 'string' || isPrivateAddress(address)) {
      return { ok: false, reason: 'private_address' }
    }
  }
  return { ok: true, url: parsed.toString(), hostname: parsed.hostname }
}

/** Stable per-request outcome identity, so retries and restarts do not mint new ids. */
export function eventIdFor(record, type) {
  const turn = record && record.response && record.response.turn !== undefined ? record.response.turn : ''
  const base = `${record.request_id}\u0000${type}\u0000${record.session_id || ''}\u0000${turn}`
  return crypto.createHash('sha256').update(base).digest('hex')
}

/** Map one durable request record to a notification type, or null while live. */
export function outcomeOf(record) {
  if (!record) return null
  if (record.terminal_scope === 'bridge_wait' || (record.response && record.response.terminal_scope === 'bridge_wait')) {
    return 'bridge_timeout'
  }
  if (record.phase === 'unknown' || record.manual_reconcile === true) return 'unknown'
  if (record.needs_input_notified === true && record.phase !== 'terminal') return 'needs_input'
  if (record.phase !== 'terminal') return null
  const response = record.response || {}
  const terminal = response.terminal
    || (response.final && response.final.reason && response.final.reason.kind)
    || 'unknown'
  if (terminal === 'completed') return 'completed'
  if (terminal === 'aborted' || terminal === 'cancelled' || terminal === 'cancelled_by_user') return 'cancelled'
  if (terminal === 'error' || terminal === 'failed' || terminal === 'model_mismatch' || terminal === 'limit') return 'failed'
  return 'unknown'
}

/**
 * Minimal outbound payload. Deliberately excludes text, title, cwd, workspace
 * name, profile and any credential.
 */
export function payloadFor(record, type, sequence, now = Date.now()) {
  const response = record.response || {}
  return {
    event_id: eventIdFor(record, type),
    type,
    request_id: String(record.request_id || ''),
    rpc_id: String(record.request_id || ''),
    turn: response.turn !== undefined && response.turn !== null ? response.turn : null,
    terminal: type === 'bridge_timeout' ? 'bridge_timeout' : (response.terminal || null),
    completed: type === 'completed',
    outcome_scope: type === 'bridge_timeout' ? 'bridge_wait' : 'official',
    sequence: Number(sequence) || 0,
    occurred_at: iso(now),
  }
}

export function signPayload(secret, timestamp, body) {
  return `sha256=${crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${body}`).digest('hex')}`
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  let handle
  try {
    handle = fs.openSync(tmp, 'wx', 0o600)
    fs.writeFileSync(handle, JSON.stringify(value))
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    handle = undefined
    fs.renameSync(tmp, file)
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle) } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
}

function loadOutbox(file) {
  if (!file) return { version: 1, events: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || !Array.isArray(parsed.events)) return { version: 1, events: [] }
    return { version: 1, events: parsed.events }
  } catch {
    return { version: 1, events: [] }
  }
}

/**
 * Create the outbox. `webhook` is already-validated config (see index.js);
 * `post` is injectable for tests. The worker starts only when enabled.
 */
export function createOutbox({ file, webhook, post, now = Date.now, logger, validate } = {}) {
  const config = webhook || {}
  const enabled = config.enabled === true
  // An injected transport is a test seam; production always re-validates the
  // configured URL (HTTPS + allowlist + public resolution) before starting.
  const validateUrl = typeof validate === 'function'
    ? validate
    : (typeof post === 'function' ? async () => ({ ok: true }) : validateWebhookUrl)
  const eventTypes = Array.isArray(config.eventTypes) && config.eventTypes.length > 0
    ? config.eventTypes
    : DEFAULT_EVENT_TYPES
  const maxAttempts = Number.isFinite(config.maxAttempts) ? Math.max(1, Math.min(20, config.maxAttempts)) : 6
  const timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(500, Math.min(30_000, config.timeoutMs)) : 5_000
  const state = loadOutbox(file)
  let timer = null

  const persist = () => {
    if (!file) return
    const delivered = state.events.filter((event) => event.status === 'delivered')
    const keep = delivered.slice(-MAX_EVENTS)
    state.events = [...state.events.filter((event) => event.status !== 'delivered'), ...keep]
    writeAtomic(file, { version: 1, events: state.events })
  }

  const find = (eventId) => state.events.find((event) => event.event_id === eventId)

  function enqueue(record) {
    if (!enabled) return null
    const type = outcomeOf(record)
    if (!type || !eventTypes.includes(type)) return null
    const eventId = eventIdFor(record, type)
    const existing = find(eventId)
    if (existing) return existing
    const event = {
      event_id: eventId,
      type,
      payload: payloadFor(record, type, record.event_seq, now()),
      status: 'pending',
      attempts: 0,
      next_at: now(),
      last_error: null,
    }
    state.events.push(event)
    try {
      persist()
    } catch (error) {
      state.events = state.events.filter((item) => item.event_id !== eventId)
      logger?.({ method: 'outbox.persist', error: 'OutboxPersistError', code: 'outbox_persist_failed' })
      return null
    }
    return event
  }

  function due(clock) {
    return state.events
      .filter((event) => event.status === 'pending' && event.next_at <= clock)
      .sort((left, right) => left.next_at - right.next_at)
      .slice(0, 10)
  }

  async function deliver(event) {
    if (typeof post !== 'function') return { status: 'retry', code: 'transport_missing' }
    const timestamp = String(Math.floor(now() / 1000))
    const body = JSON.stringify(event.payload)
    try {
      const result = await post({
        url: config.url,
        body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'dsh-control-bridge-outbox/1',
          'x-dsh-event-id': event.event_id,
          'x-dsh-event-type': event.type,
          'x-dsh-timestamp': timestamp,
          'x-dsh-signature': signPayload(config.secret || '', timestamp, body),
        },
        timeoutMs,
      })
      const status = Number(result && result.status)
      if (status >= 200 && status < 300) return { status: 'delivered' }
      if (status === 408 || status === 429 || status >= 500) return { status: 'retry', code: `http_${status}` }
      return { status: 'failed', code: `http_${status}` }
    } catch (error) {
      return { status: 'retry', code: (error && error.code) || 'network_error' }
    }
  }

  async function flushOnce() {
    if (!enabled) return 0
    const clock = now()
    let processed = 0
    for (const event of due(clock)) {
      const outcome = await deliver(event)
      processed += 1
      if (outcome.status === 'delivered') {
        event.status = 'delivered'
        event.delivered_at = iso(now())
        event.last_error = null
      } else if (outcome.status === 'failed') {
        event.status = 'failed'
        event.last_error = outcome.code
      } else {
        event.attempts += 1
        event.last_error = outcome.code
        if (event.attempts >= maxAttempts) {
          event.status = 'failed'
        } else {
          const delay = RETRY_DELAYS_MS[Math.min(event.attempts - 1, RETRY_DELAYS_MS.length - 1)]
          event.next_at = now() + delay
        }
      }
      try {
        persist()
      } catch {
        logger?.({ method: 'outbox.persist', error: 'OutboxPersistError', code: 'outbox_persist_failed' })
      }
    }
    return processed
  }

  function start() {
    if (!enabled || timer) return Promise.resolve({ active: enabled })
    return validateUrl(config.url, { allowedHosts: config.allowedHosts }).then((verdict) => {
      if (!verdict.ok) {
        logger?.({ method: 'outbox.validate', error: 'WebhookUrlRejected', code: verdict.reason })
        return { active: false, reason: verdict.reason }
      }
      timer = setInterval(() => { void flushOnce() }, 1_000)
      if (typeof timer.unref === 'function') timer.unref()
      return { active: true }
    }).catch((error) => {
      logger?.({ method: 'outbox.validate', error: 'WebhookUrlRejected', code: (error && error.code) || 'validate_failed' })
      return { active: false, reason: 'validate_failed' }
    })
  }

  function close() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    enabled,
    eventTypes,
    enqueue,
    flushOnce,
    start,
    close,
    get file() { return file || '' },
    snapshot() {
      return state.events.map((event) => ({
        event_id: event.event_id,
        type: event.type,
        status: event.status,
        attempts: event.attempts,
        next_at: event.next_at,
        last_error: event.last_error,
      }))
    },
  }
}
