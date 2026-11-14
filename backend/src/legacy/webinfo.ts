import { Hono } from 'hono'
import type { Env, PostRow } from '../lib/types'
import { legacyOk as ok } from './response'
import { parseArr } from '../lib/posts'
import { readConfig, asArray } from '../lib/siteConfig'
import { deriveSorts, deriveLabels, toLegacyArticle } from './mapper'

/**
 * 官方 /webInfo/* 接口适配。
 *
 * 官方前端启动时会并发拉 getWebInfo + listSysConfig + getSortInfo，
 * 任何一个失败整站白屏。所以这三个必须稳定返回。
 */
/**
 * Live2D 配置。
 *
 * utils/live2d.js 会 l2dPath 拉这份 JSON，然后直接：
 *   for (let {selector, text} of result.mouseover)
 *   for (let {selector, text} of result.click)
 *   result.seasons.forEach(...)
 * 三个字段缺任何一个都会抛 forEach/invalid destructure 并白屏。
 * 这里给空数组：看板娘不显示，但页面正常。
 */
const LIVE2D_CFG = {
  mouseover: [] as { selector: string; text: string[] }[],
  click: [] as { selector: string; text: string[] }[],
  seasons: [] as { date: string; text: string[] }[],
  waifu: {},
  tips: { message: { default: [] as string[] }, copy: {} },
  daytime: [] as { hour: string; text: string[] }[],
  live2d: { models: [] as unknown[] }
}

/**
 * 图片转绝对 URL 用的源。
 *
 * 优先读 site_config.siteOrigin（可在后台改，适配前端换域名），
 * 没配置时回落到主站。
 */
const DEFAULT_ORIGIN = 'https://www.lwsnb.eu.cc'

export const webInfo = new Hono<{ Bindings: Env }>()

/** GET /webInfo/getWebInfo —— 站点信息（官方 11 个字段） */
webInfo.get('/getWebInfo', async (c) => {
  /**
   * 顺手记一条访问日志（后台首页统计用）。
   * 异步不阻断主流程，失败静默。
   */
  c.executionCtx?.waitUntil?.(
    (async () => {
      try {
        const ip = c.req.header('CF-Connecting-IP') || ''
        if (!ip) return
        // 同一 IP 5 分钟内只记一次，避免刷量
        const dup = await c.env.DB
          .prepare(`SELECT id FROM poem_history WHERE ip=?1 AND create_time > ?2 LIMIT 1`)
          .bind(ip, new Date(Date.now() - 300_000).toISOString())
          .first()
        if (dup) return
        await c.env.DB
          .prepare(`INSERT INTO poem_history (ip,nation,province,city,user_agent,url,create_time) VALUES (?1,?2,'','',?3,?4,?5)`)
          .bind(ip, c.req.header('CF-IPCountry') || '', (c.req.header('User-Agent') || '').slice(0, 200),
            c.req.header('Referer') || '', new Date().toISOString())
          .run()
      } catch { /* 静默 */ }
    })()
  )

  const cfg = await readConfig(c.env.DB)

  // 封面池：优先用配置里的 randomCover，为空则回落到文章封面
  let covers = asArray(cfg.randomCover)
  if (!covers.length) {
    const { results } = await c.env.DB
      .prepare(`SELECT cover FROM posts WHERE draft = 0 AND cover != '' LIMIT 12`)
      .all<{ cover: string }>()
    covers = results.map(r => r.cover)
  }

  /**
   * 图片地址统一转绝对 URL。
   *
   * el-avatar 内部会用 src 直接赋给 <img>，相对路径在某些渲染时机下
   * 会被解析成空（表现为 <span class="el-avatar"> 里没有 img）。
   * 用绝对地址最稳。
   */
  const origin = cfg.siteOrigin || DEFAULT_ORIGIN
  const abs = (u: string) => {
    if (!u) return ''
    if (/^https?:\/\//.test(u)) return u
    return `${origin}${u.startsWith('/') ? '' : '/'}${u}`
  }

  return ok({
    id: 1,
    webName: cfg.webName,
    webTitle: cfg.webTitle,
    /**
     * author —— 站长昵称，侧栏作者卡片显示它。
     *
     * 与 webName（站点名）分开：webName 用在页头、版权声明、关于页，
     * 改成作者名语义会乱（"洛神是指运行在...上的网站"）。
     * 前端 myAside.vue 的 authorName 优先取这个，为空才回落 webName。
     */
    author: cfg.author || '',
    /**
     * **notices / randomCover 必须返回 JSON 字符串，不是数组。**
     * 前端 store/index.js 的 loadWebInfo 会做：
     *   webInfo.notices = JSON.parse(webInfo.notices)
     *   webInfo.randomCover = JSON.parse(webInfo.randomCover)
     * 传数组会 JSON.parse 失败 → loadWebInfo 抛错 → webInfo 为空
     * → 侧栏头像、站点名全部不渲染。
     */
    notices: cfg.notices || '[]',
    footer: cfg.footer,
    avatar: abs(cfg.avatar),
    backgroundImage: abs(cfg.backgroundImage),
    randomCover: JSON.stringify(covers.map(abs)),
    historyAllCount: 0,
    status: cfg.status === 'true',
    waifuJson: JSON.stringify(LIVE2D_CFG),
    webStaticResourcePrefix: cfg.webStaticResourcePrefix,
    /**
     * home.vue 会执行 localStorage.setItem("defaultStoreType", res.data.defaultStoreType)，
     * 缺这个字段时 localStorage 存的是字符串 "undefined"，
     * 后台资源页的「存储平台」列和上传下拉框都会显示 undefined。
     */
    defaultStoreType: 'b2',
  })
})

/** GET /webInfo/getSortInfo —— 分类（含 labels） */
webInfo.get('/getSortInfo', async (c) => {
  /**
   * 排序必须与 article.ts 的 listArticle 完全一致。
   * deriveLabels 按遍历顺序自增分配标签 id，
   * 顺序不同 → 同一标签不同 id → 前端点标签过滤扑空。
   */
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM posts WHERE draft = 0 ORDER BY top DESC, date DESC, id DESC`)
    .all<PostRow>()

  const sorts = deriveSorts(results)
  const labels = deriveLabels(results, sorts)

  // 把 label 挂到对应 sort 下
  for (const s of sorts) {
    s.labels = labels.filter(l => l.sortId === s.id)
  }

  return ok(sorts)
})

/** GET /webInfo/listSortAndLabel —— 同 getSortInfo，官方两处都在用 */
webInfo.get('/listSortAndLabel', async (c) => {
  /**
   * 排序必须和 article.ts 的 loadAll **完全一致**。
   *
   * deriveLabels 是按文章遍历顺序自增分配 id 的，
   * 两个接口如果顺序不同，同一标签会拿到不同 id ——
   * 前端拿着 listSortAndLabel 的 id 去 listArticle 过滤就会扑空。
   */
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM posts WHERE draft = 0 ORDER BY top DESC, date DESC, id DESC`)
    .all<PostRow>()
  const sorts = deriveSorts(results)
  const labels = deriveLabels(results, sorts)
  return ok({ sorts, labels })
})

