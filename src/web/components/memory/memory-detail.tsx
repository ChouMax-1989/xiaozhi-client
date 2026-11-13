import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { memoryError, useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import type {
  MemoryDetailView,
  MemoryRecord,
  MemorySourceView,
} from "../../../types/memory-admin";
import {
  MemoryEmpty,
  MemoryErrorState,
  MemoryLoading,
  MemoryStatusBadge,
  assertionLabels,
  formatMemoryTime,
  roleLabel,
  subjectLabel,
} from "./memory-common";

export interface MemorySelection {
  id: string;
  revision?: number;
}

type Evidence = Omit<MemoryDetailView["sources"][number], "message"> & {
  message?: MemorySourceView | null;
};

function SourceEvidence({ source }: { source: Evidence }) {
  const [expanded, setExpanded] = useState(false);
  const load = useCallback(
    (signal: AbortSignal) =>
      memoryApi.source(source.messageId, source.revision, signal),
    [source.messageId, source.revision]
  );
  const historical = useMemoryResource(
    load,
    expanded && source.message === undefined
  );
  const message =
    source.message === undefined ? historical.data : source.message;
  const changed =
    source.currentRevision !== null &&
    source.currentRevision !== source.revision;
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">引用版本 {source.revision}</Badge>
        {message ? (
          <Badge variant="secondary">{roleLabel(message.role)}</Badge>
        ) : null}
        {changed ? (
          <Badge variant="outline">
            原文已有新版本 {source.currentRevision}
          </Badge>
        ) : null}
      </div>
      <p className="break-all text-xs text-muted-foreground">
        消息 ID：{source.messageId}
      </p>
      <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm leading-relaxed">
        {source.quote}
      </blockquote>
      {changed ? (
        <p className="text-sm text-muted-foreground">
          这条记忆引用的是当时的原话。当前原文已变化，请结合版本记录核对。
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded ? "收起完整原文" : "查看本版完整原文"}
      </Button>
      {expanded ? (
        historical.loading ? (
          <MemoryLoading label="正在读取引用版本…" />
        ) : historical.error ? (
          <MemoryErrorState
            message={historical.error}
            retry={historical.refresh}
          />
        ) : message ? (
          <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
            <p className="text-xs text-muted-foreground">
              {roleLabel(message.role)} · {formatMemoryTime(message.createdAt)}{" "}
              · 版本 {message.revision}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {message.content}
            </p>
          </div>
        ) : (
          <p className="text-sm text-destructive">
            找不到这条消息的引用版本，暂时无法核验原文。
          </p>
        )
      ) : null}
    </article>
  );
}

function MemoryFacts({ memory }: { memory: MemoryRecord }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap gap-2">
          <MemoryStatusBadge status={memory.status} />
          <Badge variant="outline">{assertionLabels[memory.assertion]}</Badge>
        </div>
        <CardTitle>{memory.facet}</CardTitle>
        <CardDescription>
          {subjectLabel(memory.subject)} · 版本 {memory.revision}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="whitespace-pre-wrap break-words leading-relaxed">
          {memory.value}
        </p>
        <dl className="grid gap-3 text-sm">
          {memory.conditions ? (
            <div>
              <dt className="text-muted-foreground">适用条件</dt>
              <dd className="whitespace-pre-wrap break-words">
                {memory.conditions}
              </dd>
            </div>
          ) : null}
          {memory.reason ? (
            <div>
              <dt className="text-muted-foreground">整理理由</dt>
              <dd className="whitespace-pre-wrap break-words">
                {memory.reason}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-muted-foreground">记录时间</dt>
            <dd>{formatMemoryTime(memory.createdAt)}</dd>
          </div>
          {memory.observedAt ? (
            <div>
              <dt className="text-muted-foreground">事实观察时间</dt>
              <dd>{formatMemoryTime(memory.observedAt)}</dd>
            </div>
          ) : null}
          {memory.validFrom || memory.validUntil ? (
            <div>
              <dt className="text-muted-foreground">有效时间</dt>
              <dd>
                {memory.validFrom
                  ? formatMemoryTime(memory.validFrom)
                  : "未限制开始时间"}{" "}
                至{" "}
                {memory.validUntil
                  ? formatMemoryTime(memory.validUntil)
                  : "未限制结束时间"}
              </dd>
            </div>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}

export function MemoryDetailSheet({
  selection,
  onClose,
  onChanged,
}: {
  selection: MemorySelection | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const id = selection?.id ?? "";
  const load = useCallback(
    (signal: AbortSignal) => memoryApi.detail(id, signal),
    [id]
  );
  const detail = useMemoryResource(load, Boolean(selection));
  const [version, setVersion] = useState<number | null>(
    selection?.revision ?? null
  );
  const [retiring, setRetiring] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [retireError, setRetireError] = useState<string | null>(null);
  const data = detail.data;
  const selectedVersion =
    version === null || version === data?.memory.revision
      ? data?.memory
      : data?.versions.find((record) => record.revision === version);
  const current = selectedVersion?.revision === data?.memory.revision;
  const sources: Evidence[] =
    selectedVersion && data
      ? selectedVersion.sources.map(
          (source) =>
            data.sources.find(
              (item) =>
                item.messageId === source.messageId &&
                item.revision === source.revision &&
                item.quote === source.quote
            ) ?? {
              ...source,
              currentRevision:
                data.sources.find((item) => item.messageId === source.messageId)
                  ?.currentRevision ?? null,
            }
        )
      : [];

  async function retire() {
    if (!data || !reason.trim()) return;
    setRetiring(true);
    setRetireError(null);
    try {
      await memoryApi.retire(
        data.memory.id,
        data.memory.revision,
        reason.trim()
      );
      setRetireOpen(false);
      setReason("");
      setVersion(null);
      detail.refresh();
      onChanged();
      toast.success("这条记忆已停用，可在操作记录中查看或撤销。");
    } catch (error) {
      setRetireError(memoryError(error));
    } finally {
      setRetiring(false);
    }
  }

  return (
    <Sheet
      open={selection !== null}
      onOpenChange={(open) => {
        if (!open && !retiring) onClose();
      }}
    >
      <SheetContent className="flex w-full flex-col gap-5 overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>记忆详情</SheetTitle>
          <SheetDescription className="break-all">
            查看事实、原话依据和历史版本。记忆 ID：{id}
          </SheetDescription>
        </SheetHeader>
        {detail.loading ? (
          <MemoryLoading label="正在读取记忆详情…" />
        ) : detail.error ? (
          <MemoryErrorState message={detail.error} retry={detail.refresh} />
        ) : !data ? (
          <MemoryEmpty
            title="找不到这条记忆"
            description="记录可能已变化，请关闭详情并刷新列表。"
          />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <Label htmlFor="memory-version">查看版本</Label>
              <Select
                value={String(version ?? data.memory.revision)}
                onValueChange={(value) => setVersion(Number(value))}
              >
                <SelectTrigger id="memory-version">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {[...data.versions]
                      .sort((left, right) => right.revision - left.revision)
                      .map((record) => (
                        <SelectItem
                          key={record.revision}
                          value={String(record.revision)}
                        >
                          版本 {record.revision}
                          {record.revision === data.memory.revision
                            ? " · 当前版本"
                            : " · 历史版本"}{" "}
                          · {formatMemoryTime(record.createdAt)}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {!selectedVersion ? (
              <Alert>
                <AlertTitle>引用的记忆版本不存在</AlertTitle>
                <AlertDescription>
                  可以在上方切换到当前版本查看。
                </AlertDescription>
              </Alert>
            ) : (
              <>
                {!current ? (
                  <Alert>
                    <AlertTitle>
                      正在查看历史版本 {selectedVersion.revision}
                    </AlertTitle>
                    <AlertDescription>
                      当前记忆已经更新到版本 {data.memory.revision}
                      。历史内容仅供追溯，停用操作应在当前版本进行。
                    </AlertDescription>
                  </Alert>
                ) : null}
                <MemoryFacts memory={selectedVersion} />
                <section
                  className="flex flex-col gap-3"
                  aria-labelledby="memory-evidence-title"
                >
                  <h3 id="memory-evidence-title" className="font-semibold">
                    原话依据（{sources.length}）
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    每条引用都绑定消息 ID
                    和具体版本，下面保留整理时引用的精确原话。
                  </p>
                  {sources.length ? (
                    sources.map((source, index) => (
                      <SourceEvidence
                        key={`${source.messageId}:${source.revision}:${index}`}
                        source={source}
                      />
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      没有可显示的原话依据。
                    </p>
                  )}
                </section>
                <Separator />
                {current &&
                (selectedVersion.status === "active" ||
                  selectedVersion.status === "candidate") ? (
                  <div className="flex flex-col items-start gap-2 pb-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setRetireError(null);
                        setRetireOpen(true);
                      }}
                    >
                      停用这条记忆
                    </Button>
                    <p className="text-sm text-muted-foreground">
                      停用后不再参与记忆检索，原始对话和历史记录仍会保留。
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </>
        )}
        <AlertDialog
          open={retireOpen}
          onOpenChange={(open) => {
            if (!retiring) setRetireOpen(open);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认停用这条记忆？</AlertDialogTitle>
              <AlertDialogDescription>
                将停用当前版本 {data?.memory.revision}
                。填写原因后确认，原始对话不会删除。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="memory-retire-reason">停用原因（必填）</Label>
              <Textarea
                id="memory-retire-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                placeholder="例如：这项偏好已经改变"
                disabled={retiring}
              />
            </div>
            {retireError ? (
              <p role="alert" className="text-sm text-destructive">
                {retireError} 如记录已更新，请取消并重新打开详情后核对。
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={retiring}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={retiring || !reason.trim()}
                onClick={(event) => {
                  event.preventDefault();
                  void retire();
                }}
              >
                {retiring ? "正在停用…" : "确认停用"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
