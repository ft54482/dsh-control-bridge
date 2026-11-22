import fs from 'node:fs'
import { createGrantStore } from './grants.js'
import { decideListen } from './policy.js'
import { createHostServer } from './server.js'

export const name = 'dsh-control-bridge-host'
export const inject = ['sessionController', 'workspaceRegistry', 'sessionQuery']

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
  const initial = readJson(config.allowlistFile) || {
    version: 1,
    workspaceAllowlist: Array.isArray(config.workspaceAllowlist) ? config.workspaceAllowlist : [],
    sessionAllowlist: Array.isArray(config.sessionAllowlist) ? config.sessionAllowlist : [],
  }
  // One authority for memory and disk; pairing, access changes, and revocation
  // all go through it, and a failed save never changes the in-memory grants.
  const grants = createGrantStore({ file: config.allowlistFile, initial })
  const loaded = grants.snapshot()
  const count = loaded.workspaceAllowlist.length + loaded.sessionAllowlist.length
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
  const defaultSelection = () => {
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
    defaultSelection,
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
