/**
 * dsh-superagent-cockpit —— Host 半。
 *
 * 只做一件事：在 DSH Web 服务上挂一条只读同源代理，
 *   GET /@dsh-superagent-cockpit/api/<path>  →  <api>/orchestrator/api/<path>
 * 让浏览器半在不跨域的前提下读取 dsh-superagent 的管理 API。
 * 只转 GET/HEAD，只放行白名单里的只读路径。
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
export const name = 'dsh-superagent-cockpit'
export const inject = ['webServer']

const PREFIX = '/@dsh-superagent-cockpit/api'
/** 只读白名单：路径第一段必须命中。 */
const ALLOW = new Set(['state', 'overview', 'sources', 'decisions', 'tickets', 'threads'])
const TIMEOUT_MS = 8000
/** 主控模式的 Super Agent 注册表；masterctl.mjs 写，驾驶舱只读。 */
const DEFAULT_MASTER_STATE = nodePath.join(os.homedir(), '.dsh', 'state', 'master-control', 'superagents.json')

/** 读取主控注册表；不存在时返回空表，不让驾驶舱整体离线。 */
function masterState(config) {
  const file = String(config?.masterState ?? DEFAULT_MASTER_STATE)
  const empty = {
    version: 1,
    project: null,
    maxWorkers: null,
    active: null,
    free: null,
    agents: [],
    updatedAt: null,
    ok: false,
  }
  try {
    if (!fs.existsSync(file)) return { ...empty, error: 'master state not found' }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed.agents) || !Number.isSafeInteger(parsed.maxWorkers) || parsed.maxWorkers < 1) return { ...empty, error: 'invalid master registry' }
    const agents = parsed.agents
    const activeStatus = new Set(['created', 'working', 'auditing', 'rework'])
    const active = agents.filter(agent => activeStatus.has(String(agent && agent.status))).length
    return {
      version: parsed.version ?? 1,
      project: parsed.project ?? null,
      maxWorkers: parsed.maxWorkers,
      active,
      free: Math.max(0, parsed.maxWorkers - active),
      agents: agents.filter(Boolean).map(({ id, sessionId, lane, title, mission, status, round, maxRounds, lastVerdict, updatedAt }) => ({
        id, sessionId, lane, title, mission, status, round, maxRounds, lastVerdict, updatedAt,
      })),
      updatedAt: parsed.updatedAt ?? null,
      ok: true,
    }
  } catch {
    return { ...empty, error: 'master registry unavailable' }
  }
}

/* ------------------------------------------------------------------ *
 * 宿主服务探测：不同 Context 实现上 agents / jobs 挂的位置不一样。
 * 逐条试、每条都包 try，取不到就把原因写进 probe —— 但绝不让 /cluster 抛错，
 * 更不靠 inject 去声明新服务（inject 失败会把整个插件带下去）。
 * ------------------------------------------------------------------ */
const isObjLike = value => value != null && (typeof value === 'object' || typeof value === 'function')

const errText = error => String(error && error.message ? error.message : error)

function resolveService(ctx, name) {
  const errors = []
  const hits = []
  const add = (value, label) => { if (isObjLike(value)) hits.push({ value, label }) }
  try {
    if (ctx && typeof ctx.get === 'function') {
      try { add(ctx.get(name), 'ctx.get') } catch (error) { errors.push('ctx.get(' + name + '): ' + errText(error)) }
    } else {
      errors.push('ctx.get is not a function')
    }
    if (ctx) {
      try { add(ctx[name], 'ctx.' + name) } catch (error) { errors.push('ctx.' + name + ': ' + errText(error)) }
      for (const key of ['root', 'scope']) {
        let scope = null
        try { scope = ctx[key] } catch (error) { errors.push('ctx.' + key + ': ' + errText(error)) }
        if (!isObjLike(scope)) continue
        try { add(scope[name], 'ctx.' + key + '.' + name) } catch (error) { errors.push('ctx.' + key + '.' + name + ': ' + errText(error)) }
        if (typeof scope.get === 'function') {
          try { add(scope.get(name), 'ctx.' + key + '.get') } catch (error) { errors.push('ctx.' + key + '.get(' + name + '): ' + errText(error)) }
        }
      }
    }
  } catch (error) {
    errors.push('resolve ' + name + ': ' + errText(error))
  }
  const hit = hits.length ? hits[0] : null
  return { service: hit ? hit.value : null, via: hit ? hit.label : null, errors }
}

