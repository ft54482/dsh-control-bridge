/**
 * Fixtures shaped like the official Desktop 0.2.2 controller.
 *
 * Deliberately does NOT accept the shapes the 0.1.3 tests used (`id`,
 * a bare event array, or a `{ sessionId, final, text }` prompt result):
 * those shapes hid the real defects.
 */

import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGrantStore } from '../grants.js'

export const SECRET = '0123456789abcdef0123456789abcdef'
export const BOOTSTRAP = 'bootstrap-secret-0123456789abcdef'
export const WORKSPACE = 'ws-demo'
export const CWD = 'C:/work/demo'

export function makeStore(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-grants-'))
  const file = path.join(dir, 'allowlist.json')
  if (initial) fs.writeFileSync(file, JSON.stringify(initial, null, 2))
  return { store: createGrantStore({ file }), file, dir }
}

export function thread(seq, overrides = {}) {
  return {
    seq,
    type: 'user/message',
    time: 1_700_000_000_000 + seq,
    data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    ...overrides,
  }
}

export function officialCtx(overrides = {}) {
  const state = {
    prompts: 0,
    cancelled: 0,
    autoComplete: true,
    promptRequestIds: [],
    // Model-related state: the live Agent's selection, the adapter registry,
    // and what the fixture records as the request header of a prompted turn.
    selection: { provider: 'example-provider', model: 'example-model' },
    selectCalls: [],
    // When set, listModels() advertises these reasoning efforts for a model;
    // leaving it unset is the "deployment does not enumerate efforts" case.
    modelEfforts: {},
    liveSessions: new Set(['session-demo', 'session-busy']),
    providers: ['example-provider'],
    providerModels: { 'example-provider': ['example-model'] },
    headerOnPrompt: true,
    requestHeaderConfig: null,
    events: [
      { seq: 1, type: 'turn/start', time: 1_700_000_000_001, data: { turn: 1 } },
      { seq: 2, type: 'user/message', time: 1_700_000_000_002, data: { content: [{ type: 'text', text: 'earlier prompt' }], source: { kind: 'user' } } },
      { seq: 3, type: 'assistant/message', time: 1_700_000_000_003, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer sk-supersecretvalue' }] } } },
      { seq: 4, type: 'turn/end', time: 1_700_000_000_004, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
    seq: 4,
    sessions: [
      {
        sessionId: 'session-demo',
        updatedAt: 1_700_000_000_004,
        running: false,
        blank: false,
        agentAvailable: true,
        cwd: CWD,
        projections: {
          kind: 'cached',
          asOfSeq: 4,
          values: {
            title: 'Demo chat',
            modelSelection: {
              lastUsed: { provider: 'example-provider', model: 'example-model' },
              next: { provider: 'example-provider', model: 'example-model' },
            },
          },
        },
      },
      {
        sessionId: 'session-busy',
        updatedAt: 1_700_000_000_005,
        running: true,
        blank: false,
        agentAvailable: true,
        cwd: CWD,
        projections: { kind: 'sequenced', asOfSeq: 5, values: { title: 'Busy chat' } },
      },
      {
        sessionId: 'session-plain',
        updatedAt: 1_700_000_000_006,
        running: false,
        blank: false,
        agentAvailable: false,
        cwd: CWD,
      },
      {
        sessionId: 'session-child',
        updatedAt: 1_700_000_000_007,
        running: false,
        blank: false,
        agentAvailable: false,
        cwd: CWD,
        origin: 'subagent',
        parentSessionId: 'session-demo',
        projections: { kind: 'cached', asOfSeq: 7, values: { title: 'Child chat' } },
      },
      {
        sessionId: 'session-removed',
        updatedAt: 1_700_000_000_008,
        running: false,
        blank: false,
        agentAvailable: false,
        cwd: 'C:/elsewhere',
      },
    ],
    ...overrides,
  }

  const workspaces = [{
    id: WORKSPACE,
    title: 'demo',
    path: CWD,
    sessionIds: ['session-demo', 'session-busy', 'session-plain', 'session-child'],
  }]

  const ctx = {
    state,
    get(name) { return this[name] },
    agentPresets: {
      async resolve(id) {
        if (['standard', 'master-control'].includes(id)) return { id }
        throw Object.assign(new Error('unknown preset'), { code: 'agent-preset/not-found' })
      },
    },
    workspaceRegistry: {
      list() { return workspaces },
      get(id) { return workspaces.find((item) => item.id === id) },
      async resolveByPath(target) {
        const real = fs.existsSync(target) ? fs.realpathSync.native(target) : null
        return workspaces.find((item) => item.path === real || item.path === target)
      },
      async create(target, title) {
        if (typeof target !== 'string' || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          const error = new Error('workspace path must be an existing directory')
          error.code = 'workspace/invalid-path'
          throw error
        }
        const real = fs.realpathSync.native(target)
        const known = workspaces.find((item) => item.path === real)
        if (known) return known
        const workspace = {
          id: `ws-created-${workspaces.length}`,
          title: title || real.split(/[\\/]/).pop(),
          path: real,
          sessionIds: [],
        }
        workspaces.push(workspace)
        state.createdWorkspaces = (state.createdWorkspaces || 0) + 1
        return workspace
      },
    },
    sessionController: {
      async projections({ sessionId }, signal) {
        signal.throwIfAborted()
        const row = state.sessions.find((item) => item.sessionId === sessionId)
        if (!row) return null
        return { kind: 'sequenced', asOfSeq: state.seq, values: row.projections?.values || {} }
      },
      async list(request, signal) {
        if (!signal) throw new TypeError('sessionController.list requires a signal')
        return { items: state.sessions }
      },
      async create(request) {
        if (!request || typeof request !== 'object') throw new TypeError('create needs a request')
        if (request.workspaceId && request.cwd) {
          const error = new Error('workspaceId and cwd are mutually exclusive')
          error.code = 'gateway/bad-request'
          throw error
        }
        const workspace = request.workspaceId
          ? workspaces.find((item) => item.id === request.workspaceId)
          : null
        if (request.workspaceId && !workspace) {
          const error = new Error('unknown workspace')
          error.code = 'workspace/not-found'
          throw error
        }
        const sessionId = request.sessionId || `session-new-${state.sessions.length}`
        const cwd = workspace ? workspace.path : request.cwd
        state.sessions.push({
          sessionId,
          updatedAt: Date.now(),
          running: false,
          blank: false,
          agentAvailable: true,
          cwd,
          projections: { kind: 'cached', asOfSeq: 0, values: { title: 'New chat', agentPreset: request.agentPreset ?? null } },
        })
        if (workspace) workspace.sessionIds.push(sessionId)
        state.liveSessions.add(sessionId)
        state.createCalls = state.createCalls || []
        state.createCalls.push({ ...request, sessionId })
        return { sessionId, agentPreset: request.agentPreset }
      },
      canOpenWorkspacePath() { return state.canOpen !== false },      async openWorkspacePath(request, signal) {
        if (!signal) throw new TypeError('openWorkspacePath requires a signal')
        state.openCalls = state.openCalls || []
        state.openCalls.push({ ...request })
        return { opened: true }
      },
      async state(request, signal) {
        if (!signal) throw new TypeError('state requires a signal')
        return {
          cursor: state.seq,
          active: true,
          running: Boolean(state.running),
          queue: null,
          pendingInput: Array.isArray(state.pendingInput) ? [...state.pendingInput] : [],
        }
      },
      async prompt(body, signal) {
        if (!body || typeof body.sessionId !== 'string') throw new TypeError('prompt needs a sessionId')
        if (body.mode !== 'queue') throw new TypeError('prompt mode must be queue')
        state.prompts += 1
        state.promptRequestIds.push(body.requestId)
        if (signal && signal.aborted) {
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        }
        if (state.holdTurn) {
          const start = ++state.seq
          state.events.push({ seq: start, type: 'turn/start', time: Date.now(), data: { turn: 7 } })
          state.events.push({
            seq: ++state.seq,
            type: 'user/message',
            time: Date.now(),
            data: { content: body.content || [], source: { kind: 'user', rpcId: body.requestId } },
          })
          const row = state.sessions.find((item) => item.sessionId === body.sessionId)
          if (row) row.running = true
          return { accepted: true }
        }
        if (state.autoComplete) {
          const text = (body.content || []).map((part) => part.text).join(' ')
          const start = ++state.seq
          state.events.push({ seq: start, type: 'turn/start', time: Date.now(), data: { turn: 99 } })
          state.events.push({
            seq: ++state.seq,
            type: 'user/message',
            time: Date.now(),
            data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: body.requestId } },
          })
          state.events.push({
            seq: ++state.seq,
            type: 'request/header',
            time: Date.now(),
            data: { header: { config: { ...(state.requestHeaderConfig || state.selection) } } },
          })
          state.events.push({
            seq: ++state.seq,
            type: 'assistant/message',
            time: Date.now(),
            data: { message: { role: 'assistant', content: [{ type: 'text', text: `answer to ${text} sk-livevalue012345` }] } },
          })
          state.events.push({ seq: ++state.seq, type: 'turn/end', time: Date.now(), data: { turn: 99, reason: state.endReason || { kind: 'completed' } } })
        }
        // The official value carries no text, no session id, and no final.
        return { accepted: true }
      },
      cancel(request) {
        if (!request || typeof request.sessionId !== 'string') {
          state.cancelRejected = (state.cancelRejected || 0) + 1
          return { accepted: false }
        }
        state.cancelCalls = state.cancelCalls || []
        state.cancelCalls.push({ sessionId: request.sessionId })
        state.cancelled += 1
        const open = [...state.events].reverse().find((event) => event.type === 'turn/start')
        const closed = open && state.events.some((event) => event.type === 'turn/end' && event.seq > open.seq)
        if (open && !closed) {
          state.events.push({
            seq: ++state.seq,
            type: 'turn/end',
            time: Date.now(),
            data: { turn: open.data && open.data.turn, reason: { kind: 'aborted' } },
          })
        }
        const row = state.sessions.find((item) => item.sessionId === request.sessionId)
        if (row) row.running = false
        return { accepted: true }
      },
    },
    // Official 'agents' service: only some Sessions have a live Agent.
    agents: {
      get(sessionId) {
        if (!state.liveSessions.has(sessionId)) return undefined
        return {
          status: state.liveStatus || 'idle',
          session: { id: sessionId },
          model: {
            current() { return { ...state.selection } },
            select(selection) {
              state.selectCalls.push({ ...selection })
              state.selection = { ...selection }
              // Official select() persists the choice as a model/selection event
              // and makes it the Session's next selection. The sessionId tag is a
              // fixture detail so one shared log does not leak across sessions.
              state.events.push({ seq: ++state.seq, type: 'model/selection', time: Date.now(), data: { ...selection, sessionId } })
              const row = state.sessions.find((item) => item.sessionId === sessionId)
              if (row && row.projections && row.projections.values && row.projections.values.modelSelection) {
                row.projections.values.modelSelection.next = { ...selection }
              }
            },
          },
        }
      },
    },
    // Official 'llm' service: provider routes with an adapter, their models,
    // and the adapter-side call-config validation that throws NO_ADAPTER.
    llm: {
      listProviders() {
        return state.providers.map((id) => ({ id, displayName: id }))
      },
      async listModels(provider) {
        return (state.providerModels[provider] || []).map((id) => {
          const efforts = state.modelEfforts && state.modelEfforts[id]
          return efforts ? { id, name: id, reasoningEfforts: efforts } : { id, name: id }
        })
      },
      async resolveModelInfo(provider, model) {
        state.resolveModelInfoCalls = (state.resolveModelInfoCalls || 0) + 1
        const efforts = state.modelEfforts && state.modelEfforts[model]
        return {
          provider,
          id: model,
          name: model,
          ...(efforts ? { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } } : {}),
        }
      },
      async resolveCallConfig(config) {
        if (!state.providers.includes(config.provider)) {
          const error = new Error(`no adapter registered for provider "${config.provider}"`)
          error.code = 'NO_ADAPTER'
          throw error
        }
        return config
      },
    },
    sessionQuery: {
      async readSession(sessionId) {
        return {
          session: { id: sessionId, cwd: CWD, createdAt: 1_700_000_000_000 },
          inheritedEventCount: 0,
          events: state.events
            .filter((event) => event.type !== 'model/selection' || !event.data.sessionId || event.data.sessionId === sessionId)
            .map((event) => ({ ...event })),
        }
      },
      async observeSession(sessionId) {
        // Mirrors the official observation lease: a header, a materialized
        // events array, and disposal; no persistence listing or replay check.
        return {
          source: 'live',
          header: { id: sessionId, cwd: CWD, createdAt: 1_700_000_000_000 },
          inheritedEventCount: 0,
          get events() {
            return state.events
              .filter((event) => event.type !== 'model/selection' || !event.data.sessionId || event.data.sessionId === sessionId)
              .map((event) => ({ ...event }))
          },
          cursor: state.seq,
          retain() { return this },
          [Symbol.dispose]() {},
          dispose() {},
        }
      },
    },
  }
  return ctx
}

