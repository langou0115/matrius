# 实例访问与资源

Matrius 无需登录；任何可访问部署地址的客户端均可使用全部已登记功能，共享对话、文件、偏好和用量。没有管理员、密码、登录会话或账户设置。侧边栏底部直接打开设置，存储和用量归入「资源」。

客户端通过 GET /api/features 初始化实例能力，断网时重连，不回退到本地业务数据。旧 /api/auth/* 已移除。业务数据导入和删除标记接口位于 /api/workspace/*。

数据库只有一条基线迁移 0001_initial，直接创建单实例 schema：instance.id=1 及指向它的业务表，画像和偏好表为 profiles、profile_fields、preferences。空库初始化不会生成迁移备份或其他伴随文件。开发期的账户迁移链（0001–0011）已删除；旧数据库需要删除 DATA_DIR 或执行一次 `alembic stamp 0001_initial`。

存储接口 GET /api/files/usage 返回 disk.total、disk.used、disk.free，使用 Python 标准库 shutil.disk_usage(DATA_DIR 所在文件系统)，Windows、macOS、Linux 使用相同实现。容量包含系统和其他应用占用，不是上传文件之和，也不汇总多块独立磁盘。Docker 下表示持久数据卷所在文件系统；Docker Desktop 的虚拟磁盘容量可能与宿主机物理磁盘不同。

files、images 分类仍仅统计本应用文件，便于进入资料库清理。取消旧的 512 MiB 账户配额；上传与文档保存按磁盘可用空间检查，单文件大小及工具并发限制保留。磁盘余量检查不是空间预留，写入时仍可能因其他进程占用而失败。

启动与部署不再接收或更新账户凭据，不生成管理员密码文件。旧账户迁移的兼容代码已移除，开发阶段不做历史账户数据迁移。
