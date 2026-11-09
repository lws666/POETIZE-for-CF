/**
 * 构建前从 Worker 拉取最新的 sitemap.xml 和 rss.xml
 *
 * 为什么需要：Cloudflare Pages 不支持跨域 200 重写，
 * /sitemap.xml 只能作为静态文件提供。但文章会增减，
 * 静态文件必须每次构建时刷新，否则新增文章不会出现在 sitemap 里
 * （之前那份是 11-04 的快照，一直没更新）。
 *
 * 拉取失败保留旧文件，不阻断构建。
 */
const fs = require('fs')
const path = require('path')

const API = 'https://api.lwsnb.eu.cc'
const PUBLIC = path.join(__dirname, '..', 'public')

async function fetchTo(file) {
  const url = `${API}/${file}`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'poetize-build' },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    // 简单校验：必须是 XML，不能是 HTML（Pages fallback 会返回 index.html）
    if (!text.trim().startsWith('<?xml')) throw new Error('返回的不是 XML')
    const dest = path.join(PUBLIC, file)
    fs.writeFileSync(dest, text, 'utf8')
    console.log(`  ✓ ${file}  ${text.length} 字节`)
  } catch (e) {
    console.warn(`  ✗ ${file} 拉取失败（保留旧文件）: ${e.message}`)
  }
}

;(async () => {
  console.log('[seo] 同步 sitemap / rss ...')
  await fetchTo('sitemap.xml')
  await fetchTo('rss.xml')
  console.log('[seo] 完成')
})()
