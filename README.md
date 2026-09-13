# 员工卫生考核系统（Hygiene Audit System）

一套用于门店/车间卫生检查的小系统：管理员现场拍照记录问题 → 员工扫码/点链接进入自己的整改页 → 上传整改图 → 老板在汇总看板上查看每个人的整改进度与扣分。

## 技术栈与服务拓扑

- **前端**：Vue 3 + Vite + Tailwind CSS + Element Plus，构建为静态文件后由 Nginx 提供（容器内 80，宿主映射 **3000**）。
- **后端**：PHP 8.2 + ThinkPHP 8。一个容器内同时运行 **Nginx（80 端口，宿主映射 8080）+ PHP-FPM（127.0.0.1:9000）**，启动命令为 `php-fpm & nginx -g "daemon off;"`（见 `backend/Dockerfile`）。
- **数据库**：MySQL 8.0，库名 `hygiene_audit`，字符集 `utf8mb4`（容器 3306，宿主映射 3306）。
- **二维码**：`endroid/qr-code`（^5.0）在 PHP 端直接生成 PNG 文件。

```
浏览器 ──► frontend:3000  (Nginx 静态文件，前端路由回退 index.html)
   │
   └─ XHR / <img> ──► backend:8080 (Nginx) ──fastcgi──► 127.0.0.1:9000 (PHP-FPM)
                                                      │
                                                      └── PDO ──► db:3306 (MySQL)
```

注意：浏览器**直连后端 8080**，API 地址在前端构建时由 `VITE_API_BASE` 写死（见下文「二维码访问域名」）。

## 启动

1. 确保 Docker Desktop / Docker Engine 已启动。
2. 在项目根目录执行：
   ```bash
   docker compose up --build
   ```
3. 等待 db 的健康检查（`mysqladmin ping`）通过，后端和前端才会启动。
4. 浏览器访问 <http://localhost:3000>，根路径 `/` 会自动跳到 `/login`。
5. 健康检查：<http://localhost:8080/ping.php> 返回 `{"code":0,"message":"pong",...}` 即后端正常。

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| 前端（Docker） | <http://localhost:3000> | 日常演示只用这个 |
| 后端 API | <http://localhost:8080> | 图片实际由这里的 Nginx 输出 |
| MySQL | localhost:3306 | root / root，库 `hygiene_audit` |
| 前端（Vite 热更新） | <http://localhost:5173> | Docker 不会启动它，需另开终端 `cd frontend && npm run dev` |

---

## Nginx 说明

系统里有**两套独立的 Nginx 配置**，不要混淆：

### 1. 后端 Nginx：`backend/docker/nginx.conf`

- `root /app/public;`，ThinkPHP 的单一入口是 `public/index.php`。
- `location /` 对不存在的文件做伪静态：`rewrite ^(.*)$ /index.php?s=$1 last;`，所以 `/api/...` 路由全部交给框架。
- `location ~ \.php$` 把 PHP 请求转发给 **`fastcgi_pass 127.0.0.1:9000`**（PHP-FPM 与 Nginx 同容器，靠 loopback 通信），并设置 `SCRIPT_FILENAME`、`PATH_INFO`。
- `client_max_body_size 20M`，与 PHP 的上传上限对齐。
- `/uploads` **没有单独的 location**，因此上传后的图片（`public/uploads/...`）是 Nginx 直接输出的静态文件，jpg/png/gif 等带 7 天缓存。
- 所有响应（含 OPTIONS 预检）都放开了跨域头：
  `Access-Control-Allow-Origin: *`，允许方法 `GET, POST, PUT, DELETE, OPTIONS`，允许头 `Content-Type, Authorization`。这样前端跑在 3000、API 跑在 8080 才不会被浏览器拦截。

### 2. 前端 Nginx：`frontend/nginx.conf`

