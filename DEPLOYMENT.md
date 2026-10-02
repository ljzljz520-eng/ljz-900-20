# 部署与演示说明（员工卫生考核系统）

本文档补充 README，写清四件在现场部署时最容易踩坑的事：**Nginx / PHP-FPM 怎么跑、数据库怎么连、上传目录权限怎么给、二维码域名和图片备份怎么处理**，最后给出**管理员 / 员工 / 老板**三种角色的完整演示动线。

- 前端：Vue 3 + Vite + Element Plus，容器内由 Nginx 托管静态文件
- 后端：PHP 8.2 + ThinkPHP 8，容器内 Nginx + PHP-FPM 同容器运行
- 数据库：MySQL 8.0（utf8mb4）
- 一键启动：项目根目录 `docker compose up --build`，启动后前端 http://localhost:3000 、后端 http://localhost:8080 、数据库 localhost:3306

---

## 1. Nginx 说明

系统里有**两个互相独立的 Nginx**，排查问题时先分清是哪一个。

### 1.1 后端 Nginx（与 PHP-FPM 同容器，宿主 8080）

配置文件：`backend/docker/nginx.conf`，容器内监听 80，`docker-compose.yml` 映射为宿主 `8080:80`。

- `root /app/public;`，入口 `index.php`（ThinkPHP）。
- `client_max_body_size 20M;` —— 拍照上传单文件上限 20M，改大小时要和下面 PHP 的两个上限一起改，否则会在 Nginx 或 PHP 任一侧被拦。
- 不存在的文件统一 rewrite 到 `/index.php?s=$1`，由 ThinkPHP 路由处理 `/api/...`。
- `location ~ \.php$` 转发到 `fastcgi_pass 127.0.0.1:9000;`（同容器内的 PHP-FPM），并设置 `SCRIPT_FILENAME`、`PATH_INFO`。
- 因为浏览器是从 3000 端口的页面直接请求 8080 端口的 API，存在跨域，所以配置里对所有响应加了：
  `Access-Control-Allow-Origin: *`、允许 `GET, POST, PUT, DELETE, OPTIONS`、允许头 `Content-Type, Authorization`；OPTIONS 预检直接返回 204。
- jpg/png/gif/css/js 等静态资源缓存 7 天。`/uploads/` 下的图片就是经这个 Nginx 直接返回的（例如 `http://localhost:8080/uploads/admin/xxx.jpg`），不经过 PHP。

### 1.2 前端 Nginx（独立容器，宿主 3000）

配置文件：`frontend/nginx.conf`，基于 `nginx:alpine`，容器内监听 80，映射为宿主 `3000:80`。

- `root /usr/share/nginx/html;` 托管 `npm run build` 产物 `dist`。
- `try_files $uri $uri/ /index.html;` —— Vue history 路由（`/admin`、`/employees`、`/summary`、`/fix`）刷新不 404 靠的就是这一条。
- 静态资源（js/css/图片/字体）缓存 7 天。
- 前端容器**不反代 API**。构建参数 `VITE_API_BASE=http://localhost:8080`（见 `frontend/Dockerfile`、`docker-compose.yml`）被打进 JS，浏览器拿到页面后直接请求 8080。因此部署到服务器时，必须改成"员工手机/浏览器能访问到的后端地址"（见第 5 节二维码域名）。

### 1.3 本地热更新模式（可选）

`cd frontend && npm run dev` 启动 Vite，端口 5173，仅开发用；此时同样直连 http://localhost:8080 后端。Docker 不会启动 5173。

---

## 2. PHP-FPM 说明

后端镜像定义在 `backend/Dockerfile`，最终阶段为 `php:8.2-fpm-alpine`，并在同一镜像里 `apk add nginx`，启动命令：

```
sh -c 'php-fpm & nginx -g "daemon off;"'
```

即 PHP-FPM 在后台、Nginx 在前台，二者共享 localhost，对应 nginx.conf 里的 `fastcgi_pass 127.0.0.1:9000`。

- 安装的扩展：`pdo_mysql`（数据库）、`gd`（编译时带 `--with-freetype --with-jpeg`，供 endroid/qr-code 生成二维码 PNG）。
- PHP 自定义配置 `backend/docker/php.ini`：
  - `upload_max_filesize = 20M`
  - `post_max_size = 20M`
  - `memory_limit = 256M`
  - `date.timezone = Asia/Shanghai`（检查日期、按天编号依赖此时区）
