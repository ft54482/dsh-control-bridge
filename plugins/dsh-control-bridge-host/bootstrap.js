/**
 * Re-armable, one-time pairing window.
 *
 * The window lives in two operator files next to the allowlist:
 * `bootstrap.json` (secret, expiry, consumed flag, and a hash of the retired
 * secret) and `bootstrap.secret` (the same secret, legacy layout from 0.1.5).
 * Both are read again on every request, so re-arming while Desktop stays
 * running needs no process restart.
 *
 * Rules:
 * - a missing file is "no window"; an unreadable or invalid file fails closed
 *   and never falls back to a stale window;
 * - a window is armed only while it is short-lived (at most
 *   `MAX_WINDOW_MS`), unexpired, not consumed, and carries a long secret;
 * - consumption is a compare-and-swap on the secret that authenticated the
 *   request: a window re-armed in the meantime is left armed, and the
 *   long-lived host secret is never touched;
 * - the retired secret is replaced by `consumedSecretHash` so a replay can be
 *   named `bootstrap_consumed` without keeping the secret on disk.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** A pairing window longer than this is refused even if the file says otherwise. */
export const MAX_WINDOW_MS = 60 * 60 * 1000
/** checkAuth() also refuses a shorter bearer; keep one threshold. */
export const MIN_SECRET_LENGTH = 32

function text(value) {
  return typeof value === 'string' ? value : ''
}

function readText(file) {
  if (!file) return ''
  try {
    return text(fs.readFileSync(file, 'utf8')).trim()
  } catch {
    return ''
  }
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex')
}

export { hashSecret }

function stampOf(file) {
  if (!file) return null
  try {
    return `${fs.statSync(file).mtimeMs}:${fs.statSync(file).size}`
  } catch {
    return null
  }
}

