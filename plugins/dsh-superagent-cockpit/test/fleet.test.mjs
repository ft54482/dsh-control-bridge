import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { createFleetServer, readConfig } from '../fleet.mjs'

async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return server.address().port
}

test('configuration accepts a named loopback port and rejects ambiguous or remote targets', () => {
  assert.equal(readConfig({}).instances[0].port, 3082)
  const config = instances => readConfig({ DSH_COCKPIT_INSTANCES: JSON.stringify(instances) })
  const entry = { port: 4100, label: 'One' }
  assert.deepEqual(config([entry]).instances[0], { ...entry, id: '4100' })
  for (const invalid of [[], [entry, entry], [{ ...entry, base: 'https://example.invalid' }],
    [{ ...entry, port: 0 }], [{ ...entry, port: 3090 }], [{ ...entry, label: ' ' }]]) {
    assert.throws(() => config(invalid))
  }
  assert.throws(() => readConfig({ FLEET_PORT: 'invalid' }))
})

test('fleet preserves executor data, isolates an unavailable instance and coalesces browser refreshes', async t => {
  const visited = []
  const enginePort = await listen(t, http.createServer((req, res) => {
    visited.push([req.method, req.url, req.headers['x-orchestrator-request']])
    const body = req.url.endsWith('/overview') ? { executor: { running: 1, maxWorkers: 4 } } : { items: [] }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }))
  const downPort = await listen(t, http.createServer((_req, res) => res.writeHead(503).end()))
  const instances = readConfig({ DSH_COCKPIT_INSTANCES: JSON.stringify([
    { port: enginePort, label: 'First' }, { port: downPort, label: 'Second' },
  ]) }).instances
  const port = await listen(t, createFleetServer(instances))
  const url = 'http://127.0.0.1:' + port + '/fleet'
  const [first, second] = await Promise.all([fetch(url), fetch(url, { headers: { origin: new URL(url).origin } })])
  const snapshot = await first.json()
  assert.deepEqual(snapshot, await second.json())
  assert.equal(snapshot.instances[0].ok, true)
  assert.deepEqual(snapshot.instances[0].overview.executor, { running: 1, maxWorkers: 4 })
  assert.equal(snapshot.instances[1].ok, false)
  assert.match(snapshot.instances[1].error, /503/)
  assert.equal(visited.length, 6)
  assert.ok(visited.every(([method, path, marker]) => method === 'GET' && path.startsWith('/orchestrator/api/') && marker === '1'))
})

test('server restricts browser origins, request methods and paths', async t => {
  const port = await listen(t, createFleetServer([]))
  const url = 'http://127.0.0.1:' + port
  for (const headers of [{ origin: 'https://example.invalid' }, { origin: 'null' },
    { host: 'example.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    const rsp = await new Promise((resolve, reject) => {
      http.get(url + '/fleet', { headers }, resolve).on('error', reject)
    })
    rsp.resume()
    assert.equal(rsp.statusCode, 403, JSON.stringify(headers))
    assert.equal(rsp.headers['access-control-allow-origin'], undefined)
  }
  assert.equal((await fetch(url + '/healthz', { method: 'HEAD' })).status, 200)
  assert.equal((await fetch(url + '/fleet', { method: 'POST' })).status, 405)
  assert.equal((await fetch(url + '/unknown')).status, 404)
})

test('engine redirects are not followed', async t => {
  let calls = 0
  const other = await listen(t, http.createServer((_req, res) => { calls++; res.end('{}') }))
  const engine = await listen(t, http.createServer((_req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:' + other + '/' }).end()
  }))
  const instances = readConfig({ DSH_COCKPIT_INSTANCES: JSON.stringify([{ port: engine, label: 'Redirect' }]) }).instances
  const fleet = await listen(t, createFleetServer(instances))
  const result = await (await fetch('http://127.0.0.1:' + fleet + '/fleet')).json()
  assert.equal(result.instances[0].ok, false)
  assert.equal(calls, 0)
})
