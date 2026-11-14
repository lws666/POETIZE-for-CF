/**
 * IndexNow —— 主动推送 URL 给搜索引擎
 *
 * 为什么需要：新站等自然抓取要几天到几周，Bing 实测完全没收录。
 * IndexNow 是 Bing / Yandex / Seznam 共用的协议，
 * 主动 POST 一批 URL，通常几小时到一天内进索引。
 *
 * 使用前提：
 *   1. 站点上要有一个 `/<key>.txt`，内容是 key 本身
 *      （放在 public/ 下，随前端一起部署）
 *   2. 推送时把同样的 key 一起提交，搜索引擎会去校验
 *
 * 接口：https://api.indexnow.org/indexnow
 *   POST { host, key, keyLocation, urlList[] }
 *
 * 注意：失败不能影响文章保存主流程。
 */

const ENDPOINT = 'https://api.indexnow.org/indexnow'

export interface IndexNowPayload {
  host: string
  key: string
  keyLocation: string
  urlList: string[]
}

/** 推送一组 URL。返回是否成功（失败静默，不抛异常） */
export async function submitIndexNow(
  host: string,
  key: string,
  urls: string[]
): Promise<boolean> {
  if (!host || !key || !urls.length) return false

  const body: IndexNowPayload = {
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    // 单次最多 10000 条，这里正常不会超
    urlList: urls.slice(0, 10000)
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body)
    })
    // 200 = 成功，202 = 已接受待处理，两者都算通过
    return res.status === 200 || res.status === 202
  } catch {
    return false
  }
}

/**
 * 从环境里取宿主（去掉协议）。
 * SITE_HOST 优先，没配就从 ALLOWED_ORIGINS 的第一个来源推。
 */
export function resolveHost(env: {
  SITE_HOST?: string
  ALLOWED_ORIGINS?: string
}): string {
  if (env.SITE_HOST) return env.SITE_HOST.replace(/^https?:\/\//, '').replace(/\/$/, '')

  const first = (env.ALLOWED_ORIGINS || '').split(',')[0]?.trim() || ''
  if (first) return first.replace(/^https?:\/\//, '').replace(/\/$/, '')

  return 'www.lwsnb.eu.cc'
}
