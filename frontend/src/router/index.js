import { createRouter, createWebHistory } from 'vue-router'
import { useAuth } from '@/composables/useAuth'

const routes = [
  // 默认进入登录页：访问 / 时重定向到 /login
  { path: '/', redirect: '/login' },
  { path: '/login', name: 'Login', component: () => import('@/views/LoginView.vue'), meta: { title: '登录', public: true } },
  { path: '/fix', name: 'Fix', component: () => import('@/views/FixView.vue'), meta: { title: '员工整改', public: true } },
  // 管理后台（/admin、/employees、/summary）：需登录，未登录会重定向到 /login
  // meta.roles 限定可访问的角色：老板（boss）只能进汇总看板
  {
    path: '/',
    component: () => import('@/components/MainLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: 'admin',
        name: 'Admin',
        component: () => import('@/views/AdminView.vue'),
        meta: { title: '管理员-检查上传', requiresAuth: true, roles: ['admin'] },
      },
      {
        path: 'employees',
        name: 'Employees',
        component: () => import('@/views/EmployeesView.vue'),
        meta: { title: '员工管理', requiresAuth: true, roles: ['admin'] },
      },
      {
        path: 'summary',
        name: 'Summary',
        component: () => import('@/views/SummaryView.vue'),
        meta: { title: '汇总看板', requiresAuth: true, roles: ['admin', 'boss'] },
      },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// 各角色登录后的默认落地页
export function homePathByRole(role) {
  return role === 'boss' ? '/summary' : '/admin'
}

// 登录态是否允许访问某路由（未声明 roles 的路由视为不限角色）
function canAccess(authUser, to) {
  const roles = to.matched
    .flatMap((r) => (Array.isArray(r.meta?.roles) ? r.meta.roles : []))
  if (roles.length === 0) return true
  return !!authUser?.role && roles.includes(authUser.role)
}

router.beforeEach(async (to) => {
  const auth = useAuth()
  const requiresAuth = to.matched.some((r) => r.meta?.requiresAuth)
  if (requiresAuth && !auth.isLoggedIn) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  // 已登录但本地缺角色信息（如硬刷新后 localStorage 被清），先拉一次 /me
  if (requiresAuth && auth.isLoggedIn && !auth.user) {
    const u = await auth.fetchUser()
    if (!u) {
      return { path: '/login', query: { redirect: to.fullPath } }
    }
  }
  // 角色越权：踢回各自的默认页面（前端兜底，后端接口同样拒绝）
  if (requiresAuth && auth.isLoggedIn && !canAccess(auth.user, to)) {
    return { path: homePathByRole(auth.user?.role) }
  }
  // 在登录页且有 token 时先校验有效性，避免过期 token 导致：跳 /admin → 401 → 回 /login 的循环
  if (to.path === '/login' && auth.isLoggedIn) {
    try {
      const user = await auth.fetchUser()
      if (user) {
        // 仅当 redirect 目标对该角色开放时才使用，否则去角色默认页
        const target = to.query.redirect
        if (target && typeof target === 'string' && canAccess(user, router.resolve(target))) {
          return { path: target }
        }
        return { path: homePathByRole(user.role) }
      }
    } catch {
      auth.clearAuth()
    }
    return true
  }
})

router.afterEach((to) => {
  if (to.meta?.title) {
    document.title = to.meta.title + ' - 员工卫生考核系统'
  }
})

export default router
