import { Hono } from 'hono'
import type { Env, UserRow } from '../lib/types'
import { legacyOk, legacyErr } from './response'
import { requireWrite, requireLogin, guardUser } from './guard'
import { rateOkDb } from '../lib/ratelimit'
import { currentUserLite } from '../lib/auth'
import { nowIso } from '../lib/crypto'
import { sanitizeText, sanitizeUrl } from '../lib/sanitize'
import { b2Client, extOf } from '../lib/b2'

/**
 * 资源 / 留言（微言）/ 表白墙 / 树洞 —— 对齐官方实体。
 *
 * 官方表：Resource WeiYan Family TreeHole
 * 本项目对应：poem_resource poem_weiyan poem_family poem_treehole
 */
export const modules = new Hono<{ Bindings: Env }>()

async function me(c: { req: { header: (k: string) => string | undefined }; env: Env }) {
  return currentUserLite(c.env.DB, c.req.header('Authorization'), c.req.header('Cookie'))
}

async function userMapOf(db: D1Database, ids: number[]) {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length) return new Map<number, UserRow>()
  const ph = uniq.map((_, i) => `?${i + 1}`).join(',')
  const { results } = await db.prepare(`SELECT * FROM users WHERE id IN (${ph})`).bind(...uniq).all<UserRow>()
  return new Map(results.map(u => [u.id, u]))
}

/* ══════════════════ 资源（相册/收藏夹） ══════════════════ */

/** POST /resource/listResource */
modules.post('/resource/listResource', async (c) => {
  const b = await c.req.json<{ current?: number; size?: number; type?: string }>()
    .catch(() => ({} as { current?: number; size?: number; type?: string }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 12))
  const type = b.type || ''

  const where = type ? `WHERE deleted=0 AND type=?1` : `WHERE deleted=0`
  const params = type ? [type] : []

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_resource ${where}`)
    .bind(...params).first<{ c: number }>())?.c ?? 0

  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_resource ${where} ORDER BY id DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`)
    .bind(...params, size, (current - 1) * size)
    .all()

  return legacyOk({
    records: (results as Record<string, unknown>[]).map(r => ({
      id: r.id, path: r.path, type: r.type, status: !!r.status,
      size: r.size, mimeType: r.mime_type, originalName: r.original_name,
      createTime: r.create_time, userId: r.user_id
    })),
    total, size, current, pages: Math.ceil(total / size)
  })
})

/** POST /resource/saveResource —— 登记已上传的文件 */
modules.post('/resource/saveResource', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const u = await me(c)
  if (!u) return legacyErr('请先登录', 401)
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const path = String(b.path || '').trim()
  if (!path) return legacyErr('path 不能为空', 400)

  const res = await c.env.DB
    .prepare(`INSERT INTO poem_resource (user_id,type,status,store_type,path,size,mime_type,original_name,create_time,deleted)
              VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,0)`)
    .bind(u.id, String(b.type || 'picture'), String(b.storeType || 'b2'), path,
      Number(b.size) || 0, String(b.mimeType || ''), String(b.originalName || ''), nowIso())
    .run()
  return legacyOk({ id: Number(res.meta.last_row_id) })
})

/** GET /resource/changeResourceStatus / deleteResource */
modules.get('/resource/changeResourceStatus', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)
  await c.env.DB.prepare(`UPDATE poem_resource SET status=1-status WHERE id=?1`).bind(id).run()
  return legacyOk({ toggled: true })
})

modules.get('/resource/deleteResource', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)
  await c.env.DB.prepare(`UPDATE poem_resource SET deleted=1 WHERE id=?1`).bind(id).run()
  return legacyOk({ deleted: true })
})

/**
 * POST /resource/upload —— 前端上传入口
 *
 * 前端 postEdit.vue 用 multipart 上传封面/图片，
 * 期望返回 { path } 或 { url }。这里直传 B2 并登记 poem_resource。
 */