- 多页应用回退：`try_files $uri $uri/ /index.html;`，保证刷新 `/admin`、`/fix` 等前端路由不出现 404。
- 静态资源（js/css/png/jpg/gif/ico/svg/woff 等）设置 7 天缓存。
- 它**不反代 API**。API 与图片请求直接发到 `VITE_API_BASE`（默认 <http://localhost:8080>）。

> 改了 Nginx 配置后需要重新构建对应服务才生效：
> `docker compose up --build backend`（或 `frontend`）。

---

## PHP-FPM 说明

- 基础镜像 `php:8.2-fpm-alpine`，额外安装的扩展：**`pdo_mysql`**（数据库）和 **`gd`**（`--with-freetype --with-jpeg`，供二维码库画图）。
- FPM 配置 `backend/docker/www.conf` 只有一行 `clear_env = no`，作用是让 `docker-compose.yml` 注入的 `DB_HOST`、`DB_PASSWORD` 等环境变量在 PHP 进程中可见（否则 FPM 默认会清空环境变量，连不上数据库）。
- 自定义 php.ini（`backend/docker/php.ini`）：
  ```ini
  upload_max_filesize = 20M   ; 单张图片上限
  post_max_size       = 20M   ; 整个请求体上限（要 ≥ upload_max_filesize）
  memory_limit        = 256M
  date.timezone       = Asia/Shanghai
  ```
- 登录态方式：管理员登录后拿到 32 字节随机 token（`users.auth_token`），前端放在 `Authorization: Bearer <token>` 请求头；有效期 24 小时（`AuthController::TOKEN_EXPIRE_HOURS`）。除登录、员工整改、图片上传外，管理端接口都挂了 `AuthMiddleware`，且中间件**只认 `role=admin`**。

---

## 数据库说明

- MySQL 8.0，启动参数强制 `--character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci`；PHP 端 DSN 也带 `charset=utf8mb4`，避免中文乱码。
- 首次启动时自动执行 `backend/database/init.sql`（挂载到 `/docker-entrypoint-initdb.d/`），建 3 张表并写入演示数据：

  | 表 | 关键字段 | 说明 |
  | --- | --- | --- |
  | `users` | `username/password_hash/auth_token`（登录）、`token`（员工入口令牌）、`role`（`admin`/`employee`）、`is_active`（启用/禁用）、`qr_code_url` | 员工 `username` 为 NULL，不走登录 |
  | `inspection_items` | `name`、`score` | 检查项字典（地面清洁 -5 分等） |
  | `records` | `user_id`、`item_id`、`item_name_snapshot/item_score_snapshot`（扣分快照，防止字典改了历史跟着变）、`sequence_key`（每人每天从 1 连续编号）、`issue_image`、`fix_image`、`status`（`pending`/`completed`）、`check_date` | 一条记录 = 一张问题图 + 一张整改图 |

- 已有数据库升级（脚本都是「列不存在才加」，可重复执行）：
  ```bash
  # 登录字段（username / password_hash / auth_token 等）
  docker compose exec -T db mysql -uroot -proot hygiene_audit < backend/database/migrate_add_auth.sql
  # 检查日期 check_date
  docker compose exec -T db mysql -uroot -proot hygiene_audit < backend/database/migrate_add_check_date.sql
  # 快照字段 + is_active + 索引（综合迁移）
  docker compose exec -T db mysql -uroot -proot hygiene_audit < backend/database/migrate_add_snapshots.sql
  ```
  若后端报「Unknown column 'check_date'」，执行对应迁移即可，接口本身也会返回中文提示引导执行。
- 数据持久化：MySQL 数据在命名卷 `db_data` 中，`docker compose down` 不会丢数据；`docker compose down -v` 才会清空。

---

## 上传目录与权限

上传的图片全部落在后端容器内的 **`/app/public/uploads/`**（即代码里的 `public_path() . 'uploads'`），按调用身份分子目录：

