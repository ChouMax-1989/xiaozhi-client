# NAS 部署小智本地记忆

NAS 准备好后，从 `ChouMax-1989/xiaozhi-client` 的最新 `main` 构建。Compose 运行一个 `xiaozhi-client` 容器，网页、MCP 和 SQLite 共用这个容器。

重新部署时沿用原数据目录，按下方 Compose 命令构建即可。它只启动记忆服务所在的 `xiaozhi-client` 容器。若从旧试验环境迁移，请保留记忆数据库和配置，跳过已移除的音响模拟容器、代发脚本和预录口令。

## 1. 准备目录与构建

在 NAS 上准备 Docker、Compose v2 和 Git。选两个不同的绝对目录：源码目录和持久化数据目录；数据目录应放在重启后保留的存储上。下面的路径、端口和内网地址仅作示例，按实际情况替换。确保端口未被其他服务占用，界面只向可信网络开放。

```bash
export XIAOZHI_DATA_DIR=/volume1/docker/xiaozhi-client-data
export XIAOZHI_WEB_PORT=9999
export XIAOZHI_BIND_ADDRESS=0.0.0.0
mkdir -p "$XIAOZHI_DATA_DIR"
git clone --branch main \
  https://github.com/ChouMax-1989/xiaozhi-client.git \
  /volume1/docker/xiaozhi-client-src
cd /volume1/docker/xiaozhi-client-src
git log -1 --oneline
# 返回0才表示包含已验证基线；不包含时先检查仓库和分支，停止部署。
git merge-base --is-ancestor 5fc4f123afbe559ac48ecd2a989d5398032a13d6 HEAD || exit 1
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs --tail=100
```

这三个环境变量需要在以后执行 Compose 的终端中继续提供，尤其是更新、重启和回退时。Compose 将数据目录挂到容器 `/workspaces`，源码目录不会自动成为持久化数据目录。镜像从当前检出的源码构建，包含 Web 服务和记忆 MCP；首次构建及依赖安装可能需要一些时间。

## 2. 配置接入点和记忆

1. 打开 `http://NAS内网地址:9999`，按实际端口调整。在顶部可切换「看板」「记忆库」「记忆图谱」。进入「看板 → 小智接入点」填写当前智能体的**一个**完整官方 WSS MCP 接入点并保存。接入点包含敏感凭据，不贴到聊天、文档或日志中。
2. 进入「记忆库 → 设置」，填写该智能体 ID。多人共用或身份未确认时，人物身份标识留空；只有明确为同一人单独使用时才填写。家庭 NAS 只通过 MCP 记录新对话。将官网历史同步间隔设为 `0`，历史访问凭据留空。
3. 保存后按提示重启容器，使用上一步同一组 Compose 环境变量：

   ```bash
   docker compose -f docker/docker-compose.yml restart xiaozhi-client
   ```

4. 在「看板 → 可用工具」确认记忆服务的 11 个工具已启用，再到小智控制台刷新接入点，确认云端已发现工具。使用官方语音时，「实时语音」卡片可留空。
5. 到看板底部「小智角色提示词」点击「复制提示词」。在小智官方控制台选中同一智能体，打开「角色介绍」，开启「自定义」，将提示词追加到原有人设末尾，保存。升级时只替换旧的记忆规则。看板会填入当前服务的工具全名。[角色规则与示例](xiaozhi-role-memory-rules.md)
6. 正常聊一段，顺便提到一项偏好。规则要求小智每轮主动调用 `memory_record_turn`。出现值得记住的内容时，按本轮回执读取原文、查重、提交记忆并标记已审阅。到「记忆库」核对消息和记忆引用，到看板核对工具调用。模型提交的内容保留来源标记，真实聊天是否逐轮记录以实际回执为准。
   真实 stdio 服务默认 `XIAOZHI_MEMORY_CHAT_START_CLAIM=0`，即使旧角色在检索时传入 `chatStart=true`，也不领取整理任务；显式设为 `1` 可兼容旧模式。显式批量整理每次读取一条，长原文续读完整后再标记已处理；任务可暂停和继续。
7. 再开新对话询问已保存的偏好，在看板查看检索调用。「记忆图谱」可从顶部或 `/memory-graph` 打开，点击节点即可回看来源。准备关闭官方记忆时，先确认历史归档和提炼完成、备份本地库，并用一条仅存于本地的记忆验证跨会话检索。

界面配置的默认数据库是容器内 `/workspaces/memory/archive.sqlite`，对应数据目录下的 `memory/archive.sqlite`。配置绑定单一智能体和端点；多个智能体使用各自独立实例及数据库，不要共用一个记忆库。

## 3. 一致性备份与已有库迁移

每次更新或迁移前，先在旧实例的「记忆库 → 设置 → 数据管理」生成并下载 SQLite 一致性备份，妥善保存到持久目录之外。该备份包含已提交的 WAL 内容；不要直接复制仍在使用的 `archive.sqlite` 当备份。JSON 导出供检查，不是 CLI `import` 的输入格式，也不能代替整库恢复。

