/** 环境绑定（与 wrangler.toml 对应） */
export interface Env {
  DB: D1Database
  KV?: KVNamespace
  /** B2 对象存储 */
  B2_ENDPOINT: string
  B2_BUCKET: string
  /** 与旧 worker 保持同名，直接复用线上已有 secret */
  B2_ACCESS_KEY_ID: string
  /** Brevo 邮件服务 */
  BREVO_API_KEY: string
  /** IndexNow 主动推送 */
  INDEXNOW_KEY?: string
  /** 站点宿主（不含协议），IndexNow 用 */
  SITE_HOST?: string
  /** GitHub PAT，用于触发 Actions 重建 */
  GITHUB_TOKEN?: string
  MAIL_FROM: string
  MAIL_FROM_NAME: string
  B2_SECRET_ACCESS_KEY: string
  B2_PUBLIC_URL: string
  /** 会话与令牌 */
  SESSION_TTL_HOURS?: string
  /** 旧版遗留的管理员直通令牌（admin 等价），保留兼容 */
  UPLOAD_TOKEN?: string
  /** 允许的前端源（CORS），逗号分隔 */
  ALLOWED_ORIGINS?: string
}

/** 统一响应信封 */
export type Envelope<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string }

/** 用户角色：admin 全权 / write 可写内容 / read 只读 */
export type Role = 'admin' | 'write' | 'read'

/**
 * 用户类型（对齐官方 user_type）
 *   0 = admin  站长，唯一
 *   1 = 管理员  可管内容与用户
 *   2 = 普通用户 只能互动
 */
export type UserType = 0 | 1 | 2

/** 用户等级（对齐官方 UserLvEnum，LV1..LV6） */
export type UserLv = 1 | 2 | 3 | 4 | 5 | 6

export interface UserRow {
  id: number
  username: string
  password_hash: string
  /** 兼容旧字段：admin/write/read */
  role: Role
  /** 官方字段：0/1/2 */
  user_type: number
  /** 官方字段：1..6 */
  user_lv: number
  totp_enabled: number
  disabled: number
  created_at: string
  last_login_at: string

  email: string
  phone_number: string
  avatar: string
  gender: number
  introduction: string
  subscribe: string
  admire: string
  user_status: number
}

/** 官方 UserVO 输出结构（不含密码） */
export interface UserVO {
  id: number
  username: string
  email: string
  phoneNumber: string
  gender: number
  avatar: string
  userLv: number
  introduction: string
  subscribe: string
  createTime: string
  isBoss: boolean
  accessToken?: string
}

export interface PostRow {
  id: number
  slug: string
  title: string
  date: string
  updated: string
  tags: string
  categories: string
  excerpt: string
  cover: string
  type: string
  top: number
  draft: number
  hide: string
  password: string
  encrypt: number
  comment: number
  toc: number
  nav: number
  pinned: number
  b2_key: string
  /** 访问控制（对齐官方 ViewTypeEnum） */
  view_type: string
  view_value: string
  tips: string
  content: string
  summary: string
  frontmatter: string
  created_at: string
  updated_at: string
}

/** API 对外输出的文章（前端消费形态） */
export interface PostDTO {
  slug: string
  title: string
  date: string
  updated: string
  tags: string[]
  categories: string[]
  excerpt: string
  cover: string
  type: string
  top: number
  hide: string
  /** 访问类型，前端据此显示锁图标 */
  view_type: string
}
