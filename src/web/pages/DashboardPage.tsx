import { DashboardStatusCard } from "@/components/dashboard-status-card";
import { ManagementPage } from "@/components/management-page";
import { McpToolTable } from "@/components/mcp-tool/mcp-tool-table";
import { Button } from "@/components/ui/button";
import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";

export default function DashboardPage() {
  return (
    <ManagementPage
      title="配置与工具"
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link to="/memory">
            对话与记忆
            <ArrowUpRight data-icon="inline-end" />
          </Link>
        </Button>
      }
    >
      <section className="flex min-w-0 flex-col gap-3" aria-label="连接与配置">
        <h3 className="text-base font-semibold">连接与配置</h3>
        <DashboardStatusCard />
      </section>
      <section className="flex min-w-0 flex-col gap-3" aria-label="可用工具">
        <h3 className="text-base font-semibold">可用工具</h3>
        <McpToolTable initialStatus="all" />
      </section>
    </ManagementPage>
  );
}
