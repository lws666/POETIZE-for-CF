import { Hono } from 'hono'
import type { Env, PostRow, UserRow } from '../lib/types'
import { legacyOk, legacyErr } from './response'
import { requireWrite, requireBoss, guardUser } from './guard'
import { audit, clientIp } from '../lib/audit'
import { submitIndexNow, resolveHost } from '../lib/indexnow'
import { readConfig, writeConfig } from '../lib/siteConfig'
import { deriveSorts, deriveLabels, toLegacyArticle } from './mapper'
import { stripFrontmatter, parseArr } from '../lib/posts'
import { nowIso } from '../lib/crypto'

/**
 * 官方管理后台接口适配。
 *
 * 覆盖前端 admin/ 目录实际调用的接口：
 *   /article/saveArticle  /article/updateArticle  /article/deleteArticle
 *   /article/listAdminArticle
 *   /webInfo/updateWebInfo  /webInfo/saveSort  /webInfo/updateSort
 *   /webInfo/deleteSort  /webInfo/saveLabel  /webInfo/updateLabel
 *   /webInfo/deleteLabel  /webInfo/listSortAndLabel
 *   /sysConfig/listConfig  /sysConfig/saveOrUpdateConfig  /sysConfig/deleteConfig
 *   /user/listUser  /user/changeUserStatus  /user/changeUserLv  /user/deleteUser
 */
export const admin = new Hono<{ Bindings: Env }>()

/* ── 文章 ─────────────────────────────────────────────────── */


/**
 * GET /admin/audit/list —— 审计日志查询
 *
 * 只给站长看（user_type === 0），因为日志里含管理员的 IP 和操作明细。
 */
admin.get('/admin/audit/list', async (c) => {
  const denied = await requireBoss(c)
  if (denied) return denied

  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50))
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)

  const total = (await c.env.DB
    .prepare(`SELECT COUNT(*) c FROM audit_log`)
    .first<{ c: number }>())?.c ?? 0

  const { results } = await c.env.DB
    .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?1 OFFSET ?2`)
    .bind(limit, offset)
    .all<Record<string, unknown>>()

  return legacyOk({
    records: results.map(r => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      action: r.action,
      target: r.target,
      detail: r.detail,
      ip: r.ip,
      createTime: r.created_at
    })),
    total,
    limit,
    offset
  })
})

/** POST /article/saveArticle */
admin.post('/article/saveArticle', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const title = String(b.articleTitle || '').trim()
  if (!title) return legacyErr('标题不能为空', 400)

  const slug = makeSlug(title)
  const now = nowIso()

  /**
   * 分类与标签：前端 postEdit.vue 传的是 **sortId / labelId（数字）**，
   * 不是 sortName / labelName。要反查成名称再存进 posts.categories/tags，
   * 否则新文章永远是未分类，首页看不到。
   */
  const all = await c.env.DB.prepare(`SELECT * FROM posts`).all<PostRow>()
  const sorts = deriveSorts(all.results)
  const labels = deriveLabels(all.results, sorts)
  const sortNameById = new Map(sorts.map(s => [s.id, s.sortName]))
  const labelNameById = new Map(labels.map(l => [l.id, l.labelName]))

  const catNames = resolveNames(b, 'sort', sortNameById, c.env)
  const tagNames = resolveNames(b, 'label', labelNameById, c.env)

  const res = await c.env.DB
    .prepare(
      `INSERT INTO posts (slug,title,date,tags,categories,excerpt,cover,type,draft,content,view_type,view_value,tips,comment,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'post',0,?8,?9,?10,?11,?12,?13,?14)`
    )
    .bind(
      slug, title, now.slice(0, 10),
      JSON.stringify(tagNames), JSON.stringify(catNames),
      String(b.articleExcerpt || ''), String(b.articleCover || ''),
      String(b.articleContent || ''),
      String(b.viewType || 'public'), String(b.viewValue || ''), String(b.tips || ''),
      b.commentStatus === false ? 0 : 1,
      now, now
    )
    .run()
  // resolveNames 内部已 await，这里同步取结果

  const newId = Number(res.meta.last_row_id)

  /**
   * IndexNow 推送：新文章上线，通知搜索引擎来抓。
   *
   * 用 waitUntil 异步发，不阻塞保存响应 ——
   * 推送失败也不影响文章已存进数据库这个事实。
   */
  const host = resolveHost(c.env)
  if (c.env.INDEXNOW_KEY) {
    const urls = [
      `https://${host}/`,
      `https://${host}/article/${newId}`,
      `https://${host}/sort`
    ]
    c.executionCtx?.waitUntil?.(
      submitIndexNow(host, c.env.INDEXNOW_KEY, urls)
    )
  }

  return legacyOk({ id: newId, slug })
})

