import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Env, UserRow } from '../lib/types'
import { genCsrfToken, CSRF_COOKIE } from '../lib/csrf'
import { rateOkDb } from '../lib/ratelimit'
import { findUserByName } from '../lib/auth'
import { hashPassword, randomToken, sha256, verifyPassword, nowIso } from '../lib/crypto'
import { legacyOk, legacyErr } from './response'
import { toUserVO, roleOf } from '../lib/userModel'
import { generateAvatar } from '../lib/avatar'
import { consumeCode } from '../routes/mail'
import { sendMail, genCode, verifyCodeHtml } from '../lib/mail'

/**
 * 官方 /user/* 适配 —— 与 poetize-server 的 UserServiceImpl 行为对齐。
 *
 * 兼容三处官方细节：
 *   1. 登录字段 account（不是 username）
 *   2. 密码 AES-128-ECB/PKCS7，key = "sarasarasarasara"
 *      Base64 中 '/'→'_'，'+'→'-'
 *   3. 请求体 form-urlencoded（官方 $http.post 第四参 json=false）
 */

const AES_KEY = 'sarasarasarasara'
const SESSION_TTL_H = 24 * 7

export const user = new Hono<{ Bindings: Env }>()

/* ── AES-ECB 解密 ─────────────────────────────────────────── */
async function aesEcbDecrypt(b64Url: string): Promise<string | null> {
  try {
    const b64 = b64Url.replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(b64)
    const data = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i)

    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(AES_KEY), { name: 'AES-CBC' }, false, ['decrypt']
    )

    // WebCrypto 无 ECB：逐 16 字节块用零 IV 做 CBC，等价于 ECB
    const out: Uint8Array[] = []
    const zeroIv = new Uint8Array(16)
    for (let off = 0; off < data.length; off += 16) {
      const dec = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: zeroIv }, key, data.slice(off, off + 16))
      out.push(new Uint8Array(dec))
    }
    const merged = new Uint8Array(out.reduce((n, b) => n + b.length, 0))
    let p = 0
    for (const b of out) { merged.set(b, p); p += b.length }

    const pad = merged[merged.length - 1]
    const end = pad > 0 && pad <= 16 ? merged.length - pad : merged.length
    return new TextDecoder().decode(merged.slice(0, end))
  } catch {
    return null
  }
}

/** 同时支持 form-urlencoded 与 JSON */
async function readBody(c: { req: { header: (k: string) => string | undefined; parseBody: () => Promise<Record<string, unknown>>; json: <T>() => Promise<T> } }): Promise<Record<string, string>> {
  const ctype = c.req.header('Content-Type') || ''
  if (ctype.includes('application/x-www-form-urlencoded') || ctype.includes('multipart/form-data')) {
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>))
    return Object.fromEntries(Object.entries(form as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
  }
  const j = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? '')]))
}

/* ── 限流 ─────────────────────────────────────────────────── */
/**
 * 登录限流 —— 改用 D1 持久化。
 *
 * 原来是内存 Map，实测在多 isolate 环境下形同虚设
 * （和之前修的评论/友链限流是同一个问题）：
 * 每次请求落在不同实例，各自计数都是 1，永远触发不了阈值。
 *
 * 现在走 rate_limit 表，全实例共享计数。
 * 阈值：同一 IP 1 分钟最多 10 次登录尝试。
 */
async function allowed(db: D1Database, ip: string, max = 10, win = 60_000): Promise<boolean> {
  return rateOkDb(db, 'login', ip, max, win)
}

/* ── 建会话 ───────────────────────────────────────────────── */
async function createSession(db: D1Database, userId: number) {
  const sid = randomToken('sess')
  const expires = new Date(Date.now() + SESSION_TTL_H * 3600_000).toISOString()
  await db.batch([
    db.prepare(`INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?1,?2,?3,?4)`)
      .bind(await sha256(sid), userId, nowIso(), expires),
    db.prepare(`UPDATE users SET last_login_at=?1 WHERE id=?2`).bind(nowIso(), userId),
    db.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(nowIso())
  ])
  return { sid, expires }
}

