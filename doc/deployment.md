# 服务器部署

[文档索引](README.md)

## 服务器要做什么

就三件事：

1. **能 SSH 登录**（公钥认证，不需要输密码）。
2. **登录账号能用 Docker**（直接执行 `docker ps` 不报权限错误）。
3. **放行 16666 端口**（网页 + API）。

其他全部由本机的 `npm run remote` 自动完成：同步源码、挂载源码并热更新、按需安装依赖、生成密码、建数据库、跑迁移、启动服务、健康检查。

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
restrict ssh-ed25519 在这里粘贴你的公钥
KEY
sudo chown -R matrius-deploy:matrius-deploy /home/matrius-deploy/.ssh
sudo chmod 600 /home/matrius-deploy/.ssh/authorized_keys
```

公钥用 `ssh-keygen -t ed25519` 生成。首次连接先手动 `ssh matrius-deploy@服务器IP` 核对主机指纹。

---

## 本机配置

```bash
cp .env.local.example .env.local
```

只需要填服务器地址：

```dotenv
REMOTE_USER=你的SSH账号
REMOTE_HOST=服务器IP
```

- SSH 不是 22 端口：加 `REMOTE_SSH_PORT=端口`。
- 密钥不是默认文件名：加 `REMOTE_SSH_KEY=~/.ssh/你的密钥`。

想指定首次部署的管理员，再加 `INITIAL_ADMIN_USERNAME` 和 `INITIAL_ADMIN_PASSWORD`；不填会随机生成，并在首次部署时打印一次。

---

## 部署

```bash
npm run remote -- --check   # 只检查本机配置，不连服务器
npm run remote               # 正式部署
```

首次部署会自动生成服务器配置、创建数据库、创建初始管理员、执行迁移，并构建 Web / API 依赖镜像。之后每次都是「同步源码 → 挂载目录里的新文件立即生效 → 健康检查」，通常几秒钟完成，不重建镜像，也不重启容器。

源码以只读方式挂载进容器：Web 运行 Expo 开发服务器（Metro），保存后 HMR 自动刷新；API 使用 `uvicorn --reload` 监听 `server/app` 和 `server/alembic`。因此普通改代码不需要任何构建。只有依赖或镜像定义变化时才重建对应镜像：`package.json`、`package-lock.json`、`Dockerfile.web.dev` 影响 web，`server/pyproject.toml`、`server/uv.lock`、`server/Dockerfile` 影响 api；`docker compose up -d` 会自动替换使用新镜像的容器。需要强制重建依赖镜像时，删除服务器上的 `~/.matrius-remote/build-state` 后重新部署。

这种模式以迭代速度优先：Web 由 Metro 提供开发 bundle，首次打开会现场编译，不适合大量公网用户。日常单人或小范围使用没有问题。

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

在本机 `.env.local` 里改，下次部署自动同步到服务器：

```dotenv
APP_PORT=16666       # 网页 + API
API_PORT=16667       # 仅 API，可选
APP_HTTPS_PORT=8443  # 预留 HTTPS
```

改完记得在安全组放行新端口。

---

## 日常命令

```bash
npm run remote                          # 日常部署
npm run remote -- --publish             # 部署并把 stable 功能开放给所有账号
npm run remote -- --publish --migrate   # 有已审查的数据库迁移时
npm run remote -- --check               # 只检查本机配置
```

默认部署只上线代码，不改变已发布的功能清单。`--publish` 会在健康检查通过后，把 `stable` 功能开放给所有账号。

部署中断或失败时，直接重新执行 `npm run remote`。

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
for img in alpine:3.20 python:3.12-slim node:24-slim caddy:2-alpine \
  postgres:16-alpine redis:7-alpine rustfs/rustfs:1.0.0 karust/openserp:0.8.12; do
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

`/api/health` 检查数据库；`/api/health/ready` 还检查 Redis、对象存储和搜索。

停止服务：

```bash
cd ~/.matrius-remote/source/docker-compose
docker compose --project-name matrius-prod \
  --env-file ~/.matrius-remote/production.env down
```

**永远不要加 `-v`**，会删除数据卷。

---

## 备份

服务器上的 `scripts/backup.sh` 会导出数据库、打包 RustFS 并复制配置：

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

它执行的就是 `npm run remote -- --publish`。本机和 CD 共用服务器会话锁，同时部署会直接失败。

---

## 目前不支持 HTTPS

当前只支持 `IP + HTTP`，公网地址固定按 `http://REMOTE_HOST:APP_PORT` 生成。域名和证书以后再做；移动端上线前必须补上。

---

## 出问题先看这里

- **`Existing database volume found but ... is missing`**：已有数据但配置文件丢了。先恢复 `production.env`，不要删除数据卷。
- **健康检查失败**：看 `docker logs matrius-api` 和 `docker logs matrius-web`。
- **构建失败**：多半是服务器访问 npm / PyPI / Docker Hub 有问题，见「国内网络」。
- **回退**：本机切回上一个已验证的 Git 版本，重新执行 `npm run remote`。数据库结构回退需单独评估。
