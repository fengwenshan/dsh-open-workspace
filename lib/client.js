window.__ModuleLoader__.load({
  id: 'dsh-open-workspace',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const POLL_INTERVAL_MS = 400
    const READY_TIMEOUT_MS = 60 * 1000
    const REVEAL_POLL_MS = 100
    const REVEAL_TIMEOUT_MS = 3000

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    /** workspaces 列表就绪前不消费请求：启动恢复期抢先打开会被后续恢复覆盖 */
    function workspacesReady(ctx) {
      try {
        return ctx.workspaces.list.getSnapshot().phase === 'ready'
      } catch {
        return false
      }
    }


    /** 目录名当侧边栏里的工作区标题用（工作区没被改过标题时就是它） */
    function workspaceLabel(path) {
      return String(path || '')
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() || ''
    }

    /** 定位后让目标行停在滚动区偏上的位置（可视高度的 18%），而不是贴着底部 */
    const REVEAL_TOP_RATIO = 0.18

    /** 找元素最近的纵向滚动容器 */
    function findScroller(el) {
      for (let node = el.parentElement; node; node = node.parentElement) {
        let overflowY = ''
        try {
          const style = window.getComputedStyle ? window.getComputedStyle(node) : null
          overflowY = style ? style.overflowY : ''
        } catch {
          overflowY = ''
        }
        if (
          (overflowY === 'auto' || overflowY === 'scroll') &&
          node.scrollHeight > node.clientHeight + 4
        ) {
          return node
        }
      }
      return null
    }

    /** 把行滚到可视区偏上的位置；拿不到滚动容器就退回 scrollIntoView */
    function revealRow(row) {
      const scroller = findScroller(row)
      if (scroller === null) {
        row.scrollIntoView({ block: 'nearest' })
        return
      }
      const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      const target = scroller.scrollTop + offset - scroller.clientHeight * REVEAL_TOP_RATIO
      scroller.scrollTop = Math.max(0, target)
    }

    async function waitForRow(find, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = find()
        if (found) return found
        await sleep(REVEAL_POLL_MS)
      }
      return null
    }

    const workspaceRows = () => Array.from(document.querySelectorAll('[data-row-key^="workspace:"]'))
    const currentSessionRow = () =>
      document.querySelector('[data-row-key^="session:"][aria-selected="true"]')

    /**
     * 侧边栏不会因为「外部打开工作区」自动展开分组、也不会滚动定位到它，
     * 这里补上：折叠着就先点开 → 把当前会话行（没有就工作区行）滚到偏上位置。
     * DOM 结构来自 dsh-client-ui-workspace：workspace:<key> / session:<id> 行、
     * role=treeitem、aria-expanded / aria-selected。找不到就安静跳过。
     */
    async function revealInSidebar(path) {
      const label = workspaceLabel(path)
      const findWorkspaceRow = () => {
        const all = workspaceRows()
        return (
          all.find((el) => (el.textContent || '').trim() === label) ||
          (label ? all.find((el) => (el.textContent || '').includes(label)) : undefined)
        )
      }

      const deadline = Date.now() + REVEAL_TIMEOUT_MS
      let row = null
      while (Date.now() < deadline) {
        row = findWorkspaceRow() ?? null
        if (row) break
        // 这个视图里根本没有工作区行（单列表 / 工作区被改名）：直接定位当前会话行
        if (workspaceRows().length === 0) {
          const selected = currentSessionRow()
          if (selected) {
            revealRow(selected)
            return true
          }
        }
        await sleep(REVEAL_POLL_MS)
      }
      if (!row) return false

      if (row.getAttribute('aria-expanded') === 'false') {
        row.click()
        await sleep(150)
      }

      // 展开后会话行才会渲染出来；等不到就退回定位工作区行
      const selected = await waitForRow(currentSessionRow, 600)
      revealRow(selected ?? row)
      return true
    }
    async function handleRequest(ctx, request) {
      // create 是幂等的：目录已有工作区就返回已有的，没有就新建
      const workspace = await ctx.workspaces.create({ path: request.path })
      // 和 DSH 自己「添加工作区 → 打开空白新会话」一致：复用/创建空白会话并聚焦
      await ctx.uiWorkspace.openWorkspace(workspace.workspaceId)
      // 打开后侧边栏补一次展开 + 滚动定位，让用户一眼看到是哪个工作区
      await revealInSidebar(request.path).catch(() => false)
      return workspace
    }

    function apply(ctx) {
      let busy = false
      let disposed = false
      const startedAt = Date.now()

      async function tick() {
        if (disposed || busy) return
        if (!workspacesReady(ctx)) {
          // 启动后迟迟没 ready 就放弃本轮（等下一次页面刷新再说）
          if (Date.now() - startedAt > READY_TIMEOUT_MS) disposed = true
          return
        }
        busy = true
        try {
          const response = await fetch('/dsh-open-workspace/poll', { cache: 'no-store' })
          if (response.ok) {
            const payload = await response.json()
            const request = payload && payload.request
            if (request && request.path) {
              await handleRequest(ctx, request)
              console.info('[dsh-open-workspace] 已打开工作区:', request.path)
            }
          }
        } catch (error) {
          console.warn('[dsh-open-workspace]', error)
        } finally {
          busy = false
        }
      }

      ctx.effect(() => {
        const timer = setInterval(tick, POLL_INTERVAL_MS)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, 'dsh-open-workspace: poll')
    }

    exports.apply = apply
    exports.inject = ['workspaces', 'uiWorkspace']

    return exports
  },
})
