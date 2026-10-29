# 服务器部署

[文档索引](README.md)

## 服务器要做什么

就三件事：

1. **能 SSH 登录**（公钥认证，不需要输密码）。
2. **登录账号能用 Docker**（直接执行 `docker ps` 不报权限错误）。
3. **放行 16666 端口**（网页 + API）。

新服务器直接执行 `npm run deploy`：同步源码、构建包含源码的生产镜像、生成配置与密码、创建 SQLite 数据库并迁移、启动 Caddy / Web / API 三个容器、刷新管理员密码后做健康检查。

服务器不用 clone 仓库，不用装 Node、Python、数据库，也不用手工写配置。

> 如果你的服务器已经装了 Docker，现有 SSH 账号也能执行 `docker ps`，那服务器侧什么都不用做，直接看「本机配置」。

---

## 服务器准备（没装 Docker 才做）

### 1. 安装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```

确认 Compose 可用：

```bash
docker compose version
```

### 2. 让 SSH 账号使用 Docker

```bash
sudo usermod -aG docker 你的SSH账号
```

重新登录，确认不需要 sudo：

```bash
docker ps
```

> Docker 组等同于服务器 root 权限，这个账号只给可信的人用。

### 3. 放行端口

云服务器在安全组放行 SSH 和 `16666`。本机防火墙示例：

```bash
sudo ufw allow 22/tcp
sudo ufw allow 16666/tcp
```

`16667` 是仅 API 的端口，不需要直连后端就不用放行。

### 可选：单独建发布账号

不想用现有账号时，可以创建一个专用账号：

```bash
sudo useradd -m -U -s /bin/bash matrius-deploy
sudo passwd -l matrius-deploy
sudo chmod 700 /home/matrius-deploy
sudo usermod -aG docker matrius-deploy
sudo install -d -m 700 -o matrius-deploy -g matrius-deploy /home/matrius-deploy/.ssh
sudo tee -a /home/matrius-deploy/.ssh/authorized_keys >/dev/null <<'KEY'
restrict,port-forwarding ssh-ed25519 在这里粘贴你的公钥
KEY
sudo chown -R matrius-deploy:matrius-deploy /home/matrius-deploy/.ssh
sudo chmod 600 /home/matrius-deploy/.ssh/authorized_keys
```

`npm run dev` 完全在本机运行，不再建立 SSH 隧道；发布账号的密钥只需完成部署，不需要 TCP 转发权限。

公钥用 `ssh-keygen -t ed25519` 生成。首次连接先手动 `ssh matrius-deploy@服务器IP` 核对主机指纹。

---

## 本机配置

服务器相关内容都在 `docker-compose/.env.production`（已被 Git 忽略）：

```bash
cp docker-compose/.env.production.example docker-compose/.env.production
```

只需要填服务器地址：

```dotenv
REMOTE_USER=你的SSH账号
REMOTE_HOST=服务器IP
```

- SSH 不是 22 端口：加 `REMOTE_SSH_PORT=端口`。
- 密钥不是默认文件名：加 `REMOTE_SSH_KEY=~/.ssh/你的密钥`。
- `APP_PORT` / `API_PORT` / `APP_HTTPS_PORT` 和 `REMOTE_WORKSPACE` 也在同一个文件里调整。

`.env.local`（从 `.env.local.example` 复制）只放本地开发与通用应用设置；浏览器 Cookie 有效期、限额、`LOG_LEVEL` 等通用项设置后会写入服务器的 `production.env`。代理需要分两个键：`WEBTOOL_PROXY_URL` 只给本机 `npm run dev` 使用，**不会**同步到服务器；`WEBTOOL_PROXY_URL_PRODUCTION` 才会在部署时映射为服务器的 `WEBTOOL_PROXY_URL`。API 运行在容器里，生产代理不能用 `127.0.0.1` / `localhost` / `::1`，应使用 `host.docker.internal` 或其它容器可达地址；部署会拒绝 loopback 地址，并清理服务器上由旧版本同步的 loopback 值。管理员账号在 `.env.local` 里用 `INITIAL_ADMIN_USERNAME` 和 `INITIAL_ADMIN_PASSWORD` 指定；密码仍是示例占位值 `change-me` 时部署会直接失败。首次初始化时两个值都留空则不创建固定密码，而是随机生成并打印一次。

