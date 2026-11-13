/**
 * MCP 服务状态卡片组件
 *
 * 显示当前连接的 MCP 服务数量，并提供服务器列表和工具调用日志查看入口。
 */

import { AddMcpServerButton } from "@/components/add-mcp-server-button";
import { ManagementStatus } from "@/components/management-page";
import { McpServerTableDialog } from "@/components/mcp-server/mcp-server-table-dialog";
import { ToolCallLogsDialog } from "@/components/tool-call-logs-dialog";
import { useMcpServersWithStatus } from "@/stores/config";

/**
 * MCP 服务状态卡片组件
 *
 * 显示当前连接的 MCP 服务数量，右上角显示服务数量指示器。
 */
export function ServerStatusCard() {
  const { servers } = useMcpServersWithStatus();

  const totalServers = servers.length;
  const connectedServers = servers.filter((s) => s.connected).length;

  return (
    <ManagementStatus
      title="MCP服务"
      value={`${connectedServers}/${totalServers}`}
      description={`已连接 ${connectedServers} 个，共 ${totalServers} 个服务`}
      actions={
        <>
          <AddMcpServerButton />
          <McpServerTableDialog />
          <ToolCallLogsDialog />
        </>
      }
    />
  );
}
