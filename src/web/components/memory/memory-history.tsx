import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { memoryError, useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { useState } from "react";
import { toast } from "sonner";
import type { MemoryOperationView } from "../../../types/memory-admin";
import {
  MemoryEmpty,
  MemoryErrorState,
  MemoryLoading,
  MemoryPagination,
  PAGE_SIZE,
  formatMemoryTime,
} from "./memory-common";
import type { MemorySelection } from "./memory-detail";

export function MemorySummaries({
  revision,
  onSelect,
}: { revision: number; onSelect: (selection: MemorySelection) => void }) {
  const summaries = useMemoryResource(memoryApi.summaries, true, revision);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const filtered = (summaries.data ?? []).filter(
    (summary) =>
      (status === "all" || summary.status === status) &&
      `${summary.title} ${summary.text}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase())
  );
  const displayed = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        显示最近 100
        条摘要及其状态。摘要引用具体记忆版本，引用失效时摘要也可能失效。
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="memory-summary-search">搜索摘要</Label>
          <Input
            id="memory-summary-search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="搜索摘要标题或内容"
          />
        </div>
        <div className="flex flex-col gap-2 sm:w-40">
          <Label htmlFor="memory-summary-status">摘要状态</Label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          >
            <SelectTrigger id="memory-summary-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">生效中</SelectItem>
                <SelectItem value="invalidated">已失效</SelectItem>
                <SelectItem value="retracted">已撤回</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
      {summaries.loading ? (
        <MemoryLoading label="正在读取摘要…" />
      ) : summaries.error ? (
        <MemoryErrorState message={summaries.error} retry={summaries.refresh} />
      ) : displayed.length ? (
        displayed.map((summary) => (
          <Card key={summary.id}>
            <CardHeader>
              <div>
                <Badge
                  variant={summary.status === "active" ? "default" : "outline"}
                >
                  {
                    {
                      active: "生效中",
                      invalidated: "已失效",
                      retracted: "已撤回",
                    }[summary.status]
                  }
                </Badge>
              </div>
              <CardTitle>{summary.title}</CardTitle>
              <CardDescription>
                {formatMemoryTime(summary.createdAt)}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {summary.text}
              </p>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">引用的记忆版本</p>
                <div className="flex flex-wrap gap-2">
                  {summary.memories.map((memory) => (
                    <Button
                      key={`${memory.id}:${memory.revision}`}
                      variant="outline"
                      size="sm"
                      className="h-auto max-w-full py-2"
                      onClick={() => onSelect(memory)}
                    >
                      <span className="truncate">{memory.id}</span>
                      <span>版本 {memory.revision}</span>
                    </Button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        ))
      ) : (
        <MemoryEmpty
          title="没有可显示的摘要"
          description="可调整筛选；还没有摘要时，把整理提示粘贴到小智聊天中，让当前模型基于已核验的记忆生成摘要。"
        />
      )}
      {!summaries.error && summaries.data ? (
        <MemoryPagination
          page={page}
          total={filtered.length}
          loading={summaries.loading}
          onPage={setPage}
        />
      ) : null}
    </div>
  );
}

const operationLabels: Record<string, string> = {
  add: "新增记忆",
  replace: "更正记忆",
  reinforce: "补充记忆依据",
  retire: "停用记忆",
  undo: "撤销操作",
  summarize: "生成摘要",
  summary: "生成摘要",
  finish_sources: "完成原文整理",
  rebind_endpoint: "更换服务接入点",
};

export function MemoryOperations({
  revision,
  onChanged,
  onSelect,
}: {
  revision: number;
  onChanged: () => void;
  onSelect: (selection: MemorySelection) => void;
}) {
  const operations = useMemoryResource(memoryApi.operations, true, revision);
  const [selected, setSelected] = useState<MemoryOperationView | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  async function undo() {
    if (!selected?.canUndo) return;
    setUndoing(true);
    setUndoError(null);
    try {
      await memoryApi.undo(selected.id);
      setSelected(null);
      onChanged();
      operations.refresh();
      toast.success("操作已撤销，记忆与摘要状态已重新计算。");
    } catch (error) {
      setUndoError(memoryError(error));
    } finally {
      setUndoing(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        显示最近 20
        条操作。只有后台确认可以安全回退的操作才会显示“撤销”，原始对话会继续保留。
      </p>
      {operations.loading ? (
        <MemoryLoading label="正在读取操作记录…" />
      ) : operations.error ? (
        <MemoryErrorState
          message={operations.error}
          retry={operations.refresh}
        />
      ) : operations.data?.length ? (
        operations.data.map((operation) => (
          <Card key={operation.id}>
            <CardHeader>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  {operationLabels[operation.kind] ?? "记忆维护"}
                </Badge>
                {operation.undoneBy ? (
                  <Badge variant="outline">已撤销</Badge>
                ) : !operation.canUndo ? (
                  <Badge variant="outline">不可撤销</Badge>
                ) : null}
              </div>
              <CardDescription>
                {formatMemoryTime(operation.createdAt)}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {operation.reason ? (
                <p className="whitespace-pre-wrap break-words text-sm">
                  {operation.reason}
                </p>
              ) : null}
              <p className="break-all text-xs text-muted-foreground">
                操作 ID：{operation.id}
              </p>
              {operation.memoryIds.length ? (
                <div className="flex flex-wrap gap-2">
                  {operation.memoryIds.map((id) => (
                    <Button
                      key={id}
                      variant="outline"
                      size="sm"
                      className="max-w-full"
                      onClick={() => onSelect({ id })}
                    >
                      <span className="truncate">查看记忆 {id}</span>
                    </Button>
                  ))}
                </div>
              ) : null}
            </CardContent>
            {operation.canUndo ? (
              <CardFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelected(operation);
                    setUndoError(null);
                  }}
                >
                  撤销此操作
                </Button>
              </CardFooter>
            ) : null}
          </Card>
        ))
      ) : (
        <MemoryEmpty
          title="还没有操作记录"
          description="记忆整理、停用和撤销操作会记录在这里。"
        />
      )}
      <AlertDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !undoing) setSelected(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认撤销这次操作？</AlertDialogTitle>
            <AlertDialogDescription>
              将回退“
              {selected ? (operationLabels[selected.kind] ?? "记忆维护") : ""}
              ”对记忆的更改，并重新检查相关摘要。原始对话不会删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {undoError ? (
            <p role="alert" className="text-sm text-destructive">
              {undoError} 请取消并刷新操作记录后重试。
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={undoing}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={undoing}
              onClick={(event) => {
                event.preventDefault();
                void undo();
              }}
            >
              {undoing ? "正在撤销…" : "确认撤销"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