/** POST /article/updateArticle */
admin.post('/article/updateArticle', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const id = Number(b.id)
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)

  const sets: string[] = []
  const vals: unknown[] = []
  const push = (col: string, v: unknown) => { sets.push(`${col}=?${vals.length + 1}`); vals.push(v) }

  if (b.articleTitle !== undefined) push('title', String(b.articleTitle))
  if (b.articleContent !== undefined) push('content', String(b.articleContent))
  if (b.articleCover !== undefined) push('cover', String(b.articleCover))
  if (b.articleExcerpt !== undefined) push('excerpt', String(b.articleExcerpt))
  if (b.viewType !== undefined) push('view_type', String(b.viewType))
  if (b.viewValue !== undefined) push('view_value', String(b.viewValue))
  if (b.tips !== undefined) push('tips', String(b.tips))
  if (b.commentStatus !== undefined) push('comment', b.commentStatus ? 1 : 0)
  if (b.sortId !== undefined || b.labelId !== undefined) {
    const all = await c.env.DB.prepare(`SELECT * FROM posts`).all<PostRow>()
    const sorts = deriveSorts(all.results)
    const labels = deriveLabels(all.results, sorts)
    const sortNameById = new Map(sorts.map(s => [s.id, s.sortName]))
    const labelNameById = new Map(labels.map(l => [l.id, l.labelName]))
    push('categories', JSON.stringify(resolveNames(b, 'sort', sortNameById, c.env)))
    push('tags', JSON.stringify(resolveNames(b, 'label', labelNameById, c.env)))
  }
  if (!sets.length) return legacyErr('没有要更新的字段', 400)

  push('updated_at', nowIso())
  await c.env.DB.prepare(`UPDATE posts SET ${sets.join(',')} WHERE id=?${vals.length + 1}`).bind(...vals, id).run()

  // 内容更新也推送一次，让搜索引擎重新抓
  const host2 = resolveHost(c.env)
  if (c.env.INDEXNOW_KEY) {
    c.executionCtx?.waitUntil?.(
      submitIndexNow(host2, c.env.INDEXNOW_KEY, [`https://${host2}/article/${id}`])
    )
  }

  return legacyOk({ updated: true })
})

/**
 * /article/deleteArticle
 *
 * postList.vue 用的是 GET（$http.get(baseURL + "/article/deleteArticle", {id})）。
 * 只注册 POST 时前端拿到 405，表现就是「删除不了」。
 * 同时保留 POST 兼容脚本调用。
 */
const deleteArticle = async (c: any) => {
  const denied = await requireWrite(c)
  if (denied) return denied

  let id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) {
    const b = await c.req.json().catch(() => ({}))
    id = Number(b.id)
  }
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)

  const exists = await c.env.DB.prepare(`SELECT id FROM posts WHERE id=?1`).bind(id).first()
  if (!exists) return legacyErr('文章不存在', 404)

  await c.env.DB.prepare(`DELETE FROM posts WHERE id=?1`).bind(id).run()
  const _u = await guardUser(c)
  await audit(c.env.DB, {
    userId: _u?.id ?? 0, username: _u?.username ?? 'unknown',
    action: 'article.delete', target: `article:${id}`, ip: clientIp(c)
  })
  return legacyOk({ deleted: true, id })
}

admin.get('/article/deleteArticle', deleteArticle)
admin.post('/article/deleteArticle', deleteArticle)

/** POST /article/listAdminArticle —— 后台文章列表（含草稿） */
admin.post('/article/listAdminArticle', async (c) => {
  const b = await c.req.json<{ current?: number; size?: number; searchKey?: string }>().catch(() => ({} as { current?: number; size?: number; searchKey?: string }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))
  const kw = String(b.searchKey || '').trim()

  const where = kw ? `WHERE title LIKE ?1` : ''
  const params = kw ? [`%${kw}%`] : []

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM posts ${where}`).bind(...params).first<{ c: number }>())?.c ?? 0
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM posts ${where} ORDER BY id DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`)
    .bind(...params, size, (current - 1) * size)
    .all<PostRow>()

  const rows = await c.env.DB.prepare(`SELECT * FROM posts`).all<PostRow>()
  const sorts = deriveSorts(rows.results)
  const sortIdByName = new Map(sorts.map(s => [s.sortName, s.id]))

  return legacyOk({
    records: results.map(r => ({ ...toLegacyArticle(r, { sortIdByName }), draft: !!r.draft })),
    total, size, current, pages: Math.ceil(total / size)
  })
})

/* ── 后台文章列表（官方路径是 /admin/article/*）──────────────── */

/** GET /admin/article/getArticleById?id=N —— 编辑页取完整文章（含正文、分类标签 id） */
admin.get('/admin/article/getArticleById', async (c) => {
  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)

  const row = await c.env.DB.prepare(`SELECT * FROM posts WHERE id=?1`).bind(id).first<PostRow>()
  if (!row) return legacyErr('文章不存在', 404)

  const all = await c.env.DB.prepare(`SELECT * FROM posts`).all<PostRow>()
  const sorts = deriveSorts(all.results)
  const labels = deriveLabels(all.results, sorts)
  const sortIdByName = new Map(sorts.map(s => [s.sortName, s.id]))
  const labelIdByName = new Map(labels.map(l => [l.labelName, l.id]))

  const cats = parseArr(row.categories)
  const tags = parseArr(row.tags)

  return legacyOk({
    ...toLegacyArticle(row, { sortIdByName, withContent: true }),
    sortId: cats[0] ? (sortIdByName.get(cats[0]) ?? null) : null,
    labelId: tags[0] ? (labelIdByName.get(tags[0]) ?? null) : null,
    /** 编辑页需要原始 markdown（含 frontmatter 也行，保存时再处理） */
    articleContent: row.content || '',
    draft: !!row.draft,
    recommendStatus: !!row.top
  })
})

/** POST /admin/article/boss/list —— 站长看全部 */
admin.post('/admin/article/boss/list', async (c) => listAdminPosts(c))
/** POST /admin/article/user/list —— 普通管理员看自己的（本项目不区分，同 boss） */
admin.post('/admin/article/user/list', async (c) => listAdminPosts(c))

