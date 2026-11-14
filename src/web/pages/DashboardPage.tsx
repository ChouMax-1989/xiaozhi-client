import { DashboardStatusCard } from "@/components/dashboard-status-card";
import { ManagementPage } from "@/components/management-page";
import { McpToolTable } from "@/components/mcp-tool/mcp-tool-table";
import { MemoryRecordingRules } from "@/components/memory/memory-recording-rules";
import { useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { memoryRolePrompt } from "../../memory/prompts";

export default function DashboardPage() {
  const settings = useMemoryResource(memoryApi.settings);
  const prompt = settings.data
    ? memoryRolePrompt(settings.data.serviceName)
    : "";
  return (
    <ManagementPage title="配置与工具">
      <section className="flex min-w-0 flex-col gap-3" aria-label="连接与配置">
        <h3 className="text-base font-semibold">连接与配置</h3>
        <DashboardStatusCard />
      </section>
      <section className="flex min-w-0 flex-col gap-3" aria-label="可用工具">
        <h3 className="text-base font-semibold">可用工具</h3>
        <McpToolTable initialStatus="all" />
      </section>
      <section
        aria-labelledby="role-prompt-title"
        className="management-panel flex min-w-0 flex-col gap-3 p-4 sm:p-5"
      >
        <h3 id="role-prompt-title" className="text-base font-semibold">
          小智角色提示词
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          在小智 AI
          控制台打开智能体的「角色介绍」，开启「自定义」，首次使用时把以下规则追加到人设末尾。已有记忆规则时，只替换旧规则并保存。
        </p>
        {prompt ? (
          <>
            <p className="whitespace-pre-line rounded-md bg-muted p-3 text-sm leading-relaxed">
              {prompt}
            </p>
            <MemoryRecordingRules prompt={prompt} />
          </>
        ) : settings.error ? (
          <button
            type="button"
            className="self-start text-sm underline"
            onClick={settings.refresh}
          >
            重新读取记忆设置
          </button>
        ) : (
          <output className="text-sm text-muted-foreground">
            正在读取提示词…
          </output>
        )}
      </section>
    </ManagementPage>
  );
}
