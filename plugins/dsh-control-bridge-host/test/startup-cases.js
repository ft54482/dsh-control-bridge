/**
 * First-start regression for the host plugin.
 *
 * A profile that has never paired anything has an empty (or absent) allowlist.
 * That may only boot when the operator's workspace-autonomy policy is really in
 * effect; every other refusal stays exactly as it was.
 *
 * The integration probe runs in a child process (see startup-probe.js): it
 * applies the real plugin to a fake Desktop context and asks the real loopback
 * endpoint, so "listening" means an HTTP answer, not a returned flag.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { decideListen } from '../policy.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE = path.join(HERE, 'startup-probe.js')
const SECRET = 'first-start-probe-secret-0123456789abcdef0123456789abcdef'
const RESERVED_PORTS = new Set([8765, 3082, 3084, 3088])

function runProbe(mode) {
  const resultFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-autonomy-probe-')), 'result.json')
  const run = spawnSync(process.execPath, [PROBE, mode, resultFile], {
    stdio: 'ignore',
    timeout: 60_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  assert.equal(run.status, 0, `probe ${mode} exited ${run.status}`)
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  // The probe must never borrow a real desktop port.
  assert.equal(RESERVED_PORTS.has(result.port), false)
  fs.rmSync(result.workDir, { recursive: true, force: true })
  fs.rmSync(path.dirname(resultFile), { recursive: true, force: true })
  return result
}

test('an effective policy lets an empty allowlist listen', async () => {
  const result = runProbe('effective')
  assert.equal(result.failure, '', result.failure)
  assert.equal(result.decision.listening, true)
  assert.equal(result.decision.grants, 0)
  assert.equal(result.decision.autonomy.effective, true)
  assert.equal(result.decision.autonomy.configured, true)
  assert.equal(result.decision.autonomy.enabled, true)
  assert.equal(result.connectable, true)
  assert.equal(result.health.status, 200)
  assert.equal(result.health.body.ok, true)
  assert.equal(result.health.body.workspace_autonomy.effective, true)
  assert.equal(result.health.body.workspace_autonomy.operations, 0)
  // Nothing was pre-seeded: the empty file stays empty.
  assert.deepEqual(JSON.parse(result.allowlistText), { version: 1, workspaceAllowlist: [], sessionAllowlist: [] })
})

test('a missing allowlist file is a legal first run under an effective policy', async () => {
  const result = runProbe('missing-file')
  assert.equal(result.failure, '', result.failure)
  assert.equal(result.decision.listening, true)
  assert.equal(result.decision.grants, 0)
  assert.equal(result.health.status, 200)
  assert.equal(result.health.body.workspace_autonomy.effective, true)
  // Listening does not create the grant file; the first grant will.
  assert.equal(result.allowlistExists, false)
})

test('without the policy an empty allowlist still refuses to listen', async () => {
  const result = runProbe('off')
  assert.equal(result.failure, '', result.failure)
  assert.equal(result.decision.listening, false)
  assert.equal(result.decision.reason, 'no steady allowlist and no armed bootstrap')
  assert.equal(result.decision.autonomy.configured, false)
  assert.equal(result.decision.autonomy.effective, false)
  assert.equal(result.connectable, false)
  assert.equal(result.health, null)
})

test('a configured but ineffective policy still refuses an empty allowlist', async () => {
  const result = runProbe('ineffective')
  assert.equal(result.failure, '', result.failure)
  assert.equal(result.decision.listening, false)
  assert.equal(result.decision.reason, 'no steady allowlist and no armed bootstrap')
  assert.equal(result.decision.autonomy.configured, true)
  assert.equal(result.decision.autonomy.enabled, true)
  assert.equal(result.decision.autonomy.effective, false)
  assert.equal(result.decision.autonomy.reason, 'allowlist_file_missing')
  assert.equal(result.connectable, false)
})

test('a zero-byte allowlist is unreadable, with or without autonomy', async () => {
  const result = runProbe('zero-byte')
  assert.equal(result.failure, '', result.failure)
  assert.equal(result.decision.listening, false)
  assert.equal(result.decision.reason, 'allowlist_unreadable')
  assert.equal(result.decision.allowlist_status, 'unreadable')
  assert.equal(result.connectable, false)
})

test('the decision itself: autonomy only replaces a missing grant count', () => {
  const base = { services: true, hostSecret: SECRET, allowlistCount: 0, bootstrap: null, bind: '127.0.0.1', now: 1 }
  const effective = decideListen({ ...base, autonomyEffective: true })
  assert.equal(effective.listening, true)
  assert.equal(effective.steady, true)
  const ineffective = decideListen({ ...base, autonomyEffective: false })
  assert.equal(ineffective.listening, false)
  assert.equal(ineffective.steady, false)
  assert.equal(decideListen({ ...base, autonomyEffective: true, hostSecret: '' }).listening, false)
  assert.equal(decideListen({ ...base, autonomyEffective: true, services: false }).listening, false)
  assert.equal(decideListen({ ...base, autonomyEffective: true, bind: '0.0.0.0' }).listening, false)
  // Grants still work without any policy, exactly as before.
  const granted = decideListen({ ...base, allowlistCount: 1 })
  assert.equal(granted.listening, true)
  assert.equal(granted.steady, true)
  // An armed bootstrap still opens a window without grants or a policy.
  const bootstrap = { armed: true, secret: SECRET, expiresAt: 2, consumed: false }
  const window = decideListen({ services: true, hostSecret: '', allowlistCount: 0, bootstrap, bind: '127.0.0.1', now: 1 })
  assert.equal(window.listening, true)
  assert.equal(window.steady, false)
  assert.equal(window.bootstrap, true)
})