/** list() 的返回值折成数组：数组 / Map / Set / 可迭代 / 普通对象。 */
function toList(value) {
  try {
    if (Array.isArray(value)) return { items: value, shape: 'array' }
    if (value instanceof Map) return { items: Array.from(value.values()), shape: 'Map' }
    if (value instanceof Set) return { items: Array.from(value), shape: 'Set' }
    if (isObjLike(value) && typeof value[Symbol.iterator] === 'function') {
      return { items: Array.from(value), shape: 'iterable' }
    }
    if (value != null && typeof value === 'object') return { items: Object.values(value), shape: 'object' }
    return { items: [], shape: value === null ? 'null' : typeof value }
  } catch (error) {
    return { items: [], shape: 'convert-failed: ' + errText(error) }
  }
}

/** 读一个服务的清单；probe 里只记「异常形状」和错误，正常 array 不写（免得页面挂噪音）。 */
function readServiceList(ctx, name) {
  const probe = {}
  const resolved = resolveService(ctx, name)
  if (resolved.errors.length) probe[name + 'Error'] = resolved.errors.join(' | ')
  if (!resolved.service) {
    probe[name + 'Shape'] = 'unresolved'
    return { items: [], probe, service: null, via: null }
  }
  probe[name + 'Via'] = resolved.via
  let value = resolved.service
  if (typeof resolved.service.list === 'function') {
    try {
      value = resolved.service.list()
    } catch (error) {
      probe[name + 'Error'] = (probe[name + 'Error'] ? probe[name + 'Error'] + ' | ' : '') + 'list(): ' + errText(error)
      return { items: [], probe, service: resolved.service, via: resolved.via }
    }
  } else {
    probe[name + 'Shape'] = 'list is ' + typeof resolved.service.list
  }
  const converted = toList(value)
  if (converted.shape !== 'array' && !probe[name + 'Shape']) probe[name + 'Shape'] = converted.shape
  return { items: converted.items, known: ['array', 'Map', 'Set', 'iterable', 'object'].includes(converted.shape)
    && !(value && typeof value.then === 'function')
    && (typeof resolved.service.list === 'function' || converted.shape !== 'object'),
    probe, service: resolved.service, via: resolved.via }
}

