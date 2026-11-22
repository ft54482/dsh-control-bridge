/**
 * Session model state, availability and the one session-scoped setter.
 *
 * The Desktop keeps four different things that must not be conflated:
 *   - the deployment default (`agentDefaultModel.currentSelection()`),
 *   - the selection recorded by the last request (`request/header` event),
 *   - a later selection waiting for the next request (`model/selection` event),
 *   - the selection the live Agent will actually use on the next step.
 *
 * A default is never a Session's selection. When the Session recorded nothing,
 * the answer is `unknown`, not the default.
 */

const ID = /^[^\s]{1,200}$/

/** Build a selection from a request header config or a model/selection payload. */
export function selectionOf(value) {
  if (!value || typeof value !== 'object') return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!ID.test(provider) || !ID.test(model)) return null
  const selection = { provider, model }
  if (typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim()) {
    selection.reasoningEffort = value.reasoningEffort.trim()
  }
  return selection
}

/** Whether two selections name the same route (effort is not part of the route). */
export function sameRoute(left, right) {
  return Boolean(left && right && left.provider === right.provider && left.model === right.model)
}

/**
 * Whether two selections are the same recorded choice. The official projection
 * compares provider, model, and reasoning effort; effort is part of the identity
 * even though it is not part of the route.
 */
export function sameSelection(left, right) {
  return Boolean(left && right && sameRoute(left, right) && (left.reasoningEffort || '') === (right.reasoningEffort || ''))
}

/**
 * Fold the model state out of one Session log.
 *
 * `request/header` is the only durable record of what a request actually used,
 * so it is `lastUsed`; a `model/selection` appended after it is still pending.
 * The official projection retires pending only when a request header records the
 * *same* selection; a different later header leaves the pending choice intact.
 * @param events - Session events in seq order.
 */
export function modelStateFromEvents(events) {
  let lastUsed = null
  let lastExecution = null
  let lastHeaderSeq = -1
  let pending = null
  let pendingSeq = -1
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    const seq = Number.isFinite(event.seq) ? event.seq : -1
    if (event.type === 'request/header') {
      const chosen = selectionOf(event.data && event.data.header && event.data.header.config)
      if (chosen) {
        lastUsed = chosen
        lastExecution = chosen
        lastHeaderSeq = seq
      }
    } else if (event.type === 'model/selection') {
      const chosen = selectionOf(event.data)
      if (chosen) {
        pending = chosen
        pendingSeq = seq
      }
    }
  }
  // A pending choice is retired only once a later request recorded that same
  // choice. A matching header that predates the selection does not retire it.
  if (pending && lastHeaderSeq > pendingSeq && sameSelection(pending, lastExecution)) pending = null
  return {
    lastUsed,
    pending,
    next: pending || lastUsed,
    lastExecution,
    last_header_seq: lastHeaderSeq,
    pending_seq: pending ? pendingSeq : -1,
  }
}

/** Model state from a list row's wire projection, used when no log was read. */
export function modelStateFromProjection(row) {
  const values = (row && row.projections && row.projections.values) || {}
  const selection = values.modelSelection
  if (!selection || typeof selection !== 'object') {
    return { lastUsed: null, pending: null, next: null, lastExecution: null, last_header_seq: -1 }
  }
  const lastUsed = selectionOf(selection.lastUsed)
  const next = selectionOf(selection.next)
  const pending = next && lastUsed && sameRoute(next, lastUsed) ? null : next
  return { lastUsed, pending, next: next || lastUsed, lastExecution: lastUsed, last_header_seq: -1 }
}

/** The request header recorded inside one turn, i.e. what that turn really ran. */
export function executionModelForTurn(events, turn) {
  if (!turn || !turn.start) return null
  const stop = turn.end ? turn.end.seq : Number.POSITIVE_INFINITY
  let found = null
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'request/header') continue
    if (!(event.seq > turn.start.seq && event.seq < stop)) continue
    const chosen = selectionOf(event.data && event.data.header && event.data.header.config)
    if (chosen) found = chosen
  }
  return found
}

