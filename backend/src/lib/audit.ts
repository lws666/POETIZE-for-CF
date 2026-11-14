/**
 * 管理端操作审计日志
 *
 * 为什么需要：
 *   后台有删文章、改配置、改用户等级、删用户等高危操作，
 *   之前全部没有记录。一旦出事（误删、被入侵）无法追溯。
 *
 * 设计：
 *   - 只记录写操作（GET 的读操作不记，避免日志爆炸）
 *   - 记录 谁 / 何时 / 什么操作 / 目标 / IP / 结果
 *   - 异步写入（waitUntil），失败不影响主流程
 *
 * 表 audit_log：
 *   id / user_id / username / action / target / detail / ip / created_at
 */

export interface AuditEntry {
  userId: number
  username: string
  /** 操作名，如 article.delete */
  action: string
  /** 目标对象标识，如 article:69 */
  target?: string
  /** 附加信息（截断到 500 字符） */
  detail?: string
  ip?: string
}

/** 异步写一条审计日志，失败静默 */
export function audit(db: D1Database, e: AuditEntry): Promise<void> {
  const sql = `INSERT INTO audit_log (user_id, username, action, target, detail, ip, created_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7)`
  return db
    .prepare(sql)
    .bind(
      e.userId,
      e.username,
      e.action,
      e.target || '',
      (e.detail || '').slice(0, 500),
      e.ip || '',
      new Date().toISOString()
    )
    .run()
    .then(() => {})
    .catch(() => {})
}

/** 从 legacy Context 取 IP */
export function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
}
