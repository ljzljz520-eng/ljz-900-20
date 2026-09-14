<?php
declare(strict_types=1);
namespace app\middleware;
use app\model\User;
use Closure;
use think\Request;
use think\Response;

class AuthMiddleware
{
    /**
     * 允许通过的角色。默认只放行 admin；
     * 路由上可通过中间件参数扩展，例如：
     *   ->middleware(AuthMiddleware::class . ':boss')              // 仅 boss
     *   ->middleware(AuthMiddleware::class . ':admin,boss')        // admin 与 boss 均可
     */
    public function handle(Request $request, Closure $next, string $roles = 'admin'): Response
    {
        $allowedRoles = array_values(array_filter(array_map('trim', explode(',', $roles))));
        if (empty($allowedRoles)) {
            $allowedRoles = ['admin'];
        }

        $token = $this->getBearerToken($request);
        if (!$token) {
            return api_json(['code' => 401, 'message' => '未登录', 'data' => null], 200);
        }

        $user = User::where('auth_token', $token)
            ->whereIn('role', $allowedRoles)
            ->where('auth_token_expires', '>', date('Y-m-d H:i:s'))
            ->find();

        if (!$user) {
            // 先判断是「登录过期」还是「角色无权访问」，给出更准确的提示
            $anyUser = User::where('auth_token', $token)
                ->where('auth_token_expires', '>', date('Y-m-d H:i:s'))
                ->find();
            if ($anyUser) {
                return api_json(['code' => 403, 'message' => '无权访问该功能', 'data' => null], 200);
            }
            return api_json(['code' => 401, 'message' => '登录已过期，请重新登录', 'data' => null], 200);
        }

        $request->authUser = $user;
        return $next($request);
    }

    private function getBearerToken(Request $request): ?string
    {
        $header = $request->header('authorization', '');
        if (preg_match('/^Bearer\s+(.+)$/i', $header, $m)) {
            return trim($m[1]);
        }
        return null;
    }
}
