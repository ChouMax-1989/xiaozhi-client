import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { MemoryRecord } from "../../../types/memory-admin";

export const PAGE_SIZE = 12;

export const statusLabels: Record<MemoryRecord["status"], string> = {
  active: "生效中",
  candidate: "候选",
  historical: "历史事实",
  superseded: "已替代",
  invalidated: "已失效",
  retracted: "已停用",
};

export const assertionLabels: Record<MemoryRecord["assertion"], string> = {
  explicit: "明确表达",
  reported: "转述信息",
  inferred: "推断",
  plan: "计划",
  event: "事件",
  assistant_suggestion: "助手建议",
};

export function subjectLabel(subject: MemoryRecord["subject"]) {
  const kind = {
    speaker: "本人",
    related_person: "相关人物",
    entity: "事物",
  }[subject.kind];
  return subject.label ? `${kind} · ${subject.label}` : kind;
}

export function formatMemoryTime(value: string | null | undefined) {
  if (!value) return "未记录时间";
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? "时间格式未知"
    : time.toLocaleString("zh-CN", { hour12: false });
}

export function roleLabel(role: string) {
  const roles: Record<string, string> = {
    user: "用户",
    assistant: "小智",
    system: "系统",
    tool: "工具",
  };
  return roles[role] || role;
}

export function MemoryStatusBadge({
  status,
}: { status: MemoryRecord["status"] }) {
  return (
    <Badge
      variant={
        status === "active"
          ? "default"
          : status === "candidate"
            ? "secondary"
            : "outline"
      }
    >
      {statusLabels[status]}
    </Badge>
  );
}

export function MemoryLoading({
  label = "正在读取记忆库…",
}: { label?: string }) {
  return (
    <div className="flex flex-col gap-3 py-4" aria-busy="true">
      <output className="text-sm text-muted-foreground">{label}</output>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

export function MemoryErrorState({
  message,
  retry,
}: { message: string; retry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>暂时无法读取</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <p>{message}</p>
        <Button variant="outline" size="sm" onClick={retry}>
          重试
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function MemoryEmpty({
  title,
  description,
}: { title: string; description: string }) {
  return (
    <Card className="border-dashed shadow-none">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

export function MemoryPagination({
  page,
  pageSize = PAGE_SIZE,
  total,
  loading,
  onPage,
}: {
  page: number;
  pageSize?: number;
  total: number;
  loading: boolean;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav
      aria-label="列表分页"
      className="flex flex-wrap items-center justify-between gap-3 pt-2"
    >
      <p className="text-sm text-muted-foreground" aria-live="polite">
        共 {total} 条 · 第 {page} / {pages} 页
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={loading || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft data-icon="inline-start" />
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || page >= pages}
          onClick={() => onPage(page + 1)}
        >
          下一页
          <ChevronRight data-icon="inline-end" />
        </Button>
      </div>
    </nav>
  );
}