/** Read the live Agent for one Session, if any. */
export function liveAgent(ctx, sessionId) {
  if (!ctx || !ctx.agents || typeof ctx.agents.get !== 'function') return null
  try {
    return ctx.agents.get(sessionId) || null
  } catch {
    return null
  }
}

/** Read the selection the live Agent would use on its next step. */
export function agentSelection(agent) {
  if (!agent || !agent.model || typeof agent.model.current !== 'function') return null
  try {
    return selectionOf(agent.model.current())
  } catch {
    return null
  }
}

function configOf(selection) {
  const config = { provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort) config.reasoningEffort = selection.reasoningEffort
  return config
}

/**
 * Check a selection against the live adapter registry, then let the adapter
 * itself validate the call config. The second step is what turns a missing
 * adapter into a pre-send refusal instead of a NO_ADAPTER mid-turn.
 * @returns `{ available, reason, detail }`; `reason` is `no_adapter` for a route
 *   without a registered adapter.
 */
export async function checkSelection(ctx, selection) {
  if (!selection) return { available: false, reason: 'unknown_model', detail: 'no model selection' }
  const llm = ctx && ctx.llm
  if (!llm || typeof llm.listProviders !== 'function') {
    return { available: false, reason: 'llm_unavailable', detail: 'the llm service is not mounted' }
  }
  let providers
  try {
    providers = llm.listProviders()
  } catch (error) {
    return { available: false, reason: 'provider_list_failed', detail: String(error && error.message || error) }
  }
  if (!Array.isArray(providers) || !providers.some((provider) => provider && provider.id === selection.provider)) {
    return {
      available: false,
      reason: 'no_adapter',
      detail: `no adapter registered for provider "${selection.provider}"`,
    }
  }
  if (typeof llm.listModels === 'function') {
    try {
      const models = await llm.listModels(selection.provider)
      if (Array.isArray(models) && !models.some((model) => model && model.id === selection.model)) {
        return {
          available: false,
          reason: 'model_not_advertised',
          detail: `provider "${selection.provider}" does not advertise model "${selection.model}"`,
        }
      }
    } catch (error) {
      return { available: false, reason: 'model_list_failed', detail: String(error && error.message || error) }
    }
  }
  if (typeof llm.resolveCallConfig === 'function') {
    try {
      await llm.resolveCallConfig(configOf(selection))
    } catch (error) {
      const code = typeof error.code === 'string' ? error.code : 'call_config_rejected'
      return {
        available: false,
        reason: code === 'NO_ADAPTER' ? 'no_adapter' : 'call_config_rejected',
        detail: String(error && error.message || error),
      }
    }
  }
  return { available: true, reason: null, detail: null }
}

/**
 * Record one selection on the live Agent only. The official controller method
 * also saves the deployment default, which this bridge must not do.
 * @returns `{ ok, confirmed, reason }`.
 */
export function selectOnAgent(agent, selection) {
  if (!agent || !agent.model) return { ok: false, reason: 'agent_not_attached' }
  if (typeof agent.model.select !== 'function') return { ok: false, reason: 'select_unsupported' }
  try {
    agent.model.select(selection)
  } catch (error) {
    return { ok: false, reason: 'select_failed', detail: String(error && error.message || error) }
  }
  const confirmed = agentSelection(agent)
  if (!sameSelection(confirmed, selection)) {
    return { ok: false, reason: 'readback_mismatch', confirmed }
  }
  return { ok: true, confirmed }
}

/** True when the Agent is not in the middle of a turn. */
export function agentIdle(agent) {
  if (!agent) return true
  const status = agent.status
  return status !== 'running'
}