- PHP-FPM 池配置 `backend/docker/www.conf` 只有一行 `clear_env = no`，作用是让 compose 注入的 `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD/DB_CHARSET` 等环境变量在 PHP 中可通过 `getenv()` 读取（见 `backend/config/database.php`）。生产环境不要照抄 `clear_env = no`，应显式声明放行的环境变量。
- 后端通过服务名 `db` 连接数据库（`DB_HOST=db`），走 compose 内部网络，不依赖宿主的 hosts 或 3306 端口；宿主暴露 3306 只是为了方便本机用客户端连库。
- 登录态：管理员登录后拿到随机 `auth_token`（64 位十六进制），存 `users.auth_token`，有效期 24 小时，前端放在 `Authorization: Bearer <token>` 里；`AuthMiddleware` 只认 `role='admin'` 且未过期的 token。员工端不登录，靠 URL 上的员工 `token` 识别身份。

---

## 3. 数据库说明

| 项 | 值 |
| --- | --- |
| 镜像/版本 | `mysql:8.0` |
| 库名 | `hygiene_audit` |
| 账号/密码 | `root` / `root`（仅演示用，生产请改） |
| 字符集 | `utf8mb4`，排序规则 `utf8mb4_0900_ai_ci`（compose command 与 init.sql 均已指定） |
| 端口 | 宿主 `3306` → 容器 `3306` |
| 持久化 | 命名卷 `db_data:/var/lib/mysql` |

初始化与升级：

- `backend/database/init.sql` 以只读方式挂载到 `/docker-entrypoint-initdb.d/init.sql`，**仅在数据卷为空（首次启动）时自动执行一次**。之后改 SQL 不会自动重跑。
- 已有数据的库升级，用 `backend/database/` 下的迁移脚本手动执行（均可重复执行）：

```bash
docker compose exec -T db mysql -uroot -proot hygiene_audit < backend/database/migrate_add_auth.sql       # 登录字段
docker compose exec -T db mysql -uroot -proot hygiene_audit < backend/database/migrate_add_snapshots.sql  # 检查项快照、启用/禁用
docker compose exec -T db mysql -uroot -proot hygiene_audit < backend/database/migrate_add_check_date.sql # 检查日期 check_date
```

表结构（init.sql）：

- `users`：管理员和员工在同一张表，用 `role` 区分（`admin` / `employee`）；员工有唯一 `token`（整改链接凭证）、`qr_code_url`、`is_active`；管理员有 `username`、`password_hash`、`auth_token` 及过期时间。
- `inspection_items`：检查项与扣分项（预置：地面清洁 -5、桌面整理 -3、设备摆放 -2、垃圾清理 -5）。
- `records`：每条问题记录。保存时把检查项名称/分值快照进 `item_name_snapshot`、`item_score_snapshot`，以后改检查项不会让历史记录"漂移"；`sequence_key` 是**按员工 + 按检查日期（check_date）连续编号**的 #1、#2…，删除一条后 `RecordSequenceService::reorderAfterDelete()` 会把后面的序号整体前移，保持连续；`status` 为 `pending` / `completed`，整改完成后写 `fix_image`。

预置演示数据：管理员 `admin`（首次登录前密码哈希为空，首次用 `admin123` 登录时自动哈希落库）；员工张三（`emp-token-001`，已有 #1 地面清洁待整改、#2 桌面整理已整改、#3 设备摆放待整改）、李四（`emp-token-002`，无记录，适合现场演示"从零录入"）。

---

## 4. 上传目录与权限

### 4.1 目录布局（容器内）

物理目录在后端容器的 `/app/public/uploads`，URL 前缀为 `http://localhost:8080/uploads/`。按上传者分子目录（见 `UploadController::image()`）：

```
/app/public/uploads/
├── admin/                       # 管理员在"检查上传"页传的问题图
│   └── 20261002_xxxxxx.jpg
├── employees/
│   └── <员工 user_id>/          # 员工本人在整改页传的整改图，互相隔离
│       └── 20261002_xxxxxx.png
└── qr_<user_id>_<time>.png      # 二维码图片，由 QrService 直接写在 uploads 根目录
```

