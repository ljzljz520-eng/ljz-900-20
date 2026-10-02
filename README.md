# 员工卫生考核系统 (Hygiene Audit System)

管理人员上传卫生问题照片并关联检查项扣分，系统自动生成员工整改链接与二维码；员工扫码免登录上传整改照片；管理层在汇总看板查看整改完成率与前后对比图。

## 技术栈

- **Frontend**: Vue 3 + Vite + Tailwind CSS + Element Plus（构建产物由 Nginx 托管）
- **Backend**: PHP 8.2 + ThinkPHP 8（Nginx + PHP-FPM 同容器运行）
- **Database**: MySQL 8.0（utf8mb4）
- **QR Code**: endroid/qr-code（后端生成 PNG）

## 启动指南 (How to Run)

1. 确保 Docker Desktop 已启动。
2. 在项目根目录执行：`docker compose up --build`
3. 等待容器启动完成（数据库健康检查通过、后端与前端构建完成）。
4. 浏览器访问前端地址即可使用。

## 服务地址 (Services)

- **Frontend（Docker，推荐）**: **http://localhost:3000** — 执行 `docker compose up --build` 后访问此地址即可，无需再开 5173。
- **Frontend（本地 Vite 开发）**: http://localhost:5173 — 仅当需要热更新时使用，需**单独**在终端执行 `cd frontend && npm run dev`（Docker 不会启动 5173）。
- **Backend API**: http://localhost:8080
- **Database**: localhost:3306（user: root / pass: root，库名 `hygiene_audit`）

### 访问不了 5173 时

- 若你只运行了 `docker compose up`：请改用 **http://localhost:3000** 访问前端，Docker 前端在 3000 端口。
- 若确实要用 5173（热更新开发）：在项目根目录新开一个终端，执行：
  ```bash
  cd frontend && npm run dev
  ```
  等终端出现 “Local: http://localhost:5173/” 后再用浏览器打开。此时需保证后端已启动（如 `docker compose up -d db backend`）。

---

## 架构与部署说明

系统由 3 个容器组成：`frontend`（Nginx 托管静态页）、`backend`（Nginx + PHP-FPM + ThinkPHP）、`db`（MySQL 8.0）。浏览器加载前端页面后，直接跨域请求后端 API（`VITE_API_BASE=http://localhost:8080` 在前端构建时注入）。

### 1. Nginx（共两个实例，职责不同）

**前端 Nginx**（`frontend/nginx.conf`，容器内 80 → 宿主机 3000）：

- 托管 Vite 构建产物（纯静态文件），`try_files $uri $uri/ /index.html` 支持 Vue Router 的 history 模式（刷新 `/admin`、`/fix` 等路径不会 404）。
- 静态资源（js/css/图片/字体）缓存 7 天。
- 不代理 API——前端 JS 直接请求 `http://localhost:8080`，跨域由后端 Nginx 的 CORS 头放行。

**后端 Nginx**（`backend/docker/nginx.conf`，容器内 80 → 宿主机 8080）：

- 站点根目录 `/app/public`，入口 `index.php`；不存在的路径重写为 `index.php?s=<path>`，交给 ThinkPHP 路由。
- `location ~ \.php$` 通过 `fastcgi_pass 127.0.0.1:9000` 把 PHP 请求转给**同容器**的 PHP-FPM。
- `client_max_body_size 20M`：限制单次上传请求体不超过 20MB，与 PHP 配置一致。
- 内置 CORS 响应头（`Access-Control-Allow-Origin: *` 等），`OPTIONS` 预检直接返回 204。
- 图片等静态文件（含 `/uploads/` 下的上传图、二维码）由 Nginx 直接返回并缓存 7 天，不经过 PHP。

### 2. PHP-FPM

- 基础镜像 `php:8.2-fpm-alpine`，与后端 Nginx **同容器**运行，通过 `127.0.0.1:9000`（FastCGI）通信；启动命令为 `php-fpm & nginx -g "daemon off;"`。
- 已装扩展：`pdo_mysql`（连接数据库）、`gd`（含 freetype/jpeg，二维码 PNG 生成依赖它）。
- 自定义配置（`backend/docker/php.ini`）：`upload_max_filesize=20M`、`post_max_size=20M`、`memory_limit=256M`、时区 `Asia/Shanghai`。
- `www.conf` 设置 `clear_env=no`，使 PHP 能读到 docker-compose 注入的 `DB_HOST`、`DB_PASSWORD` 等环境变量。
- 数据库连接走服务名 `db`（容器间网络），不依赖宿主机环境。

### 3. 数据库

