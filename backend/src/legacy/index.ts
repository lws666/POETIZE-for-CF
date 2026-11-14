import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { legacyOk as ok, legacyErr } from './response'
import { readConfig } from '../lib/siteConfig'
import { webInfo } from './webinfo'
import { article } from './article'
import { user } from './user'
import { admin } from './admin'
import { comment } from './comment'
import { modules } from './modules'
import { history } from './history'

/**
 * 官方 Vue2 前端适配层。
 *
 * 官方前端启动即并发请求：
 *   POST /webInfo/getWebInfo
 *   GET  /sysConfig/listSysConfig
 *   GET  /webInfo/getSortInfo
 * 任一失败就白屏，所以这三个必须返回合法结构。
 *
 * 挂载方式（见 index.ts）：
 *   app.route('/api/legacy', legacyRouter)
 *   前端 axios baseURL 指到 https://api.lwsnb.eu.cc/api/legacy
 */
export const legacy = new Hono<{ Bindings: Env }>()

legacy.route('/', admin)
/* 访问统计（/history/record 记录，/history/info 查询） */
legacy.route('/history', history)
/* 资源 / 微言 / 留言 / 表白墙 / 树洞 —— 必须早于 webInfo，
   否则会被 webInfo 的 all('/*') 兜底吃掉 */
legacy.route('/', modules)
legacy.route('/webInfo', webInfo)
legacy.route('/article', article)

/**
 * GET /sysConfig/listSysConfig
 *
 * **不能返回空对象。** home.vue 根节点是
 *   <div v-if="!\$common.isEmpty(\$store.state.sysConfig)">
 * isEmpty({}) 为真 → 整个首页不渲染，#app 内只剩 <!---->。
 *
 * 官方 sysConfig 至少需要下列字段（前端各处直接读取）：
 *   webStaticResourcePrefix  静态资源前缀
 *   qiniuUrl / beian         备案号等
 *   friend*                  友人帐字段（archive/links 页用）
 */
/** 取站长的 userId（user_type=0），前端判断「能否写随笔」用 */
async function bossUserId(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT id FROM users WHERE user_type=0 ORDER BY id LIMIT 1`)
    .first<{ id: number }>()
  return row?.id ?? 1
}

legacy.get('/sysConfig/listSysConfig', async (c) => {
  const cfg = await readConfig(c.env.DB)

  /**
   * 前端会拼成 prefix + 'assets/xxx.png' 或用 sysConfig["a.b"] 直接取值：
   *   - webStaticResourcePrefix 必须是 '/'
   *   - bar.menu.show 被 .includes() 调用，缺了就 TypeError 白屏
   * 两者都由 readConfig 的 DEFAULTS 兜底，这里再显式传出。
   */
  return ok({
    webStaticResourcePrefix: cfg.webStaticResourcePrefix,
    'bar.menu.show': cfg['bar.menu.show'],
    'local.enable': cfg['local.enable'],
    /** 首页「每日推荐」弹窗开关，默认关闭 */
    'push.enable': cfg['push.enable'] ?? 'false',
    'qiniu.enable': cfg['qiniu.enable'],
    /** 前端用它显示「存储平台」，缺失时会渲染成 undefined */
    defaultStoreType: 'b2',
    storeType: 'b2',
    /**
     * 站长 userId —— 前端 constant.userId 写死 1，
     * 但本项目 admin 是 id=14，导致随笔页「+」按钮判断失败不显示。
     * 由后端下发真实 id，前端读这里。
     */
    userId: String(await bossUserId(c.env.DB)),
    'qiniu.downloadUrl': '',
    friendWebName: cfg.friendWebName,
    friendUrl: cfg.friendUrl,
    friendAvatar: cfg.friendAvatar,
    friendIntroduction: cfg.friendIntroduction,
    friendCover: cfg.friendCover,
    beian: cfg.beian,
    qiniuUrl: ''
  })
})

legacy.all('/sysConfig/*', (c) => ok([]))

/** 评论 */
legacy.route('/comment', comment)

/** 用户接口：登录/注册/登出（官方前端用 account + AES 加密密码） */
legacy.route('/user', user)

/**
 * 兜底：其余未实现接口统一返回空，避免前端崩溃。
 *
 * 但 `/admin/*` 与 `/user/change*` 这类管理路径必须先鉴权 ——
 * 否则未登录访问 /admin/user/changeUserLv 会命中这里，
 * 拿到 200 + 空数组，看起来"调用成功"，实际是鉴权缺失的假象。
 */
/**
 * 兜底路由
 *
 * 重要：`/admin/*` 这类前缀会被**原样当作路径**匹配。
 * admin.ts 里的路由都挂在 `/` 根上（如 `/user/changeUserLv`），
 * 前端如果调 `/admin/user/changeUserLv` 就会落到这里。
 *
 * 原实现返回 `ok([])`，前端拿到空数组当成功，
 * 表现为「点了没反应」——排查时极难定位（实测浪费很多时间）。
 *
 * 现在对管理路径明确返回 404，让问题立刻暴露。
 */
legacy.all('/*', async (c) => {
  const path = c.req.path
  const isAdminPath = path.includes('/admin/')

  if (isAdminPath) {
    const { guardUser } = await import('./guard')
    const u = await guardUser(c)
    if (!u) return legacyErr('请先登录', 401)
    if (u.user_type > 1) return legacyErr('需要管理员权限', 403)

    // 已登录管理员但路径不存在 → 明确报错，不要静默返回空
    return legacyErr(`接口不存在：${path}`, 404)
  }

  const needsAuth = /\/user\/(change|delete|list)/.test(path) || /\/(save|update|delete)[A-Z]/.test(path)
  if (needsAuth) {
    const { guardUser } = await import('./guard')
    const u = await guardUser(c)
    if (!u) return legacyErr('请先登录', 401)
    if (u.user_type > 1) return legacyErr('需要管理员权限', 403)
  }

  return ok([])
})