/** GET /admin/article/changeArticleStatus —— 显隐/推荐开关 */
/**
 * GET /admin/article/changeArticleStatus
 *
 * 前端实际传的是**具名参数**（不是 field/value）：
 *   ?articleId=N&commentStatus=true
 *   ?articleId=N&recommendStatus=true
 * 也兼容 ?articleId=N&viewType=public（改访问类型）
 */
admin.get('/admin/article/changeArticleStatus', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const id = Number(c.req.query('articleId') ?? c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('articleId 非法', 400)

  const sets: string[] = []
  const vals: unknown[] = []
  const push = (col: string, v: unknown) => { sets.push(`${col}=?${vals.length + 1}`); vals.push(v) }

  const q = c.req.query()

  if (q.commentStatus !== undefined) push('comment', q.commentStatus === 'true' ? 1 : 0)
  if (q.recommendStatus !== undefined) push('top', q.recommendStatus === 'true' ? 1 : 0)
  if (q.viewType !== undefined) push('view_type', String(q.viewType))
  if (q.viewValue !== undefined) push('view_value', String(q.viewValue))
  if (q.draft !== undefined) push('draft', q.draft === 'true' ? 1 : 0)

  // 兼容旧的 field/value 写法
  const field = q.field
  if (field) {
    const v = q.value
    if (field === 'draft' || field === 'hide') push('draft', v === 'true' || v === '1' ? 1 : 0)
    else if (field === 'top' || field === 'recommendStatus') push('top', v === 'true' || v === '1' ? 1 : 0)
    else if (field === 'view_type' || field === 'viewType') push('view_type', String(v || 'public'))
  }

  if (!sets.length) return legacyErr('没有要更新的字段', 400)

  push('updated_at', nowIso())
  await c.env.DB.prepare(`UPDATE posts SET ${sets.join(',')} WHERE id=?${vals.length + 1}`)
    .bind(...vals, id).run()
  return legacyOk({ updated: true })
})

/* ── 分类 / 标签 ───────────────────────────────────────────── */

