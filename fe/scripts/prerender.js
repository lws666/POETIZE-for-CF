/**
 * 预渲染：把每个路由渲染成带正文的静态 HTML
 *
 * 为什么需要：
 *   博客是纯 CSR，<div id="app"> 初始为空。实测 Google 能执行 JS，
 *   但 Bing / 百度 / AI 爬虫都读不到正文，所以一直不被收录。
 *   同一账号下的静态页面（导航站）早就被收录了，差别就在这里。
 *
 * 为什么自写而不用 prerender-spa-plugin：
 *   试过 3 种配置，插件能跑但静默不产出内容（不报错也不写文件）。
 *   Puppeteer + 本地 HTTP 服务这套已验证可用（单页 56KB 渲染成功）。
 *
 * 用法：node scripts/prerender.js
 *   需先执行过一次 build，dist 已存在。
 */
const puppeteer = require('puppeteer')
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'dist')
const PORT = 4399
const API = 'https://api.lwsnb.eu.cc'
// 每页等多久让 Vue 完成数据请求与渲染
const WAIT_MS = 5000

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain'
}

/** 固定页面 */
const STATIC_ROUTES = [
  ['/', 'index'],
  ['/sort', 'sort'],
  ['/weiYan', 'weiyan'],
  ['/jotting', 'jotting'],
  ['/favorite', 'favorite'],
  ['/love', 'love'],
  ['/message', 'message'],
  ['/about', 'about'],
  ['/friend', 'friend']
]

/** 从 API 取文章 id 列表 */
function fetchArticles() {
  return new Promise(resolve => {
    const req = https.get(`${API}/api/posts?page=1&size=500`,
      { headers: { 'User-Agent': 'prerender' }, timeout: 20000 }, res => {
      let d = ''
      res.on('data', c => (d += c))
      res.on('end', () => {
        try {
          const j = JSON.parse(d)
          const posts = j?.data?.posts || []
          // 前端路由是 /article/:id，但 /api/posts 返回的是 slug，
          // 需要另外拿 id —— 用 legacy 接口
          resolve(posts)
        } catch { resolve([]) }
      })
    })
    req.on('error', () => resolve([]))
    req.on('timeout', () => { req.destroy(); resolve([]) })
  })
}

/** 从 legacy 接口取文章 id（前端实际用的就是这个 id） */
function fetchArticleIds() {
  return new Promise(resolve => {
    const body = JSON.stringify({ current: 1, size: 500 })
    const req = https.request(`${API}/api/legacy/article/listArticle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'prerender' },
      timeout: 20000
    }, res => {
      let d = ''
      res.on('data', c => (d += c))
      res.on('end', () => {
        try {
          const j = JSON.parse(d)
          const recs = j?.data?.records || []
          resolve(recs.map(r => r.id))
        } catch { resolve([]) }
      })
    })
    req.on('error', () => resolve([]))
    req.on('timeout', () => { req.destroy(); resolve([]) })
    req.write(body)
    req.end()
  })
}

/** 本地静态服务（SPA fallback） */
function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      try {
        const p = decodeURIComponent(req.url.split('?')[0])
        let f = path.join(ROOT, p)
        if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
          const idx = path.join(f, 'index.html')
          f = fs.existsSync(idx) ? idx : path.join(ROOT, 'index.html')
        }
        if (!fs.existsSync(f)) { res.writeHead(404); return res.end('404') }
        const body = fs.readFileSync(f)
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
          'Content-Length': body.length
        })
        res.end(body)
      } catch { if (!res.headersSent) res.writeHead(500); res.end('500') }
    })
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    console.error('[prerender] 找不到 dist/index.html，先执行 build')
    process.exit(1)
  }

  console.log('[prerender] 拉取文章列表...')
  const ids = await fetchArticleIds()
  console.log(`[prerender] 文章 ${ids.length} 篇`)

  const routes = [
    ...STATIC_ROUTES.map(([p]) => p),
    ...ids.map(id => `/article/${id}`)
  ]
  console.log(`[prerender] 共 ${routes.length} 个路由`)

  const server = await startServer()
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })

  let ok = 0, fail = 0

  for (const route of routes) {
    const page = await browser.newPage()
    try {
      await page.goto(`http://127.0.0.1:${PORT}${route}`, {
        waitUntil: 'domcontentloaded', timeout: 40000
      }).catch(() => {})

      /**
       * 等页面真正渲染完成。
       *
       * 只等 #app 长度 > 3000 不够 —— 外壳（导航栏、侧栏）就有 3000+，
       * 文章正文要等 API 返回才出现。实测 article/69 有时只拿到 33 字。
       *
       * 改成看「有效文本长度」：
       *   文章页必须出现 .article-title
       *   其他页文本长度要 > 150（排除只有骨架的情况）
       * 最多等 20 秒。
       */
      const needTitle = route.startsWith('/article/')
      let textLen = 0
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500))
        const st = await page.evaluate(() => {
          const app = document.getElementById('app')
          return {
            textLen: (app?.innerText || '').replace(/\s+/g, ' ').trim().length,
            hasTitle: !!document.querySelector('.article-title')
          }
        })
        textLen = st.textLen
        if (needTitle) {
          if (st.hasTitle && st.textLen > 500) break
        } else {
          if (st.textLen > 150) break
        }
      }
      const len = textLen

      /**
       * 移除看板娘相关 DOM，再落盘。
       *
       * 原因：预渲染跑在桌面尺寸（默认 800×600 以上），
       * live2d.js 的 `screen.width > 768` 判断成立，看板娘会被
       * insertAdjacentHTML 写进 body。这份 HTML 一旦被手机访问，
       * 直接显示出来 —— 等于绕过了「手机端不显示」的判断。
       *
       * 桌面端不受影响：页面加载后 Vue 重新执行 live2d.js，
       * 判断通过会重新插入。
       */
      await page.evaluate(() => {
        document.querySelectorAll('#waifu, #waifu-toggle').forEach(el => el.remove())
      })

      const html = await page.content()

      /**
       * 落盘成**扁平 .html 文件**，不是目录下的 index.html。
       *
       * 原因：Pages 对 `article/69/index.html` 这种结构，
       * 请求 `/article/69` 会返回 308 重定向到 `/article/69/`。
       * 爬虫拿到 308 就停了，等于还是读不到内容（实测 0 字）。
       *
       * 写成 `article/69.html` 后，Pages 的 clean URL 特性
       * 会直接把 `/article/69` 映射到这个文件，无重定向。
       */
      const outFile = route === '/'
        ? path.join(ROOT, 'index.html')
        : path.join(ROOT, route.replace(/^\//, '') + '.html')

      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      fs.writeFileSync(outFile, html, 'utf8')

      if (len > (needTitle ? 400 : 100)) { ok++; console.log(`  ✓ ${route.padEnd(24)} 正文 ${len} 字`) }
      else { fail++; console.log(`  ✗ ${route.padEnd(24)} 内容过少 (${len})`) }
    } catch (e) {
      fail++
      console.log(`  ✗ ${route}  ${e.message.slice(0, 60)}`)
    } finally {
      await page.close()
    }
  }

  await browser.close()
  server.close()

  console.log(`[prerender] 完成：成功 ${ok}，失败 ${fail}`)
  // 只要有内容就继续部署，不因个别失败中断
  process.exit(ok > 0 ? 0 : 1)
}

main().catch(e => {
  console.error('[prerender] 致命错误:', e.message)
  process.exit(1)
})