/* ── POST /user/login ─────────────────────────────────────── */
user.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!(await allowed(c.env.DB, ip))) return legacyErr('尝试过于频繁，请稍后再试', 429)

  const b = await readBody(c)
  const account = (b.account || b.username || '').trim()
  const password = b.password || ''
  if (!account || !password) return legacyErr('请输入账号或密码', 400)

  const plain = (await aesEcbDecrypt(password)) ?? password

  // 支持用户名 / 邮箱 / 手机号登录
  const u = await c.env.DB
    .prepare(`SELECT * FROM users WHERE username=?1 OR (email<>'' AND email=?1) OR (phone_number<>'' AND phone_number=?1) LIMIT 1`)
    .bind(account)
    .first<UserRow>()

  const dummy = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
  const passOk = await verifyPassword(plain, u?.password_hash || dummy)

  if (!u || !passOk) return legacyErr('账号或密码错误', 400)
  if (u.disabled || u.user_status === 0) return legacyErr('账号已被禁用', 403)

  const { sid } = await createSession(c.env.DB, u.id)
  setCookie(c, 'sid', sid, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_H * 3600 })
  /**
   * 同时下发 CSRF token。
   * 注意 httpOnly: false —— 前端 JS 必须能读到它才能放进请求头，
   * 这正是双提交 Cookie 的机制：攻击者跨域读不到，就伪造不出来。
   */
  setCookie(c, CSRF_COOKIE, genCsrfToken(), {
    httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_H * 3600
  })

  return legacyOk(toUserVO(u, sid))
})

/* ── GET /user/logout ─────────────────────────────────────── */
user.get('/logout', async (c) => {
  const sid = getCookie(c, 'sid')
  if (sid) await c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash=?1`).bind(await sha256(sid)).run()
  return legacyOk({})
})

/* ── POST /user/regist ────────────────────────────────────── */
user.post('/regist', async (c) => {
  const b = await readBody(c)
  const username = (b.username || '').trim()
  const password = b.password || ''
  const email = (b.email || '').trim()
  const phone = (b.phoneNumber || '').trim()

  // 官方校验：用户名不能是 11 位纯数字（避免与手机号混淆）、不能含 @
  if (!username) return legacyErr('请输入用户名', 400)
  if (/^\d{11}$/.test(username)) return legacyErr('用户名不能为11位数字', 400)
  if (username.includes('@')) return legacyErr('用户名不能包含@', 400)
  if (!/^[\w\u4e00-\u9fa5-]{2,20}$/.test(username)) return legacyErr('用户名 2-20 位', 400)
  if (!password) return legacyErr('请输入密码', 400)

  const plain = (await aesEcbDecrypt(password)) ?? password
  if (plain.length < 6) return legacyErr('密码至少 6 位', 400)

  /**
   * 邮箱验证码校验。
   *
   * 官方前端把验证码放在 code 字段（注册表单第 4 个输入框）。
   * 如果提供了 code 就必须校验通过；不提供则跳过（兼容脚本注册）。
   */
  const code = (b.code || '').trim()
  if (code) {
    if (!email) return legacyErr('未填写邮箱，无法校验验证码', 400)
    const vr = await consumeCode(c.env.DB, email, code, 'register')
    if (!vr.ok) return legacyErr(vr.reason || '验证码错误', 400)
  }

  const dup = await c.env.DB.prepare(`SELECT id FROM users WHERE username=?1`).bind(username).first()
  if (dup) return legacyErr('用户名重复', 409)
  if (email) {
    const e = await c.env.DB.prepare(`SELECT id FROM users WHERE email=?1 AND email<>''`).bind(email).first()
    if (e) return legacyErr('邮箱重复', 409)
  }
  if (phone) {
    const p = await c.env.DB.prepare(`SELECT id FROM users WHERE phone_number=?1 AND phone_number<>''`).bind(phone).first()
    if (p) return legacyErr('手机号重复', 409)
  }

  /**
   * 默认头像用内联 SVG 生成，不用 static 图片。
   *
   * 原来的 randomAvatar() 返回 /assets/avatar-1..4.png，
   * 但这几个文件根本不存在 —— Pages 的 SPA fallback 让它们返回
   * index.html（content-type: text/html），<img> 加载失败显示空白。
   *
   * 现在按用户名哈希取色 + 取首字，零请求且每人不同。
   */
  const avatar = generateAvatar(username)

  const res = await c.env.DB
    .prepare(
      `INSERT INTO users (username,password_hash,role,user_type,user_lv,email,phone_number,avatar,created_at,user_status)
       VALUES (?1,?2,'read',2,1,?3,?4,?5,?6,1)`
    )
    .bind(username, await hashPassword(plain), email, phone, avatar, nowIso())
    .run()

  const id = Number(res.meta.last_row_id)
  const u = await c.env.DB.prepare(`SELECT * FROM users WHERE id=?1`).bind(id).first<UserRow>()
  if (!u) return legacyErr('注册失败', 500)

  const { sid } = await createSession(c.env.DB, id)
  setCookie(c, 'sid', sid, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_H * 3600 })
  /**
   * 同时下发 CSRF token。
   * 注意 httpOnly: false —— 前端 JS 必须能读到它才能放进请求头，
   * 这正是双提交 Cookie 的机制：攻击者跨域读不到，就伪造不出来。
   */
  setCookie(c, CSRF_COOKIE, genCsrfToken(), {
    httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_H * 3600
  })

  return legacyOk(toUserVO(u, sid))
})

/* ── 个人资料 ─────────────────────────────────────────────── */

/** GET /user/getUserInfo —— 按 id 查（公开，只暴露安全字段） */
user.get('/getUserInfo', async (c) => {
  const id = Number(c.req.query('id'))
  if (!Number.isFinite(id)) return legacyErr('id 非法', 400)
  const u = await c.env.DB.prepare(`SELECT * FROM users WHERE id=?1`).bind(id).first<UserRow>()
  if (!u) return legacyErr('用户不存在', 404)

  // 公开信息：不含 email / phone
  return legacyOk({
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    gender: u.gender,
    introduction: u.introduction,
    userLv: u.user_lv,
    createTime: u.created_at,
    isBoss: u.user_type === 0
  })
})

/** POST /user/updateUserInfo —— 改自己的资料 */
user.post('/updateUserInfo', async (c) => {
  const me = await currentUser(c)
  if (!me) return legacyErr('请先登录', 401)

  const b = await readBody(c)
  const sets: string[] = []
  const vals: unknown[] = []

  if (b.avatar !== undefined) { sets.push(`avatar=?${vals.length + 1}`); vals.push(b.avatar) }
  if (b.introduction !== undefined) { sets.push(`introduction=?${vals.length + 1}`); vals.push(b.introduction) }
  if (b.gender !== undefined) { sets.push(`gender=?${vals.length + 1}`); vals.push(Number(b.gender) || 0) }
  if (b.username !== undefined && b.username.trim()) {
    const name = b.username.trim()
    const dup = await c.env.DB.prepare(`SELECT id FROM users WHERE username=?1 AND id<>?2`).bind(name, me.id).first()
    if (dup) return legacyErr('用户名重复', 409)
    sets.push(`username=?${vals.length + 1}`); vals.push(name)
  }

  if (!sets.length) return legacyErr('没有要更新的字段', 400)

  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?${vals.length + 1}`)
    .bind(...vals, me.id).run()

  const u = await c.env.DB.prepare(`SELECT * FROM users WHERE id=?1`).bind(me.id).first<UserRow>()
  return legacyOk(toUserVO(u!))
})

