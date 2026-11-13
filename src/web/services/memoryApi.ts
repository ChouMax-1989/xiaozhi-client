import type {
  MemoryAdminOverview,
  MemoryAdminSettings,
  MemoryCaptureView,
  MemoryChatView,
  MemoryDetailView,
  MemoryListStatus,
  MemoryOperationView,
  MemoryPage,
  MemoryRecord,
  MemorySettingsInput,
  MemorySourceView,
  MemorySyncJob,
  SummaryRecord,
} from "../../types/memory-admin";

interface MemoryResponse<T> {
  success: boolean;
  data: T;
  error?: { message?: string } | string;
}

function responseError(payload: { error?: MemoryResponse<unknown>["error"] }) {
  return typeof payload.error === "string"
    ? payload.error
    : payload.error?.message;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/memory${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let payload: MemoryResponse<T>;
  try {
    payload = await response.json();
  } catch {
    throw new Error("记忆服务返回了无法读取的响应，请刷新后重试。");
  }
  if (!response.ok || !payload.success) {
    throw new Error(
      responseError(payload) || `记忆服务请求失败（${response.status}）`
    );
  }
  return payload.data;
}

interface PageInput {
  query?: string;
  page: number;
  pageSize: number;
}

function queryString(values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return query.toString();
}

async function download(path: string, fileName: string) {
  const response = await fetch(`/api/memory${path}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: MemoryResponse<unknown>["error"];
    };
    throw new Error(responseError(payload) || "下载失败，请重试。");
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const memoryApi = {
  overview: (signal?: AbortSignal) =>
    request<MemoryAdminOverview>("/overview", { signal }),
  settings: (signal?: AbortSignal) =>
    request<MemoryAdminSettings>("/settings", { signal }),
  saveSettings: (settings: MemorySettingsInput) =>
    request<MemoryAdminSettings>("/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  saveCredential: (token: string) =>
    request<{ configured: true }>("/credential", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  chats: (input: PageInput, signal?: AbortSignal) =>
    request<MemoryPage<MemoryChatView>>(`/chats?${queryString({ ...input })}`, {
      signal,
    }),
  messages: (input: PageInput & { chatId: string }, signal?: AbortSignal) =>
    request<MemoryPage<MemorySourceView>>(
      `/messages?${queryString({ ...input })}`,
      { signal }
    ),
  source: (id: string, revision: number, signal?: AbortSignal) =>
    request<MemorySourceView | null>(
      `/sources/${encodeURIComponent(id)}?revision=${revision}`,
      { signal }
    ),
  entries: (
    input: PageInput & { status: MemoryListStatus },
    signal?: AbortSignal
  ) =>
    request<MemoryPage<MemoryRecord>>(`/entries?${queryString({ ...input })}`, {
      signal,
    }),
  detail: (id: string, signal?: AbortSignal) =>
    request<MemoryDetailView | null>(`/entries/${encodeURIComponent(id)}`, {
      signal,
    }),
  retire: (id: string, revision: number, reason: string) =>
    request<{ operationId: string; memory: MemoryRecord }>(
      `/entries/${encodeURIComponent(id)}/retire`,
      { method: "POST", body: JSON.stringify({ revision, reason }) }
    ),
  summaries: (signal?: AbortSignal) =>
    request<SummaryRecord[]>("/summaries", { signal }),
  captures: (signal?: AbortSignal) =>
    request<MemoryCaptureView[]>("/captures", { signal }),
  operations: (signal?: AbortSignal) =>
    request<MemoryOperationView[]>("/operations", { signal }),
  undo: (id: string) =>
    request<unknown>(`/operations/${encodeURIComponent(id)}/undo`, {
      method: "POST",
      body: "{}",
    }),
  sync: () => request<MemorySyncJob>("/sync", { method: "POST", body: "{}" }),
  export: () =>
    download(
      "/export",
      `xiaozhi-memory-${new Date().toISOString().slice(0, 10)}.json`
    ),
  backup: () =>
    request<{ fileName: string; bytes: number }>("/backup", {
      method: "POST",
      body: "{}",
    }),
  downloadBackup: (fileName: string) =>
    download(`/backups/${encodeURIComponent(fileName)}`, fileName),
};
