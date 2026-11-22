/**
 * Regression for the write-capable directory/session endpoints (0.2.0 D):
 * official create/open APIs, the double opt-in (capability flag + roots), and
 * path safety. Isolated fixture + real temp directories; not a live Desktop.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SECRET, WORKSPACE, call, close, officialCtx, startServer } from './fixtures.js'

const WRITE_DEMO = {
  version: 1,
  workspaceAllowlist: [{ id: WORKSPACE, cwd: 'C:/work/demo', title: 'demo' }],
  sessionAllowlist: [{ sessionId: 'session-demo', workspaceId: WORKSPACE, access: 'write', cwd: 'C:/work/demo', profile: 'desktop' }],
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-create-'))
  return { root, real: fs.realpathSync.native(root) }
}

function writable(extra = {}) {
  return { initial: WRITE_DEMO, ...extra }
}

test('workspace and session creation require both the capability flag and an allowed root', async () => {
  const { root } = tempRoot()
  const closedCtx = officialCtx()
  const closed = await startServer(closedCtx, writable())
  const denied = await call(closed.port, 'POST', '/v1/workspaces', { path: root })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.reason, 'create_workspace_disabled')
  await close(closed.server)

  const ctx = officialCtx()
  const noRoots = await startServer(ctx, writable({
    allowCreateWorkspace: true,
    allowCreateSession: true,
    allowOpenPath: true,
  }))
  const noRoot = await call(noRoots.port, 'POST', '/v1/sessions', {
    path: root, create_workspace: true, access: 'read',
  })
  assert.equal(noRoot.status, 403)
  assert.equal(noRoot.body.reason, 'no_allowed_roots')
  await close(noRoots.server)
})

test('a workspace is registered by official path, idempotently, and only under a root', async () => {
  const { root, real } = tempRoot()
  const project = fs.mkdtempSync(path.join(root, 'project-'))
  const ctx = officialCtx()
  const started = await startServer(ctx, writable({
    workspaceRoots: [real],
    allowCreateWorkspace: true,
    allowCreateSession: true,
    allowOpenPath: true,
  }))

  const first = await call(started.port, 'POST', '/v1/workspaces', { path: project, title: 'Project' })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.created, true)
  assert.ok(first.body.workspace_id)
  assert.equal(first.body.workspace.path, fs.realpathSync.native(project))

  const again = await call(started.port, 'POST', '/v1/workspaces', { path: project })
  assert.equal(again.status, 200)
  assert.equal(again.body.created, false)
  assert.equal(again.body.workspace_id, first.body.workspace_id)

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outside-'))
  const refused = await call(started.port, 'POST', '/v1/workspaces', { path: outside })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.reason, 'outside_allowed_roots')

  const missing = path.join(real, 'not-there')
  const noCreate = await call(started.port, 'POST', '/v1/workspaces', { path: missing })
  assert.equal(noCreate.status, 400)
  assert.equal(noCreate.body.reason, 'missing_directory')

  const made = await call(started.port, 'POST', '/v1/workspaces', { path: missing, create_directory: true })
  assert.equal(made.status, 200)
  assert.equal(made.body.created_directory, true)
  assert.equal(fs.statSync(missing).isDirectory(), true)
  await close(started.server)
})

test('a session is created through the official API, granted, and never uses the deployment default', async () => {
  const { root, real } = tempRoot()
  const project = fs.mkdtempSync(path.join(root, 'project-'))
  const ctx = officialCtx()
  ctx.state.modelEfforts = { 'example-model': ['low', 'high'] }
  const started = await startServer(ctx, writable({
    workspaceRoots: [real],
    allowCreateWorkspace: true,
    allowCreateSession: true,
    allowOpenPath: true,
  }))

  const created = await call(started.port, 'POST', '/v1/sessions', {
    path: project,
    create_workspace: true,
    title: 'New project',
    access: 'write',
    model: { provider: 'example-provider', model: 'example-model', reasoning_effort: 'high' },
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.ok, true)
  assert.ok(created.body.session_id)
  assert.equal(created.body.access, 'write')
  assert.equal(created.body.model.source, 'session_selected_by_bridge')
  assert.equal(created.body.model.selection.reasoningEffort, 'high')
  assert.equal(ctx.state.createCalls.length, 1)
  assert.equal(ctx.state.createCalls[0].workspaceId, created.body.workspace_id)

  const granted = await call(started.port, 'GET', '/v1/granted')
  const row = granted.body.sessions.find((item) => item.session_id === created.body.session_id)
  assert.ok(row)
  assert.equal(row.access, 'write')
  assert.equal(row.workspace_id, created.body.workspace_id)

  const models = await call(started.port, 'GET', `/v1/models?session_id=${created.body.session_id}`)
  assert.equal(models.status, 200)
  assert.equal(models.body.session.pending.reasoningEffort, 'high')

  // The created session is dispatchable through the same authorized resume path.
  const resumed = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: created.body.workspace_id,
    session_id: created.body.session_id,
    profile: 'desktop',
    request_id: 'req-created',
    text: 'hello from the bridge',
  })
  assert.equal(resumed.status, 200)
  assert.equal(resumed.body.completed, true)
  assert.equal(resumed.body.session_id, created.body.session_id)
  assert.equal(resumed.body.confirmed_selection.reasoningEffort, 'high')

  const unsupported = await call(started.port, 'POST', '/v1/sessions', {
    workspace_id: created.body.workspace_id, access: 'read',
    model: { provider: 'example-provider', model: 'example-model', reasoning_effort: 'medium' },
  })
  assert.equal(unsupported.status, 409)
  assert.equal(unsupported.body.reason, 'unsupported_reasoning_effort')
  // A rejected model must not leave a created Session or a persisted grant.
  assert.equal(ctx.state.createCalls.length, 1)
  const stored = JSON.parse(fs.readFileSync(started.file, 'utf8'))
  // The seed grant (session-demo) plus the one created session; the rejected
  // attempt added neither.
  assert.equal(stored.sessionAllowlist.length, 2)
  await close(started.server)
})

test('a new task gets a fresh verified preset Session in the existing workspace', async (t) => {
  const { real } = tempRoot()
  const ctx = officialCtx()
  const ws = await ctx.workspaceRegistry.create(fs.mkdtempSync(path.join(real, 'project-')))
  const started = await startServer(ctx, writable({ workspaceRoots: [real], allowCreateSession: true }))
  t.after(() => close(started.server))
  const health = await call(started.port, 'GET', '/v1/health')
  assert.equal(health.body.preset_create_verified, true)
  const body = { workspace_id: ws.id, access: 'write', agent_preset: 'master-control' }
  const first = await call(started.port, 'POST', '/v1/sessions', body)
  const next = await call(started.port, 'POST', '/v1/sessions', body)
  assert.notEqual(first.body.session_id, next.body.session_id)
  for (const receipt of [first, next]) {
    assert.equal(receipt.status, 200)
    assert.equal(receipt.body.agent_preset, 'master-control')
    assert.equal(receipt.body.agent_preset_source, 'session_projection')
    assert.equal(receipt.body.workspace_id, ws.id)
    assert.equal(receipt.body.grant.access, 'write')
    assert.ok(ws.sessionIds.includes(receipt.body.session_id))
    assert.equal(receipt.body.started_task, false)
  }
  assert.equal(ctx.state.prompts, 0)
})

test('unavailable and broken presets fail before creating or granting anything', async (t) => {
  const { real } = tempRoot()
  const ctx = officialCtx()
  const started = await startServer(ctx, writable({
    workspaceRoots: [real], allowCreateSession: true, allowCreateWorkspace: true,
  }))
  t.after(() => close(started.server))
  const body = { path: real, create_workspace: true, agent_preset: 'missing' }
  const send = () => call(started.port, 'POST', '/v1/sessions', body)
  assert.equal((await send()).body.reason, 'agent-preset/not-found')
  ctx.agentPresets.resolve = async () => ({ id: 'missing', broken: 'diagnostic' })
  assert.equal((await send()).body.reason, 'agent-preset/invalid')
  delete ctx.agentPresets
  assert.equal((await send()).body.reason, 'preset_creation_unavailable')
  const health = await call(started.port, 'GET', '/v1/health')
  assert.equal(health.body.preset_create_verified, false)
  assert.equal(ctx.state.createdWorkspaces, undefined)
  assert.equal(ctx.state.createCalls, undefined)
  assert.equal(started.store.snapshot().sessionAllowlist.length, 1)
})

test('a mismatched create receipt or unverified projection leaves the new Session ungranted', async (t) => {
  const { real } = tempRoot()
  const ctx = officialCtx()
  const ws = await ctx.workspaceRegistry.create(fs.mkdtempSync(path.join(real, 'project-')))
  const started = await startServer(ctx, writable({ workspaceRoots: [real], allowCreateSession: true }))
  t.after(() => close(started.server))
  const create = ctx.sessionController.create.bind(ctx.sessionController)
  for (const [returned, projection] of [
    ['standard', { kind: 'sequenced', values: { agentPreset: 'master-control' } }],
    ['master-control', { kind: 'sequenced', values: { agentPreset: 'standard' } }],
    ['master-control', { kind: 'migration-required', values: { agentPreset: 'master-control' } }],
    ['master-control', null],
  ]) {
    ctx.sessionController.create = async (request) => ({ ...await create(request), agentPreset: returned })
    ctx.sessionController.projections = async () => projection
    const result = await call(started.port, 'POST', '/v1/sessions', {
      workspace_id: ws.id, access: 'write', agent_preset: 'master-control',
    })
    assert.equal(result.status, 409)
    assert.equal(result.body.reason, 'agent_preset_unverified')
    assert.equal(result.body.workspace_id, ws.id)
    assert.ok(ws.sessionIds.includes(result.body.session_id))
    assert.equal(result.body.started_task, false)
    assert.equal(result.body.saved, false)
  }
  assert.equal(started.store.snapshot().sessionAllowlist.length, 1)
  assert.equal(ctx.state.prompts, 0)
})

test('preset creation rejects caller IDs and preserves the identity of a partially created Session', async (t) => {
  const { real } = tempRoot()
  const ctx = officialCtx()
  const ws = await ctx.workspaceRegistry.create(fs.mkdtempSync(path.join(real, 'project-')))
  const started = await startServer(ctx, writable({ workspaceRoots: [real], allowCreateSession: true }))
  t.after(() => close(started.server))
  const body = { workspace_id: ws.id, agent_preset: 'master-control', access: 'write' }
  const create = () => call(started.port, 'POST', '/v1/sessions', body)
  const reused = await call(started.port, 'POST', '/v1/sessions', { ...body, session_id: 'session-demo' })
  assert.equal(reused.status, 400)
  assert.equal(reused.body.reason, 'omit_session_id_for_preset_create')
  assert.equal(ctx.state.createCalls, undefined)
  assert.equal(started.store.snapshot().sessionAllowlist.length, 1)
  ctx.sessionController.create = async () => {
    throw Object.assign(new Error('attach failed'), {
      code: 'session/workspace-attach-failed', details: { sessionId: 'minted', workspaceId: ws.id },
    })
  }
  const partial = await create()
  assert.equal(partial.body.reason, 'session/workspace-attach-failed')
  assert.equal(partial.body.session_id, 'minted')
  assert.equal(partial.body.manual_reconcile, true)
  ctx.sessionController.create = async () => { throw Object.assign(new Error(), { code: 'gateway/internal' }) }
  const unknown = await create()
  assert.equal(unknown.status, 502)
  assert.equal(unknown.body.manual_reconcile, true)
  ctx.sessionController.create = async () => ({ agentPreset: 'master-control' })
  const missing = await create()
  assert.equal(missing.body.reason, 'create_returned_no_session_id')
  assert.equal(missing.body.manual_reconcile, true)
  assert.equal(started.store.snapshot().sessionAllowlist.length, 1)
  assert.equal(ctx.state.prompts, 0)
})

test('a created session and its grant survive a Host restart', async () => {
  const { root, real } = tempRoot()
  const project = fs.mkdtempSync(path.join(root, 'project-'))
  const ctx = officialCtx()
  const first = await startServer(ctx, writable({
    workspaceRoots: [real],
    allowCreateWorkspace: true,
    allowCreateSession: true,
  }))
  const created = await call(first.port, 'POST', '/v1/sessions', {
    path: project, create_workspace: true, access: 'write',
  })
  assert.equal(created.status, 200)
  const sessionId = created.body.session_id
  await close(first.server)

  const second = await startServer(ctx, {
    store: first.store,
    file: first.file,
    dir: first.dir,
    requestsFile: first.requestsFile,
    workspaceRoots: [real],
    allowCreateWorkspace: true,
    allowCreateSession: true,
  })
  const granted = await call(second.port, 'GET', '/v1/granted')
  const row = granted.body.sessions.find((item) => item.session_id === sessionId)
  assert.ok(row)
  assert.equal(row.access, 'write')
  const discovered = await call(second.port, 'GET', '/v1/discover?limit=50')
  assert.ok(discovered.body.items.some((item) => item.session_id === sessionId))
  await close(second.server)
})

test('open path calls the official opener and refuses paths outside the roots', async () => {
  const { root, real } = tempRoot()
  const project = fs.mkdtempSync(path.join(root, 'project-'))
  const ctx = officialCtx()
  const started = await startServer(ctx, writable({
    workspaceRoots: [real],
    allowOpenPath: true,
  }))
  const opened = await call(started.port, 'POST', '/v1/open', { path: project })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.opened, true)
  assert.equal(ctx.state.openCalls.length, 1)
  assert.equal(ctx.state.openCalls[0].path, fs.realpathSync.native(project))

  const reveal = await call(started.port, 'POST', '/v1/open', { path: project, action: 'reveal' })
  assert.equal(reveal.status, 200)
  assert.equal(ctx.state.openCalls[1].action, 'reveal')

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outside-'))
  const refused = await call(started.port, 'POST', '/v1/open', { path: outside })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.reason, 'outside_allowed_roots')

  ctx.state.canOpen = false
  const unavailable = await call(started.port, 'POST', '/v1/open', { path: project })
  assert.equal(unavailable.status, 501)
  assert.equal(unavailable.body.reason, 'open_path_unavailable')
  await close(started.server)
})
