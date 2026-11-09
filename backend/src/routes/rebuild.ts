import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { type AuthCtx } from '../lib/auth'
import { guardUser } from '../legacy/guard'
import { ok, fail } from '../lib/response'

/**
 * 一键重建 —— 触发 GitHub Actions 跑完整的构建+部署流程
 *
 * 为什么需要：
 *   加了预渲染后，新文章要重新构建才会进入静态 HTML，
 *   否则搜索引擎抓到的还是旧内容。让用户去点 GitHub 太麻烦。
 *
 * 做的事：
 *   POST GitHub 的 workflow_dispatch 接口，触发 deploy-frontend.yml。
 *   后续（拉代码、npm build、预渲染、部署 Pages）全由 CI 完成。
 *
 * 需要的 Secret：
 *   GITHUB_TOKEN  —— 有 actions:write 权限的 PAT
 */
const r = new Hono<AuthCtx & { Bindings: Env }>()

const OWNER = 'lws666'
const REPO = 'POETIZE-for-CF'
const WORKFLOW = 'deploy-frontend.yml'

/** POST /api/rebuild —— 触发重建 */
/**
 * 鉴权：后台页面用的是 legacy 的 sess_ token（不是 api_tokens 里的 blg_），
 * 所以这里用 guardUser 而不是 requireWrite。
 * 要求 user_type <= 1（站长/管理员）。
 */
async function ensureAdmin(c: any): Promise<Response | null> {
  const u = await guardUser(c)
  if (!u) return fail('请先登录', 401, 'unauthorized')
  if (u.user_type > 1) return fail('需要管理员权限', 403, 'forbidden')
  return null
}

r.post('/', async (c) => {
  const denied = await ensureAdmin(c)
  if (denied) return denied
  const token = c.env.GITHUB_TOKEN
  if (!token) {
    return fail(
      '未配置 GITHUB_TOKEN，无法触发重建。请在 Worker 设置里添加该 Secret（需要 actions:write 权限）',
      503,
      'not_configured'
    )
  }

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub 要求带 UA，否则 403
        'User-Agent': 'poetize-rebuild'
      },
      body: JSON.stringify({ ref: 'main' })
    })

    // 204 = 触发成功（GitHub 这个接口成功时不返回 body）
    if (res.status === 204) {
      return ok({
        triggered: true,
        message: '已触发重建，约 3-5 分钟后生效',
        url: `https://github.com/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`
      })
    }

    const text = await res.text()
    return fail(`触发失败 HTTP ${res.status}: ${text.slice(0, 200)}`, 502, 'github_error')
  } catch (e) {
    return fail(`触发失败：${(e as Error).message}`, 502, 'network_error')
  }
})

/** GET /api/rebuild/status —— 查最近一次构建状态 */
r.get('/status', async (c) => {
  const denied = await ensureAdmin(c)
  if (denied) return denied
  const token = c.env.GITHUB_TOKEN
  if (!token) return ok({ configured: false })

  try {
    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'poetize-rebuild'
        }
      }
    )
    if (!res.ok) return ok({ configured: true, error: `HTTP ${res.status}` })

    const j = await res.json<{
      workflow_runs?: Array<{
        status: string
        conclusion: string | null
        created_at: string
        html_url: string
        run_number: number
      }>
    }>()

    const run = j.workflow_runs?.[0]
    if (!run) return ok({ configured: true, run: null })

    return ok({
      configured: true,
      run: {
        status: run.status,           // queued / in_progress / completed
        conclusion: run.conclusion,   // success / failure / null
        createdAt: run.created_at,
        url: run.html_url,
        number: run.run_number
      }
    })
  } catch {
    return ok({ configured: true, error: 'network' })
  }
})

export default r
