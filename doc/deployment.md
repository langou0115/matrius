# 服务器部署

[文档索引](README.md)

日常用 `npm run remote` 从本机同步源码，并在服务器构建、启动生产镜像。服务器不需要 clone 仓库，本机也不需要 Python、Docker 或数据库。

## 拓扑

```text
浏览器 → Caddy :16666（网页 + API）
          ├─ /api/model-proxy/* → Web/Node：模型中继
          ├─ /api/*             → Python API
          └─ /*                 → Web：生产静态页面

客户端 → Caddy :16667（仅 API，可选）
          └─ /api/*             → Python API

API → PostgreSQL / Redis / RustFS / OpenSERP
```

公网只由 Caddy 暴露端口：网页默认 `16666`，API 可选 `16667`；不直接暴露 Uvicorn。数据服务只在容器网络内，不映射宿主机端口。

## 服务器准备

需要 Docker Engine、Compose v2、OpenSSH Server、Bash、tar、curl、flock 和 coreutils。国内网络可在服务配置中指定镜像源：

```dotenv
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
PYPI_INDEX_CANDIDATES=https://pypi.org/simple,https://pypi.tuna.tsinghua.edu.cn/simple
```

## 发布账号

`matrius-deploy` 是服务器 SSH 账号，不是网站用户。加入 Docker 组等同于服务器管理权限，只授予可信密钥。

```bash
sudo useradd -m -U -s /bin/bash matrius-deploy
sudo passwd -l matrius-deploy
sudo chmod 700 /home/matrius-deploy
sudo usermod -aG docker matrius-deploy
sudo install -d -m 700 -o matrius-deploy -g matrius-deploy \
  /home/matrius-deploy/.ssh /home/matrius-deploy/.matrius-remote
sudo touch /home/matrius-deploy/.ssh/authorized_keys
sudo chown matrius-deploy:matrius-deploy /home/matrius-deploy/.ssh/authorized_keys
sudo chmod 600 /home/matrius-deploy/.ssh/authorized_keys
```

已有同名账号时跳过 `useradd`，先确认归属。

### 开发机公钥

每台开发机生成专用密钥，私钥只留本机：

```bash
ssh-keygen -t ed25519 -C matrius-remote
```

把公钥追加到服务器，`restrict` 禁用端口转发和 PTY：

```bash
sudo tee -a /home/matrius-deploy/.ssh/authorized_keys >/dev/null <<'KEY'
restrict ssh-ed25519 在这里粘贴开发机公钥 matrius-remote
KEY
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

最后一条是服务器主机指纹，供首次连接时核对。私钥有口令时先加载到 ssh-agent；remote 使用非交互认证。

## 服务配置

默认不需要手工创建。首次运行会自动生成 `<REMOTE_WORKSPACE>/production.env`（默认 `~/.matrius-remote/production.env`，权限 600），随机生成数据库、Redis、RustFS 密码和 `admin` 初始密码，并套用默认端口与公开地址。管理员凭据在首次输出中打印一次，同时保存在 `<REMOTE_WORKSPACE>/initial-admin.txt`。

需要固定路径或沿用已有配置时，显式设置 `REMOTE_ENV_FILE` 并手工准备：

```bash
scp docker-compose/.env.production.example 管理员账号@服务器IP:/tmp/matrius-production.env.example

sudo install -d -m 750 -o root -g matrius-deploy /etc/matrius
sudo install -m 640 -o root -g matrius-deploy /tmp/matrius-production.env.example /etc/matrius/remote.env
sudoedit /etc/matrius/remote.env
```

常见配置项：

```dotenv
APP_PORT=16666          # 网页 + API
API_PORT=16667          # 仅 API，可选
APP_URL=http://服务器IP:16666
POSTGRES_PASSWORD=<随机>
REDIS_PASSWORD=<随机>
RUSTFS_ACCESS_KEY=<随机>
RUSTFS_SECRET_KEY=<随机>
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=<强密码>
```

已有数据时密码必须与现有服务一致；已有数据库卷但配置文件丢失时，脚本会拒绝生成新密码，避免用错误凭据连接旧数据。

防火墙放行 SSH 和 `APP_PORT`（默认 16666）；需要直连后端时再放行 `API_PORT`（默认 16667）。IP + 端口访问保持 `CADDY_SITE_ADDRESS=:80`。

## 本机配置

```bash
cp .env.local.example .env.local
```

```dotenv
REMOTE_SSH=matrius-deploy@服务器IP
REMOTE_PUBLIC_URL=http://服务器IP:16666

