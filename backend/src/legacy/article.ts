import { Hono } from 'hono'
import type { Env, PostRow } from '../lib/types'
import { legacyOk, legacyErr } from './response'

/** 惯用别名 */
const ok = legacyOk

/** 官方信封版的错误响应 */
const notFound = (m: string) => legacyErr(m, 404)
const badRequest = (m: string) => legacyErr(m, 400)
import { toLegacyArticle, deriveSorts, deriveLabels } from './mapper'
import { checkAccess } from '../lib/access'
import { parseArr } from '../lib/posts'
import { currentUserLite } from '../lib/auth'

/**
 * 官方 /article/* 接口适配。
 *
 * 关键差异：
 *   官方 listArticle 用 **POST + JSON 分页对象**，返回 { records, total, ... }
 *   官方文章 id 是数字，本项目 slug 是字符串 → 用 posts.id 做主键
 *   官方没有 slug 概念，路由是 /article/:id
 */
export const article = new Hono<{ Bindings: Env }>()

interface PageReq {
  current?: number
  size?: number
  searchKey?: string
  sortId?: number | null
  labelId?: number | null
  articleSearch?: string
}

async function loadAll(db: D1Database): Promise<PostRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM posts WHERE draft = 0 ORDER BY top DESC, date DESC, id DESC`)
    .all<PostRow>()
  return results
}

/** POST /article/listArticle */
article.post('/listArticle', async (c) => {
  const b = await c.req.json<PageReq>().catch(() => ({} as PageReq))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))

  /**
   * 全量文章 —— 必须和 listSortAndLabel 完全一致的查询与排序。
   *
   * deriveLabels 是按遍历顺序自增分配 id 的，如果两处顺序不同，
   * 同一标签会拿到不同 id：前端拿 listSortAndLabel 的 id 来过滤，
   * 后端用另一套 id 反查，就会匹配到错误的标签。
   *
   * 之前的 bug 正是如此：SEO 在前端是 id=9，在 listArticle 里算成别的。
   */
  const { results: allRows } = await c.env.DB
    .prepare(`SELECT * FROM posts WHERE draft = 0 ORDER BY top DESC, date DESC, id DESC`)
    .all<PostRow>()

  const sorts = deriveSorts(allRows)
  const sortIdByName = new Map(sorts.map(s => [s.sortName, s.id]))

  // 用全量数据算标签 id，与 listSortAndLabel 同源同序
  const allLabels = deriveLabels(allRows, sorts)
  const labelIds = new Map<string, number>()
  for (const l of allLabels) {
    if (!labelIds.has(l.labelName)) labelIds.set(l.labelName, l.id)
  }

  let rows = allRows

  // 按 sort 过滤
  if (b.sortId) {
    const target = sorts.find(s => s.id === Number(b.sortId))
    if (target) {
      rows = rows.filter(r => parseArr(r.categories).includes(target.sortName))
    }
  }

  /**
   * 按 label 过滤。
   *
   * 之前完全没实现：前端点标签跳 /sort?labelId=N，
   * 后端忽略这个参数，导致「标签页显示全部文章」。
   *
   * labelId 由 deriveLabels 动态生成（没有独立表），
   * 所以要先反查出标签名，再按 tags 字段过滤。
   */
  if (b.labelId) {
    const targetLabel = allLabels.find(l => l.id === Number(b.labelId))
    if (targetLabel) {
      // 同一标签名可能挂在多个分类下，任一命中即算
      const names = new Set(
        allLabels.filter(l => l.labelName === targetLabel.labelName).map(l => l.labelName)
      )
      /**
       * 必须用 parseArr，不能裸 JSON.parse。
       * 历史数据里 tags 存在 {} 这种空对象（id=57），
       * JSON.parse 得到对象，.some 直接 TypeError → 500。
       * parseArr 会兜底成 []。
       */
      rows = rows.filter(r => parseArr(r.tags).some((t: string) => names.has(t)))
    } else {
      // 标签不存在 → 返回空，不要退化成"全部"
      rows = []
    }
  }

  // 关键词
  const kw = (b.searchKey || b.articleSearch || '').trim().toLowerCase()
  if (kw) {
    rows = rows.filter(r => r.title.toLowerCase().includes(kw) || (r.excerpt || '').toLowerCase().includes(kw))
  }

  const total = rows.length
  const start = (current - 1) * size
  const page = rows.slice(start, start + size)

  return ok({
    records: page.map(r => toLegacyArticle(r, { sortIdByName, labelIds })),
    total,
    size,
    current,
    pages: Math.ceil(total / size)
  })
})

/**
 * GET /article/listSortArticle —— 首页按分类分组
 *
 * 关键两点（缺一不可）：
 * 1. 前端用 **GET**（index.vue 的 getSortArticles），只注册 POST 会 404
 * 2. 返回对象必须以 **sortId 为 key**：模板里写的是
 *    sortArticles[sort.id]，用分类名当 key 就永远取不到
 */
article.get('/listSortArticle', async (c) => {
  const rows = await loadAll(c.env.DB)
  const sorts = deriveSorts(rows)
  const sortIdByName = new Map(sorts.map(s => [s.sortName, s.id]))

  const out: Record<string, ReturnType<typeof toLegacyArticle>[]> = {}
  /**
   * 未分类文章（categories 为空）不能落到 sortId=0。
   *
   * 首页模板遍历的是 getSortInfo 返回的分类（id 从 1 开始），
   * 只渲染 sortArticles[sort.id]。sortId=0 不在这个列表里，
   * 对应文章就永远不显示 —— 用户表现为「发布了但首页看不到」。
   *
   * 这里把未分类兜到第一个分类；若一个分类都没有，才用 0。
   */
  const firstId = sorts.length ? sorts[0].id : 0

  for (const r of rows) {
    const cat = (JSON.parse(r.categories || '[]') as string[])[0] || ''
    const sid = String(cat ? (sortIdByName.get(cat) ?? firstId) : firstId)
    if (!out[sid]) out[sid] = []
    if (out[sid].length < 6) out[sid].push(toLegacyArticle(r, { sortIdByName }))
  }
  return ok(out)
})

/** POST 版本兼容 */
article.post('/listSortArticle', async (c) => {
  const rows = await loadAll(c.env.DB)
  const sorts = deriveSorts(rows)
  const sortIdByName = new Map(sorts.map(s => [s.sortName, s.id]))
  const out: Record<string, ReturnType<typeof toLegacyArticle>[]> = {}
  for (const r of rows) {
    const cat = (JSON.parse(r.categories || '[]') as string[])[0] || '未分类'
    const sid = String(sortIdByName.get(cat) ?? 0)
    if (!out[sid]) out[sid] = []
    if (out[sid].length < 6) out[sid].push(toLegacyArticle(r, { sortIdByName }))
  }
  return ok(out)
})

/**
 * GET /article/getArticleById?id=N[&password=xxx]
 *
 * 官方前端传入 id（article.id），本项目 posts.id 与之对应。
 *
 * 访问控制（对齐官方 ResourceCheckAspect）：
 *   public    返回正文
 *   login     需登录
 *   userLv    当前用户 level >= view_value
 *   password  比对 password 参数
 * 无权时返回 200 + locked 结构，前端据此弹窗。
 */
article.get('/getArticleById', async (c) => {
  const idRaw = c.req.query('id')
  const id = Number(idRaw)
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)

  const row = await c.env.DB.prepare(`SELECT * FROM posts WHERE id = ?1`).bind(id).first<PostRow>()
  if (!row) return legacyErr('文章不存在', 404)

  const rows = await loadAll(c.env.DB)
  const sorts = deriveSorts(rows)
  const sortIdByName = new Map(sorts.map(s => [s.sortName, s.id]))

  /**
   * 必须算 labelIds 并传给 toLegacyArticle。
   *
   * 之前漏了这一步，导致返回的 article.labelId 是 null、label.id 是 0。
   * 前端点「订阅」时传的就是 this.article.labelId ——
   * 拿到 null 就变成 `?flag=true`，后端报「缺少 labelId」。
   *
   * 和 listArticle 用同一份派生逻辑，保证 id 一致。
   */
  const allLabels = deriveLabels(rows, sorts)
  const labelIds = new Map<string, number>()
  for (const l of allLabels) {
    if (!labelIds.has(l.labelName)) labelIds.set(l.labelName, l.id)
  }

  // 解析当前用户（Bearer 或 Cookie）
  const user = await currentUserLite(c.env.DB, c.req.header('Authorization'), c.req.header('Cookie'))

  const pwd = c.req.query('password') ?? c.req.query('viewValue') ?? undefined
  const access = checkAccess(row, user, pwd)

  const base = toLegacyArticle(row, { sortIdByName, labelIds, withContent: true })

  if (!access.allowed) {
    return legacyOk({
      ...base,
      articleContent: '',
      locked: true,
      lockReason: access.reason,
      lockMessage: access.message,
      needLevel: access.needLevel ?? null,
      currentLevel: user?.user_lv ?? 0
    })
  }

  // base 里的 articleContent 已由 mapper 剥离过 frontmatter
  return legacyOk({ ...base, locked: false })
})

/** 写操作：官方后台用，本项目暂不支持，返回明确错误 */
article.all('/*', async (c) => legacyErr('该接口未在新后端实现', 501))