admin.get('/webInfo/listSortAndLabel', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM posts`).all<PostRow>()
  const sorts = deriveSorts(results)
  const labels = deriveLabels(results, sorts)
  return legacyOk({ sorts, labels })
})

admin.post('/webInfo/saveSort', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<{ sortName?: string; sortDescription?: string }>().catch(() => ({} as { sortName?: string; sortDescription?: string }))
  const name = String(b.sortName || '').trim()
  if (!name) return legacyErr('分类名不能为空', 400)
  // 分类由 posts.categories 聚合而来，这里作为「新建空分类」占位
  return legacyOk({ sortName: name, note: '分类由文章自动聚合，新建后需有文章使用才会显示' })
})

admin.post('/webInfo/updateSort', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<{ sortName?: string; newName?: string }>().catch(() => ({} as Record<string, unknown>))
  const oldName = String(b.sortName || '').trim()
  const newName = String(b.newName || b.sortName || '').trim()
  if (!oldName || !newName) return legacyErr('参数不完整', 400)

  // 批量替换所有文章该分类
  const { results } = await c.env.DB.prepare(`SELECT id, categories FROM posts`).all<{ id: number; categories: string }>()
  const stmts = results
    .filter(r => parseArr(r.categories).includes(oldName))
    .map(r => {
      const next = parseArr(r.categories).map(x => (x === oldName ? newName : x))
      return c.env.DB.prepare(`UPDATE posts SET categories=?1 WHERE id=?2`).bind(JSON.stringify(next), r.id)
    })
  if (stmts.length) await c.env.DB.batch(stmts)
  return legacyOk({ updated: stmts.length })
})

admin.post('/webInfo/deleteSort', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<{ sortName?: string }>().catch(() => ({} as Record<string, unknown>))
  const name = String(b.sortName || '').trim()
  if (!name) return legacyErr('分类名不能为空', 400)

  const { results } = await c.env.DB.prepare(`SELECT id, categories FROM posts`).all<{ id: number; categories: string }>()
  const stmts = results
    .filter(r => parseArr(r.categories).includes(name))
    .map(r => {
      const next = parseArr(r.categories).filter(x => x !== name)
      return c.env.DB.prepare(`UPDATE posts SET categories=?1 WHERE id=?2`).bind(JSON.stringify(next), r.id)
    })
  if (stmts.length) await c.env.DB.batch(stmts)
  return legacyOk({ removedFrom: stmts.length })
})

admin.post('/webInfo/saveLabel', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<{ labelName?: string }>().catch(() => ({} as Record<string, unknown>))
  return legacyOk({ labelName: String(b.labelName || ''), note: '标签由文章自动聚合' })
})

/** 更新/删除标签：批量改 posts.tags */
admin.post('/webInfo/updateLabel', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<{ labelName?: string; newName?: string }>().catch(() => ({} as Record<string, unknown>))
  const oldName = String(b.labelName || '').trim()
  const newName = String(b.newName || b.labelName || '').trim()
  if (!oldName || !newName) return legacyErr('参数不完整', 400)

  const { results } = await c.env.DB.prepare(`SELECT id, tags FROM posts`).all<{ id: number; tags: string }>()
  const stmts = results
    .filter(r => parseArr(r.tags).includes(oldName))
    .map(r => {
      const next = parseArr(r.tags).map(x => (x === oldName ? newName : x))
      return c.env.DB.prepare(`UPDATE posts SET tags=?1 WHERE id=?2`).bind(JSON.stringify(next), r.id)
    })
  if (stmts.length) await c.env.DB.batch(stmts)
  return legacyOk({ updated: stmts.length })
})

admin.post('/webInfo/deleteLabel', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<{ labelName?: string }>().catch(() => ({} as Record<string, unknown>))
  const name = String(b.labelName || '').trim()
  if (!name) return legacyErr('标签名不能为空', 400)

  const { results } = await c.env.DB.prepare(`SELECT id, tags FROM posts`).all<{ id: number; tags: string }>()
  const stmts = results
    .filter(r => parseArr(r.tags).includes(name))
    .map(r => {
      const next = parseArr(r.tags).filter(x => x !== name)
      return c.env.DB.prepare(`UPDATE posts SET tags=?1 WHERE id=?2`).bind(JSON.stringify(next), r.id)
    })
  if (stmts.length) await c.env.DB.batch(stmts)
  return legacyOk({ removedFrom: stmts.length })
})


/* ── 资源管理（resourceList.vue） ───────────────────────────── */

/**
 * POST /resource/listResource —— 后台资源列表
 * 列：id / userId / type / storeType / originalName / mimeType / createTime
 */
admin.post('/resource/listResource', async (c) => {
  const b = await c.req.json<{ current?: number; size?: number; type?: string }>()
    .catch(() => ({} as { current?: number; size?: number; type?: string }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))

  const where = b.type ? `WHERE deleted=0 AND type=?1` : `WHERE deleted=0`
  const params = b.type ? [b.type] : []

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_resource ${where}`)
    .bind(...params).first<{ c: number }>())?.c ?? 0

  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_resource ${where} ORDER BY id DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`)
    .bind(...params, size, (current - 1) * size)
    .all<Record<string, unknown>>()

  return legacyOk({
    records: results.map(r => ({
      id: r.id,
      userId: r.user_id,
      type: r.type,
      storeType: r.store_type,
      path: r.path,
      originalName: r.original_name,
      mimeType: r.mime_type,
      size: r.size,
      status: !!r.status,
      createTime: r.create_time
    })),
    total, size, current, pages: Math.ceil(total / size)
  })
})

/** POST /resource/deleteResource —— 按 id 或 path 删除 */
admin.post('/resource/deleteResource', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<{ id?: number; path?: string }>()
    .catch(() => ({} as { id?: number; path?: string }))
  if (b.id !== undefined) {
    await c.env.DB.prepare(`UPDATE poem_resource SET deleted=1 WHERE id=?1`).bind(Number(b.id)).run()
  } else if (b.path) {
    await c.env.DB.prepare(`UPDATE poem_resource SET deleted=1 WHERE path=?1`).bind(String(b.path)).run()
  } else {
    return legacyErr('需要 id 或 path', 400)
  }
  return legacyOk({ deleted: true })
})

/* ── 树洞管理（treeHoleList.vue） ───────────────────────────── */

/** POST /admin/treeHole/boss/list */
admin.post('/admin/treeHole/boss/list', async (c) => treeHoleList(c))
/** POST /admin/treeHole/user/list */
admin.post('/admin/treeHole/user/list', async (c) => treeHoleList(c))

async function treeHoleList(c: { req: { json: <T>() => Promise<T> }; env: Env }) {
  const b = await c.req.json<{ current?: number; size?: number }>()
    .catch(() => ({} as { current?: number; size?: number }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_treehole WHERE deleted=0`)
    .first<{ c: number }>())?.c ?? 0
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_treehole WHERE deleted=0 ORDER BY id DESC LIMIT ?1 OFFSET ?2`)
    .bind(size, (current - 1) * size)
    .all<Record<string, unknown>>()

  return legacyOk({
    records: results.map(r => ({
      id: r.id,
      avatar: r.avatar,
      message: r.message,
      createTime: r.create_time
    })),
    total, size, current, pages: Math.ceil(total / size)
  })
}

/* ── 评论管理（commentList.vue） ───────────────────────────── */

/** POST /admin/comment/boss/list 与 /admin/comment/user/list */
admin.post('/admin/comment/boss/list', async (c) => commentList(c))
admin.post('/admin/comment/user/list', async (c) => commentList(c))

async function commentList(c: { req: { json: <T>() => Promise<T> }; env: Env }) {
  const b = await c.req.json<{ current?: number; size?: number }>()
    .catch(() => ({} as { current?: number; size?: number }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_comment WHERE deleted=0`)
    .first<{ c: number }>())?.c ?? 0
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_comment WHERE deleted=0 ORDER BY id DESC LIMIT ?1 OFFSET ?2`)
    .bind(size, (current - 1) * size)
    .all<Record<string, unknown>>()

  // 取用户名
  const ids = [...new Set(results.map(r => Number(r.user_id)).filter(Boolean))]
  const users = new Map<number, UserRow>()
  if (ids.length) {
    const ph = ids.map((_, i) => `?${i + 1}`).join(',')
    const { results: us } = await c.env.DB
      .prepare(`SELECT * FROM users WHERE id IN (${ph})`).bind(...ids).all<UserRow>()
    for (const u of us) users.set(u.id, u)
  }

  return legacyOk({
    records: results.map(r => {
      const u = users.get(Number(r.user_id))
      return {
        id: r.id,
        source: r.source,
        type: r.type,
        userId: r.user_id,
        // 前端列名是 commentInfo，展示「用户名 + 内容摘要」
        commentInfo: u ? u.username : String(r.comment_info || '').slice(0, 40),
        commentContent: r.comment_content,
        likeCount: r.like_count,
        createTime: r.create_time
      }
    }),
    total, size, current, pages: Math.ceil(total / size)
  })
}

/** GET /admin/comment/boss/deleteComment 与 user 版 */
admin.get('/admin/comment/boss/deleteComment', async (c) => delComment(c))
admin.get('/admin/comment/user/deleteComment', async (c) => delComment(c))

async function delComment(c: any) {
  const denied = await requireWrite(c)
  if (denied) return denied

  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)
  // 软删该评论及其所有回复
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE poem_comment SET deleted=1 WHERE id=?1`).bind(id),
    c.env.DB.prepare(`UPDATE poem_comment SET deleted=1 WHERE floor_comment_id=?1`).bind(id)
  ])
  return legacyOk({ deleted: true })
}


