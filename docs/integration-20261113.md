# 家庭 MCP 整合记录（2026-11-13）

## 版本与用途

本分支以 `shenjingnan/xiaozhi-client` 的当前主分支为基础，吸收已审查的修复，并修正家庭 Docker 部署方式。设备继续使用小智官方服务中已经选好的模型；本地运行 MCP 客户端、工具和配置网页。

- 整合分支：`integrate/home-mcp-20261113`。
- 上游基线：[`fe3c3824bc55341624aeedd97527224dca4337c3`](https://github.com/shenjingnan/xiaozhi-client/commit/fe3c3824bc55341624aeedd97527224dca4337c3)。
- 应用版本：`2.4.0-beta.3`。这是基于上游测试版的自用整合分支，并非上游新发布的正式版本。
- 上游最新稳定标签为 `v2.3.0`；当前主分支比该标签多 44 个提交。

## 分支筛选

检查了 1,082 个远程分支名称，并比较了其中 42 个非 `claude/` 命名分支与主分支的提交关系；重点审查近期 6 个未合并 PR。没有逐份审查全部自动生成分支的代码。

- `dev` 比主分支落后 773 个提交，没有领先提交，不用于更新。
- 多数其他功能分支基线较旧，或仍在试验阶段。
- `feature/tts-pcm-to-opus-flow` 比主分支领先 1 个提交，对应 [PR #3513](https://github.com/shenjingnan/xiaozhi-client/pull/3513)。它引入新的音频处理流程，与此次家庭 MCP 部署目的无直接关系，暂不纳入。

## 吸收的更新

| 来源 | 处理方式 | 整合结果 |
| --- | --- | --- |
| [#3520](https://github.com/shenjingnan/xiaozhi-client/pull/3520) | 使用 `cherry-pick -x` 吸收头提交 `84b3b72abf43f21029789f1ec6e5b8a40f5e4dc0` | 接住缓冲区排空后发送停止消息失败的 Promise rejection，并新增回归测试 |
| [#3521](https://github.com/shenjingnan/xiaozhi-client/pull/3521) | 使用 `cherry-pick -x` 吸收头提交 `5d47c5aeed8f92640f673d51fe570249147861b6` | Vite 更新到 `7.3.5`，保留该 PR 的配套锁文件更新 |
| [#3519](https://github.com/shenjingnan/xiaozhi-client/pull/3519) | 整合目标版本并重新生成锁文件 | Vitest 与 `@vitest/coverage-v8` 同步为 `3.2.6` |
| [#3518](https://github.com/shenjingnan/xiaozhi-client/pull/3518) | 整合目标版本并补齐间接依赖 | Hono 统一到 `4.12.21`，包含 MCP SDK 实际使用的版本 |
| [#3516](https://github.com/shenjingnan/xiaozhi-client/pull/3516) | 整合目标版本并补齐间接依赖 | ws 统一到 `8.20.1`，包含 Happy DOM 使用的版本 |
| [#3506](https://github.com/shenjingnan/xiaozhi-client/pull/3506) | 整合目标版本并补齐间接依赖 | PostCSS 统一到 `8.5.10`，包含 Vite 与样式构建链 |

五个依赖 PR 都修改同一份锁文件，并带有重叠的间接依赖更新。因此保留 Vite PR 的提交，再用仓库指定的 pnpm `10.30.3` 整合其余目标版本，没有把几份锁文件互相覆盖。

直接依赖固定为本次验证的版本。对旧 Hono 4、ws 8、PostCSS 8 增加范围受限的 overrides；已安装依赖树中这些包各只有目标版本。Node 最低要求改为 `22.12.0`，与所用 Vite 7 的要求一致。

## Docker 改动

1. 多阶段构建从当前完整源码和冻结锁文件生成后端、CLI、网页及独立生产安装包；删除原来默认安装 npm `xiaozhi-client@2.0.0` 的路径。
2. 容器直接以前台方式运行 `WebServerLauncher.js`，由 `dumb-init` 传递信号及回收子进程，解决新版 CLI 后台启动后容器退出的问题。
3. 健康检查访问真实 HTTP 健康接口，并核对响应内容。
4. 首次启动只补齐缺失模板，不覆盖现有配置；默认 MCP 工具列表为空，网页可先启动，再添加工具。
5. 保留 Node、npx、pnpm、Python、pip、uv、uvx、Git、FFmpeg；应用程序与持久化数据分开放置。
6. Compose 从当前源码构建，默认只映射 9999，去掉固定子网和 IPv6 前置条件。
7. README、启动脚本和部署文档改为使用完整源码构建。容器的重启、停止和升级由 Compose 管理。

## 验证结果

验证环境：Linux x86_64、Node `24.22.1`、pnpm `10.30.3`。

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | 通过，锁文件与清单一致 |
| `pnpm check:all` | 通过，包含代码格式、类型、拼写和重复代码检查 |
| `pnpm build` | 后端、CLI、WebUI 全部构建成功 |
| `pnpm test --maxWorkers=4 --minWorkers=1` | 128 个测试文件通过；2,772 个用例通过，5 个跳过 |
| TTS 模块覆盖率检查 | 27 个用例通过；语句与行 89.05%，分支 84.52%，函数 100%，四项均通过 80% 门槛 |
| 生产安装包 | 离线导出成功；直接运行依赖与源锁文件一致；不包含 Husky、Vite 等开发工具 |
| 实际服务烟测 | HTTP 健康、网页首页及构建后的 JS 资源均成功 |
| 实际 MCP 烟测 | 启动 stdio MCP 子进程，成功调用工具，`/mcp` 能列出聚合工具 |
| 退出流程 | SIGTERM 后服务正常退出，MCP 子进程退出，停机后的健康检查失败 |

原有测试日志中仍有部分预期错误日志、React 测试警告；构建有浏览器兼容数据和大文件体积提示，均未造成检查失败。依赖安装仍提示现有发布工具的 peer 版本不匹配，本次没有运行发布工具。

## 验证边界

- 当前环境没有 Docker 引擎。没有实际执行 Docker 镜像构建、Compose 启动、Node 22 容器运行或 ARM64 镜像验证。宿主上的生产包烟测不能替代这些检查。
- 没有用户的官方 MCP 接入点令牌和家庭设备，未验证小智官方服务、语音指令和真实家电控制。
- 本次修改面向家庭本地 Compose 部署，未执行上游的 Docker Hub / npm 发布流程。
- 没有修改上游仓库。整合结果已保存到用户仓库 [ChouMax-1989/xiaozhi-client](https://github.com/ChouMax-1989/xiaozhi-client)，通过 [PR #1](https://github.com/ChouMax-1989/xiaozhi-client/pull/1) 合入 `main`，并保留 `integrate/home-mcp-20261113` 分支。
- 首次导入及合并后的完整文件树为 `16d0981be7ffb1127c85897caf5364eac4a46075`，与已验证的本地提交 `f11a1c247da95397b3e202b11480a692bb89ca6f` 完全相同，包括文件权限。网页导入将远程提交按文件重新组织；合并后仅本报告补充仓库保存状态，源码、配置及测试内容未再修改。

## 家中部署

取得完整源码并切换到本整合分支后，在仓库根目录运行：

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs -f
```

访问 `http://宿主机局域网IP:9999`，填写官方 MCP 接入点，并添加家庭网络中的 MCP 工具。默认数据目录为 `~/xiaozhi-client`，源码应放在另一个目录，例如 `~/xiaozhi-client-src`。

详细配置、网络访问及更新方法见 [Docker 部署说明](content/usage/docker.mdx)。