export async function startServer(ctx, options = {}) {
  const { createHostServer } = await import('../server.js')
  const { store, file, dir } = options.store
    ? { store: options.store, file: options.file || '', dir: options.dir || '' }
    : makeStore(options.initial)
  const requestsFile = options.requestsFile || (dir ? path.join(dir, 'requests.json') : '')
  const server = createHostServer(ctx, {
    grants: store,
    busyPolicy: 'refuse',
    globalDefault: options.globalDefault
      || (() => ({ provider: 'example-provider', model: 'example-model' })),
    resumeTimeoutMs: options.resumeTimeoutMs,
    pollIntervalMs: options.pollIntervalMs || 10,
    requestsFile,
    ledger: options.ledger,
    workspaceRoots: options.workspaceRoots || [],
    presetSessionWorkspaceIds: options.presetSessionWorkspaceIds || [],
    allowCreateSession: options.allowCreateSession === true,
    allowCreateWorkspace: options.allowCreateWorkspace === true,
    allowOpenPath: options.allowOpenPath === true,
    // Workspace autonomy is opt-in: an explicit `workspaceAutonomy` value is the
    // only thing that can turn it on, and `allowlistFile: ''` can model the
    // "configured but not effective" deployment.
    allowlistFile: options.allowlistFile === undefined ? (file || undefined) : options.allowlistFile,
    workspaceAutonomy: options.workspaceAutonomy,
    autonomyRecordFile: options.autonomyRecordFile,
    outbox: options.outbox,
    outboxFile: options.outboxFile || '',
    webhook: options.webhook,
  }, options.secret || SECRET)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: server.address().port, store, file, dir, requestsFile }
}

export async function call(port, method, pathname, body, secret = SECRET) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, body: await response.json() }
}

export function close(server) {
  return new Promise((resolve) => {
    const done = () => resolve()
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    server.close(done)
    setTimeout(done, 1_000).unref()
  })
}

export function readGrantFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