function normalizeModel(model) {
  if (!model) return null
  if (typeof model === 'string') {
    return { id: model, name: model, reasoning_efforts: null, reasoning_efforts_source: 'unknown', input_modalities: null }
  }
  const id = model.id || model.model || model.name
  if (!id) return null
  const rawEfforts = model.reasoningEfforts ?? model.reasoning_efforts ?? null
  const efforts = Array.isArray(rawEfforts)
    ? rawEfforts.map((entry) => (typeof entry === 'string' ? entry : (entry && (entry.id || entry.value || entry.name)) || null)).filter(Boolean)
    : null
  return {
    id: String(id),
    name: String(model.name || model.label || id),
    reasoning_efforts: efforts,
    reasoning_efforts_source: efforts ? 'official' : 'unknown',
    input_modalities: Array.isArray(model.inputModalities) ? model.inputModalities : null,
  }
}

/**
 * List the registered provider/model routes and the reasoning efforts each one
 * advertises. Official builds that do not enumerate efforts are reported as
 * `reasoning_efforts: null` with source `unknown`; nothing is hard-coded.
 */
export async function modelCatalog(ctx) {
  const llm = ctx && ctx.llm
  if (!llm || typeof llm.listProviders !== 'function') {
    return { ok: false, reason: 'llm_unavailable', providers: [], effort_source: 'unavailable' }
  }
  let providers
  try {
    providers = await llm.listProviders()
  } catch (error) {
    return { ok: false, reason: 'provider_list_failed', detail: String(error && error.message || error), providers: [], effort_source: 'unavailable' }
  }
  const rows = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerId = provider && (provider.id || provider.provider)
    if (!providerId) continue
    let models = []
    try {
      models = typeof llm.listModels === 'function' ? await llm.listModels(providerId) : []
    } catch (error) {
      rows.push({ provider: String(providerId), name: provider.name || null, models: [], error: 'model_list_failed', detail: String(error && error.message || error) })
      continue
    }
    const normalised = []
    for (const raw of Array.isArray(models) ? models : []) {
      const model = normalizeModel(raw)
      if (!model) continue
      // The official adapter only exposes reasoning capabilities through
      // resolveModelInfo(); listModels() has no reasoning field.
      if (!model.reasoning_efforts && typeof llm.resolveModelInfo === 'function') {
        try {
          const info = await llm.resolveModelInfo(providerId, model.id)
          const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts)
            ? info.reasoning.efforts.map((effort) => (typeof effort === 'string' ? effort : (effort && (effort.id || effort.value)) || null)).filter(Boolean)
            : null
          if (efforts) {
            model.reasoning_efforts = efforts
            model.reasoning_efforts_source = 'official'
            if (info.reasoning.defaultEffort) model.default_reasoning_effort = String(info.reasoning.defaultEffort)
          }
        } catch { /* capability lookup is advisory; the route stays unknown */ }
      }
      if (raw && raw.description) model.description = String(raw.description)
      normalised.push(model)
    }
    rows.push({
      provider: String(providerId),
      name: (provider && (provider.name || provider.label)) || null,
      models: normalised,
    })
  }
  return {
    ok: true,
    source: 'official_llm',
    effort_source: rows.some((row) => row.models.some((model) => model.reasoning_efforts)) ? 'official' : 'unknown',
    providers: rows,
  }
}

/**
 * Look up one route in the catalog. `efforts` is null when the deployment does
 * not enumerate them, which means a caller must not reject an effort value.
 */
export async function effortSupport(ctx, selection) {
  if (!selection) return { known: false, efforts: null, reason: 'no_selection' }
  const catalog = await modelCatalog(ctx)
  if (!catalog.ok) return { known: false, efforts: null, reason: catalog.reason }
  const provider = catalog.providers.find((row) => row.provider === selection.provider)
  if (!provider) return { known: false, efforts: null, reason: 'provider_not_registered' }
  const model = provider.models.find((row) => row.id === selection.model)
  if (!model) return { known: false, efforts: null, reason: 'model_not_advertised' }
  return { known: Array.isArray(model.reasoning_efforts), efforts: model.reasoning_efforts }
}