/* ── 资源分类（resourcePathList.vue） ───────────────────────── */

/** POST /webInfo/listResourcePath */
admin.post('/webInfo/listResourcePath', async (c) => {
  const b = await c.req.json<{ current?: number; size?: number; classify?: string }>()
    .catch(() => ({} as { current?: number; size?: number; classify?: string }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))
  const where = b.classify ? `WHERE deleted=0 AND classify=?1` : `WHERE deleted=0`
  const params = b.classify ? [b.classify] : []

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_resource_path ${where}`)
    .bind(...params).first<{ c: number }>())?.c ?? 0
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_resource_path ${where} ORDER BY id DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`)
    .bind(...params, size, (current - 1) * size)
    .all<Record<string, unknown>>()

  return legacyOk({
    records: results.map(r => ({
      id: r.id, title: r.title, classify: r.classify, cover: r.cover,
      url: r.url, introduction: r.introduction, type: r.type,
      remark: r.remark, createTime: r.create_time
    })),
    total, size, current, pages: Math.ceil(total / size)
  })
})

/** POST /webInfo/saveResourcePath */
admin.post('/webInfo/saveResourcePath', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const title = String(b.title || '').trim()
  if (!title) return legacyErr('标题不能为空', 400)

  const res = await c.env.DB
    .prepare(`INSERT INTO poem_resource_path (title,classify,cover,url,introduction,type,remark,status,create_time,deleted)
              VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,0)`)
    .bind(title, String(b.classify || ''), String(b.cover || ''), String(b.url || ''),
      String(b.introduction || ''), String(b.type || 'picture'), String(b.remark || ''), nowIso())
    .run()
  return legacyOk({ id: Number(res.meta.last_row_id) })
})

/** POST /webInfo/updateResourcePath */
admin.post('/webInfo/updateResourcePath', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const id = Number(b.id)
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)

  const sets: string[] = []
  const vals: unknown[] = []
  const push = (col: string, v: unknown) => { sets.push(`${col}=?${vals.length + 1}`); vals.push(v) }
  if (b.title !== undefined) push('title', String(b.title))
  if (b.classify !== undefined) push('classify', String(b.classify))
  if (b.cover !== undefined) push('cover', String(b.cover))
  if (b.url !== undefined) push('url', String(b.url))
  if (b.introduction !== undefined) push('introduction', String(b.introduction))
  if (b.type !== undefined) push('type', String(b.type))
  if (b.remark !== undefined) push('remark', String(b.remark))
  if (!sets.length) return legacyErr('没有要更新的字段', 400)

  await c.env.DB.prepare(`UPDATE poem_resource_path SET ${sets.join(',')} WHERE id=?${vals.length + 1}`)
    .bind(...vals, id).run()
  return legacyOk({ updated: true })
})

/** GET /webInfo/deleteResourcePath */
admin.get('/webInfo/deleteResourcePath', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)
  await c.env.DB.prepare(`UPDATE poem_resource_path SET deleted=1 WHERE id=?1`).bind(id).run()
  return legacyOk({ deleted: true })
})

/* ── 表白墙列表（loveList.vue） ─────────────────────────────── */

/**
 * POST /family/listFamily
 *
 * 列需要：id / userId / manName / womanName / timing
 *        countdownTime / countdownTitle / familyInfo / createTime / updateTime
 */
