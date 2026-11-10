/**
 * dsh-open-workspace —— host 半。
 *
 * ws-workbench 点「DeepSeek」时写 `$DSH_HOME/open-workspace.json`，本插件把
 * 它通过 HTTP 路由交给页面里的 client 半（client 半再调 workspaces 服务）。
 * 请求文件是唯一的跨进程桥：ws-workbench 不知道 DSH 的端口、cookie 和鉴权。
 *
 * 路由只在 DSH 自己的 web server 上暴露（宿主鉴权保护），外部进程碰不到；
 * 所有路由都 try/catch，出问题只影响插件本身，不影响宿主动画。
 */
import { readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-open-workspace'
export const inject = ['webServer']

const PLUGIN_VERSION = '0.1.0'
/** 请求有效期：10 分钟没被消费就丢弃，避免重启后莫名打开旧目录 */
const REQUEST_TTL_MS = 10 * 60 * 1000

let lastRequest = null
let lastError = null

function dshHome() {
  const custom = process.env.DSH_HOME
  return custom && custom.trim() ? custom : join(homedir(), '.dsh')
}

function requestPath() {
  return join(dshHome(), 'open-workspace.json')
}

/** 读并消费请求文件；过期 / 非法 / 目录不存在时直接删掉并返回 null。 */
function takeRequest() {
  const file = requestPath()
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  // 先删再校验：坏请求不能一直卡在文件里反复被读到
  try {
    unlinkSync(file)
  } catch {
    // 删不掉也继续，最多下一轮再读一次
  }
  let request
  try {
    request = JSON.parse(raw)
  } catch {
    return null
  }
  if (!request || typeof request.path !== 'string' || !request.path) return null
  const createdAt = Date.parse(request.createdAt)
  if (!Number.isFinite(createdAt) || Math.abs(Date.now() - createdAt) > REQUEST_TTL_MS) return null
  try {
    if (!statSync(request.path).isDirectory()) return null
  } catch {
    return null
  }
  return {
    requestId: typeof request.requestId === 'string' ? request.requestId : '',
    path: request.path,
    createdAt: request.createdAt,
  }
}

export function apply(ctx) {
  const logger = ctx.logger
  const warn = (...args) => {
    if (logger?.warn) logger.warn('[dsh-open-workspace]', ...args)
    else console.warn('[dsh-open-workspace]', ...args)
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-open-workspace/poll',
    handler: (req, res) => {
      try {
        const request = takeRequest()
        if (request) lastRequest = { ...request, takenAt: new Date().toISOString() }
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ request }))
      } catch (error) {
        lastError = String(error)
        warn('poll failed', error)
        res.setHeader('Content-Type', 'application/json')
        res.end('{"request":null}')
      }
    },
  })

  // 调试路由：DSH 页面里打开 /dsh-open-workspace/status 看插件版本与最近一次请求
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-open-workspace/status',
    handler: (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ version: PLUGIN_VERSION, lastRequest, lastError }))
    },
  })
}