/** 取当前登录用户（支持 Bearer 与 Cookie 两种凭证） */
async function currentUser(c: {
  req: { header: (k: string) => string | undefined }
  env: Env
}): Promise<UserRow | null> {
  // 兼容 Bearer 前缀与裸 token（官方 Vue 前端不带前缀）
  const auth = (c.req.header('Authorization') || '').trim()
  let token = ''
  if (auth && auth !== 'null' && auth !== 'undefined') {
    token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth
  }
  if (!token) {
    const cookie = c.req.header('Cookie') || ''
    token = cookie.match(/sid=([^;]+)/)?.[1] || ''
  }
  if (!token || token === 'null') return null

  return (
    (await c.env.DB
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
          WHERE s.token_hash=?1 AND s.expires_at > ?2`
      )
      .bind(await sha256(token), nowIso())
      .first<UserRow>()) ?? null
  )
}


/**
 * GET /user/getCodeForForgetPassword
 *
 * 官方前端「获取验证码」按钮走这个路径（user.vue getCode）。
 * 拿 email 参数，发 6 位验证码到该邮箱。
 */
user.get('/getCodeForForgetPassword', async (c) => {
  /**
   * 前端 user.vue 的 checkParams() 传的是 **place**，不是 email：
   *   params.place = this.email
   * 只读 email 会导致永远返回「请输入邮箱」。
   * 这里同时兼容 place / email 两种写法。
   */
  const email = (c.req.query('place') || c.req.query('email') || '').trim().toLowerCase()
  if (!email) return legacyErr('请输入邮箱', 400)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return legacyErr('邮箱格式不正确', 400)

  const code = genCode()
  const expires = new Date(Date.now() + 15 * 60_000).toISOString()

  await c.env.DB
    .prepare(`UPDATE email_codes SET used=1 WHERE email=?1 AND used=0`)
    .bind(email).run()

  /**
   * 用途判断 —— 必须区分「注册」和「找回密码」。
   *
   * 前端注册页和找回密码页**共用这个接口**（都传 place + flag=2），
   * 但 regist 校验 purpose='register'、重置密码校验 purpose='reset'。
   *
   * 之前写死 'reset'，导致新用户注册永远报「验证码不存在或已使用」，
   * 实测确认。判据：邮箱是否已注册。
   */
  const exists = await c.env.DB
    .prepare(`SELECT id FROM users WHERE email=?1`)
    .bind(email).first()
  const purpose = exists ? 'reset' : 'register'

  await c.env.DB
    .prepare(`INSERT INTO email_codes (email,code,purpose,attempts,used,expires_at,created_at)
              VALUES (?1,?2,?3,0,0,?4,?5)`)
    .bind(email, code, purpose, expires, nowIso()).run()

  try {
    await sendMail(c.env as never, {
      to: email,
      subject: `【谢谢の博客】验证码 ${code}`,
      html: verifyCodeHtml(code, email.split('@')[0], 15)
    })
  } catch (e) {
    return legacyErr(`邮件发送失败：${(e as Error).message}`, 502)
  }

  return legacyOk({ sent: true })
})

/** GET /user/getCodeForBind —— 绑定手机/邮箱，复用同一逻辑 */
user.get('/getCodeForBind', async (c) => {
  const email = (c.req.query('place') || c.req.query('email') || '').trim().toLowerCase()
  if (!email) return legacyErr('请输入邮箱', 400)

  const code = genCode()
  const expires = new Date(Date.now() + 15 * 60_000).toISOString()
  await c.env.DB.prepare(`UPDATE email_codes SET used=1 WHERE email=?1 AND used=0`).bind(email).run()
  await c.env.DB
    .prepare(`INSERT INTO email_codes (email,code,purpose,attempts,used,expires_at,created_at)
              VALUES (?1,?2,'bind',0,0,?3,?4)`)
    .bind(email, code, expires, nowIso()).run()

  try {
    await sendMail(c.env as never, {
      to: email,
      subject: `【谢谢の博客】验证码 ${code}`,
      html: verifyCodeHtml(code, email.split('@')[0], 15)
    })
  } catch (e) {
    return legacyErr(`邮件发送失败：${(e as Error).message}`, 502)
  }
  return legacyOk({ sent: true })
})


/**
 * POST /user/updateSecretInfo —— 绑定 / 修改邮箱、手机号
 *
 * 前端 user.vue 的 updateSecretInfo() 传的是：
 *   { code, password(AES加密), place, flag }
 *   flag=1 手机号，flag=2 邮箱
 *
 * 之前这个接口**完全没实现**：请求落到 user.all('/*') 兜底，
 * 返回 200 + {}，前端拿到空对象当成功，实际什么都没改 ——
 * 用户表现为「点了绑定没反应」。
 */
user.post('/updateSecretInfo', async (c) => {
  const me = await currentUser(c)
  if (!me) return legacyErr('请先登录', 401)

  const b = await readBody(c)
  const code = String(b.code || '').trim()
  const place = String(b.place || '').trim()
  const flag = Number(b.flag) || 0
  const rawPwd = String(b.password || '')

  if (!code) return legacyErr('请输入验证码', 400)
  if (!place) return legacyErr(flag === 1 ? '请输入手机号' : '请输入邮箱', 400)
  if (!rawPwd) return legacyErr('请输入密码', 400)

  // 密码校验 —— 前端传的是 AES 加密后的，先解出明文
  const plain = await aesEcbDecrypt(rawPwd)
  if (plain === null) return legacyErr('密码格式错误', 400)
  const okPwd = await verifyPassword(plain, me.password_hash)
  if (!okPwd) return legacyErr('密码错误', 401)

  const target = flag === 2 ? place.toLowerCase() : place

  // 验证码必须是 bind 用途
  const check = await consumeCode(c.env.DB, target, code, 'bind')
  if (!check.ok) return legacyErr(check.reason || '验证码错误', 400)

  // 唯一性检查
  if (flag === 2) {
    const dup = await c.env.DB
      .prepare(`SELECT id FROM users WHERE email=?1 AND id<>?2`)
      .bind(target, me.id).first()
    if (dup) return legacyErr('该邮箱已被其他账号绑定', 409)
    await c.env.DB.prepare(`UPDATE users SET email=?1 WHERE id=?2`).bind(target, me.id).run()
  } else {
    const dup = await c.env.DB
      .prepare(`SELECT id FROM users WHERE phone_number=?1 AND id<>?2`)
      .bind(target, me.id).first()
    if (dup) return legacyErr('该手机号已被其他账号绑定', 409)
    await c.env.DB.prepare(`UPDATE users SET phone_number=?1 WHERE id=?2`).bind(target, me.id).run()
  }

  const row = await c.env.DB.prepare(`SELECT * FROM users WHERE id=?1`).bind(me.id).first<UserRow>()
  return legacyOk(toUserVO(row!))
})

/**
 * POST /user/updateForForgetPassword —— 忘记密码重置
 *
 * 前端传 { code, password, place, flag }
 * 用 getCodeForForgetPassword 发的验证码（purpose='reset'）。
 * 之前同样没实现。
 */
user.post('/updateForForgetPassword', async (c) => {
  const b = await readBody(c)
  const code = String(b.code || '').trim()
  const place = String(b.place || '').trim().toLowerCase()
  const rawPwd = String(b.password || '')

  if (!code) return legacyErr('请输入验证码', 400)
  if (!place) return legacyErr('请输入邮箱', 400)
  if (!rawPwd) return legacyErr('请输入新密码', 400)

  const plain = await aesEcbDecrypt(rawPwd)
  if (plain === null) return legacyErr('密码格式错误', 400)
  if (plain.length < 6) return legacyErr('密码至少 6 位', 400)

  const check = await consumeCode(c.env.DB, place, code, 'reset')
  if (!check.ok) return legacyErr(check.reason || '验证码错误', 400)

  const user = await c.env.DB
    .prepare(`SELECT id FROM users WHERE email=?1`)
    .bind(place).first<{ id: number }>()
  if (!user) return legacyErr('该邮箱未注册', 404)

  const hash = await hashPassword(plain)
  await c.env.DB.prepare(`UPDATE users SET password_hash=?1 WHERE id=?2`).bind(hash, user.id).run()
  // 改密后清掉所有会话，强制重新登录
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=?1`).bind(user.id).run()

  return legacyOk({ updated: true })
})