admin.post('/family/listFamily', async (c) => {
  const b = await c.req.json<{ current?: number; size?: number }>()
    .catch(() => ({} as { current?: number; size?: number }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_family WHERE deleted=0`)
    .first<{ c: number }>())?.c ?? 0
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_family WHERE deleted=0 ORDER BY id DESC LIMIT ?1 OFFSET ?2`)
    .bind(size, (current - 1) * size)
    .all<Record<string, unknown>>()

  const now = Date.now()
  return legacyOk({
    records: results.map(r => {
      const start = r.timing ? new Date(String(r.timing).replace(' ', 'T')).getTime() : 0
      const diff = start ? now - start : 0
      const days = Math.floor(diff / 86400000)
      return {
        id: r.id,
        userId: r.user_id,
        manName: r.man_name,
        womanName: r.woman_name,
        /* 表格里三个 el-image 都读这些驼峰字段，漏传就显示「加载失败」 */
        bgCover: r.bg_cover,
        manCover: r.man_cover,
        womanCover: r.woman_cover,
        timing: r.timing,
        countdownTitle: r.countdown_title,
        timeTitle: r.time_title || '',
        // 前端列名是 countdownTime，展示已在一起多久
        countdownTime: start ? `${days} 天` : '',
        familyInfo: `${r.man_name || ''} ❤ ${r.woman_name || ''}`,
        createTime: r.create_time,
        updateTime: r.create_time
      }
    }),
    total, size, current, pages: Math.ceil(total / size)
  })
})

/* ── 站点设置 ─────────────────────────────────────────────── */

/** POST /webInfo/updateWebInfo —— webEdit.vue 保存站点信息 */
admin.post('/webInfo/updateWebInfo', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const patch: Record<string, string> = {}

  const map: Record<string, string> = {
    webName: 'webName',
    webTitle: 'webTitle',
    avatar: 'avatar',
    backgroundImage: 'backgroundImage',
    footer: 'footer',
    notices: 'notices',
    randomCover: 'randomCover',
    waifuJson: 'waifuJson'
  }
  for (const [from, to] of Object.entries(map)) {
    if (b[from] === undefined) continue
    const v = b[from]
    patch[to] = Array.isArray(v) ? JSON.stringify(v) : String(v)
  }
  if (!Object.keys(patch).length) return legacyErr('没有要更新的字段', 400)

  await writeConfig(c.env.DB, patch)
  return legacyOk({ updated: Object.keys(patch).length })
})

/**
 * GET /admin/webInfo/getAdminWebInfo —— webEdit.vue 实际调用
 *
 * 必须返回 webEdit 表单需要的全部字段（webName/webTitle/footer/status/
 * backgroundImage/avatar/waifuJson + notices/randomCover 等数组）。
 */
admin.get('/admin/webInfo/getAdminWebInfo', async (c) => {
  const cfg = await readConfig(c.env.DB)
  const { results } = await c.env.DB
    .prepare(`SELECT cover FROM posts WHERE draft=0 AND cover<>'' LIMIT 12`)
    .all<{ cover: string }>()

  const asArr = (v: string) => { try { const a = JSON.parse(v); return Array.isArray(a) ? a : [] } catch { return [] } }

  /**
   * **notices / randomName / randomAvatar / randomCover 必须是 JSON 字符串**，
   * 不是数组。
   *
   * webEdit.vue 第 434-437 行直接做 JSON.parse(res.data.notices)。
   * 传数组时 JSON.parse 会先 String() 成 "欢迎来到..."，
   * 再解析就抛：Unexpected token '欢', "欢迎来到 谢谢的博客"... is not valid JSON
   */
  const coverList = asArr(cfg.randomCover).length ? asArr(cfg.randomCover) : results.map(r => r.cover)

  return legacyOk({
    id: 1,
    webName: cfg.webName,
    webTitle: cfg.webTitle,
    footer: cfg.footer,
    status: cfg.status === 'true',
    backgroundImage: cfg.backgroundImage,
    avatar: cfg.avatar,
    waifuJson: cfg.waifuJson || '',
    notices: JSON.stringify(asArr(cfg.notices)),
    randomName: cfg.randomName || '[]',
    randomAvatar: cfg.randomAvatar || '[]',
    randomCover: JSON.stringify(coverList)
  })
})

/** GET /webInfo/getWebInfo（前台读）已由 webinfo.ts 提供 */

/* ── 系统配置 ─────────────────────────────────────────────── */

/**
 * GET /sysConfig/listConfig —— 配置列表
 *
 * configList.vue 期望的列：id / configName / configKey / configValue / configType
 * 缺 id 和 configKey 时表格渲染不出来（看起来像「后台看不到配置」）。
 *
 * 本项目的 site_config 是 key-value 表，这里：
 *   id         用 rowid 序号
 *   configKey  就是 key（程序读取用）
 *   configName 给一个人可读的中文名
 *   configType '2' = 公开（前端可读），'1' = 私有
 */
const CONFIG_LABELS: Record<string, string> = {
  webName: '网站名称',
  webTitle: '网站标题',
  author: '站长昵称',
  avatar: '头像地址',
  backgroundImage: '背景图',
  randomCover: '随机封面池',
  notices: '公告（JSON 数组）',
  footer: '页脚文案',
  beian: '备案号',
  'bar.menu.show': '导航菜单（逗号分隔）',
  'push.enable': '首页弹窗开关（true/false）',
  status: '站点状态',
  'local.enable': '本地存储开关',
  'qiniu.enable': '七牛云开关',
  webStaticResourcePrefix: '静态资源前缀',
  siteOrigin: '站点源（图片绝对化用）',
  friendWebName: '友人帐-站名',
  friendUrl: '友人帐-链接',
  friendAvatar: '友人帐-头像',
  friendIntroduction: '友人帐-简介',
  friendCover: '友人帐-封面'
}

const PRIVATE_KEYS = new Set(['siteOrigin', 'qiniu.enable', 'local.enable'])

admin.get('/sysConfig/listConfig', async (c) => {
  const cfg = await readConfig(c.env.DB)
  const rows = Object.entries(cfg).map(([k, v], i) => ({
    id: i + 1,
    configName: CONFIG_LABELS[k] || k,
    configKey: k,
    configValue: v,
    /** '1' 私有 / '2' 公开 */
    configType: PRIVATE_KEYS.has(k) ? '1' : '2'
  }))
  return legacyOk(rows)
})

