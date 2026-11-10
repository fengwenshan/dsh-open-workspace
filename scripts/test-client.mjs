// 客户端插件的无依赖冒烟测试：用 mock DOM / mock 宿主服务把 lib/client.js 真跑一遍。
// 目的：插件改动（尤其是侧边栏展开滚动）回归时，能在本地/CI 前就发现，而不是等用户点开。
//
// 运行：node scripts/test-client.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeRow(key, text, expanded) {
  return {
    key,
    textContent: text,
    expanded,
    scrolls: [],
    clicks: 0,
    getAttribute(name) {
      return name === 'aria-expanded' ? String(this.expanded) : null
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
 * 构造一次插件运行环境。
 * @param {{ phase?: string, domMode?: 'group' | 'flat', request?: object | null }} options
 */
function boot(options = {}) {
  const { phase = 'ready', domMode = 'group', request = { requestId: 'r1', path: '/x/xhfjmsq-layui' } } = options
  let pendingRequest = request

  const workspaceRows = [
    makeRow('workspace:aaa', 'monorepo-app', true),
    makeRow('workspace:bbb', 'xhfjmsq-layui（西湖风景名胜区）', false),
  ]
  const sessionRow = {
    scrolls: [],
    scrollIntoView(options) {
      this.scrolls.push(options?.block)
    },
  }

  // 可选：把行挂进一个滚动容器，验证「停在可视区偏上 18%」的定位算法
  const scroller =
    options.scroller === true
      ? {
          scrollTop: 0,
          clientHeight: 500,
          scrollHeight: 2000,
          parentElement: null,
          getBoundingClientRect: () => ({ top: 100 }),
        }
      : null
  if (scroller !== null) {
    for (const row of [...workspaceRows, sessionRow]) row.parentElement = scroller
    workspaceRows[1].getBoundingClientRect = () => ({ top: 700 })
    sessionRow.getBoundingClientRect = () => ({ top: 760 })
  }

  const document = {
    querySelectorAll(selector) {
      if (selector.includes('workspace:') && domMode === 'group') return workspaceRows
      return []
    },
    querySelector(selector) {
      if (selector.includes('aria-selected="true"') && domMode === 'group') return sessionRow
      if (selector.includes('aria-selected="true"') && domMode === 'flat') return sessionRow
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
  if (scroller !== null) sandbox.window.getComputedStyle = () => ({ overflowY: 'auto' })
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
  const effectCleanups = []
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
      effectCleanups.push(fn())
    },
  }

  const exports = loaded.factory(() => {
    throw new Error('插件不应 require 其他模块')
  })
  exports.apply(ctx)

  return {
    workspaceRows,
    sessionRow,
    scroller,
    opened,
    created,
    intervalCallbacks,
    effectCleanups,
  }
}

async function flush(ms = 120) {
  await sleep(ms)
}

// 1) 正常情况：就绪 → 消费请求 → 打开工作区 → 侧边栏展开 + 滚动到新会话
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
  assert.deepEqual(state.sessionRow.scrolls, ['nearest'], '新会话行应滚进视野')
}

// 2) 请求只会被消费一次：第二次轮询不应重复创建/打开
{
  const state = boot()
  state.intervalCallbacks[0]()
  await flush()
  state.intervalCallbacks[0]()
  await flush()
  assert.equal(state.created.length, 1, '请求不应重复消费')
}

// 3) 工作区列表未就绪：先不消费请求
{
  const state = boot({ phase: 'loading' })
  state.intervalCallbacks[0]()
  await flush()
  assert.equal(state.created.length, 0, '未就绪时不应打开工作区')
}

// 4) 单列表视图没有工作区行：仍要滚动到当前会话行
{
  const state = boot({ domMode: 'flat' })
  state.intervalCallbacks[0]()
  await flush()
  assert.deepEqual(state.sessionRow.scrolls, ['nearest'], '单列表视图应滚动到当前会话')
}

// 5) 没有待处理请求：不做任何动作
{
  const state = boot({ request: null })
  state.intervalCallbacks[0]()
  await flush()
  assert.equal(state.created.length, 0)
}

// 6) 分组视图 + 滚动容器：会话行应停在可视区上方 18% 处（不是贴底）
{
  const state = boot({ scroller: true })
  state.intervalCallbacks[0]()
  await flush(400)
  // 会话行距滚动区顶 760-100=660，可视高 500 → 目标 scrollTop = 660 - 500*0.18 = 570
  assert.equal(state.scroller.scrollTop, 570, '会话行应停在可视区偏上位置')
}

// 7) 单列表视图 + 滚动容器：同样定位到偏上位置
{
  const state = boot({ domMode: 'flat', scroller: true })
  state.intervalCallbacks[0]()
  await flush(300)
  assert.equal(state.scroller.scrollTop, 570, '单列表视图也应停在可视区偏上位置')
}

console.log('test-client: 7 组用例全部通过')