/**
 * GET /user/subscribe —— 订阅 / 取消订阅专栏（标签）
 *
 * 前端 article.vue 点小手时调用，参数：
 *   labelId  标签 id
 *   flag     true=订阅，false=取消
 *
 * 数据存 users.subscribe，格式是 JSON 数组字符串，如 ["6","9"]。
 * 之前这个接口完全没实现，点了没反应。
 */
user.get('/subscribe', async (c) => {
  const me = await currentUser(c)
  if (!me) return legacyErr('请先登录', 401)

  const labelId = String(c.req.query('labelId') || '').trim()
  const flag = String(c.req.query('flag')) === 'true'
  if (!labelId) return legacyErr('缺少 labelId', 400)

  // 解析当前订阅列表
  let list: string[] = []
  try {
    const parsed = JSON.parse(me.subscribe || '[]')
    if (Array.isArray(parsed)) list = parsed.map(String)
  } catch { list = [] }

  const has = list.includes(labelId)

  if (flag && !has) {
    list.push(labelId)
  } else if (!flag && has) {
    list = list.filter(x => x !== labelId)
  }

  const next = JSON.stringify(list)
  await c.env.DB.prepare(`UPDATE users SET subscribe=?1 WHERE id=?2`)
    .bind(next, me.id).run()

  // 返回最新的用户对象，前端会 commit 到 Vuex
  const row = await c.env.DB.prepare(`SELECT * FROM users WHERE id=?1`)
    .bind(me.id).first<UserRow>()

  return legacyOk(toUserVO(row!))
})

/** 其余 user/* 占位 */
user.all('/*', (c) => legacyOk({}))