```
public/uploads/
├── admin/                         管理员拍的问题图：/uploads/admin/20260913_xxxxxx.jpg
├── employees/<员工id>/            员工上传的整改图：/uploads/employees/2/20260913_xxxxxx.png
└── qr_<userId>_<时间戳>.png       生成的员工整改二维码（存在根目录）
```

- 文件名格式：`年月日时分秒_uniqid.扩展名`，避免重名覆盖。
- 白名单扩展名：`jpg / jpeg / png / gif`，其他一律拒绝（后端 `UploadController` 校验，前端 input 也带 `accept` 限制）。
- 权限要点：
  - 镜像构建时 `backend/Dockerfile` 执行了
    `mkdir -p runtime/log runtime/cache public/uploads && chmod -R 777 runtime public/uploads`。
  - 原因：Nginx master 以 root 启动、worker 为 `nginx` 用户，而 PHP-FPM 工作进程默认是官方镜像内置的 **`www-data`**（uid 82；本项目的 `www.conf` 没有覆盖 user/group），两边都要写这个目录，所以直接放开为 777；运行期代码 `mkdir()` 新建的子目录权限为 `0755`，属主是 FPM 运行用户。
  - 本地（非 Docker）部署时请确保 PHP-FPM 的运行用户（如 `www-data`）对 `runtime/` 和 `public/uploads/` 有写权限，例如：
    ```bash
    chown -R www-data:www-data backend/runtime backend/public/uploads
    chmod -R 755 backend/public/uploads
    ```
- **重要（当前版本的坑）**：`docker-compose.yml` 目前**没有给 `public/uploads` 挂载卷**，图片只存在后端容器的可写层里。一旦执行 `docker compose up --build backend` 重建后端容器，所有上传图片（含二维码 PNG）都会丢失，数据库里只剩路径。生产或需要长期保留时，请在 `backend` 服务下加挂载：
  ```yaml
      volumes:
        - uploads_data:/app/public/uploads
  # 文件底部 volumes: 段同时加上  uploads_data:
  ```

---

## 二维码与访问域名

二维码的链接由**前端当前访问地址**决定，不由后端配置决定（代码见 `EmployeesView.vue` / `AdminView.vue`）：

```js
const baseUrl = window.location.origin + '/fix'
// 最终链接：<baseUrl>?token=<员工token>
// 例：    http://192.168.1.20:3000/fix?token=emp-token-001
```

- 二维码内容拼成 `…/fix?token=xxx`，由 PHP 端 `QrService` 用 endroid 生成 300×300 PNG，保存为 `/uploads/qr_<userId>_<时间戳>.png`，路径写回 `users.qr_code_url`。
- **本机演示**：浏览器开 <http://localhost:3000>，点「生成/刷新二维码」，扫出来就是 `http://localhost:3000/fix?token=...`，本机可用。
- **手机扫码演示（重点）**：手机里的 `localhost` 指的是手机自己，扫了也打不开。必须让**电脑浏览器用局域网 IP 访问前端**（如 `http://192.168.1.20:3000`），再在该页面上生成二维码，手机和电脑连同一 Wi-Fi 才能扫码打开。
  - 同时前端构建参数要让手机也能访问到后端。默认 `VITE_API_BASE=http://localhost:8080` 是写死进 JS 的，手机端同样解析不了 localhost。重新构建时改成电脑局域网 IP：
    ```bash
    # 临时改 docker-compose.yml 中 frontend 的 build args，或命令行：
    VITE_API_BASE=http://192.168.1.20:8080 docker compose up --build frontend
    ```
  - 部署到服务器时同理，把两处都换成正式域名（前端域名用于二维码链接，API 域名用于数据/图片），并在 HTTPS 下使用 `https://`。
- 链接中的 `token` 是员工的**免密凭证**（32 位十六进制，`users.token` 唯一）。在「员工管理」里点「重置 token」后旧链接、旧二维码立即失效（重置时会清空 `qr_code_url`，需要重新生成）。
- 员工入口无需账号密码：打开 `/fix?token=...` 即拉取该员工记录；`is_active=0` 的员工访问会收到 403「账号已禁用」。