- 允许的扩展名仅 `jpg / jpeg / png / gif`（服务端校验，前端 accept 只是辅助）；单文件 20M（Nginx、PHP 双重限制）。
- 文件名按 `时间_uniqid.扩展名` 重命名，避免覆盖和路径穿越。
- 上传接口 `/api/upload/image` 不要求管理员登录态，但**禁止匿名**：二选一——管理员 `Authorization: Bearer <auth_token>`，或员工表单字段 `token=<本人 token>`；被禁用（`is_active=0`）的员工上传会收到 403「账号已禁用」。

### 4.2 Docker 演示环境的权限（开箱即用）

`backend/Dockerfile` 里已经：

```dockerfile
RUN mkdir -p runtime/log runtime/cache public/uploads && chmod -R 777 runtime public/uploads
```

容器内 Nginx worker 与 php-fpm 主进程以 root 启动（自定义 nginx.conf 未声明 `user`），php-fpm worker 默认为 `www-data`。因为目录已被建成 `777`，无论写入动作来自哪个账号都能成功，所以 `runtime/`（日志、缓存）和 `public/uploads/` 开箱可写，无需额外授权。注意：`777` 只适合本机演示，生产不要沿用。

### 4.3 裸机/虚拟机部署的权限（生产建议）

不用 Docker 时，Nginx 与 php-fpm 通常以 `www-data`（Debian/Ubuntu）或 `nginx`（RHEL 系）运行，按以下方式授权，不要用 777：

```bash
# 假设部署在 /var/www/hygiene-audit，运行账号 www-data
cd /var/www/hygiene-audit/backend
mkdir -p runtime/log runtime/cache public/uploads
chown -R www-data:www-data runtime public/uploads
find runtime public/uploads -type d -exec chmod 755 {} \;
find runtime public/uploads -type f -exec chmod 644 {} \;
```

要点：

- **只有 `runtime/` 和 `public/uploads/` 需要写权限**；`app/`、`vendor/`、`config/` 对运行账号只读即可。
- Nginx 以静态方式直接返回 `/uploads/` 文件，因此该目录要在 web 根下且对 Nginx 进程可读（上面的 755/644 已满足）。
- 若给 uploads 改用挂载卷（见第 6 节），新卷的属主不一定是运行账号，需在首次启动后补一次上面的 `chown/chmod`。

---

## 5. 二维码与访问域名（重点，手机扫不开多半是这里）

### 5.1 二维码里编码的是什么

- 生成逻辑在 `backend/app/service/QrService.php`，链接 = `base_url + '?token=' + 员工token`，二维码是用 endroid/qr-code 现场画的 300×300 PNG，存到 `/uploads/qr_<用户id>_<时间戳>.png`，并把相对路径写回 `users.qr_code_url`。
- `base_url` 由前端提供（`AdminView.vue`、`EmployeesView.vue`）：

```js
const baseUrl = window.location.origin + '/fix'
```

所以**二维码里的域名 = 管理员点"生成二维码"那一刻，浏览器地址栏的源（协议+主机+端口）+ `/fix`**。本机演示时编码的就是：

```
http://localhost:3000/fix?token=emp-token-001
```

员工页 `/fix` 是公开路由（`router/index.js` 中 `meta.public`），不需要登录；进入后用 `token` 调 `/api/records?token=...` 拉取本人记录，上传整改图时再把同一个 token 带给上传/整改接口。

### 5.2 部署到服务器/门店时怎么保证手机能扫开

1. 前端要用"员工手机能访问到的地址"重新构建。例如后端对外是 `http://192.168.1.50:8080`，则构建参数改为：
   `VITE_API_BASE=http://192.168.1.50:8080`（有域名/HTTPS 同理，例如 `https://api.example.com`）。
2. 管理员本人也要通过**同一个对外地址**打开管理后台（如 `http://192.168.1.50:3000`）再点"生成/刷新二维码"，二维码才会编码 `http://192.168.1.50:3000/fix?token=...`。
   - 如果管理员是在自己电脑上用 `localhost:3000` 生成的二维码，码里就是 `localhost`，手机扫码后访问的是手机自己，必然打不开——这是最高频的"扫不开"原因。
3. 换域名/端口后，需要对相关员工重新点一次「生成/刷新二维码」（旧 PNG 不会自动更新，新码会生成新文件）。
4. 相关安全行为（演示时可顺带说明）：
   - 在"员工管理"里点「重置 token」会更换 token、**同时清空 `qr_code_url`**，旧链接/旧二维码立即失效，需要重新生成再下发。
   - 点「禁用」后，员工用原链接访问会收到 403「账号已禁用」，无法查看与上传；「启用」后恢复。
   - 每次生成都是新文件（按时间戳命名），旧二维码 PNG 不会被自动清理，长期运行可定期清理。

