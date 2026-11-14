/**
 * CSRF 防护
 *
 * 背景：
 *   登录会同时下发 Cookie（sid）和返回 accessToken。
 *   前端用 Authorization 头，但 **Cookie 也是被后端接受的凭证**，
 *   浏览器会自动携带 Cookie —— 这就是 CSRF 攻击面。
 *
 *   更严重的是：有 18 个写操作注册在 GET 上
 *   （deleteArticle / changeUserLv / deleteUser 等）。
 *   SameSite=Lax 只挡跨站 POST，**不挡顶级导航的 GET**。
 *   攻击者诱导管理员点一个链接就能删用户。
 *
 * 方案：双提交 Cookie（double-submit cookie）
 *   1. 登录时同时下发一个非 HttpOnly 的 csrf cookie
 *   2. 前端每次请求把该值放进 X-CSRF-Token 头
 *   3. 后端比对 cookie 与 header
 *
 *   攻击者能诱导浏览器发请求（带 cookie），
 *   但读不到 csrf cookie 的值（跨域读不到），
 *   所以伪造不出匹配的 header。
 *
 * 豁免：
 *   - 使用 Bearer / 裸 token 的请求（脚本、预渲染）不需要 CSRF，
 *     因为它们不依赖浏览器自动携带的 Cookie
 *   - GET 且无 Cookie 的请求（纯 token 鉴权）
 */

const CSRF_COOKIE = 'csrf'
const CSRF_HEADER = 'X-CSRF-Token'

/** 生成随机 token（32 字节 hex） */
export function genCsrfToken(): string {
  const arr = crypto.getRandomValues(new Uint8Array(32))
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 校验 CSRF。
 *
 * @returns true 通过，false 拒绝
 */
export function checkCsrf(
  method: string,
  cookieHeader: string | undefined,
  csrfHeader: string | undefined,
  authorization: string | undefined
): boolean {
  // 1) 用 Authorization 的请求豁免 —— 不依赖 Cookie，无 CSRF 风险
  const auth = (authorization || '').trim()
  if (auth && auth !== 'null' && auth !== 'undefined') return true

  // 2) 没有 sid cookie 也豁免（未登录，靠 401 拦）
  const cookies = cookieHeader || ''
  const hasSid = /(?:^|;\s*)sid=/.test(cookies)
  if (!hasSid) return true

  // 3) 从 cookie 里取 csrf
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]+)`))
  const cookieToken = m ? m[1] : ''
  const headerToken = (csrfHeader || '').trim()

  if (!cookieToken || !headerToken) return false

  // 4) 恒定时间比较
  if (cookieToken.length !== headerToken.length) return false
  let diff = 0
  for (let i = 0; i < cookieToken.length; i++) {
    diff |= cookieToken.charCodeAt(i) ^ headerToken.charCodeAt(i)
  }
  return diff === 0
}

export { CSRF_COOKIE, CSRF_HEADER }