- MySQL 8.0，库 `hygiene_audit`，全库 `utf8mb4` / `utf8mb4_0900_ai_ci`（支持 emoji 与完整中文排序）。
- 数据持久化在命名卷 `db_data`：`docker compose down` 不丢数据，只有 `down -v` 才会清空。
- 首次启动自动执行 `backend/database/init.sql` 建表并写入种子数据；老库升级用 `backend/database/migrate_*.sql`（见下文「已有数据库升级」）。
- 三张表：
  - `users`：账号与员工（`role` 区分 admin/employee）、员工免登录 token、登录态 `auth_token`、二维码图片地址 `qr_code_url`。
  - `inspection_items`：检查项与分值（如「地面清洁 -5分」）。
  - `records`：考核记录——序号 `sequence_key`、问题图 `issue_image`、整改图 `fix_image`、状态 `status`、检查日期 `check_date`，并冗余保存检查项名称/分值快照（检查项日后改名不影响历史记录）。

### 4. 上传目录与权限

- 所有上传文件落在后端容器的 **`/app/public/uploads/`**，经后端 Nginx 以 `http://localhost:8080/uploads/...` 直接访问。
- 目录分工：
  - `uploads/admin/` —— 管理员上传的问题图；
  - `uploads/employees/<员工id>/` —— 员工上传的整改图；
  - `uploads/qr_*.png` —— 系统生成的二维码图片。
- 权限：镜像构建时 `chmod -R 777 public/uploads`（`backend/Dockerfile`），运行时 PHP 以 `0755` 逐级创建子目录。开发环境用 777 是为了让 Nginx/PHP-FPM 不同用户及宿主机挂载场景都能写；**生产环境建议收紧为 0755 并把属主改为 PHP-FPM 运行用户**。
- 上传限制：仅 `jpg/jpeg/png/gif`，单文件与单请求均 ≤ 20MB（Nginx 与 PHP 双重限制）。
- 接口鉴权：`POST /api/upload/image` 要求管理员登录态（`Authorization: Bearer <auth_token>`）或员工 token 二选一，禁止匿名上传；被禁用员工（`is_active=0`）上传会被拒绝。
- ⚠️ 注意：当前 compose **未给 backend 挂载 uploads 卷**，图片保存在容器文件系统中，容器被删除重建后图片会丢失。生产部署建议加卷：
  ```yaml
  backend:
    volumes:
      - uploads_data:/app/public/uploads
  volumes:
    uploads_data:
  ```

### 5. 二维码访问域名

- 二维码内容 = `{base_url}?token={员工token}`，其中 `base_url` 由前端在「员工管理」页点击「生成/刷新二维码」时取**当前浏览器地址栏的源**（`window.location.origin + '/fix'`）传给后端 `/api/qr/generate`。
- 本地开发时生成的是 `http://localhost:3000/fix?token=emp-token-001`。**`localhost` 只在生成它的那台电脑上有效**——手机扫码会打不开。
- 局域网/手机演示：先用电脑的局域网 IP 访问前端（如 `http://192.168.1.10:3000`），再到「员工管理」点「生成/刷新二维码」，新二维码即指向该 IP，手机与电脑连同一 Wi-Fi 即可扫码进入。
- 正式上线：用正式域名（如 `https://hygiene.example.com`）访问一次前端再重新生成二维码；或直接调接口：
  ```bash
  curl -X POST http://localhost:8080/api/qr/generate \
    -H "Authorization: Bearer <管理员token>" \
    -d "user_id=2&base_url=https://hygiene.example.com/fix"
  ```
- 二维码 PNG 存于 `uploads/qr_<用户id>_<时间戳>.png`，URL 写回 `users.qr_code_url`；员工 token 重置后旧二维码失效，需重新生成。

### 6. 备份图片与数据的方式

系统未内置自动备份，图片与数据库需分别备份（建议在容器外执行并归档）：

```bash
# ① 备份上传图片（容器内 /app/public/uploads → 宿主机 ./backup/uploads）
mkdir -p backup
docker compose cp backend:/app/public/uploads ./backup/uploads

# ② 备份数据库（导出 SQL）
docker compose exec db mysqldump -uroot -proot hygiene_audit \
  > backup/hygiene_audit_$(date +%F).sql
```

恢复：

```bash
# 恢复图片（注意末尾的 /. ，表示把目录内容拷进容器目标目录）
docker compose cp ./backup/uploads/. backend:/app/public/uploads
# 恢复数据库
docker compose exec -T db mysql -uroot -proot hygiene_audit < backup/hygiene_audit_2026-10-02.sql
```

建议：把上面两条备份命令写入 crontab 每日执行；或按第 4 节给 `uploads` 挂载命名卷后，直接备份宿主机目录/卷即可。数据库卷 `db_data` 本身随 `docker compose down` 保留，但 `down -v` 会清除，执行前务必先备份。

---

## 三种角色演示流程

> 说明：系统账号体系为「管理员账号（密码登录）+ 员工（token 链接免登录）」两类；**老板没有独立账号**，演示时用管理员账号登录后打开「汇总看板」，或由管理员投屏展示。以下流程基于种子数据（员工：张三、李四；检查项 4 项；张三已有 3 条历史记录）。