---

## 6. 备份图片（及数据库）的方式

### 6.1 先注意：当前 compose 没有为 uploads 挂卷

`docker-compose.yml` 只给数据库挂了 `db_data`，**图片写在后端容器的可写层里**。因此：

- `docker compose stop` 之后再 `start`、或直接重启宿主：容器还在，图片还在；
- `docker compose down`：默认就会**停止并删除容器**，容器可写层里的图片随之丢失（加不加 `-v` 只影响命名卷，而 uploads 此刻并不在卷里）；镜像更新、改 Dockerfile 后重新 `up --build` 产生新容器，图片同样会丢；
- 数据库记录（含图片路径、整改状态）在 `db_data` 命名卷里，后端容器重建不影响它——结果就是可能出现"记录在、图裂开"。所以图片要单独备份。

### 6.2 临时备份/恢复（docker cp，不改配置）

备份（在项目根目录执行）：

```bash
mkdir -p backup
CID=$(docker compose ps -q backend)
docker cp "$CID:/app/public/uploads" "backup/uploads-$(date +%F_%H%M)"
```

恢复到新容器：

```bash
CID=$(docker compose ps -q backend)
docker cp backup/uploads-2026-10-02_1400/. "$CID:/app/public/uploads/"
```

恢复后建议进容器确认属主/权限：`docker compose exec backend ls -l /app/public/uploads`。

### 6.3 长期方案：给 uploads 挂卷（推荐）

在 `docker-compose.yml` 的 `backend` 服务下增加挂载，并在顶层 `volumes:` 声明：

```yaml
services:
  backend:
    # ...原有配置...
    volumes:
      - uploads_data:/app/public/uploads

volumes:
  db_data:
  uploads_data:
```

首次挂载空命名卷时 Docker 会把镜像内目录连同权限复制过去；若线上遇到 PHP 无法写入，执行一次：

```bash
docker compose exec backend sh -c 'chmod -R 777 /app/public/uploads'   # 演示环境
# 生产环境改为把属主调整为 php-fpm 运行账号
```

之后可直接对宿主机上的卷目录做定时打包，例如：

```bash
# 每天打包一次上传图片（卷的实际路径可用 docker volume inspect 查看）
tar czf backup/uploads-$(date +%F).tgz -C /var/lib/docker/volumes/<项目名>_uploads_data/_data .
```

### 6.4 数据库一起备份

图片路径和"是否已整改"都在库里，备份图片时应连同数据库一起，恢复时才对得上：

```bash
# 备份
docker compose exec -T db mysqldump -uroot -proot --single-transaction --default-character-set=utf8mb4 \
  hygiene_audit > "backup/hygiene_audit-$(date +%F).sql"

# 恢复（空库时）
docker compose exec -T db mysql -uroot -proot --default-character-set=utf8mb4 \
  hygiene_audit < backup/hygiene_audit-2026-10-02.sql
```

建议把 6.3 的图片 tar 与 6.4 的 SQL  dump 放进同一个 crontab，按日期留存。

---

## 7. 三种角色演示动线

> 演示前：项目根目录执行 `docker compose up --build`，等 db 健康检查通过；浏览器开 http://localhost:3000 会自动跳到 `/login`。
> 预置账号：管理员 `admin` / `admin123`；员工张三 token `emp-token-001`（已有 3 条记录）、李四 token `emp-token-002`（空白）。

### 7.1 管理员：录入问题、下发整改、管理人员

1. **登录**：在 http://localhost:3000/login 输入 `admin` / `admin123`。
   - 首次登录后端会把 `admin123` 做 password_hash 落库，并签发 24 小时有效的 auth_token（以后再进 `/admin` 不用重复登）。
