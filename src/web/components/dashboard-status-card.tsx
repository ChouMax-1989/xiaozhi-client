/**
 * 仪表板状态卡片容器组件
 *
 * 组合显示小智接入点、MCP 服务、实时语音和系统设置的状态卡片。
 */

import {
  EndpointStatusCard,
  ServerStatusCard,
  SystemStatusCard,
  VoiceInteractionCard,
} from "@/components/status-cards";

/**
 * 仪表板状态卡片组件
 *
 * 按网格布局排列四个状态卡片：小智接入点、MCP 服务数量、实时语音、系统设置。
 */
export function DashboardStatusCard() {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
      <EndpointStatusCard />
      <ServerStatusCard />
      <VoiceInteractionCard />
      <SystemStatusCard />
    </div>
  );
}