### 角色一：管理员 —— 检查、建档、发二维码

1. 浏览器打开 `http://localhost:3000`，自动跳转登录页；输入 `admin` / `admin123` 登录（种子数据中管理员密码哈希为空，首次用 `admin123` 登录成功时系统自动把该密码写入哈希，此后按哈希校验）。
2. 进入左侧「员工管理」（`/employees`）：列表显示每名员工的 ID、token、整改链接；点击张三所在行的「生成/刷新二维码」，行内出现二维码图片与完整整改链接。
3. 进入「检查上传」（`/admin`）：在「选择员工」下拉框选「李四」，检查日期默认今天（可改）。
4. 点击或拖拽上传问题照片；每传一张，下方出现一行，需为它选择检查项（如「地面清洁 -5分」）。已上传的图片按 `#1、#2…` 编号横排展示；点某张的「删除」，后续序号自动补齐、不出现跳号。
5. 点「保存并生成链接与二维码」：页面弹出该员工的整改链接（可复制）和二维码（可截图打印贴在工位）。
6. 验证结果：数据库 `records` 表新增对应 `pending` 记录，问题图文件存于 `uploads/admin/`。

### 角色二：员工 —— 扫码整改，无需登录

1. 手机扫管理员给的二维码（或电脑直接打开链接 `http://localhost:3000/fix?token=emp-token-002`）。
2. 页面只显示**本人**的待整改项：每条包含 `#序号`、检查项徽章、扣分值和问题图，按 `#` 从小到大排列；打开「仅看待整改」开关可过滤已完成的。
3. 对 `#1` 点击「上传整改图」，拍照或从相册选图上传；上传成功后该项状态变为「已完成」，问题图与整改图左右成对展示。
4. 边界验证：把链接里的 token 改成别人的（如 `emp-token-001`），看到的是对应员工的数据而非自己的——token 即身份；员工无法打开 `/admin` 等管理页面（会被重定向到登录页）。
5. 验证结果：整改图存于 `uploads/employees/<员工id>/`，对应记录 `status` 变为 `completed`。

### 角色三：老板 —— 看进度、看对比（只读）

1. 用管理员账号登录后进入「汇总看板」（`/summary`），或由管理员投屏。
2. 每名员工一张卡片：左侧姓名，右侧**整改进度百分比**（已完成数/总数）与**扣分合计**；进度 100% 时数字变绿。
3. 卡片内按 `#序号` 列出每条记录：问题图与整改图左右成对，共用同一徽章（检查项 + 扣分），未完成项只有问题图并标「待整改」。
4. 现场联动演示：员工刚在手机上传整改图，老板刷新看板，李四的进度即从 `0%` 变为对应百分比，整改图即时出现在对比位。
5. 看板数据来自 `GET /api/summary`（需登录），每次打开/刷新实时统计；记录按 `#序号` 排列，检查项名称与分值取保存时的快照，日后修改检查项不影响历史展示。

---

## 测试账号与数据

- 系统通过 Seed 预置演示数据。
- **登录**：管理员端需先登录。默认账号：`admin` / `admin123`（首次登录会自动初始化密码）。
- **管理员-检查上传**：登录后打开 `/admin`，选择员工、上传问题图片（每张显示 key #1、#2… 与检查项、扣分值）、可删除单张（删除后序号自动连续）、保存后获得整改链接与二维码。
- **员工管理**：登录后打开 `/employees`，查看每名员工的 ID、token、整改链接与二维码（可点击「生成/刷新二维码」）。
- **员工端**：通过链接 `http://localhost:3000/fix?token=emp-token-001` 进入（或扫码），无需登录，查看待整改项（图片对按 #key 从小到大排序）并上传整改图。
- **汇总看板**：登录后打开 `/summary`，查看各员工整改进度与对比图；问题图与整改图成对展示，同一徽章（检查项+分值）共用。

### 已有数据库升级

若数据库已存在且缺少登录相关字段，可执行迁移脚本：

```bash
docker exec -i <mysql_container_name> mysql -uroot -proot hygiene_audit < backend/database/migrate_add_auth.sql
```

若需要为历史记录补充「检查日期」字段（用于按天编号与筛选），可执行：

```bash
docker exec -i <mysql_container_name> mysql -uroot -proot hygiene_audit < backend/database/migrate_add_check_date.sql
```

脚本会为 `records.check_date` 赋值：优先取 `created_at` 的日期部分，缺失时使用当前日期。

## Docker 说明

- 数据库使用 `utf8mb4` 字符集，连接时指定 charset。
- 前端构建时通过 `VITE_API_BASE=http://localhost:8080` 指定后端地址，浏览器直接请求后端 API。
- 后端通过服务名 `db` 连接 MySQL，不依赖本地环境。
