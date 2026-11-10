#!/usr/bin/env node
/**
 * 把某个版本的插件 zip 镜像到 Gitee 发行版（国内下载加速）。
 *
 * ws-workbench 的「设置 → 资源」默认从 Gitee 读版本、下 zip，Gitee 失败才回退 GitHub，
 * 所以每次发版都要把 GitHub Release 的 zip 同步一份到 Gitee 同名 tag 的发行版，
 * 附件名保持一致（`dsh-open-workspace-<version>.zip`）。
 *
 * 用法（CI 里由 release.yml 在 GitHub Release 之后调用；也可本地补镜像）：
 *   GITEE_TOKEN=xxx node scripts/gitee-mirror.mjs --version 0.1.0
 *   GITEE_TOKEN=xxx node scripts/gitee-mirror.mjs --version 0.1.0 --dry-run
 *
 * 环境变量：
 *   GITEE_TOKEN    Gitee 私人令牌（projects 权限）；CI 来自 secrets.GITEE_TOKEN
 *   GITEE_REPO     Gitee 仓库，默认 feng_wenshan/dsh-open-workspace（必须公开）
 *   GITEE_API_BASE 默认 https://gitee.com/api/v5（测试可指向本地 mock）
 *   GITEE_BRANCH   发行版挂载的分支，默认 main
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UA = 'dsh-open-workspace-release-mirror'
const GITEE_REPO = process.env.GITEE_REPO || 'feng_wenshan/dsh-open-workspace'
const GITEE_API = process.env.GITEE_API_BASE || 'https://gitee.com/api/v5'
const GITEE_WEB = process.env.GITEE_WEB_BASE || 'https://gitee.com'
const GITEE_TOKEN = process.env.GITEE_TOKEN || ''
const BRANCH = process.env.GITEE_BRANCH || 'main'
const DRY_RUN = process.argv.includes('--dry-run')

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] || '' : ''
}

const log = (msg) => console.log(`[gitee-mirror] ${msg}`)
const warn = (msg) => console.warn(`[gitee-mirror] ${msg}`)
const fail = (msg) => {
  console.error(`[gitee-mirror] 失败: ${msg}`)
  process.exit(1)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readVersion() {
  const fromArg = (argValue('--version') || '').replace(/^v/, '')
  if (fromArg) return fromArg
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return String(pkg.version || '').replace(/^v/, '')
}

async function gitee(path, { method = 'GET', form } = {}) {
  const url = new URL(GITEE_API + path)
  if (GITEE_TOKEN) url.searchParams.set('access_token', GITEE_TOKEN)
  const init = { method, headers: { 'User-Agent': UA } }
  if (form) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(form)) {
      if (value !== undefined && value !== null) params.set(key, String(value))
    }
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded'
    init.body = params.toString()
  }
  const res = await fetch(url, init)
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const err = new Error(`Gitee API ${method} ${path} 返回 HTTP ${res.status}: ${text.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  return json
}

async function withRetry(fn, label, attempts = 3) {
  let last
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      last = err
      warn(`${label} 第 ${attempt}/${attempts} 次失败: ${err.message}`)
      if (attempt < attempts) await sleep(3000 * attempt)
    }
  }
  throw last
}

async function findRelease(tag) {
  try {
    // Gitee 对「tag 不存在」可能返回 200 + 空 body，所以要判空
    const release = await gitee(`/repos/${GITEE_REPO}/releases/tags/${encodeURIComponent(tag)}`)
    if (release && release.id) return release
  } catch (err) {
    if (err.status !== 404) throw err
  }
  return null
}

/** 拿到（必要时创建）Gitee 发行版；Gitee 的发行版必须挂在已有 tag 上。 */
async function ensureRelease(tag) {
  const existing = await findRelease(tag)
  if (existing) {
    log(`复用 Gitee 发行版: ${existing.tag_name} (id=${existing.id})`)
    return existing
  }
  try {
    await gitee(`/repos/${GITEE_REPO}/tags`, {
      method: 'POST',
      form: { refs: BRANCH, tag_name: tag, tag_message: '' },
    })
    log(`已创建 Gitee tag: ${tag}`)
  } catch (err) {
    warn(`创建 Gitee tag 失败（可能已存在，继续）: ${err.message}`)
  }
  const created = await withRetry(
    () =>
      gitee(`/repos/${GITEE_REPO}/releases`, {
        method: 'POST',
        form: {
          tag_name: tag,
          name: tag,
          body: `dsh-open-workspace ${tag}`,
          target_commitish: BRANCH,
          prerelease: false,
        },
      }),
    '创建 Gitee 发行版'
  )
  let release = created && created.id ? created : await findRelease(tag)
  if (!release || !release.id) throw new Error(`创建 Gitee 发行版后读不到发行版（tag ${tag}）`)
  log(`已创建 Gitee 发行版: ${release.tag_name} (id=${release.id})`)
  return release
}