modules.post('/resource/upload', async (c) => {
  const u = await me(c)
  if (!u) return legacyErr('请先登录', 401)

  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file') ?? form?.get('multipartFile')
  if (!file || typeof file === 'string') return legacyErr('缺少文件', 400)

  const mime = file.type || 'application/octet-stream'
  const isImage = mime.startsWith('image/')
  const key = `${isImage ? 'album' : 'files'}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extOf(mime)}`

  /**
   * 写入 B2 后返回**代理路径**而不是 B2_PUBLIC_URL。
   *
   * img.lwsnb.eu.cc 这个自定义域名当前不通（404），
   * 而 /api/album/file/<key> 是 Worker 内部代理，实测 200 且正确返回图片。
   * 前端只需要能显示的 URL，用代理最稳。
   */
  await b2Client(c.env).put(key, await file.arrayBuffer(), mime)
  // 绝对地址：前端在 *.pages.dev，相对路径会打到前端域名上
  const url = `https://api.lwsnb.eu.cc/api/album/file/${key}`

  await c.env.DB
    .prepare(`INSERT INTO poem_resource (user_id,type,status,store_type,path,size,mime_type,original_name,create_time,deleted)
              VALUES (?1,?2,1,'b2',?3,?4,?5,?6,?7,0)`)
    .bind(u.id, isImage ? 'picture' : 'file', url, file.size, mime, file.name || key, nowIso())
    .run()

  return legacyOk({ path: url, url, key, size: file.size, mimeType: mime })
})

/** GET /qiniu/getUpToken —— 本项目不用七牛，返回空避免前端报错 */
modules.get('/qiniu/getUpToken', (c) => legacyOk({ token: '', enable: false }))

/* ══════════════════ 微言 / 留言 ══════════════════ */

/** POST /weiYan/listWeiYan */
modules.post('/weiYan/listWeiYan', async (c) => {
  const b = await c.req.json<{ current?: number; size?: number; type?: string }>()
    .catch(() => ({} as { current?: number; size?: number; type?: string }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))
  const type = b.type || ''

  /**
   * jotting（随笔）页不传 type，需要返回所有公开微言；
   * 传 type 时按类型过滤。
   */
  const where = type ? `WHERE deleted=0 AND is_public=1 AND type=?1` : `WHERE deleted=0 AND is_public=1`
  const params = type ? [type] : []

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_weiyan ${where}`)
    .bind(...params).first<{ c: number }>())?.c ?? 0

  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_weiyan ${where} ORDER BY id DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`)
    .bind(...params, size, (current - 1) * size)
    .all<Record<string, unknown>>()

  const users = await userMapOf(c.env.DB, results.map(r => Number(r.user_id)))

  return legacyOk({
    records: results.map(r => {
      const u = users.get(Number(r.user_id))
      return {
        id: r.id, userId: r.user_id,
        username: u?.username || '匿名',
        avatar: u?.avatar || '',
        userLv: u?.user_lv ?? 1,
        content: r.content, likeCount: r.like_count,
        type: r.type, createTime: r.create_time
      }
    }),
    total, size, current, pages: Math.ceil(total / size)
  })
})

/** POST /weiYan/saveWeiYan */
modules.post('/weiYan/saveWeiYan', async (c) => {
  // 微言是用户发布内容，登录即可
  const denied = await requireLogin(c)
  if (denied) return denied

  const _wu = await guardUser(c)
  if (_wu && !(await rateOkDb(c.env.DB, 'weiyan', _wu.id, 3, 60_000))) {
    return legacyErr('发布太频繁，请稍后再试', 429)
  }
  const u = await me(c)
  if (!u) return legacyErr('请先登录', 401)
  const b = await c.req.json<{ content?: string; type?: string; isPublic?: boolean }>()
    .catch(() => ({} as { content?: string; type?: string; isPublic?: boolean }))
  const raw = String(b.content || '').trim()
  if (!raw) return legacyErr('内容不能为空', 400)
  const content = sanitizeText(raw)

  const res = await c.env.DB
    .prepare(`INSERT INTO poem_weiyan (user_id,like_count,content,is_public,type,source,create_time,deleted)
              VALUES (?1,0,?2,?3,?4,0,?5,0)`)
    /**
     * 前端 jotting 页只传 { content, isPublic }，不传 type。
     * 默认归为 jotting（随笔），否则随笔页拿不到数据。
     */
    .bind(u.id, content, b.isPublic === false ? 0 : 1, String(b.type || 'jotting'), nowIso())
    .run()
  return legacyOk({ id: Number(res.meta.last_row_id) })
})

