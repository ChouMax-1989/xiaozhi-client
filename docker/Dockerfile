# 从仓库源码和锁文件构建，构建上下文必须为仓库根目录。
FROM node:22-bookworm AS build

WORKDIR /build
ENV HUSKY=0

# 原生依赖需要 Python；Node 完整镜像已包含编译工具链。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY src/web/package.json ./src/web/package.json
COPY mcps/calculator-mcp/package.json ./mcps/calculator-mcp/package.json
COPY mcps/datetime-mcp/package.json ./mcps/datetime-mcp/package.json
COPY docs/package.json ./docs/package.json

# 使用项目声明的 pnpm 版本，禁止安装时改写锁文件。
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" \
    && pnpm --filter xiaozhi-client --filter xiaozhi-frontend-app install --frozen-lockfile

COPY src ./src
COPY template ./template
COPY tsconfig.json README.md LICENSE ./

# 应用无 workspace 运行依赖；标准 deploy 使用独立的冻结锁文件导出生产包。
# 保留构建工具路径，让生产包的 prepare 能找到 husky，并由 HUSKY=0 跳过安装钩子。
RUN pnpm build \
    && PATH="/build/node_modules/.bin:$PATH" pnpm --filter xiaozhi-client \
        --config.inject-workspace-packages=true deploy --prod --offline /out \
    && test -f /out/dist/backend/WebServerLauncher.js \
    && test -f /out/dist/memory/stdio.js \
    && test -f /out/dist/memory/cli.js \
    && test -f /out/dist/frontend/index.html

# 保留完整 Node 环境，便于 npx 安装含原生模块的 MCP 服务。
FROM node:22-bookworm AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        dumb-init git python3 python3-pip python3-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    NODE_ENV=production \
    XIAOZHI_WORKSPACE=/workspaces \
    XIAOZHI_CONFIG_DIR=/workspaces \
    XIAOZHI_CONTAINER=true

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY --from=build /out/ ./
COPY --from=build /usr/local/lib/node_modules/pnpm/ /usr/local/lib/node_modules/pnpm/
COPY docker/templates/ ./docker/templates/
COPY docker/examples/ ./docker/examples/
COPY docker/scripts/entrypoint.sh docker/scripts/healthcheck.mjs ./docker/scripts/

# CLI 用于查看版本和管理配置；服务生命周期由 Docker 管理。
RUN chmod +x /app/dist/cli/index.js /app/docker/scripts/entrypoint.sh \
    && ln -s /app/dist/cli/index.js /usr/local/bin/xiaozhi \
    && ln -s /app/dist/cli/index.js /usr/local/bin/xiaozhi-client \
    && ln -s /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && ln -s /usr/local/lib/node_modules/pnpm/bin/pnpx.cjs /usr/local/bin/pnpx

WORKDIR /workspaces
EXPOSE 9999

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD ["node", "/app/docker/scripts/healthcheck.mjs"]

# 直接运行服务器，避免 CLI 的后台启动使容器主进程提前退出。
# dumb-init 负责传递信号和回收 MCP 子进程。
ENTRYPOINT ["dumb-init", "--", "/app/docker/scripts/entrypoint.sh"]
CMD ["node", "/app/dist/backend/WebServerLauncher.js"]