# 可选：首次部署时创建的管理员
# INITIAL_ADMIN_USERNAME=admin
# INITIAL_ADMIN_PASSWORD=你的密码
```

不填 `INITIAL_ADMIN_*` 时首次运行会随机生成管理员密码，并打印到终端、保存到服务器的 `<workspace>/initial-admin.txt`。管理员只在数据库为空时创建，之后修改这里不会改变已有账号。

端口不是 22 时加 `REMOTE_SSH_PORT`；密钥不是默认文件名时加 `REMOTE_SSH_KEY`。首次连接前手工 `ssh` 一次并核对主机指纹，否则严格校验会失败。

### 修改端口

在本机 `.env.local` 中设置，`npm run remote` 每次都会把这三个值同步到服务器配置：

```dotenv
APP_PORT=16666       # 网页 + API
API_PORT=16667       # 仅 API，可选
APP_HTTPS_PORT=8443  # 映射容器 443，配置域名和 HTTPS 后使用
```

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `APP_PORT` | `16666` | 网页 + API 的公网端口 |
| `API_PORT` | `16667` | 仅 API 的公网端口，可选 |
| `APP_HTTPS_PORT` | `8443` | 映射容器 443，配置域名和 HTTPS 后使用 |

不写某个变量时，服务器配置里已有的值保持不变；首次运行则使用默认值。修改后：

1. 同步把 `REMOTE_PUBLIC_URL` 改成 `http://服务器IP:<APP_PORT>`（用 HTTPS 时改为域名）。
2. 在服务器防火墙或安全组放行新端口。
3. 重新执行 `npm run remote`。

配置保存在服务器的 `<workspace>/production.env`（默认 `~/.matrius-remote/production.env`），或显式设置 `REMOTE_ENV_FILE` 时指向的文件。也可以直接编辑该文件，但 `.env.local` 中设置的端口会在下次部署时覆盖它。

已有数据库但 `production.env` 不存在时，脚本会拒绝生成新密码。先把旧配置迁移到 workspace，或显式设置 `REMOTE_ENV_FILE` 指向旧配置。

## 首次部署

```bash
npm run remote -- --check   # 只校验本机配置
npm run remote               # 自动生成配置、初始化服务、建管理员并部署
```

首次运行完成后直接重复 `npm run remote` 即可。

## 日常部署

```bash
npm run remote                        # 同步、构建、启动，健康检查通过后退出
npm run remote -- --publish           # 同上，并更新已发布功能清单
npm run remote -- --publish --migrate # 有已审查的数据库迁移时
```

每次命令都是完整部署：全量同步源码 → 服务器构建 Web/API 镜像 → 重建容器 → 健康检查 → 退出。通常 1–3 分钟，Docker 缓存会加速未变化的构建。命令退出不会停止容器。

默认部署只上线代码，不更新功能清单；`--publish` 在健康检查通过后原子更新清单，是把测试账号验证过的 stable 功能开放给其他账号的唯一入口。健康检查失败时不会更新清单。

回退时在本机切换到已验证的 Git 版本后重新部署；数据库结构回退需单独评估。

## 功能发布与 CD

新功能在 `server/app/features/registry.py` 登记为 `preview`，只对 `admin_test` 开放。验证后改为 `stable`，再发布：

- 手动：`npm run remote -- --publish`
- GitHub Actions：Actions → Deploy Production → Run workflow

