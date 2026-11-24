#!/usr/bin/env node
/**
 * masterctl - Super Agent registry for the Master Control mode.
 *
 * The master session owns this file. It records the Super Agents it creates,
 * the audit rounds their independent auditors return, and the final verdict.
 * The Cockpit plugin reads the same JSON through its read-only host route.
 *
 * No dependencies. ASCII-only console output (GBK consoles corrupt symbols).
 *
 * Usage:
 *   node masterctl.mjs init [--project D:\path] [--max-workers 4]
 *   node masterctl.mjs create --id sa-1 --title "..." --mission "..." \
 *        --acceptance "criterion 1" --acceptance "criterion 2" \
 *        [--lane 1] [--name sa-1] [--session-id session-...] [--preset ...] \
 *        [--cwd D:\path] [--output D:\path] [--max-rounds 3] [--force]
 *   node masterctl.mjs capacity [--max-workers 6]
 *   node masterctl.mjs slots [--json]
 *   node masterctl.mjs update --id sa-1 [--status working|auditing|rework|accepted|blocked|paused] \
 *        [--round 1] [--session-id ...] [--name ...] [--note "..."]
 *   node masterctl.mjs audit --id sa-1 --auditor auditor-1 --verdict PASS|FAIL \
 *        [--round 1] [--finding "..."] [--findings-file path] [--evidence path] [--note "..."]
 *   node masterctl.mjs list [--json]
 *   node masterctl.mjs show --id sa-1 [--json]
 *   node masterctl.mjs doctor
 *   node masterctl.mjs path
 *
 * Exit codes: 0 ok, 1 validation/IO error.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_STATE = path.join(os.homedir(), '.dsh', 'state', 'master-control', 'superagents.json')
const VALID_STATUS = new Set(['created', 'working', 'auditing', 'rework', 'accepted', 'blocked', 'paused'])
/** A lane is occupied only while the Super Agent can still be sent more work. */
const ACTIVE_STATUS = new Set(['created', 'working', 'auditing', 'rework'])

function fail(message) {
  process.stderr.write('[masterctl] ERROR: ' + message + '\n')
  process.exit(1)
}

function now() {
  return new Date().toISOString()
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
      continue
    }
    i += 1
    if (args[key] === undefined) args[key] = next
    else if (Array.isArray(args[key])) args[key].push(next)
    else args[key] = [args[key], next]
  }
  return args
}

function listOf(value) {
  if (value === undefined || value === null || value === true) return []
  return Array.isArray(value) ? value : [value]
}

function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail('cannot read ' + file + ': ' + error.message)
  }
}

function statePath(args) {
  return path.resolve(args.state || process.env.DSH_MASTER_STATE || DEFAULT_STATE)
}

function defaultState(project) {
  return {
    version: 1,
    project: project || process.cwd(),
    maxWorkers: 4,
    createdAt: now(),
    updatedAt: now(),
    agents: [],
    events: [],
  }
}

function loadState(file) {
  if (!fs.existsSync(file)) return defaultState()
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail('cannot read state ' + file + ': ' + error.message)
  }
  let state
  try {
    state = JSON.parse(raw)
  } catch (error) {
    fail('state is not valid JSON (' + file + '): ' + error.message)
  }
  if (!state || typeof state !== 'object') fail('state root must be an object')
  if (!Array.isArray(state.agents)) state.agents = []
  if (!Array.isArray(state.events)) state.events = []
  if (state.version == null) state.version = 1
  if (!state.project) state.project = process.cwd()
  state.maxWorkers = Math.max(1, Number(state.maxWorkers) || 4)
  return state
}

function isActive(agent) {
  return ACTIVE_STATUS.has(String(agent && agent.status))
}

function activeAgents(state) {
  return state.agents.filter(isActive)
}

function laneOf(agent) {
  const lane = Number(agent && agent.lane)
  return Number.isInteger(lane) && lane > 0 ? lane : null
}