admin.post('/sysConfig/saveOrUpdateConfig', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  // 前端表单有 configKey（程序键名）与 configName（显示名），优先用 configKey
  const k = String(b.configKey || b.configName || '').trim()
  if (!k) return legacyErr('键名不能为空', 400)
  await writeConfig(c.env.DB, { [k]: String(b.configValue ?? '') })
  return legacyOk({ saved: true, configKey: k })
})

/**
 * /sysConfig/deleteConfig
 * configList.vue 用 GET（传 ?id=），同时兼容 POST 的 configKey。
 */
const deleteConfig = async (c: any) => {
  const denied = await requireWrite(c)
  if (denied) return denied

  let k = String(c.req.query('configKey') || '').trim()

  // 前端只传 id，需要用 id 反查 key
  const id = Number(c.req.query('id'))
  if (!k && Number.isFinite(id)) {
    const cfg = await readConfig(c.env.DB)
    const keys = Object.keys(cfg)
    k = keys[id - 1] || ''
  }

  if (!k) {
    const b = await c.req.json().catch(() => ({}))
    k = String(b.configKey || b.configName || '').trim()
  }
  if (!k) return legacyErr('配置名不能为空', 400)

  await c.env.DB.prepare(`DELETE FROM site_config WHERE key=?1`).bind(k).run()
  return legacyOk({ deleted: true, configKey: k })
}

admin.get('/sysConfig/deleteConfig', deleteConfig)
admin.post('/sysConfig/deleteConfig', deleteConfig)

/* ── 用户管理 ─────────────────────────────────────────────── */

/** POST /admin/user/list —— userList.vue 实际调用 */
admin.post('/admin/user/list', async (c) => {
  /* 用户列表含邮箱等敏感信息，需要站长权限 */
  const denied = await requireBoss(c)
  if (denied) return denied

  const b = await c.req.json<{ current?: number; size?: number; userType?: number }>()
    .catch(() => ({} as { current?: number; size?: number; userType?: number }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))
  const where = b.userType !== undefined && b.userType !== null ? `WHERE user_type=?1` : ''
  const params = where ? [b.userType] : []

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM users ${where}`)
    .bind(...params).first<{ c: number }>())?.c ?? 0
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM users ${where} ORDER BY id LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`)
    .bind(...params, size, (current - 1) * size)
    .all<UserRow>()

  return legacyOk({
    records: results.map(u => ({
      id: u.id, username: u.username, email: u.email, gender: u.gender,
      avatar: u.avatar, userType: u.user_type, userLv: u.user_lv,
      userStatus: !!u.user_status, admire: u.admire || '',
      createTime: u.created_at
    })),
    total, size, current, pages: Math.ceil(total / size)
  })
})

/** GET /admin/user/changeUserType —— 改用户类型 */
admin.get('/admin/user/changeUserType', async (c) => {
  const denied = await requireBoss(c)
  if (denied) return denied
  const id = Number(c.req.query('userId') ?? c.req.query('id'))
  const type = Number(c.req.query('userType'))
  if (!Number.isFinite(id) || ![0, 1, 2].includes(type)) return legacyErr('参数非法', 400)

  const target = await c.env.DB.prepare(`SELECT user_type FROM users WHERE id=?1`).bind(id).first<{ user_type: number }>()
  if (target?.user_type === 0 && type !== 0) return legacyErr('站长账号不可降级', 409)

  await c.env.DB.prepare(`UPDATE users SET user_type=?1, role=?2 WHERE id=?3`)
    .bind(type, type <= 1 ? 'admin' : 'read', id).run()
  const _u = await guardUser(c)
  await audit(c.env.DB, {
    userId: _u?.id ?? 0, username: _u?.username ?? 'unknown',
    action: 'user.changeType', target: `user:${c.req.query('userId') || c.req.query('id')}`, ip: clientIp(c)
  })
  return legacyOk({ updated: true })
})

/** GET /admin/user/changeUserAdmire —— 赞赏设置（本项目占位） */
admin.get('/admin/user/changeUserAdmire', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  return legacyOk({ updated: true })
})

/** GET /user/listUser（保留兼容） */
admin.get('/user/listUser', async (c) => {
  const denied = await requireBoss(c)
  if (denied) return denied

  const { results } = await c.env.DB
    .prepare(`SELECT id,username,email,gender,avatar,user_type,user_lv,user_status,created_at FROM users ORDER BY id`)
    .all()
  return legacyOk({
    records: results.map((u: Record<string, unknown>) => ({
      id: u.id, username: u.username, email: u.email,
      gender: u.gender, avatar: u.avatar,
      userType: u.user_type, userLv: u.user_lv,
      userStatus: !!u.user_status, createTime: u.created_at
    })),
    total: results.length
  })
})

admin.get('/user/changeUserStatus', async (c) => {
  const denied = await requireBoss(c)
  if (denied) return denied
  const id = Number(c.req.query('userId') ?? c.req.query('id'))
  const status = c.req.query('userStatus')
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)
  await c.env.DB.prepare(`UPDATE users SET user_status=?1, disabled=?2 WHERE id=?3`)
    .bind(status === 'false' ? 0 : 1, status === 'false' ? 1 : 0, id).run()
  const _u = await guardUser(c)
  await audit(c.env.DB, {
    userId: _u?.id ?? 0, username: _u?.username ?? 'unknown',
    action: 'user.changeStatus', target: `user:${c.req.query('userId') || c.req.query('id')}`, ip: clientIp(c)
  })
  return legacyOk({ updated: true })
})

