#!/bin/bash
set -euo pipefail

# 从本地检出的源码构建并启动，不再拉取独立发布的 npm 版本或 latest 镜像。
show_help() {
    cat <<'HELP'
使用方法：
  bash docker/scripts/start.sh

请先切换到需要部署的分支、标签或提交，再运行本脚本。
可选环境变量：
  XIAOZHI_DATA_DIR       持久化目录，默认 ~/xiaozhi-client
  XIAOZHI_WEB_PORT       宿主机端口，默认 9999
  XIAOZHI_BIND_ADDRESS   宿主机监听地址，默认 0.0.0.0

示例：
  XIAOZHI_WEB_PORT=19999 bash docker/scripts/start.sh
HELP
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    show_help
    exit 0
fi
if [ "$#" -ne 0 ]; then
    echo "错误：镜像内容由当前源码决定，请先切换 Git 版本，再运行本脚本。" >&2
    show_help
    exit 1
fi

script_path="${BASH_SOURCE[0]:-}"
if [ ! -f "$script_path" ]; then
    echo "错误：请先克隆完整仓库，再运行 bash docker/scripts/start.sh。" >&2
    exit 1
fi
project_root="$(cd -- "$(dirname -- "$script_path")/../.." && pwd)"
compose_file="$project_root/docker/docker-compose.yml"
cd "$project_root"

if [ ! -f "$project_root/pnpm-lock.yaml" ]; then
    echo "错误：未找到完整源码和锁文件，请在克隆后的仓库中运行。" >&2
    exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "错误：请先安装并启动 Docker，并安装 Docker Compose v2。" >&2
    exit 1
fi

docker compose -f "$compose_file" config --quiet
docker compose -f "$compose_file" up -d --build --wait --wait-timeout 180

printf '服务已通过健康检查，宿主机端口绑定如下：\n'
docker compose -f "$compose_file" port xiaozhi-client 9999
printf '请使用宿主机局域网 IP 和上述端口访问 WebUI，配置 MCP 接入点。\n'
printf '查看日志：docker compose -f "%s" logs -f\n' "$compose_file"
