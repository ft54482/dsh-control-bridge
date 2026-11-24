import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const prefix = '/@dsh-superagent-cockpit/api'

// Exercise the registered Harness panel, its real fetch paths and its text
// rendering. Hook and slot stand-ins keep these checks offline.
async function renderPanel(responses) {
  const state = []
  const effects = []
  let cursor = 0
  let bundle
  let page
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const i = cursor++
      if (!(i in state)) state[i] = initial
      return [state[i], value => { state[i] = value }]
    },
    useCallback: fn => fn,
    useEffect: fn => effects.push(fn),
    useRef: initial => ({ current: initial }),
  }
  vm.runInNewContext(source, {
    URL,
    setInterval: () => 1,
    clearInterval: () => {},
    window: { __ModuleLoader__: { load: value => { bundle = value } } },
    async fetch(url) {
      assert.ok(url.startsWith(prefix))
      const key = url.slice(prefix.length)
      const ok = Object.hasOwn(responses, key)
      return { ok, status: ok ? 200 : 404, json: async () => responses[key] }
    },
  })
  const ctx = {
    effect: fn => fn(),
    slots: {
      inject: (_, fn) => fn(),
      register(entry, component) {
        if (entry.name === 'main') page = component
      },
    },
  }
  function text(node) {
    if (node == null || node === false) return ''
    if (Array.isArray(node)) return node.map(text).join(' ')
    if (typeof node !== 'object') return String(node)
    if (typeof node.type === 'function') return text(node.type(node.props))
    return node.type === 'style' ? '' : text(node.children)
  }
  bundle.factory(() => react).apply(ctx)
  text(page({}))
  for (const effect of effects.splice(0)) effect()
  await new Promise(resolve => setImmediate(resolve))
  cursor = 0
  return text(page({})).replace(/\s+/g, ' ')
}

test('registered tasks, Harness sessions and per-engine occupancy are independent', async () => {
  const instance = {
    id: '3084', port: 3084, label: 'Synthetic engine', ok: true,
    state: {}, overview: { executor: { running: 0, maxWorkers: 4, queued: 0 } }, tickets: { items: [] },
  }
  const sample = {
    '/fleet': { instances: [instance] },
    '/superagents': { ok: true, maxWorkers: 10, agents: Array.from({ length: 5 }, (_, i) => ({
      id: 'sample-' + i, lane: i + 1, title: 'Synthetic lane ' + (i + 1), status: i % 2 ? 'working' : 'auditing',
    })) },
  }
  const unknown = await renderPanel(sample)
  for (const value of ['5/10', 'Synthetic lane 5', 'Synthetic engine', '0/4', 'Harness 运行中会话 —']) {
    assert.ok(unknown.includes(value), value)
  }
  const live = await renderPanel({
    ...sample,
    '/cluster': { agentsKnown: true, agents: [{ phase: 'running' }], counts: { total: 1, running: 1 }, jobs: { active: 0, items: [] } },
  })
  assert.ok(live.includes('Harness 运行中会话 1'))
  assert.ok(live.includes('0/4'))
})

test('unavailable data sources leave counts unknown', async () => {
  const output = await renderPanel({})
  assert.ok(output.includes('登记表未知'))
  assert.ok(output.includes('Harness 运行中会话 —'))
  assert.ok(!output.includes('0/4'))
})
