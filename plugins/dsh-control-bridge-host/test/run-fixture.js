import { createHostServer } from '../server.js'

const config = JSON.parse(process.env.FIXTURE_CONFIG || '{}')
const secret = process.env.FIXTURE_SECRET || ''
const sessions = JSON.parse(process.env.FIXTURE_SESSIONS || '[]')
const events = JSON.parse(process.env.FIXTURE_EVENTS || '[]')
const ctx = {
  workspaceRegistry: { async list() { return JSON.parse(process.env.FIXTURE_WORKSPACES || '[]') } },
  sessionController: {
    async list() { return sessions },
    async prompt(body) {
      if (body.sessionId !== sessions[0]?.id) {
        return { sessionId: 'session-new', final: { reason: { kind: 'completed' } }, text: 'new' }
      }
      return { sessionId: body.sessionId, final: { reason: { kind: 'completed' } }, text: process.env.FIXTURE_TEXT || 'ok' }
    },
  },
  sessionQuery: { async readSession() { return events } },
}
const server = createHostServer(ctx, config, secret)
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`)
})