function occupiedLanes(state, exceptId) {
  const used = new Map()
  for (const agent of activeAgents(state)) {
    if (exceptId && agent.id === exceptId) continue
    const lane = laneOf(agent)
    if (lane) used.set(lane, agent)
  }
  return used
}

function nextFreeLane(state, exceptId) {
  const used = occupiedLanes(state, exceptId)
  for (let lane = 1; lane <= state.maxWorkers; lane += 1) {
    if (!used.has(lane)) return lane
  }
  return null
}

function laneBoard(state) {
  const used = occupiedLanes(state)
  const lanes = []
  for (let lane = 1; lane <= state.maxWorkers; lane += 1) {
    const agent = used.get(lane)
    lanes.push({ lane, agentId: agent ? agent.id : null, title: agent ? agent.title : null })
  }
  return lanes
}

function saveState(file, state) {
  state.updatedAt = now()
  if (state.events.length > 500) state.events = state.events.slice(-500)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function event(state, type, id, detail) {
  state.events.push({ at: now(), type, id: id || null, detail: detail === undefined ? null : detail })
}

function findAgent(state, id) {
  const agent = state.agents.find(item => item && item.id === id)
  if (!agent) fail('unknown Super Agent id: ' + id)
  return agent
}

function oneLine(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ')
  return text.length > max ? text.slice(0, max) + '...' : text
}

function normalizeAgent(agent) {
  agent.acceptance = Array.isArray(agent.acceptance) ? agent.acceptance : []
  agent.audits = Array.isArray(agent.audits) ? agent.audits : []
  agent.notes = Array.isArray(agent.notes) ? agent.notes : []
  agent.round = Number(agent.round) || 0
  agent.maxRounds = Number(agent.maxRounds) || 3
  agent.lane = laneOf(agent)
  return agent
}

function printAgent(agent) {
  process.stdout.write(
    [
      'id        : ' + agent.id,
      'title     : ' + agent.title,
      'status    : ' + agent.status + '  round ' + agent.round + '/' + agent.maxRounds,
      'lane      : ' + (agent.lane || '-'),
      'name      : ' + (agent.name || '-'),
      'sessionId : ' + (agent.sessionId || '-'),
      'cwd       : ' + (agent.cwd || '-'),
      'output    : ' + (agent.output || '-'),
      'verdict   : ' + (agent.lastVerdict || '-'),
      'mission   : ' + oneLine(agent.mission, 160),
      'acceptance: ' + (agent.acceptance.length ? '' : '(none)'),
      ...agent.acceptance.map((item, index) => '  ' + (index + 1) + '. ' + oneLine(item, 160)),
      'audits    : ' + agent.audits.length,
      ...agent.audits.map(item =>
        '  r' + item.round + ' ' + item.verdict + ' by ' + item.auditor + ' @ ' + item.at +
        (item.findings && item.findings.length ? ' :: ' + oneLine(item.findings.join(' | '), 200) : '')),
    ].join('\n') + '\n',
  )
}

/**
 * Parse one integer CLI argument strictly.
 *
 * Digits only (so negative, decimal, exponent and "Infinity" spellings are
 * refused), then a safe-integer range check: 400-digit input or 1e309 becomes
 * Infinity, and JSON.stringify(Infinity) writes null, which is how rounds used
 * to be corrupted.
 */
function integerArg(raw, label, min, max) {
  const text = String(raw)
  const shown = text.length > 32 ? text.slice(0, 32) + '...' : text
  if (!/^\d+$/.test(text)) fail(label + ' must be an integer ' + min + '..' + max + ' (got "' + shown + '")')
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(label + ' must be an integer ' + min + '..' + max + ' (got ' + shown + ')')
  }
  return value
}