管理员密码**以最近一次部署为准**：每次 `npm run deploy` 都会把 `.env.local` 中的 `INITIAL_ADMIN_*` 写入服务器 `production.env`，API 启动时的 bootstrap 会把该账号密码更新为这份值。A、B 两台机器分别部署不同密码时，后部署的生效。两个值都留空时不会改动现有密码；首次初始化且留空则随机生成并打印一次。

---

## 部署

```bash
npm run deploy
```

`npm run deploy` 每次都执行同一套流程：同步源码 → 构建 Web/API 生产镜像 → 备份现有数据库 → 执行迁移并刷新管理员密码 → 更新 Web/API 与 Caddy → 健康检查。新服务器首次执行时会自动生成缺失配置、创建 `matrius_prod_api_data` 数据卷和空库管理员。配置未变化的 Web 容器保持运行；API 每次重建以应用迁移和最新密码。Docker 缓存复用未变化的依赖与构建层。Web 使用静态生产构建；API 使用普通 Uvicorn（单 worker）。两者源码直接放进镜像，不挂载源码，也不运行 Metro 或热重载。

`docker compose up` 带 `--remove-orphans`，会自动停止并删除旧拓扑遗留的 `migrate` / `postgres` / `redis` / `rustfs` / `openserp` 容器；旧数据卷不会被自动删除，可按需手动清理。

API 容器入口会在 uvicorn 启动前执行 `alembic upgrade head`、`alembic check` 和 `bootstrap`，因此每次部署都会应用最新迁移。运行时 `/api/health` 与 `/api/health/ready` 也会校验版本，不一致返回 503。

### 前端如何找到 Web 工具接口

前端不保存 API 地址，也不读取部署域名。`web_search` / `web_fetch` 与其它云端接口一样，用相对路径请求同源的 `/api/tools/search`、`/api/tools/fetch`：

```text
浏览器（打开 http://服务器:16666）
    ├── /api/model-proxy/*  → Caddy → web:8081（模型中继）
    ├── /api/*              → Caddy → api:8000（FastAPI，含 /api/tools/*、/api/admin/tools/test）
    └── 其它路径            → Caddy → web:8081（静态前端）
```

因此浏览器访问哪个地址，工具请求就发到同一个地址，由 Caddy 分流到 API 容器；换服务器、换端口或换域名都不需要改前端配置。API 容器再按部署时写入的 `WEBTOOL_PROXY_URL` 决定直连还是经上游代理访问搜索与网页；该生产值来自 `.env.local` 的 `WEBTOOL_PROXY_URL_PRODUCTION`，容器可通过 compose 的 `host.docker.internal:host-gateway` 访问宿主机代理。只有跨源调用（例如脚本或第三方客户端）才需要显式 API 地址与 `CORS_ORIGINS`。

