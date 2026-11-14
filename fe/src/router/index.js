import Vue from 'vue'
import VueRouter from 'vue-router'

const originalPush = VueRouter.prototype.push;
VueRouter.prototype.push = function push(location) {
  return originalPush.call(this, location).catch(err => err);
}

Vue.use(VueRouter)

const routes = [
  {
    path: '/',
    component: () => import('../components/home'),
    children: [{
      path: "/",
      name: "index",
      component: () => import('../components/index')
    }, {
      path: "/sort",
      name: "sort",
      component: () => import('../components/sort')
    }, {
      path: "/article/:id",
      name: "article",
      component: () => import('../components/article')
    }, {
      path: "/weiYan",
      name: "weiYan",
      component: () => import('../components/weiYan')
    }, {
      path: "/jotting",
      name: "jotting",
      component: () => import('../components/jotting')
    }, {
      path: "/love",
      name: "love",
      component: () => import('../components/love')
    }, {
      path: "/favorite",
      name: "favorite",
      component: () => import('../components/favorite')
    }, {
      path: "/travel",
      name: "travel",
      component: () => import('../components/travel')
    }, {
      path: "/message",
      name: "message",
      component: () => import('../components/message')
    }, {
      path: "/about",
      name: "about",
      component: () => import('../components/about')
    }, {
      path: "/user",
      name: "user",
      component: () => import('../components/user')
    }, {
      path: "/friend",
      name: "friend",
      component: () => import('../components/friend')
    }, {
      path: "/letter",
      name: "letter",
      component: () => import('../components/letter')
    }]
  },
  {
    path: '/admin',
    redirect: '/welcome',
    meta: {requiresAuth: true},
    component: () => import('../components/admin/admin'),
    children: [{
      path: '/welcome',
      name: 'welcome',
      component: () => import('../components/admin/welcome')
    }, {
      path: '/main',
      name: 'main',
      component: () => import('../components/admin/main')
    }, {
      path: '/webEdit',
      name: 'webEdit',
      component: () => import('../components/admin/webEdit')
    }, {
      path: '/userList',
      name: 'userList',
      component: () => import('../components/admin/userList')
    }, {
      path: '/postList',
      name: 'postList',
      component: () => import('../components/admin/postList')
    }, {
      path: '/postEdit',
      name: 'postEdit',
      component: () => import('../components/admin/postEdit')
    }, {
      path: '/sortList',
      name: 'sortList',
      component: () => import('../components/admin/sortList')
    }, {
      path: '/configList',
      name: 'configList',
      component: () => import('../components/admin/configList')
    }, {
      path: '/commentList',
      name: 'commentList',
      component: () => import('../components/admin/commentList')
    }, {
      path: '/treeHoleList',
      name: 'treeHoleList',
      component: () => import('../components/admin/treeHoleList')
    }, {
      path: '/resourceList',
      name: 'resourceList',
      component: () => import('../components/admin/resourceList')
    }, {
      path: '/loveList',
      name: 'loveList',
      component: () => import('../components/admin/loveList')
    }, {
      path: '/resourcePathList',
      name: 'resourcePathList',
      component: () => import('../components/admin/resourcePathList')
    }, {
      path: '/friendList',
      name: 'friendList',
      component: () => import('../components/admin/friendList')
    }]
  },
  {
    path: '/verify',
    name: 'verify',
    component: () => import('../components/admin/verify')
  }
]

const router = new VueRouter({
  mode: "history",
  routes: routes,
  scrollBehavior(to, from, savedPosition) {
    return {x: 0, y: 0}
  }
})

/**
 * 后台路由守卫
 *
 * 原来只认 adminToken。
 * 但 adminToken 只有后台专用登录页 /verify 会设置；
 * 用户从前台 /user 登录后拿到的是 userToken，
 * 直接访问 /main 会被踢回 /verify —— 表现就是「登录了还是进不去后台」。
 *
 * 现在同时接受 userToken（需是站长/管理员身份）：
 *   - 有 adminToken → 直接放行
 *   - 没有 adminToken 但有 userToken 且 currentUser.isBoss → 自动补 adminToken 后放行
 *   - 都没有 → 跳 /verify
 */
router.beforeEach((to, from, next) => {
  if (to.matched.some(record => record.meta.requiresAuth)) {
    const adminToken = localStorage.getItem('adminToken')
    if (adminToken) return next()

    // 回退：前台登录的站长
    const userToken = localStorage.getItem('userToken')
    let cur = {}
    try { cur = JSON.parse(localStorage.getItem('currentUser') || '{}') } catch (e) { cur = {} }

    if (userToken && cur && cur.isBoss) {
      // 同步一份 adminToken / currentAdmin，后续后台请求都用它
      localStorage.setItem('adminToken', userToken)
      localStorage.setItem('currentAdmin', JSON.stringify(cur))
      return next()
    }

    return next({
      path: '/verify',
      query: { redirect: to.fullPath }
    })
  }
  next()
})

export default router
