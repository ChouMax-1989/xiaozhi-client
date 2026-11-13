import { RestartButton } from "@/components/restart-button";

export function MemoryRestartHint({
  containerMode,
}: { containerMode?: boolean }) {
  if (containerMode) {
    return (
      <p>
        新设置尚未生效。请在 NAS 容器管理界面重启此容器，或在源码目录执行{" "}
        <code className="break-all">
          docker compose -f docker/docker-compose.yml restart xiaozhi-client
        </code>
        ；重启后刷新页面。
      </p>
    );
  }
  return (
    <>
      <p>
        记忆服务仍在使用启动时的配置。请重启整个客户端使新设置生效，重连后刷新页面。
      </p>
      <RestartButton defaultText="重启服务" />
    </>
  );
}