function cmdInit(args, file) {
  const state = defaultState(args.project)
  if (fs.existsSync(file) && !args.force) fail('state already exists: ' + file + ' (use --force to reset)')
  state.maxWorkers = Math.max(1, Number(args['max-workers']) || 4)
  saveState(file, state)
  process.stdout.write('[ok] initialized ' + file + ' (capacity ' + state.maxWorkers + ' lanes)\n')
}

function cmdCreate(args, file) {
  const state = loadState(file)
  const id = String(args.id || '').trim()
  const title = String(args.title || '').trim()
  const mission = String(args.mission || (args['mission-file'] ? readText(args['mission-file']) : '')).trim()
  if (!id) fail('--id is required')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(id)) fail('--id must be 2-64 chars of letters, digits, dot, underscore, hyphen')
  if (!title) fail('--title is required')
  if (!mission) fail('--mission or --mission-file is required')
  const existing = state.agents.find(item => item && item.id === id)
  if (existing && !args.force) fail('Super Agent already exists: ' + id + ' (use --force to replace)')
  const acceptance = listOf(args.acceptance).flatMap(item => splitLines(item))
  if (existing) state.agents = state.agents.filter(item => item && item.id !== id)
  if (activeAgents(state).length >= state.maxWorkers) {
    fail('all ' + state.maxWorkers + ' lanes are busy; wait for a verdict, raise capacity with "capacity --max-workers N", or finish a lane')
  }
  let lane = args.lane === undefined ? null : Number(args.lane)
  if (lane !== null) {
    if (!Number.isInteger(lane) || lane < 1 || lane > state.maxWorkers) fail('--lane must be 1..' + state.maxWorkers)
    if (occupiedLanes(state).has(lane)) fail('lane ' + lane + ' is already occupied by ' + occupiedLanes(state).get(lane).id)
  } else {
    lane = nextFreeLane(state)
    if (lane === null) fail('no free lane; raise capacity with "capacity --max-workers N"')
  }
  const agent = normalizeAgent({
    id,
    title,
    mission,
    acceptance,
    status: 'created',
    lane,
    maxWorkers: state.maxWorkers,
    round: 0,
    maxRounds: Number(args['max-rounds']) || 3,
    name: args.name ? String(args.name) : id,
    sessionId: args['session-id'] ? String(args['session-id']) : null,
    preset: args.preset ? String(args.preset) : null,
    cwd: args.cwd ? String(args.cwd) : process.cwd(),
    output: args.output ? String(args.output) : null,
    createdAt: now(),
    updatedAt: now(),
    acceptedAt: null,
    blockedAt: null,
    lastVerdict: null,
    audits: [],
    notes: [],
  })
  if (existing) state.agents = state.agents.filter(item => item && item.id !== id)
  state.agents.push(agent)
  event(state, 'create', id, { title, acceptance: acceptance.length })
  saveState(file, state)
  if (args.json) process.stdout.write(JSON.stringify(agent, null, 2) + '\n')
  else process.stdout.write('[ok] created ' + id + ' (' + acceptance.length + ' acceptance criteria)\n')
}

