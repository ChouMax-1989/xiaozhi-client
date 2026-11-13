import { Button } from "@/components/ui/button";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useMemoryResource } from "@/hooks/useMemoryResource";
import { ChevronDown, ChevronRight, Network } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";
import {
  MemoryEmpty,
  MemoryErrorState,
  MemoryLoading,
  subjectLabel,
} from "./memory-common";
import type { MemorySelection } from "./memory-detail";
import { MemoryGraphCanvas } from "./memory-graph-canvas";
import {
  GRAPH_LIMIT,
  type GraphRelation,
  buildMemoryGraph,
  loadGraphMemories,
  relationLabels,
} from "./memory-graph-model";

export function MemoryGraph({
  revision,
  onSelect,
}: { revision: number; onSelect: (selection: MemorySelection) => void }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <section aria-label="记忆图谱" className="min-w-0">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <Network data-icon="inline-start" />
        记忆图谱
        {open ? (
          <ChevronDown data-icon="inline-end" />
        ) : (
          <ChevronRight data-icon="inline-end" />
        )}
      </Button>
      <div id={contentId}>
        {open ? (
          <MemoryGraphExplorer revision={revision} onSelect={onSelect} />
        ) : null}
      </div>
    </section>
  );
}

export function MemoryGraphExplorer({
  revision,
  onSelect,
}: { revision: number; onSelect: (selection: MemorySelection) => void }) {
  const resource = useMemoryResource(loadGraphMemories, true, revision);
  const [relation, setRelation] = useState<GraphRelation>("facet");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [facet, setFacet] = useState("all");
  const [listOpen, setListOpen] = useState(false);
  const query = useDeferredValue(search.trim().toLocaleLowerCase());
  const searchId = useId();
  const statusId = useId();
  const facetId = useId();
  const facets = useMemo(
    () =>
      [...new Set(resource.data?.items.map((item) => item.facet) ?? [])].sort(),
    [resource.data]
  );
  const filtered = useMemo(
    () =>
      (resource.data?.items ?? []).filter(
        (memory) =>
          (status === "all" || memory.status === status) &&
          (facet === "all" || `facet:${memory.facet}` === facet) &&
          (!query ||
            [
              memory.facet,
              memory.value,
              subjectLabel(memory.subject),
              memory.conditions,
            ]
              .join(" ")
              .toLocaleLowerCase()
              .includes(query))
      ),
    [resource.data, status, facet, query]
  );
  const graph = useMemo(
    () => buildMemoryGraph(filtered, relation),
    [filtered, relation]
  );

  if (resource.loading) return <MemoryLoading label="正在连接记忆图谱…" />;
  if (resource.error)
    return (
      <MemoryErrorState message={resource.error} retry={resource.refresh} />
    );
  if (!resource.data?.items.length)
    return (
      <div className="pt-3">
        <MemoryEmpty
          title="还没有可展示的记忆"
          description="生效中和候选记忆会显示在这里。提炼记忆后，即可查看真实字段之间的关联。"
        />
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-4 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          type="single"
          value={relation}
          onValueChange={(value) => {
            if (value) setRelation(value as GraphRelation);
          }}
          size="sm"
          variant="outline"
          aria-label="图谱关联方式"
          className="flex-wrap justify-start"
        >
          {(Object.keys(relationLabels) as GraphRelation[]).map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {relationLabels[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          显示 {filtered.length} 条记忆 · {graph.nodes.length - filtered.length}{" "}
          个共同字段
        </p>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(8rem,12rem)]">
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={searchId}>筛选已载入记忆</Label>
          <Input
            id={searchId}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索内容、主体或分类"
            maxLength={200}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={statusId}>记忆状态</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id={statusId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部当前记忆</SelectItem>
                <SelectItem value="active">生效中</SelectItem>
                <SelectItem value="candidate">候选</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={facetId}>记忆分类</Label>
          <Select value={facet} onValueChange={setFacet}>
            <SelectTrigger id={facetId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部分类</SelectItem>
                {facets.map((value) => (
                  <SelectItem key={value} value={`facet:${value}`}>
                    {value}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        已载入 {resource.data.items.length} / {resource.data.total}{" "}
        条生效中或候选记忆，最多展示 {GRAPH_LIMIT} 条；筛选仅作用于已载入集合。
        {resource.data.total > GRAPH_LIMIT
          ? "其余记忆可在“更多 → 全部记忆”中搜索。"
          : null}
        {relation === "subject"
          ? "连线表示同一档案内的主体标记相同，不代表身份已核验。"
          : relation === "source"
            ? "连线表示引用同一档案中的相同来源消息及版本。"
            : "连线表示分类字段相同，不代表因果或语义关系。"}
      </p>
      {filtered.length ? (
        <>
          <MemoryGraphCanvas
            key={`${relation}:${revision}:${status}:${facet}:${query}`}
            graph={graph}
            onSelect={onSelect}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {graph.isolated
                ? `${graph.isolated} 条记忆在当前视图中没有共同字段，仍保留为独立点。`
                : "悬停或聚焦可读标题，选择记忆可查看详情与来源。"}
            </p>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={listOpen}
              onClick={() => setListOpen((value) => !value)}
            >
              {listOpen ? "收起列表" : "列表浏览"}
            </Button>
          </div>
          {listOpen ? (
            <ul
              aria-label="图谱记忆列表"
              className="max-h-72 overflow-y-auto rounded-lg border p-2"
            >
              {filtered.map((memory) => (
                <li key={memory.id}>
                  <button
                    type="button"
                    className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => onSelect({ id: memory.id })}
                  >
                    <span className="font-medium">{memory.facet}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {memory.status === "candidate" ? "候选" : "生效中"} ·{" "}
                      {subjectLabel(memory.subject)}
                    </span>
                    <span className="mt-1 block break-words leading-6">
                      {memory.value}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <MemoryEmpty
          title="没有匹配的记忆"
          description="请修改搜索词、状态或分类，或清除筛选后重试。"
        />
      )}
      {search || status !== "all" || facet !== "all" ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            setSearch("");
            setStatus("all");
            setFacet("all");
          }}
        >
          清除图谱筛选
        </Button>
      ) : null}
    </div>
  );
}
