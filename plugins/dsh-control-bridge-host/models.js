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
 * Fold the model state out of one Session log.
 *
 * `request/header` is the only durable record of what a request actually used,
 * so it is `lastUsed`; a `model/selection` appended after it is still pending.
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
  // A pending choice is retired once a matching (or any later) request was recorded.
  if (pending && pendingSeq < lastHeaderSeq) pending = null
  return {
    lastUsed,
    pending,
    next: pending || lastUsed,
    lastExecution,
    last_header_seq: lastHeaderSeq,
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
  if (!sameRoute(confirmed, selection)) {
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
