/**
 * Workspace autonomy regression.
 *
 * The policy is opt-in: every case here either proves the old refusal still
 * happens without it, or proves one frozen promise of the new flow (canonical
 * identity, task ownership, first write Session, preset projection proof,
 * idempotent retry, revocable grant) against the isolated official fixture and
 * real temp directories. No live Desktop, no prompt is ever sent.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SECRET, WORKSPACE, call, close, officialCtx, readGrantFile, startServer } from './fixtures.js'

const TASK = { task_id: 'task-alpha', purpose: 'build the alpha feature' }

// Only directories this file minted are ever removed, and only when they still
// live directly under the OS temp directory. A stray character, a drive root or
// the checkout itself can never become a delete target.
const OWN_PREFIXES = ['ws-autonomy-', 'dsh-grants-']
const TEMP_ROOT = path.resolve(os.tmpdir())

function tempDir(tag = '') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ws-autonomy-${tag}`))
}

function safeRemove(dir) {
  if (typeof dir !== 'string' || !dir) return false
  const resolved = path.resolve(dir)
  if (path.dirname(resolved) !== TEMP_ROOT) return false
  if (!OWN_PREFIXES.some((prefix) => path.basename(resolved).startsWith(prefix))) return false
  if (resolved === TEMP_ROOT || resolved.length <= TEMP_ROOT.length) return false
  fs.rmSync(resolved, { recursive: true, force: true })
  return true
}

/** Read the operation journal the host wrote (one JSON object per line). */
function journal(dir) {
  const file = path.join(dir, 'workspace-autonomy.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
}

async function harness(t, options = {}) {
  const ctx = options.ctx || officialCtx()
  const ownRoots = options.workspaceRoots === undefined
  const root = ownRoots ? tempDir() : null
  const workspaceRoots = ownRoots ? [root] : options.workspaceRoots
  const ownOutside = options.outside === undefined
  const outside = ownOutside ? tempDir() : options.outside
  const started = await startServer(ctx, {
    initial: options.initial,
    workspaceRoots,
    allowCreateWorkspace: true,
    allowCreateSession: true,
    workspaceAutonomy: options.workspaceAutonomy === undefined ? true : options.workspaceAutonomy,
    allowlistFile: options.allowlistFile,
    autonomyRecordFile: options.autonomyRecordFile,
  })
  const cleanup = [started.dir, ...(ownRoots ? [root] : []), ...(ownOutside ? [outside] : [])]
  t.after(async () => {
    await close(started.server)
    for (const dir of cleanup) safeRemove(dir)
  })
  // The official fixture already owns one workspace (ws-demo); autonomy must add exactly one.
  const baseline = ctx.workspaceRegistry.list().length
  return { ctx, started, root: workspaceRoots[0], outside, baseline }
}

const health = (port) => call(port, 'GET', '/v1/health')

test('cleanup refuses anything that is not one of our own temp directories', () => {
  // A known bad sample for the guard itself: a drive root, the checkout, the
  // temp directory, a lone drive letter. None of them may be a delete target.
  assert.equal(safeRemove(''), false)
  assert.equal(safeRemove('C'), false)
  assert.equal(safeRemove(path.parse(process.cwd()).root), false)
  assert.equal(safeRemove(process.cwd()), false)
  assert.equal(safeRemove(os.tmpdir()), false)
  assert.equal(safeRemove(path.join(os.tmpdir(), 'ws-autonomy-does-not-exist')), true)
  const own = tempDir('guard-')
  fs.writeFileSync(path.join(own, 'file.txt'), 'x')
  assert.equal(safeRemove(own), true)
  assert.equal(fs.existsSync(own), false)
})

test('autonomy off keeps every old refusal: outside roots and the missing write Session', async (t) => {
  const ctx = officialCtx()
  const legacyRoot = fs.realpathSync.native(tempDir('legacy-root-'))
  const started = await startServer(ctx, {
    workspaceRoots: [legacyRoot],
    allowCreateWorkspace: true,
    allowCreateSession: true,
  })
  t.after(async () => {
    await close(started.server)
    safeRemove(started.dir)
    safeRemove(legacyRoot)
  })
  const outside = tempDir('legacy-outside-')
  t.after(() => safeRemove(outside))

  const registered = await call(started.port, 'POST', '/v1/workspaces', { path: outside })
  assert.equal(registered.status, 400)
  assert.equal(registered.body.reason, 'outside_allowed_roots')

  // A paired workspace whose only Session is read-only cannot host a preset
  // write Session without the policy: the old 403 must survive.
  const project = tempDir('legacy-project-')
  t.after(() => safeRemove(project))
  const workspace = await ctx.workspaceRegistry.create(project)
  workspace.sessionIds.push('paired-read')
  const paired = await startServer(ctx, {
    initial: {
      version: 1,
      workspaceAllowlist: [{ id: workspace.id, cwd: workspace.path, title: 'paired' }],
      sessionAllowlist: [{ sessionId: 'paired-read', workspaceId: workspace.id, cwd: workspace.path, access: 'read', profile: 'desktop' }],
    },
    workspaceRoots: [path.dirname(workspace.path)],
    allowCreateWorkspace: true,
    allowCreateSession: true,
  })
  t.after(async () => {
    await close(paired.server)
    safeRemove(paired.dir)
  })
  const denied = await call(paired.port, 'POST', '/v1/sessions', {
    workspace_id: workspace.id, agent_preset: 'master-control', access: 'write',
  })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.reason, 'workspace_write_not_granted')
  const declared = await health(paired.port)
  assert.equal(declared.body.workspace_autonomy.configured, false)
  assert.equal(declared.body.workspace_autonomy.enabled, false)
  assert.equal(declared.body.workspace_autonomy.effective, false)
  assert.equal(declared.body.workspace_autonomy.reason, 'not_configured')
  assert.equal(declared.body.workspace_autonomy.roots_mode, 'configured_roots')
})

