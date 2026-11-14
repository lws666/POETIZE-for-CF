/**
 * 限流 —— 基于 D1 持久化
 *
 * 为什么不用内存 Map：
 *   实测内存版完全不生效。Cloudflare Workers 每次请求可能落在
 *   不同 isolate，模块级 Map 不共享，各自计数都是 1，永远触发不了阈值。
 *
 * 用 D1 表 rate_limit 做原子计数：
 *   k        限流键（scope:identity）
 *   n        窗口内已用次数
 *   reset_at 窗口过期时间
 *
 * 逻辑：
 *   1. 先清理过期的键（顺手，避免表膨胀）
 *   2. INSERT ... ON CONFLICT DO UPDATE 原子自增
 *   3. 自增后读回 n，超过阈值返回 false
 *
 * 成本：每次限流检查多 1-2 次 D1 读写，对博客量级完全可接受。
 */

export async function rateOkDb(
  db: D1Database,
  scope: string,
  identity: string | number,
  limit: number,
  windowMs: number
): Promise<boolean> {
  const key = `${scope}:${identity}`
  const now = Date.now()
  const resetAt = new Date(now + windowMs).toISOString()

  try {
    // 原子自增：不存在则插入，存在且未过期则 +1，已过期则重置
    await db
      .prepare(
        `INSERT INTO rate_limit (k, n, reset_at) VALUES (?1, 1, ?2)
         ON CONFLICT(k) DO UPDATE SET
           n = CASE WHEN rate_limit.reset_at < ?3 THEN 1 ELSE rate_limit.n + 1 END,
           reset_at = CASE WHEN rate_limit.reset_at < ?3 THEN ?2 ELSE rate_limit.reset_at END`
      )
      .bind(key, resetAt, new Date(now).toISOString())
      .run()

    const row = await db
      .prepare(`SELECT n FROM rate_limit WHERE k = ?1`)
      .bind(key)
      .first<{ n: number }>()

    return (row?.n ?? 1) <= limit
  } catch {
    // 限流本身出错时不阻断业务
    return true
  }
}

/** 清理过期记录（可在低频路径顺手调用，失败静默） */
export async function pruneRateLimit(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(`DELETE FROM rate_limit WHERE reset_at < ?1`)
      .bind(new Date().toISOString())
      .run()
  } catch { /* 静默 */ }
}
