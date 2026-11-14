import { ManagementPage } from "@/components/management-page";
import {
  MemoryErrorState,
  MemoryLoading,
} from "@/components/memory/memory-common";
import {
  MemoryDetailSheet,
  type MemorySelection,
} from "@/components/memory/memory-detail";
import { MemoryGraphExplorer } from "@/components/memory/memory-graph";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

export default function MemoryGraphPage() {
  const overview = useMemoryResource(memoryApi.overview);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<MemorySelection | null>(null);
  function refresh() {
    overview.refresh();
    setRevision((value) => value + 1);
  }
  return (
    <ManagementPage
      title="记忆图谱"
      actions={
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新图谱"
          title="刷新图谱"
          disabled={overview.loading}
          onClick={refresh}
        >
          <RefreshCw />
        </Button>
      }
    >
      {overview.error ? (
        <MemoryErrorState message={overview.error} retry={refresh} />
      ) : !overview.data ? (
        <MemoryLoading label="正在读取记忆服务状态…" />
      ) : overview.data.ready ? (
        <MemoryGraphExplorer revision={revision} onSelect={setSelection} />
      ) : (
        <Alert>
          <AlertTitle>
            {overview.data.settings.configured
              ? "记忆服务尚未就绪"
              : "先完成记忆服务设置"}
          </AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <p>
              {overview.data.error ||
                "前往记忆库检查设置，服务就绪后即可查看图谱。"}
            </p>
            <Button asChild size="sm" variant="outline">
              <Link to="/memory">前往记忆库</Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <MemoryDetailSheet
        key={selection?.id ?? "closed"}
        selection={selection}
        onClose={() => setSelection(null)}
        onChanged={refresh}
      />
    </ManagementPage>
  );
}