admin.get('/user/changeUserLv', async (c) => {
  const denied = await requireBoss(c)
  if (denied) return denied
  const id = Number(c.req.query('userId') ?? c.req.query('id'))
  const lv = Number(c.req.query('userLv'))
  if (!Number.isFinite(id) || !(lv >= 1 && lv <= 6)) return legacyErr('参数非法', 400)
  await c.env.DB.prepare(`UPDATE users SET user_lv=?1 WHERE id=?2`).bind(lv, id).run()

  const _u = await guardUser(c)
  await audit(c.env.DB, {
    userId: _u?.id ?? 0,
    username: _u?.username ?? 'unknown',
    action: 'user.changeLv',
    target: `user:${id}`,
    ip: clientIp(c)
  })

  return legacyOk({ updated: true })
})

admin.get('/user/deleteUser', async (c) => {
  const denied = await requireBoss(c)
  if (denied) return denied
  const id = Number(c.req.query('userId') ?? c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)
  const u = await c.env.DB.prepare(`SELECT user_type FROM users WHERE id=?1`).bind(id).first<{ user_type: number }>()
  if (u?.user_type === 0) return legacyErr('站长账号不可删除', 409)
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM users WHERE id=?1`).bind(id)
  ])
  const _u = await guardUser(c)
  await audit(c.env.DB, {
    userId: _u?.id ?? 0, username: _u?.username ?? 'unknown',
    action: 'user.delete', target: `user:${c.req.query('userId') || c.req.query('id')}`, ip: clientIp(c)
  })
  return legacyOk({ deleted: true })
})

/* 注意：admin 路由注册在 legacy 根路径下，不能加 all('/*') 兜底，
   否则会把 /article/* /webInfo/* 等其它子路由全部吞掉。 */

/* ── 工具 ─────────────────────────────────────────────────── */

/** 后台文章列表（供 boss/user 两个路径复用） */
async function listAdminPosts(c: {
  req: { json: <T>() => Promise<T> }
  env: Env
}) {
  const b = await c.req.json<{ current?: number; size?: number; searchKey?: string }>()
    .catch(() => ({} as { current?: number; size?: number; searchKey?: string }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))
  const kw = String(b.searchKey || '').trim()

  const where = kw ? `WHERE title LIKE ?1` : ''
  const params = kw ? [`%${kw}%`] : []

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM posts ${where}`)
    .bind(...params).first<{ c: number }>())?.c ?? 0

  const { results } = await c.env.DB
    .prepare(`SELECT * FROM posts ${where} ORDER BY id DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`)
    .bind(...params, size, (current - 1) * size)
    .all<PostRow>()

  const all = await c.env.DB.prepare(`SELECT * FROM posts`).all<PostRow>()
  const sorts = deriveSorts(all.results)
  const sortIdByName = new Map(sorts.map(s => [s.sortName, s.id]))

  return legacyOk({
    records: results.map(r => ({
      ...toLegacyArticle(r, { sortIdByName }),
      draft: !!r.draft,
      recommendStatus: !!r.top,
      /** postList.vue 用 viewType 判断显示哪个图标 */
      viewType: r.view_type || 'public',
      viewValue: r.view_value || '',
      commentStatus: !!r.comment
    })),
    total, size, current, pages: Math.ceil(total / size)
  })
}

function makeSlug(title: string): string {
  const base = title.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return `${base || 'post'}-${Date.now().toString(36)}`
}

/**
 * 把前端传来的 sortId/labelId（或 sortName/labelName）统一解析成名称数组。
 * 数字 id 通过 id→name 映射反查；查不到就丢弃。
 */
function resolveNames(
  b: Record<string, unknown>,
  kind: 'sort' | 'label',
  idToName: Map<number, string>,
  _env: Env
): string[] {
  const idKey = kind === 'sort' ? 'sortId' : 'labelId'
  const nameKey = kind === 'sort' ? 'sortName' : 'labelName'
  const listKey = kind === 'sort' ? 'sortNames' : 'labelNames'

  // 1) 数字 id
  const rawId = b[idKey]
  if (rawId !== undefined && rawId !== null && rawId !== '') {
    const name = idToName.get(Number(rawId))
    if (name) return [name]
  }
  // 2) id 数组（前端没用到，但兼容）
  if (Array.isArray(b[listKey + 'Id'])) {
    return (b[listKey + 'Id'] as unknown[])
      .map(x => idToName.get(Number(x)))
      .filter((x): x is string => !!x)
  }
  // 3) 名称
  if (Array.isArray(b[listKey])) return (b[listKey] as unknown[]).map(String)
  if (b[nameKey]) return [String(b[nameKey])]
  return []
}

function sortNames(b: Record<string, unknown>): string[] {
  if (Array.isArray(b.sortNames)) return b.sortNames.map(String)
  if (b.sortName) return [String(b.sortName)]
  if (b.sort) return [String(b.sort)]
  return []
}

async function labelNames(b: Record<string, unknown>, _env: Env): Promise<string[]> {
  if (Array.isArray(b.labelNames)) return b.labelNames.map(String)
  if (b.labelName) return [String(b.labelName)]
  if (b.label) return [String(b.label)]
  return []
}