/**
 * GET /webInfo/getHistoryInfo —— 后台首页统计
 *
 * 字段名必须严格对齐 main.vue 的模板（缺一个就显示「暂无数据」）：
 *   ip_history_count     历史访问总数
 *   ip_history_province  TOP10 省份   [{province, num}]
 *   ip_history_ip        TOP10 IP     [{ip, num}]
 *   ip_count_today       今日访问量
 *   province_today       今日省份     [{province, num}]
 *   username_today       今日用户     [{username, avatar, num}]
 *   ip_count_yest        昨日访问量
 *   username_yest        昨日用户
 */
webInfo.get('/getHistoryInfo', async (c) => {
  const today = new Date().toISOString().slice(0, 10)
  const yest = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)

  const cnt = async (like?: string) =>
    (await c.env.DB
      .prepare(like ? `SELECT COUNT(*) c FROM poem_history WHERE create_time LIKE ?1` : `SELECT COUNT(*) c FROM poem_history`)
      .bind(...(like ? [`${like}%`] : []))
      .first<{ c: number }>())?.c ?? 0

  const topProvince = async (like?: string) => {
    const sql = like
      ? `SELECT COALESCE(NULLIF(city,''), NULLIF(nation,''), '未知') AS province, COUNT(*) AS num
           FROM poem_history WHERE create_time LIKE ?1 GROUP BY province ORDER BY num DESC LIMIT 10`
      : `SELECT COALESCE(NULLIF(city,''), NULLIF(nation,''), '未知') AS province, COUNT(*) AS num
           FROM poem_history GROUP BY province ORDER BY num DESC LIMIT 10`
    const { results } = await c.env.DB.prepare(sql).bind(...(like ? [`${like}%`] : [])).all()
    return results
  }

  const topIp = async () => {
    const { results } = await c.env.DB
      .prepare(`SELECT ip, COUNT(*) AS num FROM poem_history WHERE ip<>'' GROUP BY ip ORDER BY num DESC LIMIT 10`)
      .all()
    return results
  }

  // 今日用户（按 ip 归并，展示最近一次 UA）
  const todayUsers = async (like: string) => {
    const { results } = await c.env.DB
      .prepare(`SELECT ip, user_agent, COUNT(*) AS num FROM poem_history
                 WHERE create_time LIKE ?1 AND ip<>'' GROUP BY ip ORDER BY num DESC LIMIT 10`)
      .bind(`${like}%`).all<{ ip: string; user_agent: string; num: number }>()
    return results.map(r => ({
      username: r.ip,
      avatar: '',
      num: r.num
    }))
  }

  const [allCount, todayCount, yestCount, provAll, provToday, ipTop, usersToday, usersYest] =
    await Promise.all([
      cnt(), cnt(today), cnt(yest),
      topProvince(), topProvince(today), topIp(),
      todayUsers(today), todayUsers(yest)
    ])

  return ok({
    ip_history_count: allCount,
    ip_history_province: provAll,
    ip_history_ip: ipTop,
    ip_count_today: todayCount,
    province_today: provToday,
    username_today: usersToday,
    ip_count_yest: yestCount,
    username_yest: usersYest
  })
})