function cmdUpdate(args, file) {
  const state = loadState(file)
  const id = String(args.id || '').trim()
  if (!id) fail('--id is required')
  const agent = normalizeAgent(findAgent(state, id))
  const wasActive = isActive(agent)
  // BUG-D: --round used to be persisted as NaN for non-numeric input and as
  // null for anything beyond Number.MAX_SAFE_INTEGER (Infinity -> JSON null).
  const nextRound = args.round === undefined
    ? null
    : integerArg(args.round, '--round', 0, Number.MAX_SAFE_INTEGER)
  const nextMaxRounds = args['max-rounds'] === undefined
    ? null
    : integerArg(args['max-rounds'], '--max-rounds', 1, 32)
  if (args.lane !== undefined) {
    const lane = Number(args.lane)
    if (!Number.isInteger(lane) || lane < 1 || lane > state.maxWorkers) fail('--lane must be 1..' + state.maxWorkers)
    const used = occupiedLanes(state, id)
    if (used.has(lane)) fail('lane ' + lane + ' is already occupied by ' + used.get(lane).id)
    agent.lane = lane
  }
  if (args.status) {
    const status = String(args.status)
    if (!VALID_STATUS.has(status)) fail('invalid --status: ' + status + ' (allowed: ' + [...VALID_STATUS].join(', ') + ')')
    if (ACTIVE_STATUS.has(status) && !wasActive) {
      if (activeAgents(state).length >= state.maxWorkers) fail('all ' + state.maxWorkers + ' lanes are busy; free a lane or raise capacity first')
      // A reactivated agent may still carry a historical lane that another active
      // agent has since taken (see "audit FAIL on a non-active agent").
      const heldLane = laneOf(agent)
      const used = occupiedLanes(state, id)
      if (!heldLane || heldLane > state.maxWorkers || used.has(heldLane)) {
        agent.lane = nextFreeLane(state, id)
        if (!agent.lane) fail('no free lane; raise capacity with "capacity --max-workers N"')
      }
    }
    agent.status = status
    if (status === 'accepted') agent.acceptedAt = now()
    if (status === 'blocked') agent.blockedAt = now()
  }
  if (nextRound !== null) agent.round = nextRound
  if (args['session-id']) agent.sessionId = String(args['session-id'])
  if (args.name) agent.name = String(args.name)
  if (args.cwd) agent.cwd = String(args.cwd)
  if (args.output) agent.output = String(args.output)
  if (nextMaxRounds !== null) agent.maxRounds = nextMaxRounds
  const note = args.note ? String(args.note) : null
  if (note) agent.notes.push({ at: now(), text: note })
  agent.updatedAt = now()
  event(state, 'update', id, { status: agent.status, round: agent.round, lane: agent.lane, note })
  saveState(file, state)
  const freed = wasActive && !isActive(agent) ? ' (lane ' + (agent.lane || '?') + ' freed)' : ''
  if (args.json) process.stdout.write(JSON.stringify(agent, null, 2) + '\n')
  else process.stdout.write('[ok] updated ' + id + ' -> ' + agent.status + ' round ' + agent.round + '/' + agent.maxRounds + freed + '\n')
}

function cmdAudit(args, file) {
  const state = loadState(file)
  const id = String(args.id || '').trim()
  const auditor = String(args.auditor || '').trim()
  const verdictRaw = String(args.verdict || '').trim().toUpperCase()
  if (!id) fail('--id is required')
  if (!auditor) fail('--auditor is required')
  if (verdictRaw !== 'PASS' && verdictRaw !== 'FAIL') fail('--verdict must be PASS or FAIL')
  const agent = normalizeAgent(findAgent(state, id))
  const maxRounds = Number.isInteger(agent.maxRounds) && agent.maxRounds >= 1 ? agent.maxRounds : 3
  let round
  if (args.round === undefined) {
    round = Number.isSafeInteger(agent.round) && agent.round >= 1 ? agent.round : 1
  } else {
    // BUG-C + BUG-D: safe integer inside 1..maxRounds only.
    round = integerArg(args.round, '--round', 1, maxRounds)
  }
  const wasActive = isActive(agent)
  const previousStatus = agent.status
  const findings = listOf(args.finding)
    .flatMap(item => splitLines(item))
    .concat(args['findings-file'] ? splitLines(readText(args['findings-file'])) : [])
  const evidence = listOf(args.evidence).flatMap(item => splitLines(item))
  const record = {
    round,
    auditor,
    verdict: verdictRaw,
    findings,
    evidence,
    note: args.note ? String(args.note) : null,
    at: now(),
  }
  agent.audits.push(record)
  agent.round = Math.max(agent.round, round)
  agent.lastVerdict = verdictRaw
  if (verdictRaw === 'PASS') {
    agent.status = 'accepted'
    agent.acceptedAt = now()
  } else if (wasActive) {
    agent.status = 'rework'
  } else {
    // BUG-A: FAIL on an accepted/blocked/paused agent must not resurrect it or
    // grab a lane; the master has to ask explicitly for "update --status working".
    agent.status = previousStatus
    agent.notes.push({
      at: now(),
      text: 'audit FAIL at round ' + round + ' while status was "' + previousStatus +
        '"; status kept and lane not occupied. To redevelop run: update --id ' + id + ' --status working',
    })
  }
  agent.updatedAt = now()
  event(state, 'audit', id, { round, auditor, verdict: verdictRaw, findings: findings.length, status: agent.status })
  saveState(file, state)
  if (args.json) process.stdout.write(JSON.stringify(record, null, 2) + '\n')
  else {
    const kept = verdictRaw === 'FAIL' && !wasActive ? ' (status kept: ' + agent.status + ', lane not occupied)' : ''
    process.stdout.write('[ok] audit ' + id + ' round ' + round + ' -> ' + verdictRaw + ' by ' + auditor + kept + '\n')
    for (const finding of findings) process.stdout.write('  - ' + finding + '\n')
  }
}

