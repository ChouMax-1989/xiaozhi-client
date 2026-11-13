#!/bin/bash
set -euo pipefail

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
workspace_dir="${XIAOZHI_CONFIG_DIR:-${XIAOZHI_WORKSPACE:-/workspaces}}"
export XIAOZHI_CONFIG_DIR="$workspace_dir"

log "初始化小智 MCP 工作目录：$workspace_dir"
mkdir -p "$workspace_dir"

# 只补齐缺少的文件；即使 package.json 缺失，也不能覆盖用户的接入点和密钥。
cp -rn "$script_dir/../templates/." "$workspace_dir/"
cd "$workspace_dir"

# 应用本身已在镜像中安装，此处仅处理用户的 MCP 项目依赖。
if [ ! -d node_modules ]; then
    log "检查工作目录的 Node.js 依赖..."
    if ! npm install --omit=dev --no-audit --no-fund; then
        log "错误：工作目录的 Node.js 依赖安装失败，请检查 package.json"
        exit 1
    fi
fi

# 空文件、空行和注释不触发安装；uv / uvx 已包含在镜像中。
if [ -f requirements.txt ] && grep -Eq '^[[:space:]]*[^#[:space:]]' requirements.txt; then
    log "安装工作目录 requirements.txt 中的 Python 依赖..."
    if ! pip install --disable-pip-version-check -r requirements.txt; then
        log "错误：Python 依赖安装失败，请检查 requirements.txt"
        exit 1
    fi
fi

# 仅清理本应用的旧状态，保留用户 MCP 服务的其他 PID 文件。
rm -f .xiaozhi-client.pid

if [ "$#" -eq 0 ]; then
    set -- node /app/dist/backend/WebServerLauncher.js
elif [[ "$1" == -* ]]; then
    set -- xiaozhi "$@"
fi

log "启动小智服务..."
# 替换 shell，使服务器直接接收 dumb-init 转发的退出信号。
exec "$@"