在容器内也可用 CLI 生成新文件；下面的 ID 应是数据库原先绑定的智能体 ID。多人模式将 `MEMORY_OWNER` 保持空值；单人模式必须填入数据库原有身份标识。路径需和界面显示的实际数据库路径一致：

```bash
export MEMORY_AGENT_ID='填写原智能体ID'
export MEMORY_OWNER=''
docker compose -f docker/docker-compose.yml exec \
  -e XIAOZHI_MEMORY_AGENT_ID="$MEMORY_AGENT_ID" \
  -e XIAOZHI_MEMORY_OWNER="$MEMORY_OWNER" \
  -e XIAOZHI_MEMORY_DB=/workspaces/memory/archive.sqlite \
  xiaozhi-client node --experimental-sqlite /app/dist/memory/cli.js \
  backup /workspaces/memory/backup-before-update.sqlite
```

备份目标必须是**不存在**的新文件；再次执行时换一个名字。CLI 不自动继承 `mcpServers.memory.env`，因此必须显式传入身份、数据库路径；其他命令也一样。备份和原始对话均含私密内容，应限制文件访问。

迁移旧本地库时：先在旧实例取得一致性备份并另外保留一份；在新容器配置相同的智能体和身份模式后停止容器，将备份放到新数据目录中的**新文件名**，例如 `memory/migrated.sqlite`。保留原有库和备份，不覆盖正在使用的库。停止状态下只调整新容器 `/workspaces/xiaozhi.config.json` 中记忆服务的 `XIAOZHI_MEMORY_DB` 为 `/workspaces/memory/migrated.sqlite`，确认 `XIAOZHI_MEMORY_CLIENT_CONFIG` 指向 `/workspaces/xiaozhi.config.json`；不要把 Windows 绝对路径配置原样复制到 Linux。启动后检查数量、来源和版本，再启用真实使用。

备份也保存端点绑定。若旧库使用的是占位接入点，或同一智能体的接入点已更换，先在新配置中设置该**同一智能体**的真实 WSS 接入点。启动容器后，即使记忆子进程因绑定不一致而拒绝，也可以在容器内执行下面的本机绑定命令，然后重启容器；不应借此把另一智能体接入旧库：

```bash
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml exec \
  -e XIAOZHI_MEMORY_AGENT_ID="$MEMORY_AGENT_ID" \
  -e XIAOZHI_MEMORY_OWNER="$MEMORY_OWNER" \
  -e XIAOZHI_MEMORY_DB=/workspaces/memory/migrated.sqlite \
  -e XIAOZHI_MEMORY_CLIENT_CONFIG=/workspaces/xiaozhi.config.json \
  xiaozhi-client node --experimental-sqlite /app/dist/memory/cli.js rebind-endpoint
docker compose -f docker/docker-compose.yml restart xiaozhi-client
```

若迁移的是默认数据库，将命令中的 `migrated.sqlite` 换成实际路径。身份不一致、数据库无法打开或绑定校验失败时，应停止并核对原库及配置，不要绕过校验。

## 4. 检查、更新和回退

- 检查容器状态及简短日志，打开记忆库核对数据库路径、会话和记忆数量；确认 11 个工具启用并在云端重新发现。待 NAS 和用户在场时，再用合成短句做真实语音验收，核对调用、保存回执、来源和后续检索，不把本机测试当成云端验收。
- 更新前先做一致性备份，记录当前 `git rev-parse HEAD`、配置和镜像版本。在源码目录检查本地修改后更新 `main`，再从源码构建，核对提交、容器和工具。`restart` 不会构建新源码。
- 回退前先再次备份当前库与配置，保留更新后产生的新数据。检出此前记录的受信任提交并重新构建启动，再检查兼容性；若必须恢复旧数据库，停止容器后使用单独保留的一致性备份作为新路径，勿覆盖当前库。恢复旧备份会回到备份时点，备份之后的新记录不会自动合并。

本机角色规则和记忆工具不能保证模型每轮都调用；网络中断、模型未调用或模型不可见的内容需要如实标记为未验证或缺失。

已有源码目录可在备份完成、确认 `git status --short` 为空后执行以下更新步骤；若存在修改，先保留并处理，不使用强制重置。先确认 `git remote get-url origin` 是你的上述仓库，沿用同一组数据目录、端口和绑定地址环境变量：

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git merge-base --is-ancestor 5fc4f123afbe559ac48ecd2a989d5398032a13d6 HEAD || exit 1
git log -1 --oneline
docker compose -f docker/docker-compose.yml up -d --build xiaozhi-client
docker compose -f docker/docker-compose.yml ps
```

若此前本地检出开发分支且尚无本地 `main`，用 `git switch --track origin/main` 创建跟踪分支，再继续后续命令。所有部署与真实语音验收均等 NAS 准备好后执行。