function cmdList(args, file) {
  const state = loadState(file)
  if (args.json) {
    process.stdout.write(JSON.stringify(state, null, 2) + '\n')
    return
  }
  if (!state.agents.length) {
    process.stdout.write('(no Super Agents) ' + file + '\n')
    return
  }
  process.stdout.write('state: ' + file + '  capacity: ' + state.maxWorkers + ' lanes\n')
  for (const raw of state.agents) {
    const agent = normalizeAgent(raw)
    process.stdout.write(
      [
        agent.status.padEnd(9),
        ('L' + (agent.lane || '-')).padEnd(4),
        ('r' + agent.round + '/' + agent.maxRounds).padEnd(6),
        (agent.lastVerdict || '-').padEnd(5),
        agent.id.padEnd(24),
        oneLine(agent.title, 70),
      ].join('  ') + '\n',
    )
  }
}

function cmdShow(args, file) {
  const state = loadState(file)
  const id = String(args.id || '').trim()
  if (!id) fail('--id is required')
  const agent = normalizeAgent(findAgent(state, id))
  if (args.json) process.stdout.write(JSON.stringify(agent, null, 2) + '\n')
  else printAgent(agent)
}

function cmdDoctor(args, file) {
  const state = loadState(file)
  const problems = []
  if (!state.version) problems.push('missing version')
  if (!Number.isInteger(state.maxWorkers) || state.maxWorkers < 1 || state.maxWorkers > 32) {
    problems.push('maxWorkers must be an integer 1..32 (got ' + state.maxWorkers + ')')
  }
  const ids = new Set()
  const lanes = new Map()
  for (const raw of state.agents) {
    if (!raw || !raw.id) { problems.push('agent without id'); continue }
    if (ids.has(raw.id)) problems.push('duplicate id: ' + raw.id)
    ids.add(raw.id)
    if (!raw.title) problems.push(raw.id + ': missing title')
    if (!raw.mission) problems.push(raw.id + ': missing mission')
    if (!VALID_STATUS.has(raw.status)) problems.push(raw.id + ': invalid status ' + raw.status)
    if (!Array.isArray(raw.acceptance) || raw.acceptance.length === 0) problems.push(raw.id + ': no acceptance criteria')
    if (!Array.isArray(raw.audits)) problems.push(raw.id + ': audits is not an array')
    if (isActive(raw)) {
      const lane = laneOf(raw)
      if (!lane || lane < 1 || lane > state.maxWorkers) problems.push(raw.id + ': active but lane is invalid (' + raw.lane + ')')
      else if (lanes.has(lane)) problems.push('lane ' + lane + ' held by both ' + lanes.get(lane) + ' and ' + raw.id)
      else lanes.set(lane, raw.id)
    }
  }
  const active = activeAgents(state).length
  if (active > state.maxWorkers) problems.push('active agents ' + active + ' exceed capacity ' + state.maxWorkers)
  process.stdout.write(JSON.stringify({
    state: file,
    exists: fs.existsSync(file),
    project: state.project,
    maxWorkers: state.maxWorkers,
    active,
    free: Math.max(0, state.maxWorkers - active),
    agents: state.agents.length,
    events: state.events.length,
    lanes: laneBoard(state),
    problems,
    ok: problems.length === 0,
  }, null, 2) + '\n')
  if (problems.length) process.exit(1)
}