/** GET /webInfo/getSortInfo —— 分类（含 labels） */
webInfo.get('/getSortInfo', async (c) => {
  /**
   * 排序必须与 article.ts 的 listArticle 完全一致。
   * deriveLabels 按遍历顺序自增分配标签 id，
   * 顺序不同 → 同一标签不同 id → 前端点标签过滤扑空。
   */
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM posts WHERE draft = 0 ORDER BY top DESC, date DESC, id DESC`)
    .all<PostRow>()

  const sorts = deriveSorts(results)
  const labels = deriveLabels(results, sorts)

  // 把 label 挂到对应 sort 下
  for (const s of sorts) {
    s.labels = labels.filter(l => l.sortId === s.id)
  }

  return ok(sorts)
})

/** GET /webInfo/listSortAndLabel —— 同 getSortInfo，官方两处都在用 */
webInfo.get('/listSortAndLabel', async (c) => {
  /**
   * 排序必须和 article.ts 的 loadAll **完全一致**。
   *
   * deriveLabels 是按文章遍历顺序自增分配 id 的，
   * 两个接口如果顺序不同，同一标签会拿到不同 id ——
   * 前端拿着 listSortAndLabel 的 id 去 listArticle 过滤就会扑空。
   */
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM posts WHERE draft = 0 ORDER BY top DESC, date DESC, id DESC`)
    .all<PostRow>()
  const sorts = deriveSorts(results)
  const labels = deriveLabels(results, sorts)
  return ok({ sorts, labels })
})

/**
 * GET /webInfo/getHistoryInfo —— 访问统计
 * 从 poem_history 聚合，并附最近 IP 明细。
 */
webInfo.get('/getHistoryInfo', async (c) => {
  const today = new Date().toISOString().slice(0, 10)
  const all = await c.env.DB.prepare(`SELECT COUNT(*) c FROM poem_history`).first<{ c: number }>()
  const day = await c.env.DB
    .prepare(`SELECT COUNT(*) c FROM poem_history WHERE create_time LIKE ?1`)
    .bind(`${today}%`).first<{ c: number }>()
  const { results } = await c.env.DB
    .prepare(`SELECT ip, nation, city, user_agent, url, create_time FROM poem_history ORDER BY id DESC LIMIT 50`)
    .all()

  return ok({
    historyAllCount: all?.c ?? 0,
    historyDayCount: day?.c ?? 0,
    ipList: results
  })
})

/** GET /webInfo/getAdmire —— 赞赏配置 */
webInfo.get('/getAdmire', async (c) => ok({ admireImage: '', admireContent: '' }))

/** GET /webInfo/getWaifuJson —— Live2D 配置（前端要求含 seasons/waifu/tips） */
/**
 * GET /webInfo/getWaifuJson
 *
 * **注意：这个接口必须返回裸 JSON，不能套信封。**
 * utils/live2d.js 用原生 fetch 直接请求，不经过 axios 拦截器，
 * 代码里就是 result.seasons.forEach / result.mouseover，
 * 套上 {code,data} 会让 result.seasons 变成 undefined 并白屏。
 */
webInfo.get('/getWaifuJson', (c) => Response.json(LIVE2D_CFG))

/** 其余 webInfo 子路径：返回空数组，避免前端报错 */
webInfo.all('/*', async (c) => ok([]))