/** GET /weiYan/deleteWeiYan */
modules.get('/weiYan/deleteWeiYan', async (c) => {
  // 登录即可，下面会判断「本人或站长」
  const u = await me(c)
  if (!u) return legacyErr('请先登录', 401)
  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)

  const row = await c.env.DB.prepare(`SELECT user_id FROM poem_weiyan WHERE id=?1`).bind(id).first<{ user_id: number }>()
  if (!row) return legacyErr('不存在', 404)
  // 只能删自己的，或站长可删全部
  if (row.user_id !== u.id && u.user_type !== 0) return legacyErr('无权删除', 403)

  await c.env.DB.prepare(`UPDATE poem_weiyan SET deleted=1 WHERE id=?1`).bind(id).run()
  return legacyOk({ deleted: true })
})

/** 留言板：listNews / saveNews */
modules.post('/weiYan/listNews', async (c) => {
  const b = await c.req.json<{ current?: number; size?: number }>()
    .catch(() => ({} as { current?: number; size?: number }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_weiyan WHERE deleted=0 AND type='news'`)
    .first<{ c: number }>())?.c ?? 0
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_weiyan WHERE deleted=0 AND type='news' ORDER BY id DESC LIMIT ?1 OFFSET ?2`)
    .bind(size, (current - 1) * size)
    .all<Record<string, unknown>>()

  const users = await userMapOf(c.env.DB, results.map(r => Number(r.user_id)))
  return legacyOk({
    records: results.map(r => {
      const u = users.get(Number(r.user_id))
      return { id: r.id, userId: r.user_id, username: u?.username || '匿名',
        avatar: u?.avatar || '', content: r.content, createTime: r.create_time }
    }),
    total, size, current, pages: Math.ceil(total / size)
  })
})

modules.post('/weiYan/saveNews', async (c) => {
  // 留言板，登录即可
  const denied = await requireLogin(c)
  if (denied) return denied
  const u = await me(c)
  if (!u) return legacyErr('请先登录', 401)
  const b = await c.req.json<{ content?: string }>().catch(() => ({} as { content?: string }))
  const raw = String(b.content || '').trim()
  if (!raw) return legacyErr('内容不能为空', 400)
  const content = sanitizeText(raw)

  const res = await c.env.DB
    .prepare(`INSERT INTO poem_weiyan (user_id,like_count,content,is_public,type,source,create_time,deleted)
              VALUES (?1,0,?2,1,'news',0,?3,0)`)
    .bind(u.id, content, nowIso()).run()
  return legacyOk({ id: Number(res.meta.last_row_id) })
})


/* ══════════════════ 友链（friend） ══════════════════ */

/**
 * POST /webInfo/saveFriend —— 提交友链申请
 *
 * 前端 friend.vue 提交 { title, introduction, cover, url }，
 * 提交后提示「待管理员审核」——所以必须落库为 status=0，
 * 不能直接展示。
 *
 * 登录不做强制要求（友链是公开申请渠道），
 * 但登录了会记下 user_id 便于追溯。
 */
modules.post('/webInfo/saveFriend', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
  if (!(await rateOkDb(c.env.DB, 'friend', ip, 3, 10 * 60_000))) {
    return legacyErr('提交过于频繁，请 10 分钟后再试', 429)
  }

  const me = await guardUser(c)
  const b = await c.req.json<{ title?: string; introduction?: string; cover?: string; url?: string }>()
    .catch(() => ({} as { title?: string; introduction?: string; cover?: string; url?: string }))

  const title = sanitizeText(String(b.title || '').trim())
  const introduction = sanitizeText(String(b.introduction || '').trim())
  const cover = sanitizeUrl(String(b.cover || '').trim())
  const url = sanitizeUrl(String(b.url || '').trim())

  if (!title) return legacyErr('请填写网站名称', 400)
  if (title.length > 30) return legacyErr('名称最多 30 字', 400)
  if (!url) return legacyErr('请填写有效的网址（http/https）', 400)

  // 同一网址不重复提交
  const dup = await c.env.DB
    .prepare(`SELECT id FROM poem_friend WHERE url=?1 AND deleted=0 AND status IN (0,1)`)
    .bind(url).first()
  if (dup) return legacyErr('该网址已提交过，请等待审核', 409)

  const res = await c.env.DB
    .prepare(`INSERT INTO poem_friend (title,introduction,cover,url,status,sort_order,user_id,create_time,deleted)
              VALUES (?1,?2,?3,?4,0,0,?5,?6,0)`)
    .bind(title, introduction, cover, url, me?.id ?? 0, nowIso()).run()

  return legacyOk({ id: Number(res.meta.last_row_id), status: 0 })
})

