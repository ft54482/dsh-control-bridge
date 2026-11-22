/**
 * HTTP fixture for the Python contract test.
 *
 * The services below return the official 0.2.2 shapes: `sessionId` rows, a
 * readSession snapshot, and a prompt result of `{ accepted: true }`. The
 * assistant text is appended to the log and then collected by the plugin.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGrantStore } from '../grants.js'
import { createHostServer } from '../server.js'

const config = JSON.parse(process.env.FIXTURE_CONFIG || '{}')
const secret = process.env.FIXTURE_SECRET || ''
const sessions = JSON.parse(process.env.FIXTURE_SESSIONS || '[]')
const rawEvents = JSON.parse(process.env.FIXTURE_EVENTS || '[]')
const cwd = sessions[0]?.cwd || process.cwd()
const answer = process.env.FIXTURE_TEXT || 'ok'

const state = {
  prompts: 0,
  seq: 0,
  events: rawEvents.map((event) => ({
    seq: event.seq,
    type: event.type === 'user' ? 'user/message' : (event.type === 'assistant' ? 'assistant/message' : event.type),
    time: 1_700_000_000_000 + (event.seq || 0),
    data: event.type === 'user' || event.type === 'assistant'
      ? { content: [{ type: 'text', text: event.text || '' }] }
      : (event.data || {}),
  })),
}
state.seq = state.events.reduce((max, event) => Math.max(max, event.seq || 0), 0)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fixture-'))
const allowlistFile = path.join(dir, 'allowlist.json')
fs.writeFileSync(allowlistFile, JSON.stringify({
  version: 1,
  workspaceAllowlist: config.workspaceAllowlist || [],
  sessionAllowlist: config.sessionAllowlist || [],
}, null, 2))
const grants = createGrantStore({ file: allowlistFile })

const ctx = {
  workspaceRegistry: {
    list() {
      return [{
        id: 'ws-demo',
        title: 'demo',
        path: cwd,
        sessionIds: sessions.map((item) => item.sessionId),
      }]
    },
  },
  sessionController: {
    async list(request, signal) {
      if (!signal) throw new TypeError('sessionController.list requires a signal')
      return { items: sessions }
    },
    async prompt(body, signal) {
      state.prompts += 1
      if (signal && signal.aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      const text = (body.content || []).map((part) => part.text).join(' ')
      state.events.push({ seq: ++state.seq, type: 'turn/start', time: Date.now(), data: { turn: 7 } })
      state.events.push({
        seq: ++state.seq,
        type: 'user/message',
        time: Date.now(),
        data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: body.requestId } },
      })
      state.events.push({
        seq: ++state.seq,
        type: 'assistant/message',
        time: Date.now(),
        data: { message: { role: 'assistant', content: [{ type: 'text', text: answer }] } },
      })
      state.events.push({ seq: ++state.seq, type: 'turn/end', time: Date.now(), data: { turn: 7, reason: { kind: 'completed' } } })
      return { accepted: true }
    },
  },
  sessionQuery: {
    async readSession(sessionId) {
      return {
        session: { id: sessionId, cwd, createdAt: 1_700_000_000_000 },
        inheritedEventCount: 0,
        events: state.events.map((event) => ({ ...event })),
      }
    },
    async observeSession(sessionId) {
      return {
        source: 'live',
        header: { id: sessionId, cwd, createdAt: 1_700_000_000_000 },
        inheritedEventCount: 0,
        get events() { return state.events.map((event) => ({ ...event })) },
        cursor: state.seq,
        retain() { return this },
        [Symbol.dispose]() {},
        dispose() {},
      }
    },
  },
}

const server = createHostServer(ctx, {
  grants,
  busyPolicy: 'refuse',
  pollIntervalMs: 25,
  resumeTimeoutMs: 10_000,
}, secret)
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`)
})