test('autonomy registers a directory outside every root and takes a task-scoped grant', async (t) => {
  const { ctx, started, outside, baseline } = await harness(t)
  const project = path.join(outside, 'fresh-project')
  const created = await call(started.port, 'POST', '/v1/workspaces', {
    path: project, create_directory: true, ...TASK,
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.ok, true)
  assert.equal(created.body.created, true)
  assert.equal(created.body.reused, false)
  assert.equal(created.body.created_directory, true)
  assert.equal(created.body.started_task, false)
  assert.equal(created.body.path, fs.realpathSync.native(project))
  assert.equal(created.body.workspace.id, created.body.workspace_id)
  assert.equal(created.body.workspace.path, created.body.path)
  assert.equal(created.body.grant.workspace_id, created.body.workspace_id)
  assert.equal(created.body.grant.path, created.body.path)
  assert.deepEqual(created.body.autonomy, { enabled: true, effective: true })
  assert.equal(created.body.task.task_id, TASK.task_id)
  assert.equal(created.body.task.purpose, TASK.purpose)
  assert.equal(fs.statSync(project).isDirectory(), true)

  assert.equal(ctx.workspaceRegistry.list().length, baseline + 1)
  const stored = readGrantFile(started.file)
  assert.equal(stored.workspaceAllowlist.length, 1)
  assert.equal(stored.sessionAllowlist.length, 0)
  assert.equal(stored.workspaceAllowlist[0].task_id, TASK.task_id)
  assert.equal(stored.workspaceAllowlist[0].source, 'autonomy')
  assert.equal(stored.workspaceAllowlist[0].cwd, fs.realpathSync.native(project))

  const lines = journal(started.dir)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].op, 'workspace_create')
  assert.equal(lines[0].task_id, TASK.task_id)
  assert.equal(lines[0].purpose, TASK.purpose)
  assert.equal(lines[0].workspace_id, created.body.workspace_id)
  assert.equal(JSON.stringify(lines[0]).includes(SECRET), false)

  assert.equal(ctx.state.prompts, 0)
  assert.equal(fs.existsSync(started.requestsFile)
    ? JSON.parse(fs.readFileSync(started.requestsFile, 'utf8')).length : 0, 0)
})