async function listAttachments(release) {
  const list = await gitee(`/repos/${GITEE_REPO}/releases/${release.id}/attach_files`)
  return Array.isArray(list) ? list : []
}

/** 上传 zip；同名旧附件先删掉，保证字节是这次构建的。 */
async function uploadAttachment(release, localPath, remoteName) {
  const bytes = readFileSync(localPath)
  const url = new URL(`${GITEE_API}/repos/${GITEE_REPO}/releases/${release.id}/attach_files`)
  if (GITEE_TOKEN) url.searchParams.set('access_token', GITEE_TOKEN)

  const existing = (await listAttachments(release)).find((item) => item.name === remoteName)
  if (existing) {
    log(`附件 ${remoteName} 已存在（id=${existing.id}），先删除再重传`)
    await gitee(`/repos/${GITEE_REPO}/releases/${release.id}/attach_files/${existing.id}`, {
      method: 'DELETE',
    }).catch((err) => warn(`删除旧附件失败（继续上传）: ${err.message}`))
  }

  const form = new FormData()
  if (GITEE_TOKEN) form.append('access_token', GITEE_TOKEN)
  form.append('file', new Blob([bytes]), remoteName)
  const res = await fetch(url, { method: 'POST', body: form, headers: { 'User-Agent': UA } })
  const text = await res.text()
  if (!res.ok) throw new Error(`上传附件 HTTP ${res.status}: ${text.slice(0, 300)}`)
  log(`已上传 ${remoteName}（${(bytes.length / 1024).toFixed(1)}KB）`)
}

/** 校验 Gitee 下载地址真能拿到文件（Gitee 会 302 到 CDN），大小一致。 */
async function verifyRemote(url, size) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const length = res.headers.get('content-length')
      if (length !== null && Number(length) !== size) {
        throw new Error(`Content-Length ${length} 与本地 ${size} 不一致`)
      }
      try {
        await res.body?.cancel()
      } catch {
        // 已关闭的流，忽略
      }
      log(`下载地址校验通过: ${url}`)
      return
    } catch (err) {
      if (attempt === 3) throw new Error(`下载地址校验失败 ${url}: ${err.message}`)
      warn(`校验第 ${attempt} 次失败，3s 后重试: ${err.message}`)
      await sleep(3000)
    }
  }
}

async function main() {
  if (!DRY_RUN && !GITEE_TOKEN) fail('缺少 GITEE_TOKEN（Gitee 私人令牌）')

  const version = readVersion()
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`版本号必须是 X.Y.Z 形式: ${version}`)
  const tag = `v${version}`
  const fileName = `dsh-open-workspace-${version}.zip`
  const filePath = resolve(ROOT, argValue('--file') || fileName)
  if (!DRY_RUN && !existsSync(filePath)) fail(`找不到 zip: ${filePath}（先在本地跑 scripts/build-zip.sh）`)

  log(`版本 ${tag} → Gitee 仓库 ${GITEE_REPO}`)
  if (DRY_RUN) {
    log(`[dry-run] 会上传 ${basename(filePath)} → releases/download/${tag}/${fileName}`)
    return
  }

  const release = await ensureRelease(tag)
  await withRetry(() => uploadAttachment(release, filePath, fileName), `上传 ${fileName}`)
  await verifyRemote(
    `${GITEE_WEB}/${GITEE_REPO}/releases/download/${tag}/${fileName}`,
    readFileSync(filePath).length
  )
  log(`完成：${GITEE_WEB}/${GITEE_REPO}/releases/tag/${tag}`)
}

main().catch((err) => fail(err.message))