/**
 * GET /webInfo/listFriend —— 已审核通过的友链（前台展示）
 *
 * **必须返回分组对象**，不是数组。
 * friend.vue 的模板是：
 *   friendList.hasOwnProperty('🥇友情链接')
 *   <card :resourcePathList="friendList['🥇友情链接']">
 *   v-for="(value, key) in friendList"
 * 返回数组的话 hasOwnProperty 全是 false，页面一片空白。
 */
modules.get('/webInfo/listFriend', async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT id,title,introduction,cover,url,sort_order,create_time FROM poem_friend
              WHERE deleted=0 AND status=1 ORDER BY sort_order DESC, id ASC`)
    .all<Record<string, unknown>>()

  const items = results.map(r => ({
    id: r.id,
    title: r.title,
    // card.vue 用 introduction 当描述
    introduction: r.introduction,
    cover: r.cover,
    url: r.url,
    // card.vue 可能读取这两个字段，补上避免 undefined
    type: 'friend',
    createTime: r.create_time
  }))

  // 全部归到「🥇友情链接」分组 —— 前端对这个 key 有专门的固定标题
  const grouped: Record<string, typeof items> = {}
  if (items.length) grouped['🥇友情链接'] = items
  return legacyOk(grouped)
})

/**
 * GET /webInfo/listAdminFriend —— 后台审核列表
 * status 可选：0 待审核 / 1 已通过 / 2 已拒绝；不传返回全部
 */
modules.get('/webInfo/listAdminFriend', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied

  const status = c.req.query('status')
  const where = status === undefined || status === ''
    ? `deleted=0`
    : `deleted=0 AND status=${Number(status) || 0}`

  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_friend WHERE ${where} ORDER BY status ASC, id DESC`)
    .all<Record<string, unknown>>()

  return legacyOk(results.map(r => ({
    id: r.id,
    title: r.title,
    introduction: r.introduction,
    cover: r.cover,
    url: r.url,
    status: r.status,
    sortOrder: r.sort_order,
    userId: r.user_id,
    createTime: r.create_time
  })))
})

/** GET /webInfo/auditFriend?id=&status= —— 审核（1 通过 / 2 拒绝） */
modules.get('/webInfo/auditFriend', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied

  const id = Number(c.req.query('id'))
  const status = Number(c.req.query('status'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)
  if (status !== 1 && status !== 2) return legacyErr('status 只能是 1 或 2', 400)

  await c.env.DB.prepare(`UPDATE poem_friend SET status=?1 WHERE id=?2`).bind(status, id).run()
  return legacyOk({ id, status })
})

/** GET /webInfo/deleteFriend?id= —— 删除 */
modules.get('/webInfo/deleteFriend', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied

  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)

  await c.env.DB.prepare(`UPDATE poem_friend SET deleted=1 WHERE id=?1`).bind(id).run()
  return legacyOk({ deleted: true })
})

/** POST /webInfo/updateFriend —— 后台编辑友链 */
modules.post('/webInfo/updateFriend', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied

  const b = await c.req.json<{ id?: number; title?: string; introduction?: string; cover?: string; url?: string; sortOrder?: number }>()
    .catch(() => ({} as { id?: number; title?: string; introduction?: string; cover?: string; url?: string; sortOrder?: number }))
  const id = Number(b.id)
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)

  const sets: string[] = []
  const vals: unknown[] = []
  const push = (col: string, v: unknown) => { sets.push(`${col}=?${vals.length + 1}`); vals.push(v) }

  if (b.title !== undefined) push('title', sanitizeText(String(b.title).trim()))
  if (b.introduction !== undefined) push('introduction', sanitizeText(String(b.introduction).trim()))
  if (b.cover !== undefined) push('cover', sanitizeUrl(String(b.cover).trim()))
  if (b.url !== undefined) push('url', sanitizeUrl(String(b.url).trim()))
  if (b.sortOrder !== undefined) push('sort_order', Number(b.sortOrder) || 0)

  if (!sets.length) return legacyErr('没有要更新的字段', 400)

  await c.env.DB.prepare(`UPDATE poem_friend SET ${sets.join(',')} WHERE id=?${vals.length + 1}`)
    .bind(...vals, id).run()
  return legacyOk({ updated: true })
})

/* ══════════════════ 表白墙 / 恋爱笔记 ══════════════════ */

