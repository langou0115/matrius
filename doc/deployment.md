# 部署与 CD

[文档索引](README.md)

生产环境使用单台服务器：Caddy 作为唯一入口，同机运行 Web、API、PostgreSQL、Redis、RustFS 和 OpenSERP。发布流程沿用 openstudio 模式：GitHub Actions 校验通过后通过 SSH 上传源码，由服务器上的固定 helper 执行 `docker compose up -d --build`。

## 拓扑

```text
公网
  │  APP_BIND:APP_PORT (默认 0.0.0.0:8081) / APP_HTTPS_PORT (默认 8443)
  ▼
Caddy
  ├── /api/model-proxy/* → web:8081     现有同源模型中继
  ├── /api/*             → api:8000     FastAPI
  └── /*                 → web:8081     Expo 静态产物 + SPA 回退

edge 网络：caddy, web, api
data 网络：api, postgres, redis, rustfs
search 网络：api, openserp
```

- 只有 Caddy 暴露公网端口。PostgreSQL、Redis、RustFS、OpenSERP 仅绑定宿主 `127.0.0.1` 的开发隧道端口（默认 15432、16379、19000、17000），供本地 SSH 转发，不对公网开放。
- OpenSERP 不在 `data` 网络，无法直接访问数据库与对象存储。
- 持久化卷：`matrius_prod_postgres_data`、`matrius_prod_rustfs_data`、`matrius_prod_caddy_data`、`matrius_prod_caddy_config`。
- Redis 不持久化，只保存限流与缓存。

## 服务器准备

要求：Linux、Docker Engine + Compose v2、`curl`、`tar`、`flock`（util-linux）、`openssh-server`。

### 1. 部署用户

```bash
sudo useradd --create-home --shell /bin/bash matrius-deploy
sudo install -d -o matrius-deploy -g matrius-deploy -m 700 /home/matrius-deploy
```

`matrius-deploy` **不要**加入 `docker` 或 `sudo` 组。它只负责接收发布包和切换软链接，Docker 命令由 root helper 执行。

### 2. root helper

仓库中的 [`docker-compose/matrius-deploy-helper.sh`](../docker-compose/matrius-deploy-helper.sh) 只执行固定命令：读取 `matrius` 软链接下的 compose 文件与 `.env.production`，运行 `docker compose up -d --build --remove-orphans`。它不会执行 release 目录里的用户可写脚本，接受 `--check` 或无参数两种调用。

```bash
sudo install -o root -g root -m 0755 \
  docker-compose/matrius-deploy-helper.sh \
  /usr/local/sbin/matrius-deploy
```

### 3. sudoers

从 [`matrius-deploy.sudoers`](../docker-compose/matrius-deploy.sudoers) 安装，仅允许两条精确命令：

```sudoers
matrius-deploy ALL=(root) NOPASSWD: /usr/local/sbin/matrius-deploy --check
matrius-deploy ALL=(root) NOPASSWD: /usr/local/sbin/matrius-deploy
```

```bash
sudo install -o root -g root -m 0440 \
  docker-compose/matrius-deploy.sudoers \
  /etc/sudoers.d/matrius-deploy
sudo visudo -cf /etc/sudoers.d/matrius-deploy
```

不要使用通配符、`sudo` 全权限或允许传入自定义 compose 文件的规则。

### 4. SSH 密钥

在可信机器生成专用密钥（不要复用个人密钥）：

```bash
ssh-keygen -t ed25519 -C 'matrius-cd' -f matrius-cd -N ''
```

把公钥加入部署用户：

```bash
sudo -u matrius-deploy install -d -m 700 /home/matrius-deploy/.ssh
sudo -u matrius-deploy sh -c 'cat >> /home/matrius-deploy/.ssh/authorized_keys' < matrius-cd.pub
sudo -u matrius-deploy chmod 600 /home/matrius-deploy/.ssh/authorized_keys
```

