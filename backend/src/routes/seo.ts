import { Hono } from 'hono'
import type { Env, PostRow } from '../lib/types'

/**
 * SEO 端点：sitemap / robots / RSS
 *
 * 前端是 SPA，这些文件必须由 Worker 动态生成（文章会增减）。
 * 通过 _routes 或前端 _redirects 把 /sitemap.xml 等转发到 API。
 */
export const seo = new Hono<{ Bindings: Env }>()

const SITE = 'https://www.lwsnb.eu.cc'

/** GET /sitemap.xml */
seo.get('/sitemap.xml', async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT id, slug, title, updated_at, date FROM posts WHERE draft=0 ORDER BY id DESC`)
    .all<PostRow>()

  const staticPages = [
    ['/', '1.0', 'daily'],
    ['/sort', '0.8', 'weekly'],
    ['/weiYan', '0.7', 'weekly'],
    ['/jotting', '0.7', 'weekly'],
    ['/favorite', '0.6', 'monthly'],
    ['/love', '0.6', 'monthly'],
    ['/message', '0.6', 'weekly'],
    ['/about', '0.5', 'monthly']
  ] as const

  const now = new Date().toISOString().slice(0, 10)

  const urls = [
    ...staticPages.map(([p, pri, freq]) => `
  <url>
    <loc>${SITE}${p}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${freq}</changefreq>
    <priority>${pri}</priority>
  </url>`),
    ...results.map(r => `
  <url>
    <loc>${SITE}/article/${r.id}</loc>
    <lastmod>${(r.updated_at || r.date || now).slice(0, 10)}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>`)
  ].join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600'
    }
  })
})

/** GET /robots.txt */
seo.get('/robots.txt', (c) => {
  const txt = `User-agent: *
Allow: /

Disallow: /admin
Disallow: /verify
Disallow: /welcome
Disallow: /main
Disallow: /configList
Disallow: /userList
Disallow: /postList
Disallow: /postEdit
Disallow: /webEdit
Disallow: /sortList
Disallow: /commentList
Disallow: /resourceList
Disallow: /resourcePathList
Disallow: /treeHoleList
Disallow: /loveList

Sitemap: ${SITE}/sitemap.xml
`
  return new Response(txt, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400'
    }
  })
})

/** GET /rss.xml —— 文章 RSS */
seo.get('/rss.xml', async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT id, slug, title, excerpt, content, date, updated_at FROM posts WHERE draft=0 ORDER BY id DESC LIMIT 30`)
    .all<PostRow>()

  const esc = (s: string) =>
    (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const items = results.map(r => `
    <item>
      <title>${esc(r.title)}</title>
      <link>${SITE}/article/${r.id}</link>
      <guid isPermaLink="true">${SITE}/article/${r.id}</guid>
      <description>${esc(r.excerpt || (r.content || '').slice(0, 200))}</description>
      <pubDate>${new Date(r.date || Date.now()).toUTCString()}</pubDate>
    </item>`).join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>谢谢の博客</title>
    <link>${SITE}</link>
    <description>记录代码折腾与生活随笔</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    }
  })
})
