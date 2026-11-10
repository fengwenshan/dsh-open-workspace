// 客户端插件的无依赖冒烟测试：用 mock DOM / mock 宿主服务把 lib/client.js 真跑一遍。
// 目的：插件改动（展开分组、滚动定位）回归时能在本地就发现，而不是等用户点开才发现。
//
// 运行：node scripts/test-client.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeRow(key, text, expanded, rectTop = 100) {
  return {
    key,
    textContent: text,
    expanded,
    style: {},
    scrolls: [],
    clicks: 0,
    getAttribute(name) {
      return name === 'aria-expanded' ? String(this.expanded) : null
    },
    getBoundingClientRect() {
      return { top: rectTop, bottom: rectTop + 28 }
    },
    scrollIntoView(options) {
      this.scrolls.push(options?.block)
    },
    click() {
      this.clicks += 1
      this.expanded = !this.expanded
    },
  }
}

/**
 * 启动一次插件运行环境。
 * @param {{ phase?: string, domMode?: 'group' | 'flat' | 'group-no-session', request?: object | null, sessionTop?: number, viewport?: number }} options
 */
function boot(options = {}) {
  const { phase = 'ready', domMode = 'group', sessionTop = 100, workspaceTop = 100 } = options
  let pendingRequest =
    options.request === undefined ? { requestId: 'r1', path: '/x/xhfjmsq-layui' } : options.request

  const workspaceRows = [
    makeRow('workspace:aaa', 'monorepo-app', true),
    makeRow('workspace:bbb', 'xhfjmsq-layui（西湖风景名胜区）', false, workspaceTop),
  ]
  const sessionRow = makeRow('session:new', '新建会话', false, sessionTop)
  const sessionRowVisible = domMode !== 'group-no-session'

  const document = {
    querySelectorAll(selector) {
      if (selector.includes('workspace:') && domMode !== 'flat') return workspaceRows
      return []
    },
    querySelector(selector) {
      if (selector.includes('aria-selected="true"') && sessionRowVisible) return sessionRow
      return null
    },
  }

  const intervalCallbacks = []
  const sandbox = {
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval: (fn) => {
      intervalCallbacks.push(fn)
      return intervalCallbacks.length
    },
    clearInterval: () => {},
    fetch: async () => {
      const pending = pendingRequest
      pendingRequest = null
      return { ok: true, json: async () => ({ request: pending ?? null }) }
    },
    document,
  }
  sandbox.window = {}
  if (typeof options.viewport === 'number') sandbox.window.innerHeight = options.viewport
  sandbox.window.__ModuleLoader__ = {
    load(module) {
      sandbox.loadedModule = module
    },
  }

  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client.js' })

  const loaded = sandbox.loadedModule
  assert.ok(loaded, '插件没有调用 __ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-open-workspace')

  const opened = []
  const created = []
  const ctx = {
    workspaces: {
      list: { getSnapshot: () => ({ phase }) },
      create: async (input) => {
        created.push(input.path)
        return { workspaceId: 'ws-1', path: input.path }
      },
    },
    uiWorkspace: {
      openWorkspace: async (workspaceId) => {
        opened.push(workspaceId)
      },
    },
    effect: (fn) => {
      fn()
    },
  }

  const exports = loaded.factory(() => {
    throw new Error('插件不应 require 其他模块')
  })
  exports.apply(ctx)

  return { workspaceRows, sessionRow, opened, created, intervalCallbacks }
}

async function flush(ms = 120) {
  await sleep(ms)
}

// 1) 正常：消费请求 → 打开工作区 → 展开折叠分组 → 把新会话行滚到偏上位置
{
  const state = boot()
  assert.equal(state.intervalCallbacks.length, 1, '应只起一个轮询定时器')
  state.intervalCallbacks[0]()
  await flush(400)
  assert.deepEqual(state.created, ['/x/xhfjmsq-layui'], '应按目录创建/复用工作区')
  assert.deepEqual(state.opened, ['ws-1'], '应打开对应工作区')
  const row = state.workspaceRows[1]
  assert.equal(row.expanded, true, '折叠的工作区行应被展开')
  assert.equal(row.clicks, 1, '应只点击一次工作区行')
  assert.deepEqual(row.scrolls, ['start'], '工作区行应滚到偏上位置')
  assert.equal(row.style.scrollMarginTop, '64px', '应留出顶部偏移')
  assert.deepEqual(state.sessionRow.scrolls, [], '会话行已露出来时不应再滚')
}

// 2) 请求只消费一次：第二次轮询不重复创建/打开
{
  const state = boot()
  state.intervalCallbacks[0]()
  await flush(400)
  state.intervalCallbacks[0]()
  await flush(400)
  assert.equal(state.created.length, 1, '请求不应重复消费')
}

// 3) 工作区列表未就绪：不消费请求
{
  const state = boot({ phase: 'loading' })
  state.intervalCallbacks[0]()
  await flush()
  assert.equal(state.created.length, 0, '未就绪时不应打开工作区')
}

// 4) 单列表视图没有工作区行：仍定位当前会话行
{
  const state = boot({ domMode: 'flat' })
  state.intervalCallbacks[0]()
  await flush(400)
  assert.deepEqual(state.sessionRow.scrolls, ['start'], '单列表视图应滚到当前会话')
}

// 5) 没有待处理请求：不做任何动作
{
  const state = boot({ request: null })
  state.intervalCallbacks[0]()
  await flush()
  assert.equal(state.created.length, 0)
}

// 6) 展开后会话行还没渲染出来：退回定位工作区行
{
  const state = boot({ domMode: 'group-no-session' })
  state.intervalCallbacks[0]()
  await flush(1000)
  const row = state.workspaceRows[1]
  assert.deepEqual(row.scrolls, ['start'], '没有会话行时应定位工作区行')
}

// 7) start 不生效（行还在视口下半部）：退回 center，保证至少能滚
{
  const state = boot({ viewport: 800, workspaceTop: 700 })
  state.intervalCallbacks[0]()
  await flush(800)
  assert.deepEqual(state.workspaceRows[1].scrolls, ['start', 'center'], 'start 无效时应退回 center')
}

console.log('test-client: 7 组用例全部通过')