记录服务器主机密钥（`DEPLOY_PORT` 非 22 时使用方括号格式）：

```bash
ssh-keyscan -p 22 -t ed25519 <DEPLOY_HOST> > known_hosts
ssh-keygen -F <DEPLOY_HOST> -f known_hosts
```

请先人工核对 `ssh-keyscan` 输出的指纹，再写入 GitHub Secret。

### 5. Docker

以有 Docker 权限的管理员安装 Docker Engine 和 Compose v2，并确保服务器可访问镜像源。国内网络可在 `PRODUCTION_ENV` 中设置：

```text
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
PYPI_INDEX_CANDIDATES=https://pypi.org/simple,https://pypi.tuna.tsinghua.edu.cn/simple
```

Python 依赖安装前会并行探测上述候选源，选用最快且可达的一个；某源缺少包或临时失败时自动尝试下一个。依赖版本和 `sha256` 始终来自 `server/uv.lock`，切换源不会改变实际安装内容。

`NPM_CONFIG_REGISTRY` 是固定值；npm 的锁文件已包含解析后的地址，不做运行时测速。

## GitHub 配置

Repository → Settings → Secrets and variables → Actions：

Variables：

| 名称 | 示例 |
| --- | --- |
| `DEPLOY_HOST` | `example.com` 或 IP |
| `DEPLOY_PORT` | `22` |
| `DEPLOY_USER` | `matrius-deploy` |

Secrets：

| 名称 | 内容 |
| --- | --- |
| `DEPLOY_SSH_PRIVATE_KEY` | 私钥全文（OpenSSH 格式） |
| `DEPLOY_SSH_KNOWN_HOSTS` | 已核对的 `known_hosts` 行 |
| `PRODUCTION_ENV` | 生产 `.env.production` 全文 |

`PRODUCTION_ENV` 以 [`docker-compose/.env.production.example`](../docker-compose/.env.production.example) 为模板。至少替换：

- `POSTGRES_PASSWORD`、`REDIS_PASSWORD`
- `RUSTFS_ACCESS_KEY`、`RUSTFS_SECRET_KEY`
- `INITIAL_ADMIN_USERNAME`、`INITIAL_ADMIN_PASSWORD`（首次部署后移除密码）

密码会拼进 `DATABASE_URL` / `REDIS_URL`，请使用 URL 安全字符（字母、数字、`-_.~`）或做百分号编码。

## 发布流程

手动触发 **Deploy Production**（`workflow_dispatch`），只接受 `main`：

1. GitHub Actions 校验分支与脚本语法。
2. `scripts/cd-deploy.sh` 校验提交 SHA、主机、端口、用户和固定主机密钥。
3. 用 `git archive` 打包源码，连同 `PRODUCTION_ENV` 和远端脚本通过 stdin 上传到 `/home/matrius-deploy/.matrius-upload.*`。
4. `scripts/cd-remote.sh` 在服务器上：
   - 加文件锁，避免并发发布；
   - 解压到 `/home/matrius-deploy/.matrius-releases/<sha>-<run>-<attempt>`；
   - 写入权限为 600 的 `.env.production`；
   - **先校验环境变量**，再原子切换 `matrius` 软链接；
   - 执行 root helper 构建并启动；
   - 轮询健康检查。
5. 健康检查通过后保留当前与上一版 release；其余旧 release 清理。数据在 Docker 卷中，不受源码清理影响。

首次部署时 `migrate` 容器执行 `alembic upgrade head && python -m app.bootstrap`，在空库创建初始管理员。

## 本地连接生产数据

后端不维护 dev Compose。本地调试直接复用服务器上的容器与数据：数据服务已经绑定在服务器回环地址，本地通过 SSH 隧道访问。首次启用该能力需要重新发布一次，让 Compose 按新增的端口映射重建数据容器；数据卷不受影响。

