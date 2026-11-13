# NAS 部署小智本地记忆

本手册用于 NAS 准备好之后部署；当前尚未在 NAS Docker 和真实小智云端验证，也没有执行部署。请使用包含本次改动的源码构建：截至编写时，`main` 的 `c804ff9` 不包含这批功能，部署入口为 `fix/local-acceptance-20261113` 分支。不要用旧上游镜像代替。分支推送完成后再执行以下步骤；若以后合并，请先核对目标提交确实包含这些改动。

## 1. 准备目录与构建

在 NAS 上准备 Docker、Compose v2 和 Git。选两个不同的绝对目录：源码目录和持久化数据目录；数据目录应放在重启后保留的存储上。下面的路径、端口和内网地址仅作示例，按实际情况替换。确保端口未被其他服务占用，界面只向可信网络开放。

```bash
export XIAOZHI_DATA_DIR=/volume1/docker/xiaozhi-client-data
export XIAOZHI_WEB_PORT=9999
export XIAOZHI_BIND_ADDRESS=0.0.0.0
mkdir -p "$XIAOZHI_DATA_DIR"
git clone --branch fix/local-acceptance-20261113 \
  https://github.com/ChouMax-1989/xiaozhi-client.git \
  /volume1/docker/xiaozhi-client-src
cd /volume1/docker/xiaozhi-client-src
git log -1 --oneline
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs --tail=100
```

这三个环境变量需要在以后执行 Compose 的终端中继续提供，尤其是更新、重启和回退时。Compose 将数据目录挂到容器 `/workspaces`，源码目录不会自动成为持久化数据目录。镜像从当前检出的源码构建，包含 Web 服务和记忆 MCP；首次构建及依赖安装可能需要一些时间。

## 2. 配置接入点和记忆

1. 打开 `http://NAS内网地址:9999`，按实际端口调整。先在客户端设置中填写当前智能体的**一个**完整官方 WSS MCP 接入点并保存。接入点包含敏感凭据，不贴到聊天、文档或日志中。
2. 进入「记忆库 → 设置」，填写该智能体 ID。多人共用或身份未确认时，人物身份标识留空；只有明确为同一人单独使用时才填写。保持自动同步间隔为 `0`，无需填写旧网页登录凭据，也无需另购模型 API。
3. 保存后按提示重启容器，使用上一步同一组 Compose 环境变量：

   ```bash
   docker compose -f docker/docker-compose.yml restart xiaozhi-client
   ```

4. 在工具列表确认记忆服务的 11 个工具可见且已启用，包括 `memory__memory_record_turn` 和 `memory__memory_read_result`；服务名不同则前缀也不同，以实际列表为准。工具启停或列表变化后，需要让云端重新请求工具列表，必要时重新连接接入点。仅容器运行或网页可访问不能证明云端已发现工具。
5. 将[角色记忆规则](xiaozhi-role-memory-rules.md)追加到对应小智智能体的角色介绍中，保留原有人设。真实对话后检查工具调用是否成功、是否收到保存回执，以及「对话记录」中是否出现模型提交的文本。来源标记为模型提交，不能保证平台所有原文、实际播报或历史都被完整采集；候选记忆也不能当成已确认事实。

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
- 更新前先做一致性备份，记录当前 `git rev-parse HEAD`、配置和镜像版本。在源码目录拉取确认过的分支提交，再执行 `docker compose -f docker/docker-compose.yml up -d --build`，核对提交、容器和工具。`restart` 不会构建新源码。
- 回退前先再次备份当前库与配置，保留更新后产生的新数据。检出此前记录的受信任提交并重新构建启动，再检查兼容性；若必须恢复旧数据库，停止容器后使用单独保留的一致性备份作为新路径，勿覆盖当前库。恢复旧备份会回到备份时点，备份之后的新记录不会自动合并。

本机角色规则和记忆工具不能保证模型每轮都调用；网络中断、模型未调用或模型不可见的内容需要如实标记为未验证或缺失。