export function matchesSecretHash(header, expectedHash) {
  if (!expectedHash) return false
  const match = /^Bearer\s+(\S+)$/.exec(header || '')
  if (!match) return false
  const given = Buffer.from(hashSecret(match[1]), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  if (given.length !== expected.length) return false
  return crypto.timingSafeEqual(given, expected)
}

function writeAtomic(file, content) {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const tmp = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  let handle
  try {
    handle = fs.openSync(tmp, 'wx', 0o600)
    fs.writeFileSync(handle, content, 'utf8')
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

function invalid(detail) {
  return {
    status: 'invalid',
    armed: false,
    reason: 'bootstrap_invalid',
    detail,
    secret: '',
    expiresAt: 0,
    consumed: false,
    consumedSecretHash: '',
  }
}

/**
 * Read the current pairing window.
 * @returns `{ status, armed, reason, detail, secret, expiresAt, consumed, consumedSecretHash }`
 *   where status is `unconfigured | missing | invalid | ok`.
 */
export function readBootstrap({ bootstrapFile, bootstrapSecretFile } = {}, now = Date.now()) {
  if (!bootstrapFile) {
    return { status: 'unconfigured', armed: false, reason: 'no_bootstrap_file', detail: '', secret: '', expiresAt: 0, consumed: false, consumedSecretHash: '' }
  }
  let raw
  try {
    raw = fs.readFileSync(bootstrapFile, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { status: 'missing', armed: false, reason: 'no_armed_window', detail: '', secret: '', expiresAt: 0, consumed: false, consumedSecretHash: '' }
    }
    return invalid(`read failed: ${error && error.code ? error.code : 'error'}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return invalid('invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid('top-level value is not an object')
  const expiresAt = Number(parsed.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return invalid('expiresAt is missing or not a number')
  const consumed = parsed.consumed === true
  const consumedSecretHash = /^[0-9a-f]{64}$/.test(text(parsed.consumedSecretHash)) ? text(parsed.consumedSecretHash) : ''
  const jsonSecret = text(parsed.secret)
  const fileSecret = readText(bootstrapSecretFile)
  // The JSON is authoritative. A non-empty legacy secret file that disagrees
  // with it is an inconsistent window, not a reason to pick one silently: a
  // stale file must never shadow a re-armed JSON secret. The re-arm script
  // writes both copies; an operator editing JSON alone must clear the legacy
  // file (empty is fine, the JSON is then used).
  if (fileSecret && jsonSecret && fileSecret !== jsonSecret) {
    return invalid('bootstrap.json and bootstrap.secret disagree')
  }
  const secret = jsonSecret || fileSecret
  const armed = !consumed
    && secret.length >= MIN_SECRET_LENGTH
    && expiresAt > now
    && (expiresAt - now) <= MAX_WINDOW_MS
  const reason = armed
    ? ''
    : (consumed ? 'bootstrap_consumed'
      : (expiresAt <= now ? 'bootstrap_expired'
        : (secret.length < MIN_SECRET_LENGTH ? 'bootstrap_no_secret'
          : 'bootstrap_window_too_long')))
  return { status: 'ok', armed, reason, detail: '', secret, jsonSecret, expiresAt, consumed, consumedSecretHash }
}

/**
 * Retire the window that authenticated one pairing, compare-and-swap style.
 * The secret is replaced by its hash so a replay can be named; the window is
 * only retired when it still holds the secret that was actually used.
 * @returns `{ consumed, reason }`
 */
export function consumeBootstrap({ bootstrapFile, bootstrapSecretFile } = {}, usedSecret, now = Date.now()) {
  if (!bootstrapFile) return { consumed: false, reason: 'no_bootstrap_file' }
  const current = readBootstrap({ bootstrapFile, bootstrapSecretFile }, now)
  if (current.status === 'invalid') return { consumed: false, reason: 'bootstrap_invalid' }
  if (current.status === 'missing') return { consumed: false, reason: 'no_armed_window' }
  if (current.consumed) return { consumed: false, reason: 'bootstrap_consumed' }
  // Compare-and-swap on both stored copies. If a re-arm has updated either the
  // JSON or the legacy secret file, the window this request authenticated no
  // longer exists and must not be retired.
  if (current.secret !== usedSecret || (current.jsonSecret && current.jsonSecret !== usedSecret)) {
    return { consumed: false, reason: 'bootstrap_changed' }
  }
  if (!(current.expiresAt > now)) return { consumed: false, reason: 'bootstrap_expired' }
  // Narrow the read→rename race: if an out-of-process re-arm touched the file
  // after we read it, fail the CAS instead of overwriting the fresh window.
  const seen = stampOf(bootstrapFile)
  if (seen === null) return { consumed: false, reason: 'bootstrap_changed' }
  const retired = {
    version: 1,
    expiresAt: current.expiresAt,
    consumed: true,
    secret: '',
    consumedSecretHash: hashSecret(usedSecret),
  }
  try {
    if (stampOf(bootstrapFile) !== seen) return { consumed: false, reason: 'bootstrap_changed' }
    writeAtomic(bootstrapFile, `${JSON.stringify(retired)}\n`)
    // The legacy secret file must stop carrying the retired secret. Empty is
    // valid: readBootstrap() falls back to bootstrap.json.
    if (bootstrapSecretFile && readText(bootstrapSecretFile)) writeAtomic(bootstrapSecretFile, '')
  } catch (error) {
    return { consumed: false, reason: 'bootstrap_persist_failed', detail: error && error.code ? error.code : 'write_failed' }
  }
  return { consumed: true, reason: 'bootstrap_consumed' }
}

/**
 * The file-backed source the running Host uses. `read()` and `consume()` are
 * called per request; nothing is cached, which is what makes a re-arm live.
 */
export function createBootstrapSource(files = {}) {
  return {
    kind: 'file',
    files,
    read(now = Date.now()) {
      return readBootstrap(files, now)
    },
    consume(usedSecret, now = Date.now()) {
      return consumeBootstrap(files, usedSecret, now)
    },
  }
}

/**
 * In-memory source used by isolated tests that pass a window object directly.
 * It mirrors the file semantics, including single use and secret retirement.
 */
export function createStaticBootstrapSource({ secret = '', expiresAt = 0, consumed = false } = {}) {
  let state = { secret: text(secret), expiresAt: Number(expiresAt) || 0, consumed: Boolean(consumed), consumedSecretHash: '' }
  return {
    kind: 'static',
    read(now = Date.now()) {
      const armed = !state.consumed
        && state.secret.length >= MIN_SECRET_LENGTH
        && state.expiresAt > now
        && (state.expiresAt - now) <= MAX_WINDOW_MS
      return {
        status: 'ok',
        armed,
        reason: armed ? '' : (state.consumed ? 'bootstrap_consumed' : (state.expiresAt <= now ? 'bootstrap_expired' : 'bootstrap_no_secret')),
        detail: '',
        secret: state.secret,
        expiresAt: state.expiresAt,
        consumed: state.consumed,
        consumedSecretHash: state.consumedSecretHash,
      }
    },
    consume(usedSecret, now = Date.now()) {
      const current = this.read(now)
      if (!current.armed) return { consumed: false, reason: current.reason || 'bootstrap_not_armed' }
      if (current.secret !== usedSecret) return { consumed: false, reason: 'bootstrap_changed' }
      state = { secret: '', expiresAt: state.expiresAt, consumed: true, consumedSecretHash: hashSecret(usedSecret) }
      return { consumed: true, reason: 'bootstrap_consumed' }
    },
  }
}

/** Wrap the legacy `{host, bootstrap, expiresAt, consumed}` shape used by tests. */
export function bootstrapSourceFromSecret(secret) {
  if (secret && typeof secret === 'object' && secret.bootstrapSource) return secret.bootstrapSource
  if (secret && typeof secret === 'object' && 'bootstrap' in secret) {
    return createStaticBootstrapSource({
      secret: secret.bootstrap,
      expiresAt: secret.expiresAt,
      consumed: secret.consumed,
    })
  }
  return createStaticBootstrapSource({})
}
