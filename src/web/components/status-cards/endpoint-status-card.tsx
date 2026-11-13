/**
 * 小智接入点状态卡片组件
 *
 * 显示当前配置的小智接入点数量，并提供设置按钮。
 */

import { ManagementStatus } from "@/components/management-page";
import { McpEndpointSettingButton } from "@/components/mcp-endpoint-setting-button";
import { useMcpEndpoint } from "@/stores/config";

/**
 * 小智接入点状态卡片组件
 *
 * 显示当前配置的小智接入点数量，右上角显示状态指示器。
 */
export function EndpointStatusCard() {
  const mcpEndpoint = useMcpEndpoint();
  const endpointCount = Array.isArray(mcpEndpoint)
    ? mcpEndpoint.length
    : mcpEndpoint
      ? 1
      : 0;

  return (
    <ManagementStatus
      title="小智接入点"
      value={endpointCount}
      description={
        endpointCount ? `已配置 ${endpointCount} 个接入点` : "尚未配置接入点"
      }
      actions={<McpEndpointSettingButton />}
    />
  );
}
