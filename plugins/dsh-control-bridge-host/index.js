import fs from 'node:fs'
import path from 'node:path'
import { createGrantStore, loadAllowlistFile } from './grants.js'
import { loadRequestFile } from './requests.js'
import { decideListen } from './policy.js'
import { createHostServer } from './server.js'

export const name = 'dsh-control-bridge-host'
export const inject = ['sessionController', 'workspaceRegistry', 'sessionQuery', 'agents', 'llm']

function readJson(path) {
  if (!path) return null
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

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
  const loaded = loadAllowlistFile(config.allowlistFile)
  // Fail closed: a file that exists but cannot be read or parsed is not an
  // empty allowlist. Starting with empty grants would let the next write
  // overwrite the file and lose the authorizations it still holds.
  if (loaded.status === 'unreadable' || loaded.status === 'invalid_entries') {
    return {
      listening: false,
      reason: 'allowlist_unreadable',
      allowlist_status: loaded.status,
      detail: loaded.detail,
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
  // One authority for memory and disk; pairing, access changes, and revocation
  // all go through it, and a failed save never changes the in-memory grants.
  const requestsFile = config.requestsFile || (config.allowlistFile ? path.join(path.dirname(config.allowlistFile), 'requests.json') : '')
  const requestsLoaded = loadRequestFile(requestsFile)
  if (requestsLoaded.status === 'invalid') {
    return {
      listening: false,
      reason: 'requests_unreadable',
      outbound: false,
      detail: requestsLoaded.detail,
    }
  }
  const grants = createGrantStore({ file: config.allowlistFile, initial })
  const snapshot = grants.snapshot()
  const count = snapshot.workspaceAllowlist.length + snapshot.sessionAllowlist.length
  const hostSecret = readSecret(config.secretFile) || process.env[config.secretEnv || ''] || ''
  const bootstrapFile = readJson(config.bootstrapFile) || {}
  const decision = decideListen({
    services,
    hostSecret,
    allowlistCount: count,
    bind: config.bind,
    bootstrap: {
      secret: readSecret(config.bootstrapSecretFile) || bootstrapFile.secret || '',
      expiresAt: bootstrapFile.expiresAt || 0,
      consumed: Boolean(bootstrapFile.consumed),
    },
  })
  if (!decision.listening) return decision
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
    globalDefault,
    busyPolicy: config.busyPolicy || 'refuse',
    consumeBootstrap() {
      if (!config.bootstrapFile) return
      const current = readJson(config.bootstrapFile) || {}
      current.consumed = true
      current.secret = ''
      fs.writeFileSync(config.bootstrapFile, JSON.stringify(current), { mode: 0o600 })
    },
  }, {
    host: hostSecret,
    bootstrap: readSecret(config.bootstrapSecretFile) || bootstrapFile.secret || '',
    expiresAt: bootstrapFile.expiresAt || 0,
    consumed: Boolean(bootstrapFile.consumed),
  })
  server.listen(config.port || 8765, '127.0.0.1')
  return {
    listening: true,
    bind: '127.0.0.1',
    port: config.port || 8765,
    outbound: false,
    bootstrap: decision.bootstrap,
    grants: count,
    allowlist_file: Boolean(config.allowlistFile),
  }
}