CD 只接受手动触发的 main 提交，执行 `npm run remote -- --publish`。在仓库或 production Environment 配置：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Variable | `REMOTE_SSH` | `matrius-deploy@服务器IP` |
| Variable | `REMOTE_SSH_PORT` | SSH 端口，默认 22 |
| Variable | `REMOTE_PUBLIC_URL` | 网站地址，端口 `16666` |
| Variable | `APP_PORT` | 网页 + API 端口，可留空 |
| Variable | `API_PORT` | 仅 API 端口，可留空 |
| Variable | `APP_HTTPS_PORT` | HTTPS 端口，可留空 |
| Variable | `REMOTE_ENV_FILE` | 可留空；默认使用 workspace 中自动生成的配置 |
| Variable | `REMOTE_WORKSPACE` | 与本机相同的 workspace，可留空 |
| Secret | `REMOTE_SSH_PRIVATE_KEY` | 专用 CD 私钥 |
| Secret | `REMOTE_SSH_KNOWN_HOSTS` | 已核对的主机密钥 |

本机与 CD 共用服务器会话锁：已有部署进行时，CD 会直接失败，等待后重试。

## HTTPS

有域名后修改服务配置并重新部署：

```dotenv
CADDY_SITE_ADDRESS=example.com
APP_PORT=80
APP_HTTPS_PORT=443
APP_URL=https://example.com
```

域名解析到服务器并放行 80/443，Caddy 自动申请和续期证书。本机 `.env.local` 的 `REMOTE_PUBLIC_URL` 同步改为 HTTPS 地址。

## 运维

### 状态与日志

```bash
ssh matrius-deploy@服务器IP "docker ps --filter name=matrius-"
ssh matrius-deploy@服务器IP "docker logs --tail 100 matrius-api"
ssh matrius-deploy@服务器IP "docker logs --tail 100 matrius-web"
```

`/api/health` 检查数据库；`/api/health/ready` 检查数据库、Redis、对象存储和搜索。

### 备份

真正不可替代的是 PostgreSQL、RustFS 对象和服务配置文件。服务器上的 `scripts/backup.sh` 会导出数据库、打包 RustFS 卷并复制配置：

```bash
sudo install -o root -g root -m 0755 \
  /home/matrius-deploy/.matrius-remote/source/scripts/backup.sh \
  /usr/local/sbin/matrius-backup
sudo /usr/local/sbin/matrius-backup
```

默认写入 `/var/backups/matrius`，保留 14 天；可用 `BACKUP_DIR`、`BACKUP_KEEP_DAYS` 覆盖。建议加入 cron：

```text
17 3 * * * /usr/local/sbin/matrius-backup >> /var/log/matrius-backup.log 2>&1
```

同机备份无法应对磁盘或服务器损坏。用 `BACKUP_REMOTE`（rsync 目标）把副本送到另一台机器或备份盘；环境文件包含密钥，异地副本应加密。

恢复时先停止 API 写入：

```bash
sudo docker stop matrius-api

sudo docker exec -i matrius-postgres \
  pg_restore -U matrius -d matrius --clean --if-exists < postgres-<时间戳>.dump

sudo docker stop matrius-rustfs
sudo docker run --rm \
  -v matrius_prod_rustfs_data:/data \
  -v "$PWD":/backup \
  alpine:3.20 \
  sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf /backup/rustfs-<时间戳>.tar.gz -C /data'
sudo docker start matrius-rustfs matrius-api
```

恢复前确认备份完整，并优先在临时数据库验证。

### 停止与密钥

停止服务时执行 `docker compose down`，永远不加 `-v`（会删除数据卷）。服务密钥默认在 `<workspace>/production.env`（权限 600）；显式设置 `REMOTE_ENV_FILE` 时以该文件为准，不要提交或下载到开发机。轮换密码后重新部署；数据库密码还需同步修改 PostgreSQL 用户。

从旧部署迁移：保留数据卷，把原配置迁到新的 `REMOTE_ENV_FILE`，再改用本流程；不要删除数据卷。

## 验证

```bash
npx expo lint
npx tsc --noEmit
npm run test:remote
```

仓库不配置自动 CI；发布前在本地完成检查，迁移在专用空 PostgreSQL 上验证。