2. **检查上传（/admin）——用李四演示从零录入**：
   - 「选择员工」选**李四**；「检查日期」默认当天，可改（#序号按"员工+日期"分别连续）。
   - 因为李四没有历史记录，"已有问题图片"区域不出现。拖入或点选 2 张照片（如地面污渍、垃圾桶满溢），下方出现两张待保存卡片，预览上方提示保存后序号为 **#1～#2**。
   - 分别给两张图选检查项：**地面清洁（-5分）**、**垃圾清理（-5分）**，点「保存并生成链接与二维码」。
   - 保存成功后页面展示整改链接（`http://localhost:3000/fix?token=emp-token-002`）与二维码图片；再选回**张三**，可看到他当天已有 #1、#2、#3 三张图，每张显示检查项徽章和扣分。
   - 可演示**删除重排**：删掉张三的 #2，列表立刻只剩 #1、#3，再刷新页面，后端已把原 #3 前移为 #2（当天序号始终连续、不跳号）。
3. **员工管理（/employees）——演示凭证生命周期**：
   - 每张员工卡片显示 ID、token、启用状态；点「生成/刷新二维码」，下方出现可复制的整改链接和二维码缩略图。
   - 点「新增员工」输入姓名（如"王五"），列表里立刻出现系统自动生成的随机 token。
   - 点「禁用」→ 标签变"已禁用"（后面员工步可以验证链接被拒）；再点「启用」恢复。
   - 点「重置 token」→ token 变成新的随机串、二维码区消失（说明旧链接/旧码已作废，需重新生成下发）。

### 7.2 员工：扫码整改，不登录

1. **用链接进入**（模拟扫码）：浏览器打开
   `http://localhost:3000/fix?token=emp-token-002`（李四），无需账号密码。
2. 页面按 **#key 从小到大**列出 #1 地面清洁（-5）、#2 垃圾清理（-5），每条左边是管理员拍的问题图、右边是"待处理 / 上传整改图"。
3. 在 #1 上点「上传整改图」选一张照片：按钮处先出现 loading，上传完成后右侧显示整改图缩略图、中间箭头变成绿色对勾，记录状态变为「已完成」（后端写入 `fix_image` 并把 `status` 置为 completed）。
4. 打开右上开关「仅看待整改」，列表只剩 #2；再切回「显示全部」可看到已完成的图片对。
5. 换张三的链接 `http://localhost:3000/fix?token=emp-token-001`，能看到预置数据：#2 已是"问题图 → 整改图"成对展示，#1、#3 仍待整改——演示"老员工有历史、接着整改"的场景。
6. 异常场景验证：
   - 不带 token 访问 `/fix`：页面提示"缺少 token / 请使用管理员提供的链接或扫码进入"。
   - 管理员在后台把该员工「禁用」后再上传：接口返回 403「账号已禁用」；「重置 token」后用旧链接：提示"无效的 token"。

### 7.3 老板：只看结果，不动数据

**当前版本的真实情况需要说明**：系统登录只对 `role='admin'` 开放（见 `AuthController::login()` 和 `AuthMiddleware`），种子数据里也只有一个 admin 账号和两个 employee 账号，**没有独立的"老板"账号/角色**。因此老板的演示方式是：

1. 用管理员账号 `admin` / `admin123` 登录 http://localhost:3000；
2. 直接进入（或只向老板展示）**汇总看板 `/summary`**，操作上约定**不进入"检查上传""员工管理"两个页签**——该页面本身是纯只读报表，没有任何新增/编辑/删除按钮。

老板在 `/summary` 能看到的内容（数据来自 `SummaryController`，按员工汇总）：

- 每名员工一张卡片：头像、姓名、**整改进度百分比（已完成/总数，如 1/2 = 50%）**、**扣分合计**（该员工全部记录的检查项快照分值之和）。
- 每条记录按 #key 排序，问题图与整改图**左右成对**展示，徽章统一显示"检查项 + 扣分"；待整改显示橙色「待整改」和箭头，完成后显示绿色「已完成」和对勾。
- 建议现场配合演示闭环：让第 7.2 步的员工当场传一张整改图，老板这边刷新页面，即可看到进度从 50% 跳到 100%、图片对补齐。

如果后续要做真正独立的老板账号，需要改三处，目前代码里**尚未实现**，不要在演示中声称已有：

1. 数据：新增一个 `role='boss'` 的账号（直接给用户名密码登录），或在"新增员工"之外加建账号入口；
2. 后端：`AuthController::login/me()` 与 `AuthMiddleware` 放开 boss 登录，但路由层只允许 boss 访问 `GET /api/summary`，其余 `/api/users`、`/api/records`（写）、`/api/qr/generate` 等一律拒绝；
3. 前端：路由守卫按 `role` 控制，老板登录后只挂载 `/summary`，布局里隐藏"检查上传/员工管理"入口。
