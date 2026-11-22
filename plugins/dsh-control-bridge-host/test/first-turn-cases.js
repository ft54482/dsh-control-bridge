import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { call, close, officialCtx, startServer, WORKSPACE } from './fixtures.js'

const id = 'session-demo'
const route = { provider: 'example-provider', model: 'example-model' }

async function fresh(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'host-first-turn-'))
  const ctx = officialCtx({ events: [], seq: 0, liveSessions: new Set() })
  const row = ctx.state.sessions.find((item) => item.sessionId === id)
  Object.assign(row, { cwd, blank: true, agentAvailable: false, projections: { values: { agentPreset: 'master-control' } } })
  const workspace = ctx.workspaceRegistry.get(WORKSPACE)
  workspace.path = cwd
  const grant = { sessionId: id, workspaceId: WORKSPACE, access: 'write', cwd, profile: 'desktop', agentPreset: 'master-control' }
  Object.assign(grant, options.grant)
  const started = await startServer(ctx, {
    initial: { version: 1, workspaceAllowlist: [{ id: WORKSPACE, cwd }], sessionAllowlist: [grant] },
    globalDefault: () => ({ provider: 'other-provider', model: 'other-model' }),
  })
  t.after(async () => {
    await close(started.server)
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(started.dir, { recursive: true, force: true })
  })
  const resolves = []
  ctx.sessionController.resolveAgent = async (sessionId) => {
    resolves.push(sessionId)
    ctx.state.liveSessions.add(sessionId)
    return { agent: ctx.agents.get(sessionId) }
  }
  const resume = (extra = {}) => call(started.port, 'POST', '/v1/resume', {
    session_id: id, workspace_id: WORKSPACE, request_id: 'first-turn', text: 'fixture task', ...extra,
  })
  return { ctx, resume, resolves, row, workspace, started }
}

test('cold master-control first prompt uses the resolved session route and replays exactly once', async (t) => {
  const { ctx, resume, resolves } = await fresh(t)
  const first = await resume()
  assert.equal(first.body.completed, true, JSON.stringify(first.body))
  assert.equal(first.body.phase, 'terminal')
  assert.equal(first.body.terminal_scope, 'official')
  assert.equal(first.body.model_selection, 'session_live_effective')
  assert.deepEqual(first.body.execution_model, route)
  assert.deepEqual(ctx.state.selectCalls, [])
  assert.equal((await resume()).body.completed, true)
  assert.deepEqual(resolves, [id])
  assert.equal(ctx.state.prompts, 1)
})

test('explicit first-turn model is selected on the exact session and verified against the execution header', async (t) => {
  const { ctx, resume } = await fresh(t)
  ctx.state.providerModels[route.provider].push('alternate')
  const model = { ...route, model: 'alternate' }
  const result = await resume({ model })
  assert.equal(result.body.completed, true, JSON.stringify(result.body))
  assert.deepEqual(result.body.execution_model, model)
  assert.deepEqual(ctx.state.selectCalls, [model])
})

for (const [name, mutate, expected] of [
  ['read grant', async ({ started }) => started.store.setAccess(id, 'read'), 'read_only'],
  ['busy listing', ({ row }) => { row.running = true }, 'busy'],
  ['missing listing', ({ ctx }) => { ctx.state.sessions = [] }, 'session_state_unverified'],
  ['preset changed on live session with a recorded route', ({ ctx, row }) => {
    ctx.state.liveSessions.add(id)
    row.projections.values = { agentPreset: 'standard', modelSelection: { next: route, lastUsed: route } }
  }, 'agent_preset_unverified'],
  ['unmounted resolver', ({ ctx }) => { delete ctx.sessionController.resolveAgent }, 'agent_resolution_unavailable'],
  ['controller error', ({ ctx }) => { ctx.sessionController.resolveAgent = async () => ({ error: { code: 'failed' } }) }, 'agent_resolution_failed'],
  ['foreign agent', ({ ctx }) => { ctx.sessionController.resolveAgent = async () => ({ agent: { session: { id: 'different' } } }) }, 'agent_identity_unverified'],
  ['running resolved agent', ({ ctx }) => { ctx.state.liveStatus = 'running' }, 'busy'],
  ['grant revoked during resolve', ({ ctx, started }) => {
    const resolve = ctx.sessionController.resolveAgent
    ctx.sessionController.resolveAgent = async (sessionId) => { await started.store.revoke(id); return resolve(sessionId) }
  }, 'session_not_allowlisted'],
  ['malformed grants before send', ({ ctx, started }) => {
    const available = ctx.llm.resolveCallConfig
    ctx.llm.resolveCallConfig = async (config) => { fs.writeFileSync(started.file, '{'); return available(config) }
  }, 'allowlist_unavailable'],
  ['workspace detached during projection', ({ ctx, workspace }) => {
    const project = ctx.sessionController.projections
    ctx.sessionController.projections = (...args) => { workspace.sessionIds = []; return project(...args) }
  }, 'workspace_mismatch'],
]) {
  test(`no first-turn prompt on ${name}`, async (t) => {
    const env = await fresh(t)
    await mutate(env)
    const result = await env.resume({ model: route })
    assert.equal(result.body.reason, expected, JSON.stringify(result.body))
    assert.equal(result.body.started_task, false)
    assert.equal(env.ctx.state.prompts, 0)
    assert.deepEqual(env.ctx.state.selectCalls, [])
  })
}

test('a blank session with no effective route cannot borrow the deployment default', async (t) => {
  const { ctx, resume } = await fresh(t)
  ctx.state.selection = null
  const result = await resume()
  assert.equal(result.body.reason, 'model_unknown')
  assert.equal(ctx.state.prompts, 0)
})

test('a route change during final admission prevents dispatch', async (t) => {
  const { ctx, resume } = await fresh(t)
  const check = ctx.llm.resolveCallConfig
  let checks = 0
  ctx.llm.resolveCallConfig = async (config) => {
    if (++checks === 2) ctx.state.selection = { ...route, model: 'drift' }
    return check(config)
  }
  const result = await resume()
  assert.equal(result.body.reason, 'model_changed_before_send')
  assert.equal(ctx.state.prompts, 0)
})

test('competing first-turn requests cannot both reach the controller', async (t) => {
  const { ctx, resume } = await fresh(t)
  const resolve = ctx.sessionController.resolveAgent
  let entered, release
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  ctx.sessionController.resolveAgent = async (sessionId) => { entered(); await gate; return resolve(sessionId) }
  const first = resume()
  await started
  try {
    assert.equal((await resume({ request_id: 'competing' })).body.reason, 'bridge_request_in_flight')
  } finally { release() }
  assert.equal((await first).body.completed, true)
  assert.equal(ctx.state.prompts, 1)
})