test('the first write Session in a workspace needs no pre-existing write grant', async (t) => {
  const { ctx, started, outside } = await harness(t)
  const project = path.join(outside, 'first-write')
  fs.mkdirSync(project)
  const created = await call(started.port, 'POST', '/v1/sessions', {
    path: project, ...TASK, agent_preset: 'master-control', access: 'write',
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.ok, true)
  assert.equal(created.body.agent_preset, 'master-control')
  assert.equal(created.body.agent_preset_source, 'session_projection')
  assert.equal(created.body.access, 'write')
  assert.equal(created.body.grant.access, 'write')
  assert.equal(created.body.grant.task_id, TASK.task_id)
  assert.equal(created.body.grant.source, 'autonomy')
  assert.equal(created.body.task_id, TASK.task_id)
  assert.equal(created.body.purpose, TASK.purpose)
  assert.equal(created.body.started_task, false)
  assert.equal(created.body.workspace_created, true)
  assert.equal(created.body.deduplicated, false)
  assert.deepEqual(created.body.autonomy, { enabled: true, effective: true })

  const workspace = ctx.workspaceRegistry.list().find((item) => item.id === created.body.workspace_id)
  assert.ok(workspace.sessionIds.includes(created.body.session_id))
  const stored = readGrantFile(started.file)
  const grant = stored.sessionAllowlist.find((row) => row.sessionId === created.body.session_id)
  assert.equal(grant.access, 'write')
  assert.equal(grant.agentPreset, 'master-control')
  assert.equal(grant.task_id, TASK.task_id)
  assert.equal(grant.cwd, fs.realpathSync.native(project))
  assert.equal(ctx.state.prompts, 0)
  assert.equal(ctx.state.createCalls.length, 1)
  assert.equal(journal(started.dir).some((line) => line.op === 'session_create' && line.result === 'ok'), true)
})

test('reuse keeps one workspace and every Session carries its own task', async (t) => {
  const { ctx, started, outside, baseline } = await harness(t)
  const project = path.join(outside, 'reused')
  fs.mkdirSync(project)
  const first = await call(started.port, 'POST', '/v1/workspaces', { path: project, ...TASK })
  const second = await call(started.port, 'POST', '/v1/workspaces', { path: project, ...TASK })
  assert.equal(second.status, 200)
  assert.equal(second.body.workspace_id, first.body.workspace_id)
  assert.equal(second.body.created, false)
  assert.equal(second.body.reused, true)
  assert.equal(readGrantFile(started.file).workspaceAllowlist.length, 1)
  assert.equal(ctx.workspaceRegistry.list().length, baseline + 1)

  const one = await call(started.port, 'POST', '/v1/sessions', {
    path: project, ...TASK, agent_preset: 'master-control', access: 'write', client_request_key: 'reuse-key-0001',
  })
  const two = await call(started.port, 'POST', '/v1/sessions', {
    path: project, ...TASK, agent_preset: 'master-control', access: 'write', client_request_key: 'reuse-key-0002',
  })
  assert.equal(one.status, 200, JSON.stringify(one.body))
  assert.equal(two.status, 200, JSON.stringify(two.body))
  assert.notEqual(one.body.session_id, two.body.session_id)
  assert.equal(two.body.workspace_id, one.body.workspace_id)
  assert.equal(two.body.workspace_created, false)
  assert.equal(two.body.workspace_reused, true)
  assert.equal(ctx.workspaceRegistry.list().length, baseline + 1)
  assert.equal(readGrantFile(started.file).workspaceAllowlist.length, 1)
  assert.equal(readGrantFile(started.file).sessionAllowlist.length, 2)
})

test('concurrent duplicates collapse to one workspace and one Session per request key', async (t) => {
  const { ctx, started, outside, baseline } = await harness(t)
  const project = path.join(outside, 'concurrent')
  fs.mkdirSync(project)
  // A second spelling of the same directory: a real alias directory plus `..`,
  // and a junction when the OS allows one.
  const aliasDir = path.join(outside, 'alias')
  fs.mkdirSync(aliasDir)
  const spellings = [project, path.join(aliasDir, '..', 'concurrent'), path.join(project, '.')]
  try {
    const link = path.join(outside, 'junction')
    fs.symlinkSync(project, link, process.platform === 'win32' ? 'junction' : 'dir')
    spellings.push(link, path.join(link, '.'))
  } catch { /* junctions can be unavailable; the other spellings still apply */ }
  while (spellings.length < 6) spellings.push(project)

  const results = await Promise.all(spellings.slice(0, 6).map((target) => call(started.port, 'POST', '/v1/workspaces', {
    path: target, ...TASK,
  })))
  for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body))
  const ids = new Set(results.map((result) => result.body.workspace_id))
  assert.equal(ids.size, 1)
  assert.equal(ctx.workspaceRegistry.list().length, baseline + 1)
  assert.equal(readGrantFile(started.file).workspaceAllowlist.length, 1)

  const body = {
    path: project, ...TASK, agent_preset: 'master-control', access: 'write', client_request_key: 'same-key-0001',
  }
  const sessions = await Promise.all([1, 2, 3, 4].map(() => call(started.port, 'POST', '/v1/sessions', body)))
  for (const result of sessions) assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(new Set(sessions.map((result) => result.body.session_id)).size, 1)
  assert.equal(ctx.state.createCalls.length, 1)
  assert.equal(sessions.filter((result) => result.body.deduplicated === true).length, 3)
  assert.equal(readGrantFile(started.file).sessionAllowlist.length, 1)
})

