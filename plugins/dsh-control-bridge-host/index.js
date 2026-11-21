import fs from 'node:fs'
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
  const allowlist = readJson(config.allowlistFile) || {}
  const count = Array.isArray(allowlist.sessionAllowlist) ? allowlist.sessionAllowlist.length : (config.sessionAllowlist || []).length
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
  const server = createHostServer(ctx, {
    ...config,
    ...allowlist,
    busyPolicy: config.busyPolicy || 'refuse',
    saveAllowlist(next) {
      if (!config.allowlistFile) return
      fs.writeFileSync(config.allowlistFile, JSON.stringify(next, null, 2), { mode: 0o600 })
    },
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
  return { listening: true, bind: '127.0.0.1', port: config.port || 8765, outbound: false, bootstrap: decision.bootstrap }
}
