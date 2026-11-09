import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { logger } from 'hono/logger'
import type { Env } from './lib/types'
import type { AuthCtx } from './lib/auth'
import { fail } from './lib/response'

import auth from './routes/auth'
import users from './routes/users'
import posts from './routes/posts'
import stats from './routes/stats'
import tokens from './routes/tokens'
import upload from './routes/upload'
import album from './routes/album'
import { legacy } from './legacy'
import siteConfig from './routes/siteConfig'
import postAccess from './routes/postAccess'
import { seo } from './routes/seo'
import mail from './routes/mail'
import rebuild from './routes/rebuild'

const app = new Hono<AuthCtx & { Bindings: Env }>()

/* ── 安全响应头 ───────────────────────────────────────────── */
/**
 * 图片代理路径不套 secureHeaders。
 *
 * secureHeaders 默认注入 Cross-Origin-Resource-Policy: same-origin，
 * 会让第三方站点的 <img> 跨域加载失败（后台资源列表显示「加载失败」）。
 * 公开图片本来就该允许任意源引用，这里单独放过。
 */
app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/api/album/file/')) return next()
  return secureHeaders({
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
    contentSecurityPolicy: undefined   // API 不返回 HTML，无需 CSP
  })(c, next)
})

/* ── CORS：只放行白名单源，且允许带 Cookie ────────────────── */
app.use('/api/*', async (c, next) => {
  const allow = (c.env.ALLOWED_ORIGINS || 'https://www.lwsnb.eu.cc,https://lwsnb-poetize.pages.dev')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const origin = c.req.header('Origin') || ''
  /**
   * 除白名单外，放行本项目所有 *.pages.dev 预览域名。
   * Cloudflare Pages 每次部署都生成随机子域（如 42bd6dde.poetize-official.pages.dev），
   * 逐个加白名单不现实；限定 pages.dev 后缀即可，不影响安全边界。
   */
  const isAllowed =
    allow.includes(origin) ||
    /^https:\/\/[a-z0-9-]+\.(poetize-official|lwsnb-poetize|lwsnb-sveltekit)\.pages\.dev$/.test(origin) ||
    /**
     * 本地构建用：预渲染时 Puppeteer 通过 http://127.0.0.1:PORT 访问页面，
     * 页面请求 API 的 Origin 就是 localhost。
     * 不限死端口号，因为插件会随机选可用端口。
     */
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)

  /**
   * 不放行时**不下发** Access-Control-Allow-Origin，而不是回落白名单首项。
   *
   * 回落会让恶意站点拿到一个"看似合法"的 CORS 响应；
   * 配合 credentials: true，浏览器仍会拦截（origin 不匹配），
   * 但缺少 ACAO 头是更明确、更安全的拒绝信号。
   */
  if (!isAllowed) {
    return cors({
      origin: '',
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86400
    })(c, next)
  }

  return cors({
    origin,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400
  })(c, next)
})

/* ── 请求日志（仅开发/调试需要时打开）───────────────────── */
if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
  app.use('*', logger())
}

/* ── 健康检查 ─────────────────────────────────────────────── */
app.get('/api/health', (c) => c.json({
  success: true,
  data: {
    ok: true,
    ts: new Date().toISOString(),
    runtime: 'workerd'
  }
}))

/* ── 业务路由 ─────────────────────────────────────────────── */
app.route('/api/auth', auth)
app.route('/api/users', users)
app.route('/api/posts', posts)
app.route('/api/stats', stats)
app.route('/api/tokens', tokens)
app.route('/api/upload', upload)
app.route('/api/album', album)

/* 官方 Vue2 前端适配层：接口形态与 poetize 原版一致 */
app.route('/api/legacy', legacy)

/* 站点配置（头像/背景/公告等），后台可改 */
app.route('/api/site-config', siteConfig)

/* 文章访问控制：设置等级/密码/登录可见 */
app.route('/api/post-access', postAccess)

/* 邮箱验证码 */
app.route('/api/mail', mail)

/* 一键重建（触发 GitHub Actions） */
app.route('/api/rebuild', rebuild)

/* SEO：sitemap / robots / rss（直接挂在根路径，前端转发过来） */
app.route('/', seo)

/* ── 404 与错误兜底（统一信封，避免泄漏堆栈）─────────────── */
app.notFound((c) => fail('接口不存在', 404, 'not_found'))

app.onError((err, c) => {
  console.error('[api]', err instanceof Error ? err.stack : err)
  return fail('服务器内部错误', 500, 'internal')
})

export default app