```bash
# 仓库根目录：准备 .env.local（模板 .env.local.example）
bash scripts/dev-tunnel.sh

# 另一个终端：准备 server/.env（模板 server/.env.example）
cd server
bash scripts/install-python-deps.sh --dev
uv run --no-sync uvicorn app.main:app --reload
```

- 隧道只监听本地 `127.0.0.1`；服务器端口也只绑定 `127.0.0.1`，不要改成为 `0.0.0.0`。服务器上的其他本地用户同样能访问这些回环端口；OpenSERP 本身没有认证，如存在不受信任的本地账号，需要额外限制。
- 优先使用 SSH 密钥；`SERVER_PASSWORD` 需要本地安装 `sshpass`，仅建议临时使用。首次连接默认 `StrictHostKeyChecking=accept-new`，可通过 `SERVER_KNOWN_HOSTS` 固定主机密钥。
- 本地 API 读写生产数据库和 bucket，请使用专用测试账号。**不要在本地执行 `alembic upgrade head`**：迁移会直接修改生产库，应随发布由 `migrate` 容器执行。
- 服务器端口通过 `.env.production` 的 `DB_TUNNEL_PORT`、`REDIS_TUNNEL_PORT`、`RUSTFS_TUNNEL_PORT`、`OPENSERP_TUNNEL_PORT` 调整，并与本地 `.env.local` 保持一致。

## 健康检查

`scripts/deploy-health.sh`：

- 校验必需密码存在且不是示例值、端口合法、`CADDY_SITE_ADDRESS` 合法；
- HTTP 模式请求 `http://127.0.0.1:${APP_PORT}/api/health`；
- 域名模式使用 `APP_HTTPS_PORT` 与 `--resolve` 访问本机，容忍自动证书尚未生效；
- 校验 `"service":"matrius"`、`"status":"ok"`，再请求 `/` 确认 Web 可访问；
- 每 5 秒重试，最多 60 次（约 5 分钟）。

## HTTPS

默认 `CADDY_SITE_ADDRESS` 为空或 `:80`，走纯 HTTP。

使用域名时：

```text
CADDY_SITE_ADDRESS=example.com
APP_PORT=80
APP_HTTPS_PORT=443
```

同时将域名 A/AAAA 记录指向服务器，并放行 80/443。Caddy 会自动申请和续期证书。HTTP 请求会被重定向到 HTTPS。

如果前面还有云负载均衡或其它反向代理，需要把真实客户端 IP 传进来，否则登录限流会以代理 IP 计数。不要把 API 端口直接暴露到公网。

## 运维

### 查看状态与日志

```bash
sudo docker compose \
  -f /home/matrius-deploy/matrius/docker-compose/docker-compose.yml \
  --env-file /home/matrius-deploy/matrius/docker-compose/.env.production \
  ps
sudo docker logs matrius-api --tail 200
sudo docker logs matrius-caddy --tail 200
```

### 手动重启

```bash
sudo -u matrius-deploy sudo -n /usr/local/sbin/matrius-deploy
```

该命令会重新构建并启动，不会删除卷。

### 回滚

保留上一版源码目录，但不自动回滚。确认新版本异常时：

```bash
ls /home/matrius-deploy/.matrius-releases
sudo -u matrius-deploy ln -sfnT \
  /home/matrius-deploy/.matrius-releases/<上一版> \
  /home/matrius-deploy/matrius.next
sudo -u matrius-deploy mv -Tf \
  /home/matrius-deploy/matrius.next \
  /home/matrius-deploy/matrius
sudo -u matrius-deploy sudo -n /usr/local/sbin/matrius-deploy
```

如果回滚涉及数据库结构，需要先在数据库中执行对应的 downgrade 或从备份恢复。生产迁移以向前兼容为原则，避免发布即需要降级。

### 数据备份

备份数据，而不是容器：容器和镜像可由仓库重建，真正不可替代的是 PostgreSQL、RustFS 对象和 `.env.production`。