modules.post('/family/listFamily', async (c) => {
  const b = await c.req.json<{ current?: number; size?: number }>()
    .catch(() => ({} as { current?: number; size?: number }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_family WHERE deleted=0`)
    .first<{ c: number }>())?.c ?? 0
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_family WHERE deleted=0 ORDER BY id DESC LIMIT ?1 OFFSET ?2`)
    .bind(size, (current - 1) * size)
    .all()

  return legacyOk({ records: results, total, size, current, pages: Math.ceil(total / size) })
})

/**
 * GET /family/getAdminFamily —— 恋爱页主数据（站长那条记录）
 * GET /family/getFamily      —— 当前登录用户自己的记录
 * 前端 love.vue 优先用 getAdminFamily。
 */
modules.get('/family/getAdminFamily', async (c) => {
  const row = await c.env.DB
    .prepare(`SELECT * FROM poem_family WHERE deleted=0 ORDER BY id ASC LIMIT 1`)
    .first<Record<string, unknown>>()
  if (!row) return legacyOk(null)
  return legacyOk({
    id: row.id, userId: row.user_id,
    bgCover: row.bg_cover, manCover: row.man_cover, womanCover: row.woman_cover,
    manName: row.man_name, womanName: row.woman_name,
    timing: row.timing, countdownTitle: row.countdown_title,
    timeTitle: row.time_title || '',
    countdownTime: row.countdown_time || '',
    status: !!row.status
  })
})

modules.get('/family/getFamily', async (c) => {
  const u = await me(c)
  if (!u) return legacyErr('请先登录', 401)
  const row = await c.env.DB
    .prepare(`SELECT * FROM poem_family WHERE deleted=0 AND user_id=?1 ORDER BY id DESC LIMIT 1`)
    .bind(u.id).first<Record<string, unknown>>()
  if (!row) return legacyOk(null)
  return legacyOk({
    id: row.id, userId: row.user_id,
    bgCover: row.bg_cover, manCover: row.man_cover, womanCover: row.woman_cover,
    manName: row.man_name, womanName: row.woman_name,
    timing: row.timing, countdownTitle: row.countdown_title,
    timeTitle: row.time_title || '',
    countdownTime: row.countdown_time || '',
    status: !!row.status
  })
})

modules.get('/family/listRandomFamily', async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_family WHERE deleted=0 AND status=1 ORDER BY RANDOM() LIMIT 6`)
    .all()
  return legacyOk(results)
})

modules.post('/family/saveFamily', async (c) => {
  // 表白墙，登录即可
  const denied = await requireLogin(c)
  if (denied) return denied
  const u = await me(c)
  if (!u) return legacyErr('请先登录', 401)
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))

  const res = await c.env.DB
    .prepare(`INSERT INTO poem_family (user_id,bg_cover,man_cover,woman_cover,man_name,woman_name,timing,countdown_title,status,create_time,deleted)
              VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9,0)`)
    .bind(u.id, String(b.bgCover || ''), String(b.manCover || ''), String(b.womanCover || ''),
      String(b.manName || ''), String(b.womanName || ''), String(b.timing || ''),
      String(b.countdownTitle || ''), nowIso())
    .run()
  return legacyOk({ id: Number(res.meta.last_row_id) })
})

modules.get('/family/deleteFamily', async (c) => {
  const u = await me(c)
  if (!u) return legacyErr('请先登录', 401)
  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)

  const row = await c.env.DB.prepare(`SELECT user_id FROM poem_family WHERE id=?1`)
    .bind(id).first<{ user_id: number }>()
  if (!row) return legacyErr('不存在', 404)
  // 管理员可删任意，普通用户只能删自己发的
  if (row.user_id !== u.id && u.user_type > 1) return legacyErr('无权删除', 403)

  await c.env.DB.prepare(`UPDATE poem_family SET deleted=1 WHERE id=?1`).bind(id).run()
  return legacyOk({ deleted: true })
})

modules.get('/family/changeLoveStatus', async (c) => {
  const denied = await requireWrite(c)
  if (denied) return denied
  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)
  await c.env.DB.prepare(`UPDATE poem_family SET status=1-status WHERE id=?1`).bind(id).run()
  return legacyOk({ toggled: true })
})

/* ══════════════════ 收藏夹（favorite） ══════════════════ */

/**
 * GET /webInfo/listCollect —— 收藏夹列表
 *
 * favorite.vue 直接 GET 后遍历 res.data，返回数组。
 * 收藏项存 poem_resource 里 type='collect' 的记录。
 */
modules.get('/webInfo/listCollect', async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_resource WHERE deleted=0 AND type='collect' ORDER BY id DESC LIMIT 200`)
    .all<Record<string, unknown>>()

  /**
   * 前端模板是 v-for="(value, key) in collects"，value 为数组，
   * 所以必须返回**分组对象**：{ 分类名: [ {title,url,...}, ... ] }
   */
  const grouped: Record<string, unknown[]> = {}
  for (const r of results) {
    const key = String(r.original_name || '未分类').split('/')[0] || '未分类'
    if (!grouped[key]) grouped[key] = []
    grouped[key].push({
      id: r.id,
      title: String(r.original_name || '未命名').split('/').pop(),
      cover: r.path || '',
      url: r.path || '',
      createTime: r.create_time
    })
  }

  // 空表时给一个占位分组，避免页面完全空白
  if (!Object.keys(grouped).length) {
    grouped['默认收藏'] = []
  }

  return legacyOk(grouped)
})

