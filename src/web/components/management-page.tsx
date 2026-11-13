import { SiteHeader } from "@/components/site-header";
import type { ReactNode } from "react";

/** 看板和记忆库共用的内容宽度、标题和操作区。 */
export function ManagementPage({
  title,
  actions,
  children,
}: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="management-workspace flex min-h-screen min-w-0 flex-col">
      <SiteHeader title={title} />
      <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-1 flex-col gap-6 px-4 py-6 lg:px-8 lg:py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {title}
          </h2>
          {actions ? (
            <div className="flex items-center gap-1">{actions}</div>
          ) : null}
        </div>
        {children}
      </main>
    </div>
  );
}

export function ManagementStatus({
  title,
  value,
  description,
  actions,
}: {
  title: string;
  value: ReactNode;
  description: ReactNode;
  actions: ReactNode;
}) {
  return (
    <section
      className="management-panel flex min-w-0 flex-col gap-4 p-4 sm:p-5"
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-lg font-semibold tabular-nums leading-5">
          {value}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{description}</p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
        </div>
      </div>
    </section>
  );
}