test('an unknown preset fails before any Session, grant or success record', async (t) => {
  const { ctx, started, outside } = await harness(t)
  const project = path.join(outside, 'unknown-preset')
  fs.mkdirSync(project)
  const result = await call(started.port, 'POST', '/v1/sessions', {
    path: project, ...TASK, agent_preset: 'not-a-preset', access: 'write',
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.reason, 'agent-preset/invalid')
  assert.equal(ctx.state.createCalls, undefined)
  assert.equal(started.store.snapshot().sessionAllowlist.length, 0)
  assert.equal(journal(started.dir).some((line) => line.result === 'ok'), false)
  assert.equal(ctx.state.prompts, 0)
})

test('an unverified preset projection grants nothing and keeps the Session for reconciliation', async (t) => {
  const { ctx, started, outside } = await harness(t)
  const project = path.join(outside, 'bad-projection')
  fs.mkdirSync(project)
  ctx.sessionController.projections = async () => ({ kind: 'sequenced', values: { agentPreset: 'standard' } })
  const result = await call(started.port, 'POST', '/v1/sessions', {
    path: project, ...TASK, agent_preset: 'master-control', access: 'write',
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.reason, 'agent_preset_unverified')
  assert.equal(result.body.manual_reconcile, true)
  assert.equal(result.body.saved, false)
  assert.equal(result.body.started_task, false)
  assert.ok(result.body.session_id)
  const workspace = ctx.workspaceRegistry.list().find((item) => item.id === result.body.workspace_id)
  assert.ok(workspace)
  assert.equal(workspace.sessionIds.includes(result.body.session_id), true)
  assert.equal(readGrantFile(started.file).sessionAllowlist.length, 0)
  assert.equal(ctx.state.prompts, 0)
  assert.equal(journal(started.dir).some((line) => line.op === 'session_create' && line.result === 'ok'), false)
})

test('a workspace owned by another task needs an explicit confirmation', async (t) => {
  const { started, outside } = await harness(t)
  const project = path.join(outside, 'owned')
  fs.mkdirSync(project)
  const first = await call(started.port, 'POST', '/v1/workspaces', { path: project, ...TASK })
  assert.equal(first.status, 200)
  const other = { task_id: 'task-beta', purpose: 'another task' }
  const denied = await call(started.port, 'POST', '/v1/workspaces', { path: project, ...other })
  assert.equal(denied.status, 409)
  assert.equal(denied.body.reason, 'workspace_task_mismatch')
  assert.equal(denied.body.existing_task_id, TASK.task_id)
  assert.equal(readGrantFile(started.file).workspaceAllowlist[0].task_id, TASK.task_id)

  const confirmed = await call(started.port, 'POST', '/v1/workspaces', { path: project, ...other, confirm_task: true })
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.task.confirmed, true)
  assert.equal(confirmed.body.task.previous_task_id, TASK.task_id)
  // The workspace keeps its first task; the confirmation is in the journal.
  assert.equal(readGrantFile(started.file).workspaceAllowlist[0].task_id, TASK.task_id)
  const lines = journal(started.dir)
  assert.equal(lines.some((line) => line.op === 'workspace_task_confirmed'
    && line.task_id === 'task-beta' && line.reason === `previous_task_id=${TASK.task_id}`), true)

  // A Session created under the confirmed task records the new task itself; the
  // workspace keeps its first owner, so the caller confirms per request.
  const session = await call(started.port, 'POST', '/v1/sessions', {
    path: project, ...other, confirm_task: true, agent_preset: 'master-control', access: 'write',
  })
  assert.equal(session.status, 200, JSON.stringify(session.body))
  assert.equal(session.body.task_id, 'task-beta')
  const grant = readGrantFile(started.file).sessionAllowlist.find((row) => row.sessionId === session.body.session_id)
  assert.equal(grant.task_id, 'task-beta')
})

test('a busy Session is joined, never preempted, and the old busy refusal still holds', async (t) => {
  const ctx = officialCtx()
  const project = tempDir('busy-')
  t.after(() => safeRemove(project))
  const workspace = await ctx.workspaceRegistry.create(project)
  const busy = ctx.state.sessions.find((row) => row.sessionId === 'session-busy')
  busy.cwd = workspace.path
  // Move the busy Session into this workspace: the catalog binds a Session to
  // the workspace whose sessionIds list it.
  const demo = ctx.workspaceRegistry.get(WORKSPACE)
  demo.sessionIds = demo.sessionIds.filter((id) => id !== 'session-busy')
  workspace.sessionIds.push('session-busy')
  const { started } = await harness(t, {
    ctx,
    initial: {
      version: 1,
      workspaceAllowlist: [{ id: workspace.id, cwd: workspace.path, title: 'busy', source: 'autonomy', task_id: TASK.task_id, purpose: TASK.purpose }],
      sessionAllowlist: [{ sessionId: 'session-busy', workspaceId: workspace.id, cwd: workspace.path, access: 'write', profile: 'desktop' }],
    },
  })
  // The grant store is the authority: compare its normalized view, not the raw
  // file bytes (a rewrite normalizes absent optional fields).
  const grantRow = () => started.store.snapshot().sessionAllowlist
    .find((row) => row.sessionId === 'session-busy')
  const before = { ...grantRow() }
  const created = await call(started.port, 'POST', '/v1/sessions', {
    path: workspace.path, ...TASK, agent_preset: 'master-control', access: 'write',
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.notEqual(created.body.session_id, 'session-busy')
  assert.equal(busy.running, true)
  assert.equal(ctx.state.cancelled, 0)
  assert.deepEqual({ ...grantRow() }, before)
  assert.equal(readGrantFile(started.file).sessionAllowlist.some((row) => row.sessionId === 'session-busy'), true)

  const resumed = await call(started.port, 'POST', '/v1/resume', {
    workspace_id: workspace.id, session_id: 'session-busy', request_id: 'busy-1', text: 'do not preempt',
  })
  assert.equal(resumed.status, 409)
  assert.equal(resumed.body.reason, 'busy')
})

test('revocation withdraws the workspace and its Session grants but never the directory', async (t) => {
  const { ctx, started, outside } = await harness(t)
  const project = path.join(outside, 'revoked')
  fs.mkdirSync(project)
  const session = await call(started.port, 'POST', '/v1/sessions', {
    path: project, ...TASK, agent_preset: 'master-control', access: 'write',
  })
  assert.equal(session.status, 200, JSON.stringify(session.body))
  const workspaceId = session.body.workspace_id
  const revoked = await call(started.port, 'POST', '/v1/workspaces/revoke', { workspace_id: workspaceId })
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
  assert.equal(revoked.body.ok, true)
  assert.equal(revoked.body.workspace_id, workspaceId)
  assert.deepEqual(revoked.body.revoked, { workspace: true, sessions: 1 })
  assert.equal(revoked.body.directory_intact, true)
  assert.equal(revoked.body.started_task, false)
  assert.equal(fs.statSync(project).isDirectory(), true)
  const stored = readGrantFile(started.file)
  assert.equal(stored.workspaceAllowlist.length, 0)
  assert.equal(stored.sessionAllowlist.length, 0)
  assert.equal(journal(started.dir).filter((line) => line.op === 'workspace_revoke').length, 1)
  assert.equal(ctx.state.cancelled, 0)

  const after = await call(started.port, 'POST', '/v1/sessions', {
    workspace_id: workspaceId, agent_preset: 'master-control', access: 'write',
  })
  assert.equal(after.status, 403)
  assert.equal(after.body.reason, 'workspace_not_allowlisted')
  assert.equal(ctx.state.createCalls.length, 1)
})

test('a failed grant is repaired by the same request key instead of creating again', async (t) => {
  const { ctx, started, outside } = await harness(t)
  const project = path.join(outside, 'retry')
  fs.mkdirSync(project)
  const original = started.store.grantFreshSession.bind(started.store)
  let armed = true
  started.store.grantFreshSession = async (...args) => {
    if (armed) {
      armed = false
      throw Object.assign(new Error('allowlist write failed'), { code: 'allowlist_persist_failed' })
    }
    return original(...args)
  }
  const body = {
    path: project, ...TASK, agent_preset: 'master-control', access: 'write', client_request_key: 'retry-key-0001',
  }
  const first = await call(started.port, 'POST', '/v1/sessions', body)
  assert.equal(first.status, 500)
  assert.equal(first.body.reason, 'grant_persist_failed')
  assert.equal(first.body.manual_reconcile, true)
  assert.ok(first.body.session_id)
  assert.equal(first.body.saved, false)
  assert.equal(readGrantFile(started.file).sessionAllowlist.length, 0)
  const partial = journal(started.dir).find((line) => line.op === 'session_create' && line.result === 'failed')
  assert.equal(partial.phase, 'session_created')
  assert.equal(partial.session_id, first.body.session_id)
  const sessionsAfterFailure = ctx.state.sessions.length

  const retry = await call(started.port, 'POST', '/v1/sessions', body)
  assert.equal(retry.status, 200, JSON.stringify(retry.body))
  assert.equal(retry.body.session_id, first.body.session_id)
  assert.equal(retry.body.repaired, true)
  assert.equal(retry.body.deduplicated, false)
  assert.equal(ctx.state.sessions.length, sessionsAfterFailure)
  assert.equal(ctx.state.createCalls.length, 1)
  assert.equal(readGrantFile(started.file).sessionAllowlist.length, 1)
  assert.equal(ctx.state.prompts, 0)

  const replay = await call(started.port, 'POST', '/v1/sessions', body)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.session_id, first.body.session_id)
  assert.equal(replay.body.deduplicated, true)
  assert.equal(ctx.state.createCalls.length, 1)
})

test('a configured policy without an allowlist file fails closed and says why', async (t) => {
  const { started, outside } = await harness(t, { allowlistFile: '' })
  const declared = await health(started.port)
  assert.equal(declared.status, 200)
  const block = declared.body.workspace_autonomy
  assert.equal(block.configured, true)
  assert.equal(block.enabled, true)
  assert.equal(block.effective, false)
  assert.equal(block.reason, 'allowlist_file_missing')
  assert.equal(block.roots_mode, 'unrestricted')
  assert.equal(block.require_task, true)
  assert.equal(block.grant_store, 'memory')
  assert.equal(block.record_file, '')
  assert.equal(block.operations, 0)

  const project = path.join(outside, 'not-effective')
  const workspace = await call(started.port, 'POST', '/v1/workspaces', { path: project, create_directory: true, ...TASK })
  assert.equal(workspace.status, 403)
  assert.equal(workspace.body.reason, 'workspace_autonomy_not_effective')
  assert.equal(workspace.body.effective, false)
  assert.equal(fs.existsSync(project), false)

  const session = await call(started.port, 'POST', '/v1/sessions', {
    path: project, ...TASK, agent_preset: 'master-control', access: 'write',
  })
  assert.equal(session.status, 403)
  assert.equal(session.body.reason, 'workspace_autonomy_not_effective')
})

test('the effective declaration reports the catch-up state and counts journal lines', async (t) => {
  const ctx = officialCtx()
  const dir = tempDir('declare-')
  t.after(() => safeRemove(dir))
  const allowlistFile = path.join(dir, 'allowlist.json')
  fs.writeFileSync(allowlistFile, JSON.stringify({ version: 1, workspaceAllowlist: [], sessionAllowlist: [] }))
  const recordFile = path.join(dir, 'custom-record.jsonl')
  fs.writeFileSync(recordFile, `${JSON.stringify({ at: '2026-11-25T00:00:00.000Z', op: 'workspace_revoke', workspace_id: 'ws-old', result: 'ok' })}\n`)
  const started = await startServer(ctx, {
    workspaceRoots: [], allowCreateWorkspace: true, allowCreateSession: true,
    workspaceAutonomy: { enabled: true }, allowlistFile, autonomyRecordFile: recordFile,
  })
  t.after(async () => {
    await close(started.server)
    safeRemove(started.dir)
  })
  const declared = await health(started.port)
  const block = declared.body.workspace_autonomy
  assert.deepEqual(Object.keys(block).sort(), [
    'configured', 'effective', 'enabled', 'grant_store', 'operations', 'reason', 'record_file', 'require_task', 'roots_mode',
  ])
  assert.equal(block.effective, true)
  assert.equal(block.reason, null)
  assert.equal(block.record_file, recordFile)
  assert.equal(block.grant_store, 'file')
  assert.equal(block.operations, 1)
  // The catch-up count is a startup floor: a later operation adds to it.
  const project = tempDir('declare-project-')
  t.after(() => safeRemove(project))
  await call(started.port, 'POST', '/v1/workspaces', { path: project, ...TASK })
  assert.equal((await health(started.port)).body.workspace_autonomy.operations, 2)
})

test('workspace listing exposes the owning task without any secret', async (t) => {
  const { started, outside } = await harness(t)
  const project = path.join(outside, 'listed')
  fs.mkdirSync(project)
  const created = await call(started.port, 'POST', '/v1/workspaces', { path: project, ...TASK })
  const listed = await call(started.port, 'GET', '/v1/workspaces')
  assert.equal(listed.status, 200)
  const row = listed.body.workspaces.find((item) => item.id === created.body.workspace_id)
  assert.ok(row)
  assert.equal(row.task_id, TASK.task_id)
  assert.equal(JSON.stringify(listed.body).includes(SECRET), false)
  assert.equal(JSON.stringify(listed.body).includes('purpose'), false)
})