日常开发使用本机 `npm run dev`，完全在本机运行，不影响服务器；详见[开发与验证](development.md#本机全栈开发npm-run-dev)。

看到这两行就成功了：

```text
Matrius health checks passed at http://127.0.0.1:16666.
Deployed. http://服务器IP:16666 (feature releases unchanged)
```

浏览器打开 `http://服务器IP:16666` 即可。

想再确认一次：

```bash
curl http://服务器IP:16666/api/health
```

返回 `"status":"ok"` 即正常。

### 修改端口

在本机 `docker-compose/.env.production` 里修改端口，再执行 `npm run deploy`。新端口会写入服务器配置，Compose 自动重建 Caddy 以应用映射；没有变化则保留原容器：

```dotenv
APP_PORT=16666       # 网页 + API
API_PORT=16667       # 仅 API，可选
APP_HTTPS_PORT=8443  # 预留 HTTPS
```

改完记得在安全组放行新的网页/API 入口端口。

只有 Caddy 的 `APP_PORT` / `API_PORT` / `APP_HTTPS_PORT` 会映射到宿主机；Web 与 API 只在 Docker 的 `edge` 网络内互相访问。实际生效的是 `docker-compose/.env.production`；只修改模板 `.env.production.example` 不会影响部署。

---

## 日常命令

```bash
npm run deploy
```

部署成功即生效：代码中 `stage="stable"` 的功能在健康检查通过后对所有账号开放；`preview` 仍只对 `admin_test` 开放。

部署中断或失败时，直接重新执行 `npm run deploy`。

---

## 数据库迁移与备份

生产数据全部在 `matrius_prod_api_data` 卷里：SQLite 数据库 `/data/matrius.db` 和上传文件 `/data/files`。本地开发使用 `server/.data`，两套数据互不影响。发布结构变更按以下顺序：

1. 在 `server/` 修改模型并用 Alembic 生成迁移。
2. 本地 `npm run dev` 会自动执行 `alembic upgrade head` 和 `alembic check`；模型与迁移不一致会启动失败。
3. 提交迁移文件，直接执行 `npm run deploy`。每次部署都会先备份，再由 API 入口应用迁移。
4. 备份使用 SQLite backup API 生成一致性快照（包含 WAL 中已提交的事务），复制到服务器 `<workspace>/backups/`，保留最近 10 份；备份失败或为空则中止。
5. API 容器入口依次执行 `alembic upgrade head`、`alembic check` 和 `bootstrap`，全部成功后才启动 uvicorn；版本不一致时 `/api/health/ready` 返回 503。

`npm run deploy` 不再区分是否允许迁移，删表、删列等破坏性操作也会随部署执行。发布前务必在本地空库或数据副本上审查并验证迁移；部署前的一致性快照是回退依据，备份失败会直接中止。

### 向后兼容与并发

生产只有一个 API 容器；每次部署都会重建 API，由新容器在启动 Uvicorn 前执行迁移，因此不存在旧代码与迁移后表结构并存的窗口。仍需注意：

- SQLite 的 `ALTER TABLE` 能力有限，Alembic 已启用 `render_as_batch`；重命名、删除列和收紧约束仍应拆成小步并先在本地验证。
- 写事务保持短小；大表回填拆成多次可重复执行的迁移，避免长时间占用 SQLite 的单一写锁。
- SQLite 只支持单机单实例。不要同时运行多个 API 容器或多个 worker。

### 从备份恢复

迁移失败或需要回退时，用部署前生成的快照恢复。先停 API，再替换数据库并清除旧的 WAL/SHM：

```bash
ssh 你的SSH账号@服务器IP
cd ~/.matrius-remote/source/docker-compose
docker compose --project-name matrius-prod --env-file ~/.matrius-remote/production.env stop api
docker run --rm -v matrius_prod_api_data:/data \
  -v ~/.matrius-remote/backups:/backup:ro alpine:3.20 sh -c '
    rm -f /data/matrius.db-wal /data/matrius.db-shm
    cp "/backup/matrius-<时间戳>.db" /data/matrius.db
    chown 10001:10001 /data/matrius.db
  '
docker compose --project-name matrius-prod --env-file ~/.matrius-remote/production.env up -d api
```

上传文件在同一个卷的 `/data/files`，如需一并回滚，从 `scripts/backup.sh` 生成的 `files-*.tar.gz` 解压到 `/data/files`。恢复后再切回上一个已验证的 Git 版本并重新部署。不要用 `docker compose down -v`，那会删除数据卷。

---

## 国内网络

构建在服务器上执行。如果 npm / PyPI 太慢导致构建失败，在服务器的 `~/.matrius-remote/production.env` 末尾加：

```dotenv
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
PYPI_INDEX_CANDIDATES=https://pypi.org/simple,https://pypi.tuna.tsinghua.edu.cn/simple
```

然后重新部署。依赖索引探测偶尔会因瞬时网络抖动全部失败；构建脚本会自动重试一次，再回退到直接尝试上面的索引，不会因此中断构建。

### 先拉基础镜像

部署会用到下面这些镜像。网络不好时，Docker Hub 的首次请求可能间歇性失败，而 Docker 不会自动重试，建议先手动拉好（带重试）：

```bash
for img in alpine:3.20 python:3.12-slim node:24-slim caddy:2-alpine; do
  for i in 1 2 3 4 5; do
    docker pull "$img" && break
    echo "重试 $img ($i/5)"; sleep 5
  done
done
```

确认全部在本地：

```bash
docker images --format '{{.Repository}}:{{.Tag}}' | sort
```

服务器通过代理访问 Docker Hub 时，确认 Docker 能读到代理配置：

```bash
docker info | grep -i proxy
```

输出里有 `HTTP Proxy` / `HTTPS Proxy` 即可。拉取失败就重试，不需要改镜像源。

---

## 查状态、看日志

```bash
ssh 你的SSH账号@服务器IP "docker ps --filter name=matrius-"
ssh 你的SSH账号@服务器IP "docker logs --tail 100 matrius-api"
ssh 你的SSH账号@服务器IP "docker logs --tail 100 matrius-web"
```

`/api/health` 检查数据库；`/api/health/ready` 还检查数据库 schema 版本、进程内缓存与文件存储。

停止服务：

```bash
cd ~/.matrius-remote/source/docker-compose
docker compose --project-name matrius-prod \
  --env-file ~/.matrius-remote/production.env down
```

**永远不要加 `-v`**，会删除数据卷。

---

## 备份

服务器上的 `scripts/backup.sh` 会用 SQLite backup API 生成一致性快照、打包 `files/` 并复制配置：

```bash
sudo install -o root -g root -m 0755 \
  ~/.matrius-remote/source/scripts/backup.sh /usr/local/sbin/matrius-backup
sudo /usr/local/sbin/matrius-backup
```

默认写入 `/var/backups/matrius`，保留 14 天。建议加 cron：

```text
17 3 * * * /usr/local/sbin/matrius-backup >> /var/log/matrius-backup.log 2>&1
```

同机备份应对不了磁盘或服务器损坏，重要数据应再同步到另一台机器。

---

## 自动部署（可选）

GitHub Actions → **Deploy Production** → **Run workflow**，只接受手动触发的 `main`。

在仓库或 production Environment 配置：

- Variables：`REMOTE_USER`、`REMOTE_HOST`，其他端口变量可留空。
- Secrets：`REMOTE_SSH_PRIVATE_KEY`、`REMOTE_SSH_KNOWN_HOSTS`。

它执行的就是 `npm run deploy`。本机和 CD 共用服务器会话锁，同时部署会直接失败。

---

## 目前不支持 HTTPS

当前只支持 `IP + HTTP`，公网地址固定按 `http://REMOTE_HOST:APP_PORT` 生成。域名和证书以后再做；对外开放自定义域名前必须补上。

---

## 出问题先看这里

- **`Existing database volume found but ... is missing`**：已有数据但配置文件丢了。先恢复 `production.env`，不要删除数据卷。
- **服务器上还留着旧的 postgres / redis / rustfs / openserp 容器**：执行一次 `npm run deploy`，Compose 会用 `--remove-orphans` 清理；旧数据卷不会自动删除。
- **健康检查失败**：看 `docker logs matrius-api` 和 `docker logs matrius-web`。
- **构建失败**：多半是服务器访问 npm / PyPI / Docker Hub 有问题，见「国内网络」。
- **回退**：本机切回上一个已验证的 Git 版本，重新执行 `npm run deploy`。数据库结构回退需单独评估。
