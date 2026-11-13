import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import { useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { Search } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import type { MemoryListStatus } from "../../../types/memory-admin";
import {
  MemoryEmpty,
  MemoryErrorState,
  MemoryLoading,
  MemoryPagination,
  MemoryStatusBadge,
  PAGE_SIZE,
  assertionLabels,
  formatMemoryTime,
  subjectLabel,
} from "./memory-common";
import { MemoryDelete } from "./memory-delete";
import type { MemorySelection } from "./memory-detail";
import { MemoryRetire } from "./memory-retire";

export function MemoryEntries({
  revision,
  onSelect,
  onChanged,
}: {
  revision: number;
  onSelect: (selection: MemorySelection) => void;
  onChanged?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<MemoryListStatus>("all");
  const [page, setPage] = useState(1);
  const load = useCallback(
    (signal: AbortSignal) =>
      memoryApi.entries({ query, status, page, pageSize: PAGE_SIZE }, signal),
    [query, status, page]
  );
  const entries = useMemoryResource(load, true, revision);
  const captures = useMemoryResource(
    memoryApi.captures,
    status === "candidate",
    revision
  );

  function searchEntries(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setQuery(search.trim());
  }
  function changed() {
    entries.refresh();
    onChanged?.();
  }

  return (
    <div className="flex flex-col gap-5">
      <form
        onSubmit={searchEntries}
        className="grid grid-cols-2 gap-3 sm:flex sm:items-end"
      >
        <div className="col-span-2 flex min-w-0 flex-1 flex-col gap-2">
          <Label className="sr-only" htmlFor="memory-search">
            搜索记忆
          </Label>
          <Input
            id="memory-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索事实、分类、人物或条件"
            maxLength={200}
          />
        </div>
        <div className="flex flex-col gap-2 sm:w-40">
          <Label className="sr-only" htmlFor="memory-status">
            记忆状态
          </Label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as MemoryListStatus);
              setPage(1);
            }}
          >
            <SelectTrigger id="memory-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="active">生效中</SelectItem>
                <SelectItem value="candidate">候选</SelectItem>
                <SelectItem value="inactive">已停用 / 历史</SelectItem>
                <SelectItem value="all">全部状态</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit">
          <Search data-icon="inline-start" />
          搜索
        </Button>
        {query ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSearch("");
              setQuery("");
              setPage(1);
            }}
          >
            清除搜索
          </Button>
        ) : null}
      </form>
      {status === "candidate" ? (
        <Alert>
          <AlertTitle>候选内容需要结合原话核验</AlertTitle>
          <AlertDescription>
            推断、助手建议等内容会保留为候选。页面不会直接批准候选，也不会把暂存文字当成原始证据。
          </AlertDescription>
        </Alert>
      ) : null}
      {entries.loading ? (
        <MemoryLoading />
      ) : entries.error ? (
        <MemoryErrorState message={entries.error} retry={entries.refresh} />
      ) : entries.data?.items.length ? (
        <div className="memory-list" aria-label="记忆列表">
          {entries.data.items.map((memory) => (
            <article key={memory.id} className="memory-row">
              <div className="memory-row-facet">
                <Badge variant="outline">{memory.facet}</Badge>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm font-medium leading-relaxed">
                  {memory.value}
                </p>
                {memory.conditions ? (
                  <p className="line-clamp-2 break-words text-xs text-muted-foreground">
                    适用条件：{memory.conditions}
                  </p>
                ) : null}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {subjectLabel(memory.subject)} · {memory.sources.length}{" "}
                  条原话依据 · 版本 {memory.revision} ·{" "}
                  {assertionLabels[memory.assertion]}
                </p>
              </div>
              <div className="memory-row-actions">
                <MemoryStatusBadge status={memory.status} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onSelect({ id: memory.id })}
                >
                  查看详情
                </Button>
                <MemoryRetire memory={memory} onRetired={changed} />
                <MemoryDelete memory={memory} compact onDeleted={changed} />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <MemoryEmpty
          title={
            query
              ? "没有找到匹配的记忆"
              : page > 1
                ? "本页已无记忆"
                : "此状态下暂无记忆"
          }
          description={
            query
              ? "试试其他关键词，或清除搜索、切换状态。"
              : page > 1
                ? "记录已变化，请返回上一页查看。"
                : "可切换记忆状态查看其他条目。"
          }
        />
      )}
      {!entries.error && entries.data ? (
        <MemoryPagination
          page={entries.data.page}
          pageSize={entries.data.pageSize}
          total={entries.data.total}
          loading={entries.loading}
          onPage={setPage}
        />
      ) : null}
      {status === "candidate" ? (
        <section
          className="flex flex-col gap-4"
          aria-labelledby="memory-captures-title"
        >
          <div className="flex flex-col gap-1">
            <h3 id="memory-captures-title" className="font-semibold">
              待核验的暂存内容
            </h3>
            <p className="text-sm text-muted-foreground">
              最近 50
              条暂存记录，不受上方记忆搜索影响。这些内容尚未核验，不能作为正式记忆的原始证据。
            </p>
          </div>
          {captures.loading ? (
            <MemoryLoading label="正在读取暂存内容…" />
          ) : captures.error ? (
            <MemoryErrorState
              message={captures.error}
              retry={captures.refresh}
            />
          ) : captures.data?.length ? (
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              {captures.data.map((capture) => (
                <Card key={capture.id}>
                  <CardHeader>
                    <CardTitle>尚未核验</CardTitle>
                    <CardDescription>
                      {formatMemoryTime(capture.createdAt)} ·{" "}
                      {capture.status === "provisional"
                        ? "暂存"
                        : capture.status === "reconciled"
                          ? "已关联核验"
                          : capture.status === "retracted"
                            ? "已撤回"
                            : "暂存记录"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {capture.text}
                    </p>
                    <p className="break-words text-sm text-muted-foreground">
                      暂存原因：{capture.reason}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <MemoryEmpty
              title="没有待核验的暂存内容"
              description="尚未能绑定原始对话的内容会在这里显示。"
            />
          )}
        </section>
      ) : null}
    </div>
  );
}
