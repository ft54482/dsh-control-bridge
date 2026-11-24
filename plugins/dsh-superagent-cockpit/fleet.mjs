import http from 'node:http'
import { pathToFileURL } from 'node:url'

const routes = {
  state: '/state',
  overview: '/overview',
  tickets: '/tickets?state=open',
  ended: '/tickets?state=ended',
  sources: '/sources',
  decisions: '/decisions?window=24h',
}

function isPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export function readConfig(env = process.env) {
  const port = Number(env.FLEET_PORT ?? 3090)
  if (!isPort(port)) throw new Error('FLEET_PORT must be a port from 1 to 65535')
  const targets = JSON.parse(env.DSH_COCKPIT_INSTANCES ?? '[{"port":3082,"label":"SuperAgent"}]')
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('DSH_COCKPIT_INSTANCES must be a nonempty array of {port, label}')
  }
  const ports = new Set()
  const instances = targets.map(target => {
    if (!target || !isPort(target.port) || typeof target.label !== 'string' || !target.label.trim()
        || Object.keys(target).some(key => key !== 'port' && key !== 'label')) {
      throw new Error('Each instance needs only a numeric port and a nonempty label; its host is 127.0.0.1')
    }
    if (ports.has(target.port) || target.port === port) throw new Error('Instance ports and FLEET_PORT must be distinct')
    ports.add(target.port)
    return { port: target.port, id: String(target.port), label: target.label.trim() }
  })
  return { port, instances }
}

async function snapshot(instance) {
  const base = 'http://127.0.0.1:' + instance.port + '/orchestrator/api'
  const signal = AbortSignal.timeout(6000)
  try {
    const results = await Promise.all(Object.entries(routes).map(async ([key, path]) => {
      const response = await fetch(base + path, {
        headers: { accept: 'application/json', 'x-orchestrator-request': '1' },
        signal,
        redirect: 'error',
      })
      if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status)
      return [key, await response.json()]
    }))
    return { ...instance, ok: true, error: null, ...Object.fromEntries(results) }
  } catch (error) {
    return { ...instance, ok: false, error: error.message }
  }
}

export function createFleetServer(instances) {
  let cached
  let expires = 0
  let pending

  function fleet() {
    if (Date.now() < expires) return cached
    if (!pending) {
      pending = Promise.all(instances.map(snapshot)).then(items => {
        cached = { at: new Date().toISOString(), instances: items }
        expires = Date.now() + 2000
        return cached
      }).finally(() => { pending = undefined })
    }
    return pending
  }

  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    const authority = req.headers.host
    const port = req.socket.localPort
    const suffix = port === 80 ? '' : ':' + port
    if ((authority !== '127.0.0.1' + suffix && authority !== 'localhost' + suffix)
        || (req.headers.origin !== undefined && req.headers.origin !== 'http://' + authority)
        || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end()
      return
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
      return
    }
    if (req.url !== '/fleet') {
      res.writeHead(404).end()
      return
    }
    try {
      const body = await fleet()
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body))
    } catch {
      res.writeHead(502).end()
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port, instances } = readConfig()
  createFleetServer(instances).listen(port, '127.0.0.1', () => {
    console.log('Cockpit fleet listening at http://127.0.0.1:' + port + '/fleet')
  })
}
