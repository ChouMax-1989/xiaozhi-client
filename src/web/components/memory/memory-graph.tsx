import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  Expand,
  Info,
  List,
  Network,
  Search,
  Shrink,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  useDeferredValue,
  useId,
  useMemo,
  useState,
} from "react";
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

const darkTheme = {
  "--background": "0 0% 13%",
  "--foreground": "0 0% 90%",
  "--muted": "0 0% 18%",
  "--muted-foreground": "0 0% 60%",
  "--popover": "0 0% 18%",
  "--popover-foreground": "0 0% 92%",
  "--border": "0 0% 23%",
  "--input": "0 0% 24%",
  "--accent": "0 0% 22%",
  "--accent-foreground": "0 0% 95%",
  "--ring": "190 35% 62%",
  "--secondary": "0 0% 21%",
  "--secondary-foreground": "0 0% 92%",
} as CSSProperties;
const lightTheme = {
  "--background": "40 15% 97%",
  "--foreground": "220 10% 22%",
  "--muted": "40 12% 92%",
  "--muted-foreground": "220 5% 48%",
  "--popover": "40 15% 99%",
  "--popover-foreground": "220 10% 22%",
  "--border": "40 8% 84%",
  "--input": "40 8% 82%",
  "--accent": "40 12% 90%",
  "--accent-foreground": "220 10% 20%",
  "--ring": "190 35% 42%",
  "--secondary": "40 12% 90%",
  "--secondary-foreground": "220 10% 22%",
} as CSSProperties;

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
      <div id={contentId} className={open ? "pt-3" : undefined}>
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
  const [relation, setRelation] = useState<GraphRelation>("all");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [facet, setFacet] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [light, setLight] = useState(false);
  const [animationPreference, setAnimationPreference] = useState<
    boolean | null
  >(null);
  const query = useDeferredValue(search.trim().toLocaleLowerCase());
  const searchId = useId();
  const statusId = useId();
  const facetId = useId();
  const filtersId = useId();
  const infoId = useId();
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
  const theme = light ? lightTheme : darkTheme;
  const hasFilters = Boolean(search || status !== "all" || facet !== "all");

  function clearFilters() {
    setSearch("");
    setStatus("all");
    setFacet("all");
  }

  if (resource.loading) return <MemoryLoading label="正在连接记忆图谱…" />;
  if (resource.error)
    return (
      <MemoryErrorState message={resource.error} retry={resource.refresh} />
    );
  if (!resource.data?.items.length)
    return (
      <MemoryEmpty
        title="还没有可展示的记忆"
        description="生效中和候选记忆会显示在这里。提炼记忆后，即可查看真实字段之间的关联。"
      />
    );

  const workspace = (
    <div
      style={theme}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-background text-foreground",
        expanded && "h-full min-h-0 overflow-y-auto rounded-none border-0"
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-3 sm:gap-3 sm:px-5 sm:pt-5">
        <div className="relative min-w-0 flex-1 basis-full sm:max-w-64 sm:basis-auto">
          <Label htmlFor={searchId} className="sr-only">
            筛选已载入记忆
          </Label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={searchId}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索记忆"
            maxLength={200}
            className="h-9 rounded-full pl-9 pr-9"
          />
          {search ? (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 size-7 -translate-y-1/2 rounded-full"
              aria-label="清除图谱搜索"
              onClick={() => setSearch("")}
            >
              <X />
            </Button>
          ) : null}
        </div>
        <Select
          value={relation}
          onValueChange={(value) => setRelation(value as GraphRelation)}
        >
          <SelectTrigger
            aria-label="图谱关联方式"
            className="h-9 w-32 shrink-0 rounded-full border-transparent"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={theme}>
            <SelectGroup>
              {(Object.keys(relationLabels) as GraphRelation[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {relationLabels[value]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-9 rounded-full"
            aria-label="图谱筛选与外观"
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            title="筛选与外观"
            onClick={() => setFiltersOpen((value) => !value)}
          >
            <SlidersHorizontal />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-9 rounded-full"
            aria-label={expanded ? "收起扩大视图" : "扩大图谱视图"}
            title={expanded ? "收起" : "扩大视图"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Shrink /> : <Expand />}
          </Button>
        </div>
      </div>
      {filtersOpen ? (
        <div
          id={filtersId}
          className="mx-3 mt-3 flex shrink-0 flex-wrap items-end gap-3 rounded-lg border bg-muted/25 p-3 sm:mx-5"
        >
          <div className="flex min-w-32 flex-1 flex-col gap-2">
            <Label htmlFor={statusId}>记忆状态</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id={statusId} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={theme}>
                <SelectGroup>
                  <SelectItem value="all">全部当前记忆</SelectItem>
                  <SelectItem value="active">生效中</SelectItem>
                  <SelectItem value="candidate">候选</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-32 flex-1 flex-col gap-2">
            <Label htmlFor={facetId}>记忆分类</Label>
            <Select value={facet} onValueChange={setFacet}>
              <SelectTrigger id={facetId} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={theme}>
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
          <ToggleGroup
            type="single"
            size="sm"
            value={light ? "light" : "dark"}
            onValueChange={(value) => {
              if (value) setLight(value === "light");
            }}
            aria-label="图谱画布外观"
          >
            <ToggleGroupItem value="dark">深色画布</ToggleGroupItem>
            <ToggleGroupItem value="light">浅色画布</ToggleGroupItem>
          </ToggleGroup>
        </div>
      ) : null}
      {filtered.length ? (
        <MemoryGraphCanvas
          key={`${relation}:${revision}:${status}:${facet}:${query}`}
          graph={graph}
          onSelect={onSelect}
          expanded={expanded}
          light={light}
          animationPreference={animationPreference}
          onAnimationPreference={setAnimationPreference}
        />
      ) : (
        <div className="flex min-h-80 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm">没有匹配的记忆</p>
          <p className="text-xs text-muted-foreground">
            请修改搜索词、状态或分类。
          </p>
          <Button variant="outline" size="sm" onClick={clearFilters}>
            清除图谱筛选
          </Button>
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/50 px-3 py-2 sm:px-5">
        <p
          aria-live="polite"
          className="text-xs leading-5 text-muted-foreground"
        >
          {filtered.length} 条记忆 · {graph.edges.length} 条共同字段关联
          <span className="ml-2 inline-block opacity-75">
            已载入 {resource.data.items.length}/{resource.data.total}
            {resource.data.total > GRAPH_LIMIT ? ` · 上限 ${GRAPH_LIMIT}` : ""}
          </span>
        </p>
        <div className="flex items-center gap-1">
          {hasFilters && filtered.length ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              清除图谱筛选
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            aria-label="图谱说明"
            aria-expanded={infoOpen}
            aria-controls={infoId}
            title="图谱说明"
            onClick={() => setInfoOpen((value) => !value)}
          >
            <Info />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={listOpen}
            onClick={() => setListOpen((value) => !value)}
          >
            <List data-icon="inline-start" />
            {listOpen ? "收起列表" : "列表浏览"}
          </Button>
        </div>
      </div>
      {infoOpen ? (
        <div
          id={infoId}
          className="flex shrink-0 flex-col gap-2 border-t px-4 py-3 text-xs leading-5 text-muted-foreground"
        >
          <p>
            每个点是一条真实记忆，颜色按分类分配。细线仅表示两条记忆共享分类、同一档案内的主体标记或相同来源消息及版本，不代表因果或身份已核验。
          </p>
          <p>
            最多载入 {GRAPH_LIMIT}{" "}
            条生效中或候选记忆；搜索和筛选仅作用于这个集合。更多内容可在“更多 →
            全部记忆”中搜索。{graph.isolated}{" "}
            条记忆没有当前视角下的共同字段，仍作为独立点保留。
          </p>
          <p>
            悬停或聚焦查看标题，选择点打开详情。拖动空白处平移，按钮或 Ctrl /
            ⌘＋滚轮缩放。图谱聚焦后用方向键平移、＋/－缩放、0 复位；Tab
            选点，回车查看。
          </p>
        </div>
      ) : null}
      {listOpen ? (
        <ul
          aria-label="图谱记忆列表"
          className="max-h-64 shrink-0 overflow-y-auto border-t p-2"
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
    </div>
  );

  return (
    <>
      {expanded ? null : workspace}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        {expanded ? (
          <DialogContent
            style={theme}
            className="h-[94dvh] max-w-[calc(100vw-24px)] gap-0 overflow-hidden bg-background p-0 sm:max-w-[calc(100vw-48px)] [&>button]:hidden"
          >
            <DialogTitle className="sr-only">记忆图谱扩大视图</DialogTitle>
            <DialogDescription className="sr-only">
              探索真实记忆之间的共同字段关联，按 Escape
              或选择收起按钮退出扩大视图。
            </DialogDescription>
            {workspace}
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