服务器上的 [`scripts/backup.sh`](../scripts/backup.sh) 会执行 `pg_dump`、只读打包 RustFS 卷并复制环境文件。以 root 安装为固定路径后再运行，避免 root 直接执行发布用户可写的脚本：

```bash
sudo install -o root -g root -m 0755 \
  /home/matrius-deploy/matrius/scripts/backup.sh \
  /usr/local/sbin/matrius-backup
sudo /usr/local/sbin/matrius-backup
```

默认写入 `/var/backups/matrius`，保留 14 天；可用 `BACKUP_DIR`、`BACKUP_KEEP_DAYS` 覆盖。脚本更新后需要重新安装。建议加入 cron：

```text
17 3 * * * /usr/local/sbin/matrius-backup >> /var/log/matrius-backup.log 2>&1
```

同机备份无法应对磁盘或服务器损坏。设置 `BACKUP_REMOTE`（`rsync` 目标，如挂载的备份盘或另一台机器）把副本送出去；环境文件包含密钥，异地副本应加密保存。

RustFS 归档是对运行中卷的只读打包，写入并发时可能不是严格的时间点一致；需要严格一致时先短暂停止写入。恢复时先停止 API 写入：

```bash
sudo docker stop matrius-api

# PostgreSQL：覆盖现有对象
sudo docker exec -i matrius-postgres \
  pg_restore -U matrius -d matrius --clean --if-exists < postgres-<时间戳>.dump

# RustFS：先停止，再清空卷并解包
sudo docker stop matrius-rustfs
sudo docker run --rm \
  -v matrius_prod_rustfs_data:/data \
  -v "$PWD":/backup \
  alpine:3.20 \
  sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf /backup/rustfs-<时间戳>.tar.gz -C /data'
sudo docker start matrius-rustfs matrius-api
```

恢复前务必确认备份文件完整，并优先在临时数据库验证。用户名和库名以 `.env.production` 为准。

`Caddy` 卷保存证书与配置；丢失后会自动重新签发，但建议一并备份。

### 停止服务

```bash
sudo docker compose ... down
```

**不要执行 `docker compose down -v`。** `-v` 会删除 PostgreSQL、RustFS 和证书卷，造成不可恢复的数据丢失。

### 日志与密钥

- 应用日志为 JSON，不包含 token、消息正文或文件内容。
- `.env.production` 只在服务器保存一份（权限 600），同时放在 GitHub Secret 中；不要写入 release 的公开文件。
- 轮换密钥后重新触发部署，使容器使用新值。PostgreSQL 密码轮换需要同时修改数据库用户密码，不能只改环境变量。

## 排查

| 现象 | 检查 |
| --- | --- |
| 健康检查超时 | 查看 `matrius-api`、`matrius-migrate` 日志；确认 `.env.production` 密码非示例值 |
| migrate 失败 | 数据库迁移错误或初始管理员缺失；修复后重新发布 |
| 无法登录 | Redis 不可用时登录会被拒绝；检查 `matrius-redis` 健康状态 |
| 搜索/网页读取 503 | `matrius-openserp` 未就绪；会话读写不受影响 |
| 上传失败 | 检查 RustFS 健康、bucket、磁盘空间与配额 |
| SSH 校验失败 | `DEPLOY_SSH_KNOWN_HOSTS` 与主机/端口不匹配；重新核对指纹 |
| 发布提示 release 清理失败 | 按提示修复 release 目录所有权；发布本身已通过健康检查 |

## CI

`.github/workflows/ci.yml` 在 push 到 `main` 和 PR 时运行：

- 后端：`scripts/install-python-deps.sh --dev`（测速选源并按哈希安装）、`ruff`、`pytest`、在空 PostgreSQL 上执行迁移；
- Web：`npm ci`、lint、`tsc --noEmit`、渲染与模型测试、`expo export --platform web`。

发布前请确保 CI 通过。部署工作流不重复构建镜像，镜像由服务器上的 Docker 构建。
