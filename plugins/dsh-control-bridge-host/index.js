import fs from 'node:fs'
import path from 'node:path'
import { resolveAutonomyConfig } from './autonomy.js'
import { createBootstrapSource } from './bootstrap.js'
import { createGrantStore, loadAllowlistFile } from './grants.js'
import { loadRequestFile } from './requests.js'
import { decideListen } from './policy.js'
import { createHostServer } from './server.js'

export const name = 'dsh-control-bridge-host'
export const inject = ['sessionController', 'workspaceRegistry', 'sessionQuery', 'agents', 'llm']

function readSecret(path) {
  if (!path) return ''
  try {
    return fs.readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

export function apply(ctx, config = {}) {
  const services = Boolean(ctx.sessionController && ctx.workspaceRegistry && ctx.sessionQuery)
  // The startup decision needs the same truth the health endpoint declares: an
  // empty profile may only start when the operator's autonomy policy is really
  // in effect, never because a flag merely exists.
  const autonomy = resolveAutonomyConfig(config, ctx)
  const autonomyInfo = {
    configured: autonomy.configured,
    enabled: autonomy.enabled,
    effective: autonomy.effective,
    reason: autonomy.reason,
  }
  const loaded = loadAllowlistFile(config.allowlistFile)
  // Fail closed: a file that exists but cannot be read or parsed is not an
  // empty allowlist. A zero-byte or corrupt file would lose every grant it is
  // supposed to hold, so it never starts a listener.
  if (loaded.status === 'unreadable' || loaded.status === 'invalid_entries') {
    return {
      listening: false,
      reason: 'allowlist_unreadable',
      allowlist_status: loaded.status,
      detail: loaded.detail,
      autonomy: autonomyInfo,
      outbound: false,
    }
  }
  const initial = loaded.status === 'unconfigured'
    ? {
      version: 1,
      workspaceAllowlist: Array.isArray(config.workspaceAllowlist) ? config.workspaceAllowlist : [],
      sessionAllowlist: Array.isArray(config.sessionAllowlist) ? config.sessionAllowlist : [],
    }
    : loaded.state
  // A missing file is the first run: the store keeps the path, writes the first
  // grant atomically, and nothing is pre-seeded here.
  // One authority for memory and disk; pairing, access changes, and revocation
  // all go through it, and a failed save never changes the in-memory grants.
  const requestsFile = config.requestsFile || (config.allowlistFile ? path.join(path.dirname(config.allowlistFile), 'requests.json') : '')
  const outboxFile = config.outboxFile || (config.allowlistFile ? path.join(path.dirname(config.allowlistFile), 'outbox.json') : '')
  const requestsLoaded = loadRequestFile(requestsFile)
  if (requestsLoaded.status === 'invalid') {
    return {
      listening: false,
      reason: 'requests_unreadable',
      autonomy: autonomyInfo,
      outbound: false,
      detail: requestsLoaded.detail,
    }
  }
  const grants = createGrantStore({ file: config.allowlistFile, initial })
  const snapshot = grants.snapshot()
  const count = snapshot.workspaceAllowlist.length + snapshot.sessionAllowlist.length
  const hostSecret = readSecret(config.secretFile) || process.env[config.secretEnv || ''] || ''
  // The pairing window is read from disk on every request, so re-arming or
  // consuming it while Desktop keeps running needs no restart. A file that
  // exists but cannot be read or parsed never arms a window.
  const bootstrap = createBootstrapSource({
    bootstrapFile: config.bootstrapFile,
    bootstrapSecretFile: config.bootstrapSecretFile,
  })
  const armed = bootstrap.read()
  const decision = decideListen({
    services,
    hostSecret,
    allowlistCount: count,
    bind: config.bind,
    bootstrap: armed,
    autonomyEffective: autonomy.effective,
  })
  if (!decision.listening) return { ...decision, autonomy: autonomyInfo }
  const globalDefault = () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
      if (!service || typeof service.currentSelection !== 'function') return null
      return service.currentSelection()
    } catch {
      return null
    }
  }
  const server = createHostServer(ctx, {
    ...config,
    grants,
    requestsFile,
    outboxFile,
    webhook: config.webhook,
    globalDefault,
    busyPolicy: config.busyPolicy || 'refuse',
  }, {
    host: hostSecret,
    bootstrapSource: bootstrap,
  })
  server.listen(config.port || 8765, '127.0.0.1')
  return {
    listening: true,
    bind: '127.0.0.1',
    port: config.port || 8765,
    outbound: Boolean(config.webhook && config.webhook.enabled === true),
    bootstrap: decision.bootstrap,
    grants: count,
    allowlist_file: Boolean(config.allowlistFile),
    autonomy: autonomyInfo,
  }
}
