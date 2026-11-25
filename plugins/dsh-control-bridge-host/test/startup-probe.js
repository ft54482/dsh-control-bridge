/**
 * First-start probe for the desktop bridge plugin.
 *
 * Runs in a child process so that "stop listening" is just process exit: the
 * test only reads the JSON this file writes. It applies the real plugin to a
 * fake Desktop context, then asks the real loopback endpoint.
 *
 * Usage: node startup-probe.js <mode> <result-file>
 *   effective      empty allowlist JSON, autonomy on        -> listens
 *   missing-file   no allowlist file at all, autonomy on    -> listens (first run)
 *   zero-byte      zero-byte allowlist, autonomy on         -> refuses
 *   off            empty allowlist, autonomy not configured -> refuses
 *   ineffective    autonomy on but no allowlist file configured -> refuses
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const [, , mode = 'effective', resultFile] = process.argv
const SECRET = 'first-start-probe-secret-0123456789abcdef0123456789abcdef'

function fakeCtx() {
  return {
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id } } }
      if (name === 'agentDefaultModel') return null
      return undefined
    },
    sessionController: {
      async create() { throw new Error('probe does not create sessions') },
      async projections() { return null },
      async list() { return { items: [] } },
      async state() { return { pendingInput: [] } },
      async prompt() { throw new Error('probe does not prompt') },
      cancel() { return { accepted: false } },
    },
    workspaceRegistry: {
      list() { return [] },
      get() { return undefined },
      async create() { throw new Error('probe does not create workspaces') },
      async resolveByPath() { return undefined },
    },
    sessionQuery: {
      async readSession() { throw new Error('probe does not read sessions') },
      async observeSession() { throw new Error('probe does not observe sessions') },
    },
    agents: { get() { return undefined } },
    llm: {
      listProviders() { return [] },
      async listModels() { return [] },
      async resolveModelInfo() { return null },
      async resolveCallConfig(config) { return config },
    },
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function connectable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = (value) => { socket.destroy(); resolve(value) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1_500, () => finish(false))
  })
}

async function health(port, secret) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(2_000),
      })
      return { status: response.status, body: await response.json() }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  return { status: 0, body: null }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-autonomy-first-start-'))
const secretFile = path.join(workDir, 'host.secret')
fs.writeFileSync(secretFile, SECRET, 'utf8')
const allowlistFile = path.join(workDir, 'allowlist.json')
if (mode === 'effective' || mode === 'off') {
  fs.writeFileSync(allowlistFile, JSON.stringify({ version: 1, workspaceAllowlist: [], sessionAllowlist: [] }), 'utf8')
} else if (mode === 'zero-byte') {
  fs.writeFileSync(allowlistFile, '', 'utf8')
}

const config = {
  port: await freePort(),
  secretFile,
  allowlistFile: mode === 'ineffective' ? undefined : allowlistFile,
  workspaceRoots: [],
  allowCreateWorkspace: true,
  allowCreateSession: true,
  allowOpenPath: false,
}
if (mode !== 'off') config.workspaceAutonomy = true

let decision
let failure = ''
try {
  decision = apply(fakeCtx(), config)
} catch (error) {
  failure = String((error && error.stack) || error)
  decision = { listening: false, reason: 'apply_threw' }
}

const result = {
  mode,
  workDir,
  port: config.port,
  decision,
  connectable: await connectable(config.port),
  health: decision.listening ? await health(config.port, SECRET) : null,
  allowlistExists: fs.existsSync(path.join(workDir, 'allowlist.json')),
  allowlistText: fs.existsSync(path.join(workDir, 'allowlist.json'))
    ? fs.readFileSync(path.join(workDir, 'allowlist.json'), 'utf8') : null,
  failure,
}
if (resultFile) fs.writeFileSync(resultFile, JSON.stringify(result), 'utf8')
process.exit(0)
