# 实例访问与资源

Matrius 无需登录；任何可访问部署地址的客户端均可使用全部已登记功能，共享对话、文件、偏好和用量。没有管理员、密码、登录会话或账户设置。侧边栏底部直接打开设置，存储和用量归入「资源」。

客户端通过 GET /api/features 初始化实例能力，断网时重连，不回退到本地业务数据。旧 /api/auth/* 已移除。业务数据导入和删除标记接口位于 /api/workspace/*。

数据库迁移 0011_remove_accounts 删除 users、auth_sessions、instance.owner_id；业务表的 instance_id 指向唯一的 instance.id=1，画像和偏好表为 profiles、profile_fields、preferences。迁移前自动在数据库旁创建 `*.before-account-removal-*.db` 完整备份。重复偏好、画像和同名字段优先采用原绑定所有者的记录，否则采用最近更新的记录，其他版本保留在备份中。对话、消息、文件和记忆全部保留，重复的旧导入键清空后继续使用资源 UUID；同日用量累加，删除标记与回填标记去重。

存储接口 GET /api/files/usage 返回 disk.total、disk.used、disk.free，使用 Python 标准库 shutil.disk_usage(DATA_DIR 所在文件系统)，Windows、macOS、Linux 使用相同实现。容量包含系统和其他应用占用，不是上传文件之和，也不汇总多块独立磁盘。Docker 下表示持久数据卷所在文件系统；Docker Desktop 的虚拟磁盘容量可能与宿主机物理磁盘不同。

files、images 分类仍仅统计本应用文件，便于进入资料库清理。取消旧的 512 MiB 账户配额；上传与文档保存按磁盘可用空间检查，单文件大小及工具并发限制保留。磁盘余量检查不是空间预留，写入时仍可能因其他进程占用而失败。

启动与部署不再接收或更新账户凭据，不生成管理员密码文件。历史迁移保留以支持旧库升级；旧多用户库在 0010 阶段仍可能需要指定旧数据归属，相关配置仅在该历史迁移内使用。