/** 集群快照：宿主里所有活着的 agent（含子代理）与 shell 作业。 */
function cluster(ctx) {
  const out = { agents: [], jobs: { active: null, items: [] }, agentsKnown: false, probe: {} }
  let items = []
  try {
    const agentsRead = readServiceList(ctx, 'agents')
    out.agentsKnown = agentsRead.known === true
    items = agentsRead.items
    Object.assign(out.probe, agentsRead.probe)
  } catch (error) {
    out.probe.agentsError = errText(error)
  }

  const text = value => {
    if (value == null) return null
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
    try { return JSON.stringify(value).slice(0, 120) } catch { return null }
  }

  out.agents = items.map(agent => {
    try {
      const header = (agent && agent.session && agent.session.header) || {}
      const phase = (agent && agent.phase) || {}
      const model = agent && agent.model
      const modelName = typeof model === 'string' ? model
        : (model && typeof model.name === 'string' ? model.name : null)
      const cwd = typeof header.cwd === 'string' ? header.cwd : null
      return {
        id: String((agent && agent.id) || header.id || ''),
        depth: Number(header.delegationDepth == null ? 0 : header.delegationDepth),
        preset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
        phase: typeof phase.kind === 'string' ? phase.kind : 'unknown',
        turn: phase.turn == null ? null : phase.turn,
        step: phase.step == null ? null : phase.step,
        lastTurn: phase.lastTurn == null ? null : phase.lastTurn,
        model: modelName,
        parent: header.parentSession ? String(header.parentSession) : null,
        startedAt: typeof header.createdAt === 'string' ? header.createdAt : (typeof header.createdAt === 'number' ? new Date(header.createdAt).toISOString() : null),
        cwd,
      }
    } catch (error) {
      return { id: '', phase: 'unknown', error: String(error && error.message ? error.message : error) }
    }
  })
  out.counts = {
    total: out.agents.length,
    running: out.agents.filter(agent => agent.phase === 'running').length,
    idle: out.agents.filter(agent => agent.phase === 'idle').length,
  }

  try {
    const jobsRead = readServiceList(ctx, 'jobs')
    Object.assign(out.probe, jobsRead.probe)
    const jobsService = jobsRead.service
    if (jobsService && typeof jobsService.activeJobCount === 'function') {
      try {
        out.jobs.active = Number(jobsService.activeJobCount()) || 0
      } catch (error) {
        out.probe.jobsError = (out.probe.jobsError ? out.probe.jobsError + ' | ' : '') + 'activeJobCount(): ' + errText(error)
      }
    }
    out.jobs.items = jobsRead.items.slice(0, 30).map(job => ({
      id: String((job && (job.id || job.jobId)) || ''),
      owner: text(job && (job.sessionId || job.owner)),
      state: text(job && (job.state || job.status)),
    }))
  } catch (error) {
    out.probe.jobsError = (out.probe.jobsError ? out.probe.jobsError + ' | ' : '') + errText(error)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 8770 仿真对练台（voicetest/sparring/ui/server.py）
 * 它不属于 DSH 子代理体系，进程独立、PID 会变；这里只读它四个只读接口，
 * 归一化成驾驶舱能直接渲染的一份快照。任何上游失败只降级，绝不让页面 500。
 * ------------------------------------------------------------------ */
const DEFAULT_SPARRING = 'http://127.0.0.1:8770'
/** 单个上游请求上限。 */
const SPAR_TIMEOUT_MS = 2000
/** 整份快照上限：到点先出降级版，不把驾驶舱挂住。 */
const SPAR_DEADLINE_MS = 2500
const SPAR_PATHS = [
  ['health', '/api/health'],
  ['status', '/api/status'],
  ['train', '/api/train/status'],
  ['stats', '/api/stats'],
]
const SPAR_FALLBACK_BANNER = null

const msgOf = error => String(error && error.message ? error.message : error)

/** 数值一律过 Number 再判有限，unknown 保持 null，不写成 0。 */
const num = value => {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const nonEmpty = value => (typeof value === 'string' && value ? value : null)

const portOf = base => {
  try {
    return num(new URL(base).port)
  } catch {
    return null
  }
}

/** 一次上游 GET；超时、连不上、非 JSON 都折成 {ok:false,error}，绝不抛。 */
function sparringGet(base, path, timeoutMs) {
  return new Promise(resolve => {
    let url
    try {
      url = new URL(base + path)
    } catch (error) {
      resolve({ ok: false, error: 'bad upstream base for ' + path + ': ' + msgOf(error) })
      return
    }
    const mod = url.protocol === 'https:' ? https : http
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let req
    try {
      req = mod.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: { accept: 'application/json' },
      }, up => {
        if (up.statusCode !== 200) {
          up.resume()
          done({ ok: false, error: 'upstream HTTP ' + up.statusCode })
          return
        }
        const chunks = []
        up.on('data', chunk => chunks.push(chunk))
        up.on('error', error => done({ ok: false, error: msgOf(error) }))
        up.on('end', () => {
          let data
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch (error) {
            done({ ok: false, error: 'invalid JSON from ' + path + ': ' + msgOf(error) })
            return
          }
          if (data == null || typeof data !== 'object') {
            done({ ok: false, error: 'non-object JSON from ' + path })
            return
          }
          done({ ok: true, data })
        })
      })
    } catch (error) {
      done({ ok: false, error: msgOf(error) })
      return
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('timeout ' + path + ' after ' + timeoutMs + 'ms'), { code: 'ETIMEDOUT' }))
    })
    req.on('error', error => done({ ok: false, error: msgOf(error) }))
    req.end()
  })
}

/** 全挂时的固定形状（HTTP 仍 200）。 */
function sparringDown(base, port, error, checkedAt) {
  return {
    source: 'sparring',
    port,
    base,
    ok: false,
    checkedAt: checkedAt || new Date().toISOString(),
    banner: SPAR_FALLBACK_BANNER,
    runner: null,
    trainer: null,
    stats: null,
    warnings: [String(error)],
    error: String(error),
  }
}

async function sparring(base, port) {
  const checkedAt = new Date().toISOString()
  const warnings = []
  let timer = null
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), SPAR_DEADLINE_MS)
  })
  const collected = await Promise.race([
    Promise.all(SPAR_PATHS.map(([key, path]) =>
      sparringGet(base, path, SPAR_TIMEOUT_MS).then(result => [key, result]))),
    deadline,
  ])
  if (timer) clearTimeout(timer)

  const got = Object.create(null)
  if (Array.isArray(collected)) {
    for (const [key, result] of collected) got[key] = result
  } else {
    warnings.push('sparring upstream exceeded ' + SPAR_DEADLINE_MS + 'ms total budget; snapshot degraded')
  }
  for (const [key, path] of SPAR_PATHS) {
    const result = got[key]
    if (!result) {
      warnings.push(path + ': no response within ' + SPAR_DEADLINE_MS + 'ms')
      continue
    }
    if (!result.ok) warnings.push(path + ': ' + result.error)
  }

  const pick = key => (got[key] && got[key].ok ? got[key].data : null)
  const health = pick('health')
  const status = pick('status')
  const train = pick('train')
  const stats = pick('stats')
  const ok = !!(health && health.ok === true)

  const runner = status ? {
    state: nonEmpty(status.state),
    runId: status.run_id == null ? null : String(status.run_id),
    scenario: status.scenario == null ? null : String(status.scenario),
    elapsed: num(status.elapsed),
    maxSeconds: num(status.max_seconds),
    callsDone: num(status.calls_done),
    callsBudget: num(status.calls_budget),
    rounds: num(status.rounds),
    roundsCurrent: num(status.rounds_current),
  } : null

  const trainer = train ? {
    state: nonEmpty(train.state),
    stageIndex: num(train.stage_index),
    ledgerRounds: num(train.ledger_rounds),
    ledgerMaxRound: num(train.ledger_max_round),
    elapsed: num(train.elapsed),
  } : null

  const cost = stats && stats.cost && typeof stats.cost === 'object' ? stats.cost : null
  const statsOut = stats ? {
    rounds: num(stats.rounds),
    calls: num(stats.calls),
    scenarios: num(stats.scenarios),
    prompts: num(stats.prompts),
    // 单价没拿到就不许写金额：只有上游明确说 unknown===false 才当已知。
    costUnknown: !(cost && cost.unknown === false),
    costNote: cost ? nonEmpty(cost.note) : null,
  } : null

  return {
    source: 'sparring',
    port,
    base,
    ok,
    checkedAt,
    banner: health ? nonEmpty(health.banner) : null,
    runner,
    trainer,
    stats: statsOut,
    warnings,
    error: ok ? null : (warnings.length ? warnings[0] : 'sparring upstream unavailable'),
  }
}