function cmdCapacity(args, file) {
  const state = loadState(file)
  if (args['max-workers'] === undefined) {
    process.stdout.write(JSON.stringify({
      state: file,
      maxWorkers: state.maxWorkers,
      active: activeAgents(state).length,
      free: Math.max(0, state.maxWorkers - activeAgents(state).length),
      lanes: laneBoard(state),
    }, null, 2) + '\n')
    return
  }
  const next = Number(args['max-workers'])
  if (!Number.isInteger(next) || next < 1 || next > 32) fail('--max-workers must be an integer 1..32')
  const active = activeAgents(state)
  if (next < active.length) fail('cannot shrink to ' + next + ': ' + active.length + ' lanes are active')
  // BUG-B: shrinking could leave an active agent on a lane above the new limit.
  const overflowing = active.filter(agent => {
    const lane = laneOf(agent)
    return lane !== null && lane > next
  })
  if (overflowing.length) {
    fail('cannot shrink to ' + next + ': active agents hold lanes above ' + next + ' (' +
      overflowing.map(agent => agent.id + ' holds L' + laneOf(agent)).join(', ') +
      '); free or move those lanes first')
  }
  const before = state.maxWorkers
  state.maxWorkers = next
  event(state, 'capacity', null, { before, after: next })
  saveState(file, state)
  process.stdout.write('[ok] capacity ' + before + ' -> ' + next + ' lanes (active ' + activeAgents(state).length + ')\n')
}

function cmdSlots(args, file) {
  const state = loadState(file)
  const lanes = laneBoard(state)
  const active = activeAgents(state).length
  if (args.json) {
    process.stdout.write(JSON.stringify({
      maxWorkers: state.maxWorkers,
      active,
      free: Math.max(0, state.maxWorkers - active),
      lanes,
    }, null, 2) + '\n')
    return
  }
  process.stdout.write('capacity ' + state.maxWorkers + ' lanes | active ' + active + ' | free ' + Math.max(0, state.maxWorkers - active) + '\n')
  for (const slot of lanes) {
    process.stdout.write(
      '  L' + String(slot.lane).padEnd(2) +
      (slot.agentId ? 'BUSY  ' + slot.agentId.padEnd(24) + '  ' + oneLine(slot.title, 70) : 'free') + '\n',
    )
  }
}

const argv = process.argv.slice(2)
const args = parseArgs(argv)
const command = args._[0]
const file = statePath(args)

if (!command || command === 'help' || args.help) {
  process.stdout.write('masterctl: init|create|update|audit|list|show|doctor|capacity|slots|path\n')
  process.stdout.write('Run "node masterctl.mjs <command> --help" for usage.\n')
  process.exit(0)
}

if (command === 'init') cmdInit(args, file)
else if (command === 'create') cmdCreate(args, file)
else if (command === 'update') cmdUpdate(args, file)
else if (command === 'audit') cmdAudit(args, file)
else if (command === 'list') cmdList(args, file)
else if (command === 'show') cmdShow(args, file)
else if (command === 'doctor') cmdDoctor(args, file)
else if (command === 'capacity') cmdCapacity(args, file)
else if (command === 'slots') cmdSlots(args, file)
else if (command === 'path') process.stdout.write(file + '\n')
else fail('unknown command: ' + command)
