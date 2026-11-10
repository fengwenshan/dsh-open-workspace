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

    /** 定位后让目标行停在离滚动区顶部这个像素数的位置（偏上，不贴底也不居中） */
    const REVEAL_TOP_OFFSET_PX = 64

    /** 记录最近一次打开的 DOM 诊断，写到 $DSH_HOME/open-workspace-debug.json，方便排查 */
    let debugSteps = []

    function rowSnapshot(row) {
      if (!row) return null
      const rect = row.getBoundingClientRect()
      const scrollers = []
      for (let node = row.parentElement; node && scrollers.length < 5; node = node.parentElement) {
        let overflowY = ''
        try {
          const style = window.getComputedStyle ? window.getComputedStyle(node) : null
          overflowY = style ? style.overflowY : ''
        } catch {
          overflowY = ''
        }
        if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
          scrollers.push({
            tag: node.tagName,
            cls: String(node.className || '').slice(0, 80),
            scrollTop: Math.round(node.scrollTop),
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
          })
        }
      }
      return {
        key: row.getAttribute ? row.getAttribute('data-row-key') : null,
        text: (row.textContent || '').trim().slice(0, 40),
        expanded: row.getAttribute ? row.getAttribute('aria-expanded') : null,
        connected: row.isConnected !== false,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        scrollers,
      }
    }

    function pushDebug(step, row) {
      debugSteps.push({ step, row: rowSnapshot(row) })
    }

    function reportDebug(payload) {
      try {
        fetch('/dsh-open-workspace/debug', {
          method: 'POST',
          cache: 'no-store',
          keepalive: true,
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch {
        // 诊断通道失败不影响功能
      }
    }

    /**
     * 让浏览器自己滚到「顶部 + 偏移」：用 block:'start' 配 scroll-margin-top。
     * 比手算 scrollTop 稳——不用猜哪个祖先才是真正的滚动容器。
     */
    function placeRow(row) {
      try {
        row.style.scrollMarginTop = `${REVEAL_TOP_OFFSET_PX}px`
      } catch {
        // 行元素不可写样式时忽略
      }
      row.scrollIntoView({ block: 'start', inline: 'nearest' })
    }

    /**
     * 滚动 + 校验。注意 finder 每次都会重新查 DOM：React 重渲染会换掉行节点，
     * 拿着旧节点调 scrollIntoView 是空操作（这就是之前「滚不动」的原因之一）。
     */
    async function revealRow(finder) {
      const first = finder()
      if (!first) return false
      placeRow(first)
      pushDebug('placed', first)
      await sleep(180)
      const again = finder() ?? first
      const top = again.getBoundingClientRect().top
      const height = typeof window.innerHeight === 'number' ? window.innerHeight : 0
      if (top < 0 || (height > 0 && top > height * 0.45)) {
        try {
          again.style.scrollMarginTop = '0px'
        } catch {
          // 忽略
        }
        again.scrollIntoView({ block: 'center', inline: 'nearest' })
        pushDebug('center-fallback', again)
      }
      return true
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
     * 这里补上：先滚工作区行 → 折叠就点开 → 重新查节点再滚一次（停在偏上），
     * 最后保证新会话行露出。找不到就安静跳过。
     */
    async function revealInSidebar(path) {
      debugSteps = []
      const label = workspaceLabel(path)
      const findWorkspaceRow = () => {
        const all = workspaceRows()
        return (
          all.find((el) => (el.textContent || '').trim() === label) ||
          (label ? all.find((el) => (el.textContent || '').includes(label)) : undefined) ||
          null
        )
      }

      const deadline = Date.now() + REVEAL_TIMEOUT_MS
      let row = null
      while (Date.now() < deadline) {
        row = findWorkspaceRow()
        if (row) break
        // 这个视图里根本没有工作区行（单列表 / 工作区被改名）：直接定位当前会话行
        if (workspaceRows().length === 0) {
          const selected = currentSessionRow()
          if (selected) {
            await revealRow(() => currentSessionRow())
            reportDebug({ label, flat: true, steps: debugSteps })
            return true
          }
        }
        await sleep(REVEAL_POLL_MS)
      }
      if (!row) {
        reportDebug({ label, found: false, steps: debugSteps })
        return false
      }

      pushDebug('found', row)
      // 点击前先滚一次：点击会让 React 换节点，晚了旧节点就失效了
      placeRow(row)
      pushDebug('placed-before-expand', row)

      if (row.getAttribute('aria-expanded') === 'false') {
        row.click()
        await sleep(150)
      }

      // 展开后重新查一次节点，再摆到偏上位置
      const fresh = findWorkspaceRow() ?? row
      pushDebug('after-expand', fresh)
      await revealRow(() => findWorkspaceRow() ?? fresh)

      // 新会话行紧随其后；只有它没露出来才补一次
      const selected = await waitForRow(currentSessionRow, 400)
      if (selected !== null) {
        const rect = selected.getBoundingClientRect()
        const height = typeof window.innerHeight === 'number' ? window.innerHeight : 0
        pushDebug('session', selected)
        if (height > 0 && (rect.top < 0 || rect.bottom > height)) {
          selected.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      }
      reportDebug({ label, found: true, steps: debugSteps })
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