---

## 备份：数据库与图片

备份必须**同时**备份 MySQL 数据和 `uploads` 图片目录，只备份其中一个会出现「有记录没图」或「有图没记录」。

### 备份数据库（逻辑导出）

```bash
# 导出（在项目根目录执行，生成带日期的 sql 文件）
mkdir -p backup
docker compose exec -T db mysqldump -uroot -proot \
  --single-transaction --default-character-set=utf8mb4 hygiene_audit \
  > backup/hygiene_audit_$(date +%Y%m%d_%H%M%S).sql
```

### 备份图片

```bash
# 从运行中的后端容器拷出整个上传目录
docker compose cp backend:/app/public/uploads backup/uploads_$(date +%Y%m%d_%H%M%S)
# 或打包成一个 tar.gz
docker compose exec -T backend tar -C /app/public -czf - uploads \
  > backup/uploads_$(date +%Y%m%d_%H%M%S).tar.gz
```

### 恢复

```bash
# 1) 恢复数据库
docker compose exec -T db mysql -uroot -proot --default-character-set=utf8mb4 hygiene_audit < backup/hygiene_audit_20260913_120000.sql
# 2) 恢复图片（解包回容器，注意会覆盖同名文件）
cat backup/uploads_20260913_120000.tar.gz | docker compose exec -T backend tar -C /app/public -xzf -
```

建议配合系统 `cron` 每天各执行一次上面两条备份命令；正式环境请按上一节给 uploads 配置独立卷，备份/迁移会更可靠。

---

## 三种角色演示流程

> 角色现状说明（避免误解）：代码里实际只落地了 **admin（管理员）** 与 **employee（员工）** 两种角色（`users.role`，`AuthMiddleware` 只放行 admin）。**老板目前没有独立账号体系**，演示中老板与管理员共用同一个登录入口，但只使用「汇总看板」这一只读页面。下方第 3 节如实给出当前可走通的老板流程；若以后要严格分权，需要新增 `role=boss` 账号、让中间件放行 boss 访问 `/api/summary`、并在前端隐藏「检查上传 / 员工管理」菜单。

预置账号（`init.sql` Seed）：

| 角色 | 身份 | 登录方式 |
| --- | --- | --- |
| 管理员 | 「管理员」 | 用户名 `admin` / 密码 `admin123`（首次登录后写入 password_hash，之后改密以此为准） |
| 员工 | 张三 | 免登录，链接/扫码：`/fix?token=emp-token-001` |
| 员工 | 李四 | 免登录，链接/扫码：`/fix?token=emp-token-002` |

### 流程 1：管理员 —— 开单、拍照、发链接

1. 打开 <http://localhost:3000>，用 `admin / admin123` 登录，进入「检查上传」（`/admin`）。
2. 顶部下拉选择员工（如「张三」），用日期选择器选检查日期（默认当天；序号按「员工 + 日期」分别从 1 开始）。
3. 「已有问题图片」区域会显示张三当天已有记录：`#1 地面清洁 -5分`、`#2 桌面整理 -3分`、`#3 设备摆放 -2分`（Seed 数据；Seed 里的示例图 `/uploads/issue_*.jpg` 没有真实文件，图裂属正常现象，自己重新上传即可）。可以点某张的「删除」，删除后 `#3` 会自动重排成 `#2`，序号不留空号。
4. 在「上传问题图片」拖拽或点选 1～多张 JPG/PNG/GIF（一次最多 20 张），每张在下方为其选择一个检查项（如「地面清洁 (-5分)」），界面会预告新序号是 `#4、#5…`。
5. 点「保存并生成链接与二维码」：图片先调 `/api/upload/image`（带 Bearer token，落到 `/uploads/admin/`），再调 `POST /api/records` 批量建记录，同时把检查项名称/分值写入快照；保存成功后页面展示整改链接（`http://localhost:3000/fix?token=emp-token-001`）和二维码 PNG。
6. 切到「员工管理」（`/employees`）可查看每名员工的 ID、token、整改链接，点「生成/刷新二维码」可单独出码；也可以在这里**新增员工、禁用/启用、重置 token**（重置后旧码作废）。
7. 不登录直接访问 `/admin`、`/employees`、`/summary` 会被路由守卫踢回 `/login`；不带头调管理端 API 会收到 `code:401 未登录`，token 超过 24 小时会提示「登录已过期」。