function forward(base, rest, method, res) {
  let url
  try {
    url = new URL(base + '/orchestrator/api' + rest)
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'bad api base' }))
    return
  }
  const mod = url.protocol === 'https:' ? https : http
  const req = mod.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method,
    headers: { 'x-orchestrator-request': '1', accept: 'application/json' },
  }, up => {
    const chunks = []
    up.on('data', chunk => chunks.push(chunk))
    up.on('error', fail)
    up.on('end', () => {
      if (res.writableEnded) return
      res.writeHead(up.statusCode ?? 502, {
        'content-type': up.headers['content-type'] ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(Buffer.concat(chunks))
    })
  })
  const fail = error => {
    if (res.writableEnded) return
    const timeout = error?.code === 'ETIMEDOUT' || /timeout/i.test(String(error?.message ?? ''))
    res.writeHead(timeout ? 504 : 502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: timeout ? 'superagent timeout' : 'superagent unreachable' }))
  }
  req.setTimeout(TIMEOUT_MS, () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })) })
  req.on('error', fail)
  req.end()
}

function serviceBase(input, fallback) {
  try {
    const url = new URL(String(input ?? fallback))
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) return null
    return url.href.replace(/\/+$/, '')
  } catch { return null }
}

export function apply(ctx, config) {
  const base = serviceBase(config?.api, 'http://127.0.0.1:3082')
  const fleetBase = serviceBase(config?.fleet, 'http://127.0.0.1:3090')
  const sparBase = serviceBase(config?.sparring, DEFAULT_SPARRING)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'read-only proxy: GET or HEAD only' }))
        return
      }
      const raw = String(req.url ?? '')
      const rest = (raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw) || '/'
      const path = rest.split('?')[0].replace(/^\/+/, '')
      const validResource = /^(?:state|overview|sources|decisions|tickets|threads)(?:\/[a-zA-Z0-9_-]+)?$/.test(path)
      if (path === 'settings') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ api: base }))
        return
      }
      if (path === 'fleet') {
        if (!fleetBase) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'invalid local fleet address' }))
          return
        }
        sparringGet(fleetBase, '/fleet', TIMEOUT_MS).then(result => {
          if (res.writableEnded) return
          res.writeHead(result.ok ? 200 : 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result.ok ? result.data : { error: 'fleet unavailable' }))
        })
        return
      }
      if (path === 'superagents') {
        const body = JSON.stringify(masterState(config))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
        return
      }
      if (path === 'cluster') {
        let body
        try {
          body = JSON.stringify(cluster(ctx))
        } catch (error) {
          body = JSON.stringify({ error: String(error && error.message ? error.message : error) })
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
        return
      }
      if (path === 'sparring') {
        // 上游基址可配置：默认 8770，测试用 config.sparring 指向坏端口验证降级。
        const sparPort = portOf(sparBase)
        const send = body => {
          if (res.writableEnded) return
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        if (!sparBase) return send(sparringDown(null, null, 'invalid local sparring address'))
        sparring(sparBase, sparPort).then(send, error => send(sparringDown(sparBase, sparPort, msgOf(error))))
        return
      }
      if (!validResource || !ALLOW.has(path.split('/')[0])) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'not in read-only allowlist', path }))
        return
      }
      if (!base) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'invalid local SuperAgent address' }))
        return
      }
      forward(base, rest, req.method, res)
    },
  }), 'dsh-superagent-cockpit: read-only api proxy')
}
