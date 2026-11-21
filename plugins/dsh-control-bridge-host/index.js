import { createHostServer } from './server.js'

export const name = 'dsh-control-bridge-host'
export const inject = ['sessionController', 'workspaceRegistry', 'sessionQuery']

export function apply(ctx, config = {}) {
  const controller = ctx.sessionController
  const registry = ctx.workspaceRegistry
  const query = ctx.sessionQuery
  if (!controller || !registry || !query) {
    return { listening: false, reason: 'desktop session services are not mounted; headless and incomplete profiles stay silent' }
  }
  const secret = process.env[config.secretEnv || 'DSH_BRIDGE_HOST_SECRET'] || ''
  if (!secret || secret.length < 32) {
    return { listening: false, reason: 'host secret is missing; the plugin did not open a port' }
  }
  if (!Array.isArray(config.workspaceAllowlist) || config.workspaceAllowlist.length === 0) {
    return { listening: false, reason: 'workspace allowlist is empty; the plugin did not open a port' }
  }
  if (config.bind && config.bind !== '127.0.0.1') {
    return { listening: false, reason: 'bind must be 127.0.0.1' }
  }
  const server = createHostServer(ctx, { ...config, busyPolicy: config.busyPolicy || 'refuse' }, secret)
  server.listen(config.port || 8765, '127.0.0.1')
  return { listening: true, bind: '127.0.0.1', port: config.port || 8765, outbound: false }
}