/* ══════════════════ 树洞 ══════════════════ */

/**
 * GET /webInfo/listTreeHole —— 树洞弹幕
 *
 * **前端 message.vue 用的是 GET，且直接对 res.data 做 forEach，**
 * 所以这里必须返回**数组**而不是分页对象，否则弹幕为空。
 */
modules.get('/webInfo/listTreeHole', async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_treehole WHERE deleted=0 ORDER BY id DESC LIMIT 100`)
    .all<Record<string, unknown>>()

  return legacyOk(
    results.map(r => ({
      id: r.id,
      avatar: r.avatar || '',
      message: r.message,
      createTime: r.create_time
    }))
  )
})

/** POST 版本兼容（后台列表用分页） */
modules.post('/webInfo/listTreeHole', async (c) => {
  const b = await c.req.json<{ current?: number; size?: number }>()
    .catch(() => ({} as { current?: number; size?: number }))
  const current = Math.max(1, Number(b.current) || 1)
  const size = Math.min(50, Math.max(1, Number(b.size) || 10))

  const total = (await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_treehole WHERE deleted=0`)
    .first<{ c: number }>())?.c ?? 0
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM poem_treehole WHERE deleted=0 ORDER BY id DESC LIMIT ?1 OFFSET ?2`)
    .bind(size, (current - 1) * size)
    .all()

  return legacyOk({ records: results, total, size, current, pages: Math.ceil(total / size) })
})

modules.post('/webInfo/saveTreeHole', async (c) => {
  /**
   * 树洞是用户公开发言的地方，**登录即可**，不需要管理员。
   * （之前误用 requireWrite，导致普通用户发不了树洞）
   */
  const denied = await requireLogin(c)
  if (denied) return denied

  const me = await guardUser(c)

  // 防刷屏：同一用户 1 分钟最多 3 条树洞
  if (me && !(await rateOkDb(c.env.DB, 'treehole', me.id, 3, 60_000))) {
    return legacyErr('发言太频繁，请稍后再试', 429)
  }

  const b = await c.req.json<{ message?: string; avatar?: string }>()
    .catch(() => ({} as { message?: string; avatar?: string }))
  const rawMsg = String(b.message || '').trim()
  if (!rawMsg) return legacyErr('内容不能为空', 400)
  const message = sanitizeText(rawMsg)

  const res = await c.env.DB
    .prepare(`INSERT INTO poem_treehole (avatar,message,create_time,deleted,user_id) VALUES (?1,?2,?3,0,?4)`)
    .bind(String(b.avatar || ''), message, nowIso(), me?.id ?? 0).run()
  return legacyOk({ id: Number(res.meta.last_row_id) })
})

modules.get('/webInfo/deleteTreeHole', async (c) => {
  const denied = await requireLogin(c)
  if (denied) return denied

  const me = await guardUser(c)
  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)

  const row = await c.env.DB
    .prepare(`SELECT user_id FROM poem_treehole WHERE id=?1`)
    .bind(id).first<{ user_id: number }>()
  if (!row) return legacyErr('树洞不存在', 404)

  // 管理员可删任意，普通用户只能删自己发的
  const isAdmin = me && me.user_type <= 1
  if (!isAdmin && row.user_id !== me?.id) {
    return legacyErr('只能删除自己发的树洞', 403)
  }

  await c.env.DB.prepare(`UPDATE poem_treehole SET deleted=1 WHERE id=?1`).bind(id).run()
  return legacyOk({ deleted: true })
})