### 流程 2：员工 —— 扫码整改

1. 在手机（与电脑同一 Wi-Fi，用局域网 IP 打开的页面生成的码）上扫码，或在本机直接打开
   <http://localhost:3000/fix?token=emp-token-001>。该页**不需要登录**，URL 没带 token 时只显示「请通过扫码或链接（含 token）进入」。
2. 页面按 `sequence_key` 从小到大列出张三的记录卡片：每条显示 `#序号`、检查项徽章、扣几分，左边是**问题图**，右边是整改区。
3. 顶部开关可在「仅看待整改 / 显示全部」之间切换。
4. 在待整改卡片上点「上传整改图」选照片：前端先调 `/api/upload/image?token=...`（校验该 token 属于启用状态的员工，文件存到 `/uploads/employees/2/`），拿到图片 URL 后调 `PUT /api/records/:id/fix`；后端再次校验 token 持有人必须是记录本人，防串号。
5. 成功后卡片右侧变为整改缩略图、中间出现绿色对勾，状态变「已完成」；`#2 桌面整理` 在 Seed 中已是 completed，可直接看到问题图/整改图成对展示的效果。
6. 回到管理员页面重新进入张三的记录或看板，新状态、新图片实时可见。
7. 若该员工被管理员「禁用」，再次打开链接或上传会收到 403「账号已禁用」。

### 流程 3：老板 —— 只看汇总（当前演示走法）

1. 老板打开 <http://localhost:3000>，当前版本用管理员账号 `admin / admin123` 登录（系统暂无独立老板账号）。
2. 登录后直接进入「汇总看板」（`/summary`），**不操作**「检查上传」和「员工管理」两个菜单。
3. 看板按员工分组（张三、李四），每人显示：
   - 整改进度百分比与「已完成 / 总数」（如 1/3 → 33.3%，全部完成显示 100% 绿色）；
   - 扣分合计（取每条记录的分值快照求和，如 `-10分`）；
   - 每条记录一行：`#序号 + 检查项徽章 + 分值 + 待整改/已完成标签`，并把**问题图与整改图左右成对**展示，按 `#key` 升序。
4. 对照演示：先让员工张三在流程 2 中补传一张整改图，老板刷新看板，可看到进度从 33.3% 变 66.7%、对应行出现绿色「已完成」和整改图。
5. 演示讲解时可说明：老板视角只关心「谁还有几条没改、总共扣多少分、前后对比照片」；如需真正的分权（老板用独立账号登录、看不到管理菜单和接口），按本节开头的说明增加 `boss` 角色即可。

---

## 本地开发补充

- 前端热更新：另开终端执行 `cd frontend && npm run dev`，等出现 `Local: http://localhost:5173/` 后访问；此时后端可用 `docker compose up -d db backend` 提供。
- API base 取值顺序：构建期环境变量 `VITE_API_BASE`（默认 <http://localhost:8080>），未设置时退回当前页面的 origin（`frontend/src/api/request.js`）。图片 URL 同理：数据库里只存 `/uploads/...` 相对路径，前端展示时拼上 API base。
- 后端日志：ThinkPHP 运行日志写在容器内 `/app/runtime/log`，排障时可 `docker compose logs backend` 或进容器查看。
