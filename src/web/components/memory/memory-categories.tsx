import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { ChevronRight, Search } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import {
  MemoryErrorState,
  MemoryLoading,
  MemoryPagination,
} from "./memory-common";
import { MemoryDelete } from "./memory-delete";
import type { MemorySelection } from "./memory-detail";
import { MemoryRetire } from "./memory-retire";

export function MemoryCategory({
  category,
  title,
  revision,
  onSelect,
  onChanged,
}: {
  category: "user_profile" | "situational";
  title: string;
  revision: number;
  onSelect: (selection: MemorySelection) => void;
  onChanged?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const load = useCallback(
    (signal: AbortSignal) =>
      memoryApi.entries(
        { category, status: "current", query, page, pageSize: 6 },
        signal
      ),
    [category, query, page]
  );
  const entries = useMemoryResource(load, true, revision);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(search.trim());
    setPage(1);
  }
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">
          {title}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {entries.data?.total ?? ""}
          </span>
        </h3>
        <form onSubmit={submit} className="flex w-full max-w-64 gap-1">
          <Input
            aria-label={`搜索${title}`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={200}
            placeholder={`搜索${title}`}
            className="h-8"
          />
          <Button
            type="submit"
            variant="ghost"
            size="icon"
            aria-label={`搜索${title}`}
            className="size-8 shrink-0"
          >
            <Search className="size-4" />
          </Button>
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setQuery("");
                setPage(1);
              }}
            >
              清除
            </Button>
          ) : null}
        </form>
      </div>
      {entries.loading ? (
        <MemoryLoading label={`正在读取${title}…`} />
      ) : entries.error ? (
        <MemoryErrorState message={entries.error} retry={entries.refresh} />
      ) : entries.data?.items.length ? (
        <ul className="flex flex-col gap-2">
          {entries.data.items.map((memory) => (
            <li
              key={memory.id}
              className="memory-fact flex-wrap sm:flex-nowrap"
            >
              <button
                type="button"
                onClick={() => onSelect({ id: memory.id })}
                className="flex w-full min-w-0 items-center gap-3 text-left sm:w-auto sm:flex-1"
                aria-label={`查看记忆：${memory.facet}：${memory.value}`}
              >
                <span className="min-w-0 flex-1 break-words text-sm leading-6">
                  <strong className="font-semibold">{memory.facet}:</strong>{" "}
                  {memory.value}
                  {memory.status === "candidate" ? (
                    <span className="ml-2 inline-block text-xs text-muted-foreground">
                      待确认
                    </span>
                  ) : null}
                  {memory.subject.label || memory.conditions ? (
                    <span className="mt-1 block text-xs font-normal text-muted-foreground">
                      {[memory.subject.label, memory.conditions]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  ) : null}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
              <div className="ml-auto flex shrink-0 items-center">
                <MemoryRetire
                  memory={memory}
                  onRetired={() => {
                    entries.refresh();
                    onChanged?.();
                  }}
                />
                <MemoryDelete
                  memory={memory}
                  compact
                  onDeleted={() => {
                    entries.refresh();
                    onChanged?.();
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg bg-muted/35 px-4 py-7 text-sm text-muted-foreground">
          {query
            ? `没有匹配的${title}，可清除搜索重试。`
            : page > 1
              ? "本页已无记忆，请返回上一页。"
              : `暂无${title}。从对话中提炼后会显示在这里。`}
        </p>
      )}
      {!entries.error &&
      entries.data &&
      (entries.data.total > 6 || page > 1) ? (
        <MemoryPagination
          page={entries.data.page}
          pageSize={entries.data.pageSize}
          total={entries.data.total}
          loading={entries.loading}
          onPage={setPage}
        />
      ) : null}
    </section>
  );
}
